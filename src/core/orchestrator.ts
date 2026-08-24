/**
 * The spawn tree: what a Subagent is allowed to be, and what becomes of it
 * (ADR-0004, ADR-0008, ADR-0009).
 *
 * Everything an Agent may ask for arrives here already validated as a *shape*
 * by the socket. What it may *have* is decided here and nowhere else: which
 * Runtime, how deep, how many at once, how many in all, how long, how much, and
 * which files it may name. None of it can be widened by the caller — the
 * capability the call came under is the only lineage there is, and it was minted
 * on this side before the Agent ever ran.
 *
 * A Subagent shares no conversation with its parent. What crosses is a Brief:
 * words and absolute file paths, never file contents and never history.
 */
import { randomUUID } from "node:crypto";
import type * as acp from "@agentclientprotocol/sdk";
import { systemClock } from "./acpClient.js";
import { message } from "./failures.js";
import type { OrchestrationCall, OrchestrationHandler } from "./ipcProtocol.js";
import type { ConductorSession } from "./session.js";
import { brief, createSemaphore, fanOutRefusal, within } from "./spawnLimits.js";
import { watcher, type SubagentResult, type SubagentState, type Watcher } from "./subagentResult.js";
import type { ClockPort, EffectiveSelection, EffortLevel, LogPort } from "./types.js";

/** What the user's settings allow a spawn tree to be. */
export interface OrchestrationLimits {
  /** The Depth Cap. A child of a Session at depth *d* runs at *d+1*. */
  maxSpawnDepth: number;
  /** Subagents running at once, across every parent in this window. */
  maxConcurrentSubagents: number;
  /**
   * Subagents one parent Session may start over its whole life.
   *
   * The bound a loop runs into. Concurrency alone does not stop one: a parent
   * that spawns, waits, and spawns again stays inside it for ever.
   */
  maxSubagentsPerSession: number;
  /** How long a Subagent's Turn runs when the Agent asks for nothing. */
  defaultTimeoutMs: number;
  /** Ceiling on what an Agent may ask for. */
  maxTimeoutMs: number;
  /** Money limit per Subagent. Applies as a ceiling whether or not a Runtime
   *  can enforce one; a Runtime that cannot is simply never told (ADR-0008). */
  budgetUsdPerSubagent: number;
  isolation: "shared" | "worktree";
  /** Preset defaults. A Brief that names none of these gets these. */
  defaultRuntimeId?: string;
  defaultModel?: string;
  defaultEffort?: EffortLevel;
}

/** One Runtime as a spawn target, with the evidence that decides eligibility. */
export interface SubagentRuntime {
  id: string;
  displayName: string;
  /** It resolves to something launchable. */
  available: boolean;
  /** Why it does not, when it does not. */
  unavailable?: string;
  /** Budget Capability: this Runtime enforces a money limit on a child. */
  budget: boolean;
  /** The user agreed this Runtime may be handed work from another provider. */
  fanOut: boolean;
  models?: Array<{ id: string; label: string }>;
}

/** A live parent Session, as the Orchestrator needs to see it. */
export interface ParentSession {
  /** The Agent's own session id — what a Subagent records its parent as. */
  readonly sessionId: string;
  readonly runtimeId: string;
  /** Absolute working directory, and the repository a worktree comes from. */
  readonly cwd: string;
}

/** Everything the host needs in order to start one Subagent. */
export interface ChildLaunch {
  /** How the Orchestrator names this child. Also the handle the parent holds,
   *  and the key this child's own Shim would act under. */
  sessionKey: string;
  parentSessionKey: string;
  /** The parent's ACP session id, for the Subagent tree. */
  parentSessionId: string;
  depth: number;
  runtimeId: string;
  requestedModel?: string;
  requestedEffort?: string;
  cwd: string;
  /** Set only for a Runtime that can enforce it. */
  budgetUsd?: number;
  worktree?: { path: string; branch: string };
  /** Every Update this child's Agent sends. The host draws them; this reads the
   *  cost and the final message off them. */
  observe(notification: acp.SessionNotification): void;
}

/** The part of a Session the Orchestrator drives. `ConductorSession` is one. */
export interface ChildSession {
  readonly sessionId: string;
  readonly runtimeId: string;
  readonly modelSelection: EffectiveSelection;
  readonly effortSelection: EffectiveSelection;
  prompt(prompt: string | acp.ContentBlock[]): Promise<acp.PromptResponse>;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
}

/** Compile-time assertion: `Assert<false>` is a type error. */
type Assert<T extends true> = T;

