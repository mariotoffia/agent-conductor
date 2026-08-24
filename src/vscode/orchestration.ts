import { join } from "node:path";
import {
  createOrchestrator,
  injectShim,
  message,
  nodeGitPort,
  resolveRuntime,
  shimRefusal,
  startOrchestrationServer,
  Worktrees,
  type ChildLaunch,
  type ChildSession,
  type ExecutablePort,
  type GitPort,
  type LogPort,
  type OrchestrationLimits,
  type OrchestrationServer,
  type Orchestrator,
  type ReleaseOutcome,
  type ParentSession,
  type ResolvedRuntime,
  type RuntimeSpec,
  type RuntimeTrust,
  type ShimInjection,
  type ShimLaunch,
  type StoragePort,
  type SubagentRuntime,
} from "../core/index.js";
import type { ConductorSettings } from "./config.js";

/**
 * Orchestration as this window has it: the socket, the spawn tree, and the
 * worktrees (ADR-0004, ADR-0008, ADR-0009).
 *
 * Apart from the composition root because none of it needs `vscode`, and
 * because the thing worth checking is what happens when orchestration is *off*
 * — no socket, no capability, no spawn RPC. That is a property of this wiring
 * rather than of any one module underneath it, so it is here that it can be
 * driven whole.
 *
 * The socket is created on the first Session that turns out to be eligible, and
 * never before. Eligibility is decided by `shimRefusal`, which reads nothing and
 * starts nothing, so a window with orchestration switched off has no socket at
 * all rather than an empty one.
 */

export interface OrchestrationOptions {
  settings(): ConductorSettings;
  /** Every Runtime the settings describe, at its pinned Adapter version. */
  runtimes(): RuntimeSpec[];
  trustFor(spec: RuntimeSpec): RuntimeTrust | undefined;
  executable: ExecutablePort;
  /** Where a Subagent works when it shares its parent's checkout, and the
   *  repository a worktree is cut from. */
  workspace(): string | undefined;
  /** Starts one Subagent Session. Supplied by the composition root, because it
   *  is the same gate every other Session start goes through (ADR-0007). */
  openChild(launch: ChildLaunch): Promise<ChildSession>;
  storage: StoragePort;
  log: LogPort;
  /** The bundled Shim: the interpreter, and the script it runs. */
  command: string;
  shim: ShimLaunch;
  /** Where worktrees are made when `worktrees.root` names nowhere. */
  worktreeRoot: string;
  git?: GitPort;
}

export interface InjectionRequest {
  /** The identity this Session is actually about to launch under. */
  runtime: Pick<ResolvedRuntime, "trusted" | "capabilities" | "quirks">;
  sessionKey: string;
  parentSessionKey?: string;
  depth: number;
  roots: readonly string[];
}

export interface Orchestration {
  /**
   * Where the orchestration socket is listening, or nothing because there is no
   * socket.
   *
   * The second is the ordinary answer: while orchestration is off, or while no
   * Session has been eligible for the Shim, none is ever created (ADR-0008).
   */
  address(): string | undefined;
  /** Every Runtime as a spawn target, as a Shim asking would be told. */
  targets(): Promise<SubagentRuntime[]>;
  /** The Shim for one Session, or nothing and the reason for nothing. */
  inject(request: InjectionRequest): Promise<ShimInjection>;
  attach(sessionKey: string, parent: ParentSession): void;
  release(sessionKey: string): Promise<void>;
  /** Settles the worktree journal against what git has. Run at activation. */
  reconcile(): Promise<void>;
  /**
   * Gives one worktree back, when the user asks.
   *
   * The only path that removes anything. Nothing in this Client calls it on its
   * own, and it refuses a checkout with uncommitted changes unless the user says
   * so a second time (ADR-0009).
   */
  releaseWorktree(path: string, options?: { force?: boolean }): Promise<ReleaseOutcome>;
  dispose(): Promise<void>;
}

