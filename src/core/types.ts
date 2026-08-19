import type * as acp from "@agentclientprotocol/sdk";
import type { SuppressionEvidence, SuppressionPlan } from "./policy.js";

/** Reasoning-effort levels understood by the conductor. Agents may clamp —
 *  the effective value must always be read back (ADR-0005). */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface LaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface ModelHint {
  id: string;
  label: string;
  /** Effort levels this model accepts; undefined = model ignores effort. */
  efforts?: EffortLevel[];
}

export interface RuntimeQuirks {
  /** Model/effort/tool config can only be set at process start (codex, copilot). */
  processScopedConfig: boolean;
  /** Agent reports the effective model/effort so Read-back is possible. */
  effortReadback: boolean;
  /** Agent slash commands safe to surface (interactive TUI commands hang ACP). */
  slashCommandAllowlist: string[];
}

export interface SessionPolicy {
  suppressBuiltInSubagents: boolean;
}

/**
 * The npm package that provides an Adapter's executable. The Registry tracks its
 * version; installing it is an explicit wizard action, never something a Session
 * start may trigger — nothing here is ever handed to a package runner (ADR-0007).
 */
export interface AdapterPackage {
  /** Package name without a version. */
  package: string;
  /** Exact version — never a range, never a dist-tag. */
  version: string;
  /** Executable the package installs; looked up on PATH once installed. */
  bin: string;
}

export interface RuntimeSpec {
  id: string;
  displayName: string;
  launch: LaunchSpec;
  /** Command the wizard opens in a terminal when the agent reports auth is required. */
  loginCommand?: string;
  detection: { binaries: string[]; versionArgs: string[] };
  /** Effective per-session policy this entry was built with. Part of the launch
   *  identity: suppression rides in argv, env, and `_meta`, so a Runtime that
   *  suppresses nothing is not the Runtime the user approved (ADR-0008). */
  policy: SessionPolicy;
  /** Why this entry cannot launch, when something about it is already known to be
   *  wrong. Listed so the user can see it and told when resolved, rather than
   *  silently missing from the picker. */
  unavailable?: string;
  /** Id of this Runtime in the ACP Registry, when the Registry tracks it. */
  registryId?: string;
  /** Adapter package behind `launch.command`; absent for a native ACP CLI. */
  adapter?: AdapterPackage;
  /** User-defined Runtime: no built-in Suppression Plan, and no orchestration
   *  until the user supplies one and its effect is verified (ADR-0008). */
  custom?: boolean;
  /** Fallback picker source when the agent exposes no configOptions. */
  modelCatalog?: ModelHint[];
  quirks: RuntimeQuirks;
  /** The recipe that disables this Runtime's built-in delegation, when it has one
   *  and its policy asks for it. Absence is not a detail: a Runtime with no plan
   *  can never be eligible for Shim injection, because there is nothing whose
   *  effect could be verified (ADR-0008). */
  suppression?: SuppressionPlan;
}

/**
 * What the user approved for one Runtime, bound to one launch identity (ADR-0007).
 * Catalog membership grants nothing; a Runtime whose fingerprint no longer matches
 * is untrusted again, and the capabilities recorded against it lapse with it.
 */
export interface RuntimeTrust {
  /** Fingerprint of the canonical artifact plus effective launch specification. */
  fingerprint: string;
  /**
   * What a Probe Session observed for this exact fingerprint (ADR-0008).
   *
   * Deliberately the evidence rather than a verdict: a stored "verified" flag
   * would outlive the plan it was true of, and a settings file could simply
   * assert it. Eligibility is re-derived from this on every resolution, so a
   * plan that grows a delegation tool invalidates its own old evidence.
   */
  suppression?: SuppressionEvidence & {
    /** Absolute workspace the evidence was gathered in. Required by plans that
     *  suppress through a workspace file, written in one workspace and absent
     *  from the next. */
    workspace?: string;
  };
  /** Agent-enforced monetary child limits verified for this fingerprint. */
  budget?: boolean;
}

/** What a Runtime may take part in, once its trust fingerprint still matches. */
export interface RuntimeCapabilities {
  /** Catalog trait, not evidence: this Runtime is known to report effective values
   *  at all. A given selection is still only *verified* when the Agent reports it
   *  for that Session — this flag never stands in for a Read-back (ADR-0005). */
  readback: boolean;
  /** Shim injection is allowed: current trust, a plan, and evidence that still
   *  clears it in this workspace (ADR-0008). */
  suppression: boolean;
  /** Agent-side monetary limits are enforceable. Local limits apply regardless. */
  budget: boolean;
}

/**
 * A Runtime whose command has been resolved to a real executable and measured
 * against the trust the user granted. Producing one spawns nothing: it is what the
 * wizard shows for approval and what `trustedLaunch` gates before a spawn.
 */