/**
 * Asserted against the real class, so a `ConductorSession` that stopped offering
 * one of these fails the build here rather than at wiring time.
 */
export type SubagentsAreSessions = [Assert<ConductorSession extends ChildSession ? true : false>];

export interface WorktreeAllocator {
  allocate(request: { sessionKey: string; repository: string }): Promise<{
    path: string;
    branch: string;
  }>;
  /**
   * Gives back a worktree whose Subagent never started.
   *
   * Part of the port because only the Orchestrator knows when that happened: a
   * checkout allocated for a Session that was then refused is a directory, a
   * branch and a journal entry that no row will ever name, and therefore one
   * nothing else could ever reach.
   */
  release(path: string): Promise<{ removed: boolean; reason?: string }>;
}

export interface OrchestratorPorts {
  limits(): OrchestrationLimits;
  runtimes(): Promise<SubagentRuntime[]>;
  openChild(launch: ChildLaunch): Promise<ChildSession>;
  worktrees?: WorktreeAllocator;
  clock?: ClockPort;
  log?: LogPort;
  /** Names one child. Injectable so a handle is readable in a test. */
  newKey?(): string;
}

export interface Orchestrator {
  /** The handler the orchestration socket calls. */
  handle: OrchestrationHandler;
  /** This window is running that Session; calls under its key may proceed. */
  attach(sessionKey: string, parent: ParentSession): void;
  /** That Session ended: cancel everything below it, and forget it. */
  release(sessionKey: string): Promise<void>;
  /** Ends every Subagent still running. Nothing may spawn afterwards. */
  dispose(): Promise<void>;
}

interface Child {
  handle: string;
  parentKey: string;
  runtimeId: string;
  worktree?: { path: string; branch: string };
  state: SubagentState;
  session?: ChildSession;
  /** Set by the timer, so a cancel it caused is not read as the user's. */
  timedOut: boolean;
  /** Set by a cancel, so a Turn that ends because of it says so. */
  cancelled: boolean;
  finished: Promise<SubagentResult>;
}

