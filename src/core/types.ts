import type * as acp from "@agentclientprotocol/sdk";

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

export interface RuntimeSpec {
  id: string;
  displayName: string;
  launch: LaunchSpec;
  /** Command the wizard opens in a terminal when the agent reports auth is required. */
  loginCommand?: string;
  detection: { binaries: string[]; versionArgs: string[] };
  /** Fallback picker source when the agent exposes no configOptions. */
  modelCatalog?: ModelHint[];
  quirks: RuntimeQuirks;
  /** Builds the `_meta` object for `session/new` (per-session policy channel). */
  sessionMeta?: (policy: SessionPolicy) => Record<string, unknown> | undefined;
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