export interface ResolvedRuntime {
  id: string;
  displayName: string;
  /** Absolute, canonical command with the catalog policy environment. Shown to the
   *  user while approving; pass it to a Session only through `trustedLaunch`. */
  launch: LaunchSpec;
  quirks: RuntimeQuirks;
  /** Per-session policy this Runtime was approved under. Carried so nothing
   *  downstream can spawn under a policy the fingerprint never covered. */
  policy: SessionPolicy;
  /** `session/new` `_meta`, already built from `policy` — a value rather than a
   *  function, so no caller can apply a policy other than the approved one. */
  sessionMeta?: Record<string, unknown>;
  custom: boolean;
  /** Identity the user approves once and the Client re-verifies before every spawn. */
  fingerprint: string;
  trusted: boolean;
  /** The fingerprint covers the artifact's content, not merely its path. False
   *  means an in-place replacement at the same path would go unnoticed, so a host
   *  that wants ADR-0007's artifact binding must supply a digest. */
  artifactVerified: boolean;
  capabilities: RuntimeCapabilities;
}

// ---------------------------------------------------------------------------
// Client ports. The core is vscode-free (ADR-0003): everything the ACP client
// needs from its host arrives through these narrow interfaces, so a Session can
// run under plain Node in tests and under VS Code in production. Each port maps
// to one ACP surface; a missing port means that capability is not advertised.
// ---------------------------------------------------------------------------

/** Severity of a log record. The `off` logging setting drops the port instead. */
export type LogLevel = "error" | "info" | "debug" | "trace";

export interface LogPort {
  log(level: LogLevel, message: string): void;
}

/** Injectable timers so the cancellation grace period is deterministic. */
export interface ClockPort {
  /** Runs `run` after `ms`; the returned function cancels it. */
  after(ms: number, run: () => void): () => void;
}

/** Everything needed to start an Agent process. Never carries a shell. */
export interface SpawnRequest {
  /** Absolute path to the executable — resolved and validated by the caller. */
  command: string;
  args: string[];
  /** Complete environment for the child; the port adds nothing of its own. */
  env: Record<string, string>;
  cwd: string;
}

export interface AgentExit {
  code: number | null;
  signal: string | null;
  /** Set when the process could not be spawned at all. */
  error?: Error;
}

export interface AgentProcess {
  readonly pid?: number;
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  /** Agent diagnostics; never ACP traffic. */
  onStderr(handler: (chunk: string) => void): void;
  readonly exited: Promise<AgentExit>;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
}

export interface ProcessPort {
  spawn(request: SpawnRequest): AgentProcess;
}

export interface ResolvedExecutable {
  /** Absolute path with symlinks resolved: the file that would actually run. */
  path: string;
  /** Digest of that file, when the host can compute one. Absent is not a failure —
   *  it narrows Runtime Trust to the path, which still fails closed on a move. */
  digest?: string;
}

/** Finds the executable a command name would run. Never executes it. */
export interface ExecutablePort {
  /**
   * PATH lookup for a bare name, existence check for an absolute path; `undefined`
   * when nothing executable is there.
   *
   * The result must be spawnable without a shell, because that is how every Agent
   * is started. On Windows that rules out returning a `.cmd`/`.bat` wrapper — Node
   * refuses those unless a shell is enabled, which is exactly what argv from
   * settings must never reach.
   */
  resolve(command: string): Promise<ResolvedExecutable | undefined>;
}

/** Durable key/value storage — VS Code global storage in production. */
export interface StoragePort {
  read(key: string): Promise<string | undefined>;
  /** Replaces the whole value atomically: a torn write must never be readable. */
  writeAtomic(key: string, value: string): Promise<void>;
}

/** Answers `session/request_permission`. Consent and audit, not a sandbox (ADR-0007). */
export interface PermissionPort {
  requestPermission(request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse>;
}

export interface FsPort {
  readTextFile(request: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse>;
  writeTextFile(request: acp.WriteTextFileRequest): Promise<void>;
}

export interface TerminalPort {
  createTerminal(request: acp.CreateTerminalRequest): Promise<acp.CreateTerminalResponse>;
  terminalOutput(request: acp.TerminalOutputRequest): Promise<acp.TerminalOutputResponse>;
  waitForTerminalExit(request: acp.WaitForTerminalExitRequest): Promise<acp.WaitForTerminalExitResponse>;
  killTerminal(request: acp.KillTerminalRequest): Promise<void>;
  releaseTerminal(request: acp.ReleaseTerminalRequest): Promise<void>;
}

export interface ElicitationPort {
  createElicitation(request: acp.CreateElicitationRequest): Promise<acp.CreateElicitationResponse>;
  /** The Agent withdrew an elicitation; close any open form. */
  completeElicitation(notification: acp.CompleteElicitationNotification): void;
}

/** Host services a Session may use. Absent ports are simply not advertised. */
export interface SessionPorts {
  process?: ProcessPort;
  clock?: ClockPort;
  log?: LogPort;
  permission?: PermissionPort;
  fs?: FsPort;
  terminal?: TerminalPort;
  elicitation?: ElicitationPort;
}

/**
 * A requested model or effort value beside the one the Agent reports as
 * effective. Agents clamp silently, so the two are tracked separately and the
 * effective value is only ever set on the Agent's own evidence (ADR-0005).
 */
export interface EffectiveSelection {
  requested?: string;
  effective?: string;
  verification: "verified" | "unavailable";
}