export function createOrchestrator(ports: OrchestratorPorts): Orchestrator {
  const clock = ports.clock ?? systemClock;
  const parents = new Map<string, ParentSession>();
  const children = new Map<string, Child>();
  /** Spawns this parent has made, ever — including the ones that failed. */
  const spawned = new Map<string, number>();
  const semaphore = createSemaphore(() => ports.limits().maxConcurrentSubagents);
  let stopped = false;
  // Unique across windows, not merely within one. Two windows share one worktree
  // root and one journal, and a per-window counter would have both name their
  // first Subagent the same thing — the same directory, and the same branch.
  const newKey = ports.newKey ?? (() => randomUUID());

  /** Throws unless that parent is still one this window is running. */
  function stillRunning(sessionKey: string): void {
    if (stopped) throw new Error("agent conductor is shutting down; no subagent can be started");
    if (!parents.has(sessionKey)) throw new Error("the parent session is no longer active");
  }

  function parentOf(call: OrchestrationCall): ParentSession {
    const parent = parents.get(call.grant.sessionId);
    // Authority outlives nothing. A capability is retired when its Session ends,
    // but a frame already read can still be in flight when that happens.
    if (!parent) throw new Error("the parent session is no longer active");
    return parent;
  }

  /** A child of this capability, or nothing this capability may see. */
  function childOf(call: OrchestrationCall, handle: string): Child {
    const child = children.get(handle);
    // Deliberately the same answer as a handle that never existed: a Shim that
    // guessed one must not be told that its guess named something real.
    if (!child || child.parentKey !== call.grant.sessionId) {
      throw new Error(`no such subagent: ${handle}`);
    }
    return child;
  }

  /** Which Runtime a Brief means, and whether it may be handed this work. */
  async function target(parent: ParentSession, asked?: string): Promise<SubagentRuntime> {
    const limits = ports.limits();
    const wanted = asked ?? limits.defaultRuntimeId ?? parent.runtimeId;
    const runtime = (await ports.runtimes()).find((entry) => entry.id === wanted);
    if (!runtime) throw new Error(`no runtime "${wanted}" is configured`);
    if (!runtime.available) {
      throw new Error(`runtime ${runtime.id} cannot be launched: ${runtime.unavailable ?? "unavailable"}`);
    }
    const refusal = fanOutRefusal(runtime, parent.runtimeId);
    if (refusal) throw new Error(refusal);
    return runtime;
  }

  async function spawn(call: OrchestrationCall & { method: "spawn_subagent" }): Promise<unknown> {
    if (stopped) throw new Error("agent conductor is shutting down; no subagent can be started");
    const parent = parentOf(call);
    const limits = ports.limits();
    const { grant, params } = call;
    // The same rule the Shim's absence already enforces, said again where the
    // call arrives: injection is the guard, this is the proof it was not bypassed.
    if (grant.depth >= limits.maxSpawnDepth) {
      throw new Error(`this session is at the spawn depth cap (${limits.maxSpawnDepth})`);
    }
    // Read and reserved with nothing awaited in between. Two calls that arrived
    // in one read are two handlers running in one turn of the loop: if the count
    // were read before an await and written after, both would see the same
    // number and both would pass a limit that only one of them fits inside.
    const files = params.files ?? [];
    for (const file of files) {
      // ACP already made it absolute; which roots it may be inside is ours.
      // Checked before the count is spent, because it costs no await and a
      // malformed brief should not use up a session's delegation.
      if (!within(file, grant.roots)) {
        throw new Error(`"${file}" is outside this session's roots`);
      }
    }
    const used = spawned.get(grant.sessionId) ?? 0;
    if (used >= limits.maxSubagentsPerSession) {
      throw new Error(
        `this session has already spawned ${used} subagents, which is all it may spawn`,
      );
    }
    spawned.set(grant.sessionId, used + 1);
    const runtime = await target(parent, params.runtime);
    const handle = newKey();
    const timeoutMs = Math.min(params.timeout_ms ?? limits.defaultTimeoutMs, limits.maxTimeoutMs);
    const isolation = params.isolation ?? limits.isolation;
    const budgetUsd = Math.min(params.budget_usd ?? limits.budgetUsdPerSubagent, limits.budgetUsdPerSubagent);

    const release = await semaphore.acquire();
    let child: Child | undefined;
    let allocated: { path: string; branch: string } | undefined;
    try {
      // Re-read after the wait. A spawn queues behind the semaphore for as long
      // as the Subagents ahead of it take, and its parent can end in that time —
      // a child started for a parent that is gone is an Agent process nobody
      // owns, because what would have cancelled it has already run.
      stillRunning(grant.sessionId);
      const worktree =
        isolation === "worktree" && ports.worktrees
          ? await ports.worktrees.allocate({ sessionKey: handle, repository: parent.cwd })
          : undefined;
      allocated = worktree;
      child = {
        handle,
        parentKey: grant.sessionId,
        runtimeId: runtime.id,
        ...(worktree ? { worktree } : {}),
        state: "running",
        timedOut: false,
        cancelled: false,
        finished: Promise.resolve() as unknown as Promise<SubagentResult>,
      };
      const watch = watcher();
      const session = await ports.openChild({
        sessionKey: handle,
        parentSessionKey: grant.sessionId,
        parentSessionId: parent.sessionId,
        depth: grant.depth + 1,
        runtimeId: runtime.id,
        ...(params.model ?? limits.defaultModel
          ? { requestedModel: params.model ?? limits.defaultModel }
          : {}),
        ...(params.effort ?? limits.defaultEffort
          ? { requestedEffort: params.effort ?? limits.defaultEffort }
          : {}),
        cwd: worktree?.path ?? parent.cwd,
        // Forwarded only where it would be enforced. Sending a limit to a
        // Runtime that ignores it is a number that reads as a guarantee.
        ...(runtime.budget ? { budgetUsd } : {}),
        ...(worktree ? { worktree } : {}),
        observe: watch.observe,
      });
      // And again, because starting an Agent is the slowest thing here and the
      // window it opens is the whole of it. Nothing is awaited between this and
      // the registration below, so a teardown that has already taken its
      // snapshot of the tree cannot miss what is being added to it.
      try {
        stillRunning(grant.sessionId);
      } catch (error) {
        await session.dispose();
        throw error;
      }
      child.session = session;
      children.set(handle, child);
      child.finished = runTurn(child, session, watch, brief(params.brief, files), timeoutMs, runtime)
        .finally(release);
    } catch (error) {
      release();
      // A checkout made for a Subagent that never started. Nothing will ever
      // draw a row for it, so this is the only moment anything can give it back
      // — and it is fresh, so the refusal that protects uncommitted work has
      // nothing to protect here.
      if (allocated && !children.has(handle)) {
        // Never allowed to throw: this is cleanup on a path that already has a
        // reason, and a failure here would replace the one the caller needs with
        // one about a worktree they never asked for.
        const given = await ports.worktrees
          ?.release(allocated.path)
          .catch((failure: unknown) => ({ removed: false, reason: message(failure) }));
        if (given && !given.removed) {
          ports.log?.log(
            "error",
            `the worktree at ${allocated.path} was left behind: ${given.reason ?? "it could not be removed"}`,
          );
        }
      }
      throw error;
    }
    if (params.mode === "background") {
      // Nothing waits on it here, so a rejection must not be one nobody caught.
      void child.finished.catch(() => undefined);
      return { handle, state: "running" as const };
    }
    return child.finished;
  }

  async function runTurn(
    child: Child,
    session: ChildSession,
    watch: Watcher,
    prompt: string,
    timeoutMs: number,
    runtime: SubagentRuntime,
  ): Promise<SubagentResult> {
    const stop = clock.after(timeoutMs, () => {
      child.timedOut = true;
      ports.log?.log("error", `subagent ${child.handle}: no result within ${timeoutMs}ms — cancelling it`);
      void session.cancel();
    });
    let stopReason: string | undefined;
    let error: string | undefined;
    try {
      stopReason = (await session.prompt(prompt)).stopReason;
    } catch (failure) {
      error = message(failure);
    } finally {
      stop();
      // One process per Session: the child's ends with the child, whatever
      // happened to its Turn (ADR-0008).
      await session.dispose();
    }
    child.state = child.timedOut
      ? "timed_out"
      : child.cancelled || stopReason === "cancelled"
        ? "cancelled"
        : error !== undefined
          ? "failed"
          : "done";
    return {
      handle: child.handle,
      runtime: runtime.id,
      sessionId: session.sessionId,
      state: child.state,
      ...(stopReason ? { stopReason } : {}),
      ...(watch.text() ? { text: watch.text() } : {}),
      model: session.modelSelection,
      effort: session.effortSelection,
      cost: watch.cost() ?? "unknown",
      budget: runtime.budget ? "enforced" : "unenforced",
      ...(child.worktree ? { worktree: child.worktree } : {}),
      ...(error === undefined ? {} : { error }),
    };
  }

  /** Ends one Subagent, and everything it started, before itself. */
  async function cancelChild(child: Child): Promise<void> {
    child.cancelled = true;
    await release(child.handle);
    await child.session?.cancel();
    await child.session?.dispose();
    // Waited for, because a cancel that has not finished is a Subagent whose
    // state is still whatever it was — so a caller told "cancelled" and a caller
    // asking for the result would otherwise be given two different answers about
    // one handle. Disposal has already taken the process down, so this settles.
    await child.finished.catch(() => undefined);
  }

  async function release(sessionKey: string): Promise<void> {
    parents.delete(sessionKey);
    spawned.delete(sessionKey);
    const below = [...children.values()].filter((child) => child.parentKey === sessionKey);
    for (const child of below) {
      children.delete(child.handle);
      await cancelChild(child);
    }
  }

  const handle: OrchestrationHandler = async (call) => {
    switch (call.method) {
      case "list_runtimes": {
        const parent = parentOf(call);
        return {
          runtimes: (await ports.runtimes()).map((runtime) => {
            const refusal = runtime.available
              ? fanOutRefusal(runtime, parent.runtimeId)
              : `${runtime.id} cannot be launched: ${runtime.unavailable ?? "unavailable"}`;
            return {
              id: runtime.id,
              name: runtime.displayName,
              spawnable: refusal === undefined,
              ...(refusal ? { reason: refusal } : {}),
              budget: runtime.budget,
              ...(runtime.models ? { models: runtime.models } : {}),
            };
          }),
        };
      }
      case "spawn_subagent":
        return spawn(call);
      case "check_subagent": {
        parentOf(call);
        const child = childOf(call, call.params.handle);
        return { handle: child.handle, state: child.state, done: child.state !== "running" };
      }
      case "subagent_result": {
        parentOf(call);
        return childOf(call, call.params.handle).finished;
      }
      case "cancel_subagent": {
        parentOf(call);
        const child = childOf(call, call.params.handle);
        // Kept, not forgotten: a parent that cancels a Subagent still asks what
        // became of it, and a handle that stopped answering reads as one that
        // never existed.
        await cancelChild(child);
        // What became of it, not what was asked of it: a Subagent that had
        // already finished is `done`, and saying otherwise would have the two
        // answers about one handle disagree.
        return { handle: child.handle, state: child.state };
      }
    }
  };

  return {
    handle,
    attach(sessionKey, parent) {
      if (stopped) return;
      parents.set(sessionKey, parent);
    },
    release,
    async dispose() {
      stopped = true;
      for (const key of [...parents.keys()]) await release(key);
      for (const child of [...children.values()]) {
        children.delete(child.handle);
        await cancelChild(child);
      }
    },
  };
}
