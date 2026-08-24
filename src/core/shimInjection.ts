/**
 * Whether one Session's Agent gets the Shim, and the Session Capability that
 * goes with it (ADR-0004, ADR-0008).
 *
 * Its own module because it is the recursion guard and nothing else. The Depth
 * Cap does not work by refusing a call that arrives; it works by there being no
 * tool to call — a Session at the cap is started with no orchestration server
 * in its `mcpServers` at all, so the Agent below it has no way to ask.
 *
 * Every condition fails closed, and each one alone is enough to refuse: a
 * Runtime whose trust no longer holds, one whose Suppression Plan has not been
 * shown to work here, orchestration switched off, or a Session already at the
 * cap. That ordering matters more than it looks — injecting the Shim beside a
 * CLI's own working `spawn_agent` is delegation that never passes our policy,
 * which is the whole thing the Suppression Capability exists to prevent.
 */
import { isAbsolute } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { ORCHESTRATION_METHODS, type SessionCapability } from "./ipcProtocol.js";
import type { OrchestrationServer } from "./ipc.js";

/**
 * The name the Shim is injected under.
 *
 * Part of what an Agent fingerprints a Session by — `mcpServers` is sorted by
 * name for exactly that reason — so it is a constant rather than a string each
 * caller spells for itself.
 */
export const SHIM_SERVER_NAME = "orchestrator";

/**
 * The variable the Session Capability reaches the Shim through.
 *
 * The Shim keeps its own copy, because it is bundled apart from the core and
 * imports nothing from it; a test is what holds the two together.
 */
export const SHIM_SECRET_VARIABLE = "AGENT_CONDUCTOR_SESSION_SECRET";

/** How long a Session Capability lives when nothing says otherwise. */
export const DEFAULT_CAPABILITY_LIFETIME_MS = 12 * 60 * 60 * 1_000;

/** How the Shim is started, before the socket it is told to use. */
export interface ShimLaunch {
  /** Absolute path of the bundled Shim, and anything before it. */
  args: string[];
  /**
   * What the interpreter itself needs, beside the Session Capability.
   *
   * The Shim is started by the *Agent*, from this entry, with an environment the
   * Agent composes — a small default set is what MCP clients hand a stdio server
   * — so nothing this side's own environment holds reaches it. Anything the
   * command depends on has to travel here or not at all.
   *
   * It can never carry the capability: an entry naming that variable is dropped
   * rather than ordered around, because a list with two entries of one name is
   * resolved by whoever reads it.
   */
  env?: Record<string, string>;
}

/**
 * Everything that has to hold before a Session may delegate.
 *
 * Separate from the request below because the answer is needed before the
 * orchestration socket exists: while orchestration is off there is to be no
 * socket at all, so what decides eligibility cannot be something that needs one
 * (ADR-0008).
 */
export interface ShimConditions {
  /** `orchestration.enabled`. Orchestration is off until turned on (ADR-0008). */
  enabled: boolean;
  /** Where the Session being started sits in the spawn tree. A root is 0. */
  depth: number;
  /** The Depth Cap: `orchestration.maxSpawnDepth`. */
  maxSpawnDepth: number;
  /** Runtime Trust holds, re-derived for the identity about to be launched. */
  trusted: boolean;
  /** A current Suppression Capability for that exact identity, in this workspace. */
  suppressionVerified: boolean;
  /** Absolute interpreter the Shim would be started with. */
  command: string;
}

/**
 * Why this Session may not delegate, or nothing.
 *
 * Each condition alone is enough to refuse, and the order is the order they
 * cost: nothing here reads a file, starts a process, or mints anything.
 */
export function shimRefusal(conditions: ShimConditions): string | undefined {
  if (!conditions.enabled) return "orchestration is switched off";
  if (!conditions.trusted) return "this runtime's trust does not hold";
  if (!conditions.suppressionVerified) return "this runtime has no current suppression capability";
  // `>=`, not `>`: a Session at the cap would spawn children beyond it.
  if (conditions.depth >= conditions.maxSpawnDepth) {
    return `this session is at the spawn depth cap (${conditions.maxSpawnDepth})`;
  }
  if (!isAbsolute(conditions.command)) {
    return `the shim interpreter must be absolute, got "${conditions.command}"`;
  }
  return undefined;
}

export interface ShimInjectionRequest extends ShimConditions {
  /**
   * How the issuer names the Session this Shim acts for.
   *
   * Minted here rather than taken from the Agent: `mcpServers` goes out *in*
   * `session/new`, so at this moment the Agent has not yet chosen a session id.
   * Everything this key is checked against lives on this side.
   */
  sessionKey: string;
  /** The Session that spawned this one, when it is itself a Subagent. */
  parentSessionKey?: string;
  /** Absolute roots this Session runs against. */
  roots: readonly string[];
  /** Mints the Session Capability, and refuses a grant it could not enforce. */
  issuer: Pick<OrchestrationServer, "address" | "issue">;
  launch: ShimLaunch;
  now(): number;
  lifetimeMs?: number;
}

export interface ShimInjection {
  /** What to add to this Session's `mcpServers`. Empty when it may not delegate. */
  servers: acp.McpServer[];
  /** Withdraws the capability. Idempotent, and safe on a refused injection. */
  revoke(): void;
  /** Why nothing was injected, for the log. Absent when the Shim was injected. */
  refused?: string;
}

const REFUSED = (reason: string): ShimInjection => ({
  servers: [],
  revoke: () => undefined,
  refused: reason,
});

/**
 * Decides whether this Session may delegate, and mints its authority if it may.
 *
 * Nothing is minted for a Session that is refused. A capability issued "just in
 * case" is authority standing in a table that only a Shim we never injected
 * could present — spent on nothing, and one more entry every handshake is
 * compared against.
 */
export function injectShim(request: ShimInjectionRequest): ShimInjection {
  const refusal = shimRefusal(request);
  if (refusal) return REFUSED(refusal);

  const grant: SessionCapability = {
    sessionId: request.sessionKey,
    ...(request.parentSessionKey ? { parentSessionId: request.parentSessionKey } : {}),
    depth: request.depth,
    roots: [...request.roots],
    expiresAtMs: request.now() + (request.lifetimeMs ?? DEFAULT_CAPABILITY_LIFETIME_MS),
    methods: [...ORCHESTRATION_METHODS],
  };
  const capability = request.issuer.issue(grant);
  return {
    servers: [
      {
        // No `type`: in ACP v1 stdio is the untagged member of the union, and a
        // tag the schema does not know is a server an Agent may simply drop.
        name: SHIM_SERVER_NAME,
        command: request.command,
        args: [...request.launch.args, "--socket", request.issuer.address],
        // Never argv: `ps` and `/proc/<pid>/cmdline` are readable by any local
        // process, and a secret anyone can read authenticates anyone.
        //
        // The capability variable appears exactly once, whatever the launch
        // environment holds. Which of two entries sharing a name reaches the
        // process is the *Agent's* decision — ACP describes a list, not a map —
        // so putting ours last would be a rule enforced in somebody else's code.
        env: [
          ...Object.entries(request.launch.env ?? {})
            .filter(([name]) => name !== SHIM_SECRET_VARIABLE)
            .map(([name, value]) => ({ name, value })),
          { name: SHIM_SECRET_VARIABLE, value: capability.secret },
        ],
      },
    ],
    revoke: () => capability.revoke(),
  };
}