export function orchestration(options: OrchestrationOptions): Orchestration {
  const worktrees = new Worktrees({
    git: options.git ?? nodeGitPort,
    storage: options.storage,
    root: () => options.settings()["worktrees.root"] || options.worktreeRoot,
    now: () => Date.now(),
    log: options.log,
  });
  let server: Promise<OrchestrationServer> | undefined;
  let address: string | undefined;
  let stopped = false;

  const orchestrator: Orchestrator = createOrchestrator({
    limits: () => limitsFrom(options.settings()),
    runtimes: () => spawnTargets(options),
    openChild: options.openChild,
    worktrees,
    log: options.log,
  });

  /** The socket, made once and only for a Session that may actually use it. */
  const socket = (): Promise<OrchestrationServer> => {
    server ??= startOrchestrationServer({ handler: orchestrator.handle, log: options.log }).then(
      (live) => {
        address = live.address;
        return live;
      },
    );
    return server;
  };

  return {
    address: () => address,
    targets: () => spawnTargets(options),
    async inject(request) {
      const settings = options.settings();
      const conditions = {
        enabled: settings["orchestration.enabled"],
        depth: request.depth,
        maxSpawnDepth: settings["orchestration.maxSpawnDepth"],
        trusted: request.runtime.trusted,
        acceptsMcpServers: request.runtime.quirks.refusesMcpServers !== true,
        command: options.command,
      };
      // Asked before the socket exists, so that a window with orchestration off
      // never creates one. `injectShim` asks the same question again over the
      // whole request, which is what keeps the two from drifting apart.
      const refused = stopped ? "agent conductor is shutting down" : shimRefusal(conditions);
      if (refused) return { servers: [], revoke: () => undefined, refused };
      return injectShim({
        ...conditions,
        sessionKey: request.sessionKey,
        ...(request.parentSessionKey ? { parentSessionKey: request.parentSessionKey } : {}),
        roots: request.roots,
        issuer: await socket(),
        launch: options.shim,
        now: () => Date.now(),
      });
    },
    attach: (sessionKey, parent) => orchestrator.attach(sessionKey, parent),
    releaseWorktree: (path, release = {}) => worktrees.release(path, release),
    release: (sessionKey) => orchestrator.release(sessionKey),
    async reconcile() {
      // Always, not only while orchestration is on: what was left behind by a
      // window that crashed with it on is still there when it is switched off.
      const outcome = await worktrees.reconcile();
      if (outcome.abandoned.length === 0) return;
      options.log.log(
        "info",
        `${outcome.abandoned.length} abandoned worktree allocation(s) were reconciled away`,
      );
    },
    async dispose() {
      stopped = true;
      await orchestrator.dispose();
      const started = server;
      server = undefined;
      address = undefined;
      await started?.then((live) => live.close()).catch(() => undefined);
    },
  };
}

/** What the user's settings say a spawn tree may be. Read per call, like every
 *  other setting: a change takes effect on the next spawn. */
export function limitsFrom(settings: ConductorSettings): OrchestrationLimits {
  // Named the way every other setting is read here, so that the check which
  // finds a setting nothing consumes can see this one being consumed.
  const preset = settings["presets"][settings["orchestration.defaultSubagentPreset"]];
  return {
    maxSpawnDepth: settings["orchestration.maxSpawnDepth"],
    maxConcurrentSubagents: settings["orchestration.maxConcurrentSubagents"],
    maxSubagentsPerSession: settings["orchestration.maxSubagentsPerSession"],
    defaultTimeoutMs: settings["orchestration.subagentTimeoutMs"],
    // One setting, both roles: what a Brief that asks for nothing gets, and the
    // ceiling on what one that asks may have.
    maxTimeoutMs: settings["orchestration.subagentTimeoutMs"],
    budgetUsdPerSubagent: settings["orchestration.budgetUsdPerSubagent"],
    isolation: settings["orchestration.subagentIsolation"],
    ...(preset?.runtime ? { defaultRuntimeId: preset.runtime } : {}),
    ...(preset?.model ? { defaultModel: preset.model } : {}),
    ...(preset?.effort ? { defaultEffort: preset.effort as OrchestrationLimits["defaultEffort"] } : {}),
  };
}

/**
 * Every Runtime as a spawn target, resolved now rather than remembered.
 *
 * A Runtime is only spawnable if its trust still holds for the identity it
 * resolves to at this moment — the same rule a direct Session start applies, and
 * for the same reason: an executable that moved or changed is a different
 * Runtime, whatever a record says (ADR-0007).
 */
async function spawnTargets(options: OrchestrationOptions): Promise<SubagentRuntime[]> {
  const workspace = options.workspace();
  return Promise.all(
    options.runtimes().map(async (spec): Promise<SubagentRuntime> => {
      const trust = options.trustFor(spec);
      const base = {
        id: spec.id,
        displayName: spec.displayName,
        fanOut: trust?.fanOut === true,
        ...(spec.modelCatalog
          ? { models: spec.modelCatalog.map((hint) => ({ id: hint.id, label: hint.label })) }
          : {}),
      };
      try {
        const resolved = await resolveRuntime(spec, {
          executable: options.executable,
          ...(trust ? { trust } : {}),
          ...(workspace ? { workspace } : {}),
        });
        return {
          ...base,
          available: resolved.trusted,
          ...(resolved.trusted
            ? {}
            : { unavailable: "this runtime has not been approved in the connection wizard" }),
          // Never what the Runtime says it could do — what this Client can
          // actually ask of it. ACP has no way to set a money limit on a child,
          // and no Runtime in the catalog has a channel of its own, so there is
          // nothing to forward and nothing that would hold it. Reporting the
          // Runtime's own claim here would tell a parent Agent that a limit is
          // being enforced when nothing was ever sent (ADR-0008).
          budget: false,
        };
      } catch (error) {
        return { ...base, available: false, unavailable: message(error), budget: false };
      }
    }),
  );
}

/** Where worktrees go when the user has named nowhere: a directory of ours. */
export function defaultWorktreeRoot(storageDirectory: string): string {
  return join(storageDirectory, "worktrees");
}
