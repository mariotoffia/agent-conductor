import { isAbsolute } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import {
  connectAgent,
  DEFAULT_SETUP_TIMEOUT_MS,
  exitError,
  message,
  stageError,
  systemClock,
  tailOf,
  withDeadline,
  type AgentConnection,
} from "./acpClient.js";
import type { AgentExit, ClockPort, LaunchSpec, LogLevel, SessionPorts } from "./types.js";

/** Lifecycle of one Session. A Session never leaves `disposed` or `failed`. */
export type SessionState = "idle" | "prompting" | "cancelling" | "failed" | "disposed";

/** How long a cancelled turn may keep running before its process is terminated. */
export const DEFAULT_CANCEL_GRACE_MS = 5_000;
/**
 * How long a Turn may go without any Agent activity before the Client ends it.
 * Generous on purpose: an Agent running a long tool inside its own harness is
 * silent on the wire, and ending such a Turn early would destroy real work.
 */
export const DEFAULT_STALL_TIMEOUT_MS = 600_000;

export interface SessionSpec {
  /** Runtime identity, used in logs and failure messages. */
  runtimeId: string;
  /** Resolved absolute command, arguments, and catalog policy environment. */
  launch: LaunchSpec;
  /** Absolute session working directory. */
  cwd: string;
  /** Values resolved from SecretStorage by the UI adapter. Never logged. */
  secretEnvironment?: Record<string, string>;
  /** Extra absolute roots; sent only when the Agent advertises support. */
  additionalDirectories?: string[];
  /** Re-sent verbatim on load; always ordered by name before it goes out. */
  mcpServers?: acp.McpServer[];
  /** Per-session policy channel, e.g. a Suppression Plan (ADR-0004). */
  sessionMeta?: Record<string, unknown>;
  cancelGraceMs?: number;
  /** Deadline for the handshake and for creating or loading the session. */
  setupTimeoutMs?: number;
  /** Silence allowed within a Turn before it is ended; `0` disables the limit. */
  stallTimeoutMs?: number;
  clientVersion?: string;
  /** Every Update the Agent sends, including any whose `sessionId` is not ours. */
  onUpdate?: (notification: acp.SessionNotification) => void;
}

/**
 * One ACP session on one Agent process (ADR-0008).
 *
 * The Session owns its subprocess for its whole life, so a cancellation that
 * escalates to termination — or an Agent crash — can only ever affect this
 * Session. Cancellation is two-layered: `session/cancel`, then the process.
 */
export class ConductorSession {
  readonly #spec: SessionSpec;
  readonly #ports: SessionPorts;
  readonly #clock: ClockPort;
  #connection?: AgentConnection;
  #sessionId = "";
  #configOptions: acp.SessionConfigOption[] = [];
  #state: SessionState = "idle";
  #cancelRequested = false;
  #clearCancelGrace?: () => void;
  #clearStallLimit?: () => void;
  #stalled = false;
  /** Answers the Agent is waiting on, counted for `#turn` only. */
  #owedAnswers = 0;
  /**
   * Turn counter used to attribute owed answers. A request the Agent never waits
   * for would otherwise outlive its Turn: releasing it late must not unpause a
   * later Turn, and leaving it open must not silence one either.
   */
  #turn = 0;
  #exit?: AgentExit;
  #disposal?: Promise<void>;

  private constructor(spec: SessionSpec, ports: SessionPorts) {
    this.#spec = spec;
    this.#ports = ports;
    this.#clock = ports.clock ?? systemClock;
  }

  /** Spawns the Agent and creates a new session (`session/new`). */
  static async open(spec: SessionSpec, ports: SessionPorts = {}): Promise<ConductorSession> {
    const session = new ConductorSession(spec, ports);
    await session.#start();
    return session;
  }

  /**
   * Spawns the Agent and reattaches to a previous session (`session/load`) —
   * ACP's separate `session/resume` method is not used.
   * MCP servers are always re-sent; supported additional roots are re-sent too.
   * Fails closed when the Agent does not advertise `loadSession`.
   */
  static async load(
    spec: SessionSpec & { sessionId: string },
    ports: SessionPorts = {},
  ): Promise<ConductorSession> {
    const session = new ConductorSession(spec, ports);
    await session.#start(spec.sessionId);
    return session;
  }

  get runtimeId(): string {
    return this.#spec.runtimeId;
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  get state(): SessionState {
    return this.#state;
  }

  /** Result of the ACP handshake: capabilities, auth methods, Agent identity. */
  get handshake(): acp.InitializeResponse {
    return this.#requireConnection().handshake;
  }

  /** Latest complete Config Option array reported by the Agent (ADR-0005). */
  get configOptions(): acp.SessionConfigOption[] {
    return this.#configOptions;
  }

  get pid(): number | undefined {
    return this.#connection?.pid;
  }

  /** Resolves when this Session's Agent process is gone. */
  get exited(): Promise<AgentExit> {
    return this.#connection?.exited ?? Promise.resolve({ code: null, signal: null });
  }

  /** Runs one turn. Returns the Agent's stop reason, or `cancelled` if we ended it. */
  async prompt(prompt: string | acp.ContentBlock[]): Promise<acp.PromptResponse> {
    const connection = this.#requireConnection();
    if (this.#state !== "idle") {
      throw new Error(`session ${this.#sessionId} is ${this.#state}; it cannot start a turn`);
    }
    this.#state = "prompting";
    this.#cancelRequested = false;
    this.#stalled = false;
    this.#turn += 1;
    this.#owedAnswers = 0;
    this.#restartStallLimit();
    try {
      const response = await connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId: this.#sessionId,
        prompt: typeof prompt === "string" ? [{ type: "text", text: prompt }] : prompt,
      });
      if (this.#stalled) throw this.#stallError();
      return response;
    } catch (error) {
      // The stall is the reason the turn ended, whatever the Agent said after.
      if (this.#stalled) throw this.#stallError();
      const lost = Boolean(this.#exit) || this.#requireConnection().closed.aborted;
      // A cancel answers `cancelled` — including when we terminated the process
      // ourselves. An Agent that died on its own is a failure that must keep its
      // exit status, even when a cancel happened to be in flight.
      if (this.#cancelRequested && (!lost || this.#isDisposed())) {
        // Keep whatever the Agent said about the turn it never finished.
        this.#log("debug", `session ${this.#sessionId}: cancelled turn ended with: ${message(error)}`);
        return { stopReason: "cancelled" };
      }
      // An Agent may refuse one turn and stay usable; only a lost connection or
      // process ends the Session, and a deliberate teardown is not a failure.
      if (lost && !this.#isDisposed()) this.#state = "failed";
      throw this.#turnError(error);
    } finally {
      this.#clearGrace();
      this.#clearStall();
      if (this.#inTurn()) this.#state = "idle";
    }
  }

  /**
   * Cancels the active turn: sends `session/cancel`, then terminates only this
   * Session's process if the Agent has not stopped within the grace period.
   */
  async cancel(): Promise<void> {
    if (this.#state !== "prompting") return;
    const connection = this.#requireConnection();
    this.#state = "cancelling";
    this.#cancelRequested = true;
    // From here the grace timer governs the turn, not the stall limit.
    this.#clearStall();
    try {
      await connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: this.#sessionId });
    } catch (error) {
      this.#log("debug", `session ${this.#sessionId}: cancel notification failed: ${message(error)}`);
    }
    // The turn can end while the notification is still being written; a timer
    // armed after that would terminate a healthy Session during a later turn.
    if (this.#state !== "cancelling") return;
    const graceMs = this.#spec.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
    this.#clearGrace();
    this.#clearCancelGrace = this.#clock.after(graceMs, () => {
      // The clock is an injected port: never terminate on a timer that should
      // have been cancelled.
      if (this.#state !== "cancelling") return;
      this.#log(
        "error",
        `session ${this.#sessionId}: agent ignored cancel for ${graceMs}ms — terminating its process`,
      );
      void this.dispose();
    });
  }

  /** Closes the connection and terminates this Session's process. Idempotent. */
  dispose(): Promise<void> {
    this.#disposal ??= (async () => {
      this.#state = "disposed";
      this.#clearGrace();
      this.#clearStall();
      await this.#connection?.close();
    })();
    return this.#disposal;
  }

  async #start(sessionId?: string): Promise<void> {
    validateSessionSpec(this.#spec);
    this.#connection = await connectAgent({
      runtimeId: this.#spec.runtimeId,
      launch: this.#spec.launch,
      cwd: this.#spec.cwd,
      secretEnvironment: this.#spec.secretEnvironment,
      clientVersion: this.#spec.clientVersion,
      ports: this.#ports,
      setupTimeoutMs: this.#spec.setupTimeoutMs,
      onAgentServing: () => {
        const turn = this.#turn;
        this.#owedAnswers += 1;
        this.#restartStallLimit();
        return () => {
          if (turn !== this.#turn) return; // the Turn that asked is over
          this.#owedAnswers -= 1;
          this.#restartStallLimit();
        };
      },
      onSessionUpdate: (notification) => this.#handleUpdate(notification),
      turnCancelled: () => this.#cancelRequested,
    });
    void this.#connection.exited.then((exit) => {
      this.#exit = exit;
      if (this.#state === "disposed") return;
      this.#log("error", `session ${this.#sessionId}: agent process ended unexpectedly`);
      if (this.#state === "idle") this.#state = "failed";
    });
    try {
      await (sessionId === undefined ? this.#createSession() : this.#loadSession(sessionId));
    } catch (error) {
      await this.dispose();
      // Disposal has reaped the process, so its exit status is known by now and
      // belongs in the failure alongside whatever went wrong.
      throw stageError(
        this.#spec.runtimeId,
        "session setup",
        error,
        this.#exit,
        this.#connection?.stderrTail() ?? "",
      );
    }
  }

  async #createSession(): Promise<void> {
    const response = await this.#withinSetup(
      this.#requireConnection().agent.request(acp.methods.agent.session.new, {
        cwd: this.#spec.cwd,
        mcpServers: sortMcpServers(this.#spec.mcpServers),
        ...this.#directories(),
        ...(this.#spec.sessionMeta ? { _meta: this.#spec.sessionMeta } : {}),
      }),
      "session/new",
    );
    this.#sessionId = response.sessionId;
    this.#configOptions = response.configOptions ?? [];
  }

  async #loadSession(sessionId: string): Promise<void> {
    const connection = this.#requireConnection();
    if (!connection.handshake.agentCapabilities?.loadSession) {
      throw new Error("agent does not support session/load");
    }
    this.#sessionId = sessionId;
    const response = await this.#withinSetup(
      connection.agent.request(acp.methods.agent.session.load, {
        sessionId,
        cwd: this.#spec.cwd,
        // Always re-sent: agents do not recover MCP servers on their own.
        mcpServers: sortMcpServers(this.#spec.mcpServers),
        ...this.#directories(),
        ...(this.#spec.sessionMeta ? { _meta: this.#spec.sessionMeta } : {}),
      }),
      "session/load",
    );
    this.#configOptions = response?.configOptions ?? [];
  }

  /** Bounds a setup request: a Runtime that never answers must not pend. */
  #withinSetup<T>(work: Promise<T>, method: string): Promise<T> {
    const ms = this.#spec.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS;
    return withDeadline(work, ms, this.#clock, () =>
      new Error(`agent did not answer ${method} within ${ms}ms`));
  }

  /** `additionalDirectories` goes out only when the Agent advertises support. */
  #directories(): { additionalDirectories?: string[] } {
    const directories = this.#spec.additionalDirectories ?? [];
    if (directories.length === 0) return {};
    const capabilities = this.#requireConnection().handshake.agentCapabilities;
    if (!capabilities?.sessionCapabilities?.additionalDirectories) {
      this.#log(
        "info",
        `runtime ${this.#spec.runtimeId}: agent does not support additionalDirectories —` +
          ` ${directories.length} root(s) omitted`,
      );
      return {};
    }
    return { additionalDirectories: [...directories] };
  }

  /**
   * Restarts the silence timer. A Turn only stalls on the Agent: time spent
   * waiting for an answer the Client owes it never counts against the limit.
   */
  #restartStallLimit(): void {
    this.#clearStall();
    const ms = this.#spec.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    if (ms <= 0 || this.#state !== "prompting" || this.#owedAnswers > 0) return;
    this.#clearStallLimit = this.#clock.after(ms, () => {
      if (this.#state !== "prompting") return;
      this.#stalled = true;
      this.#log(
        "error",
        `session ${this.#sessionId}: no agent activity for ${ms}ms — cancelling the turn`,
      );
      void this.cancel();
    });
  }

  #stallError(): Error {
    const ms = this.#spec.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    return new Error(
      `session ${this.#sessionId}: agent produced no output for ${ms}ms; the turn was ended`,
    );
  }

  #clearStall(): void {
    this.#clearStallLimit?.();
    this.#clearStallLimit = undefined;
  }

  #handleUpdate(notification: acp.SessionNotification): void {
    this.#restartStallLimit(); // the Agent is alive and working
    // One process serves one Session, so a foreign id means a confused Agent:
    // render what it sends, but never let it rewrite our verified selection.
    const ours = this.#sessionId === "" || notification.sessionId === this.#sessionId;
    // A complete refreshed array, prompted or not; always render the latest.
    if (ours && notification.update.sessionUpdate === "config_option_update") {
      this.#configOptions = notification.update.configOptions;
    }
    this.#spec.onUpdate?.(notification);
  }

  #turnError(error: unknown): Error {
    const connection = this.#requireConnection();
    if (this.#exit) return exitError(this.#spec.runtimeId, this.#exit, connection.stderrTail());
    // The exit event can trail the connection close, so the status may still be
    // unknown here. The Agent's own diagnostics are the useful part regardless.
    return new Error(
      `session ${this.#sessionId}: turn failed: ${message(error)}${tailOf(connection.stderrTail())}`,
      { cause: error },
    );
  }

  /** Read through a call so the compiler does not narrow away live mutations. */
  #inTurn(): boolean {
    return this.#state === "prompting" || this.#state === "cancelling";
  }

  #isDisposed(): boolean {
    return this.#state === "disposed";
  }

  #clearGrace(): void {
    this.#clearCancelGrace?.();
    this.#clearCancelGrace = undefined;
  }

  #requireConnection(): AgentConnection {
    if (!this.#connection) throw new Error(`runtime ${this.#spec.runtimeId}: session is not connected`);
    return this.#connection;
  }

  #log(level: LogLevel, text: string): void {
    this.#ports.log?.log(level, text);
  }
}

/** ACP requires absolute paths everywhere; reject before anything is spawned. */
export function validateSessionSpec(spec: SessionSpec): void {
  if (!isAbsolute(spec.cwd)) {
    throw new Error(`runtime ${spec.runtimeId}: session cwd must be absolute, got "${spec.cwd}"`);
  }
  for (const directory of spec.additionalDirectories ?? []) {
    if (!isAbsolute(directory)) {
      throw new Error(
        `runtime ${spec.runtimeId}: additional directory must be absolute, got "${directory}"`,
      );
    }
  }
  for (const server of spec.mcpServers ?? []) {
    if ("command" in server && !isAbsolute(server.command)) {
      throw new Error(
        `runtime ${spec.runtimeId}: mcp server "${server.name}" command must be absolute,` +
          ` got "${server.command}"`,
      );
    }
  }
}

/**
 * Orders MCP servers by name with a codepoint comparison — locale-aware sorting
 * would differ per machine, and agents fingerprint `(cwd, mcpServers)`.
 */
export function sortMcpServers(servers: acp.McpServer[] = []): acp.McpServer[] {
  return [...servers].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}
