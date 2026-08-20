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
import {
  asConfigOptions,
  discoverConfig,
  readBack,
  selectorSlot,
  type DiscoveredConfig,
} from "./discovery.js";
import { sortMcpServers, validateSessionSpec, type SessionSpec } from "./sessionSpec.js";
import type { AgentExit, ClockPort, EffectiveSelection, LogLevel, SessionPorts } from "./types.js";

/** Lifecycle of one Session. A Session never leaves `disposed` or `failed`. */
export type SessionState =
  | "idle"
  | "configuring"
  | "prompting"
  | "cancelling"
  | "failed"
  | "disposed";

/** How long a cancelled turn may keep running before its process is terminated. */
export const DEFAULT_CANCEL_GRACE_MS = 5_000;
/**
 * How long a Turn may go without any Agent activity before the Client ends it.
 * Generous on purpose: an Agent running a long tool inside its own harness is
 * silent on the wire, and ending such a Turn early would destroy real work.
 */
export const DEFAULT_STALL_TIMEOUT_MS = 600_000;

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
  #requestedModel?: string;
  #requestedEffort?: string;
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
    this.#requestedModel = spec.requestedModel;
    this.#requestedEffort = spec.requestedEffort;
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

  /**
   * Latest complete Config Option array reported by the Agent (ADR-0005).
   *
   * ponytail: handed out by reference. Harmless while only `config` and tests
   * read it — a caller that mutates or retains it would be our own code, not
   * the untrusted Agent this Session guards against. Copy on the way out once
   * view code consumes it directly.
   */
  get configOptions(): acp.SessionConfigOption[] {
    return this.#configOptions;
  }

  /** Those Config Options split into the pickers the conductor drives. */
  get config(): DiscoveredConfig {
    return discoverConfig(this.#configOptions);
  }

  /** What was asked for beside what the Agent reports running (ADR-0005). */
  get modelSelection(): EffectiveSelection {
    return readBack(this.config.model, this.#requestedModel);
  }

  get effortSelection(): EffectiveSelection {
    return readBack(this.config.effort, this.#requestedEffort);
  }

  /**
   * Sets one Config Option and adopts the complete array the Agent answers with.
   *
   * Only between Turns: a Runtime that applies the change to the Turn already in
   * flight would silently rewrite the configuration that Turn started under.
   * Boolean options are not settable — the Client does not advertise the boolean
   * Config Option capability, so it must not send boolean values either.
   */
  async setConfigOption(configId: string, value: string): Promise<DiscoveredConfig> {
    const connection = this.#requireConnection();
    if (this.#state !== "idle") {
      throw new Error(`session ${this.#sessionId} is ${this.#state}; it cannot set a config option`);
    }
    const target = this.#configOptions.find((option) => option.id === configId);
    if (!target) {
      throw new Error(`session ${this.#sessionId}: unknown config option "${configId}"`);
    }
    if (target.type !== "select") {
      throw new Error(
        `session ${this.#sessionId}: config option "${configId}" is not a select;` +
          " this client does not advertise boolean config options",
      );
    }
    // Read before the array is replaced: the refreshed one need not still carry
    // the option that was just set.
    const slot = selectorSlot(this.config, configId);
    // Busy for the whole exchange, so no Turn can start under a configuration
    // that is still being changed and no second set can race this one's answer.
    this.#state = "configuring";
    try {
      const response = await this.#bounded(
        connection.agent.request(acp.methods.agent.session.setConfigOption, {
          sessionId: this.#sessionId,
          configId,
          value,
        }),
        "session/set_config_option",
      );
      // Asking is not getting: the Agent may clamp, and Read-back shows both.
      if (slot === "model") this.#requestedModel = value;
      if (slot === "effort") this.#requestedEffort = value;
      // The Agent answers with the complete refreshed array; never merge into
      // the one it replaces (ADR-0005).
      if (!Array.isArray(response.configOptions)) {
        throw new Error(
          `session ${this.#sessionId}: agent answered session/set_config_option without config options`,
        );
      }
      this.#configOptions = asConfigOptions(response.configOptions);
      return this.config;
    } catch (error) {
      // An exchange that did not complete leaves the Agent's configuration
      // genuinely unknown: it may have applied the change, answered nothing
      // useful, or died. Keeping the array from before the request would let
      // Read-back go on calling a superseded value verified, so the Session
      // forgets it instead. The pickers survive on the catalog fallback.
      this.#configOptions = [];
      throw error;
    } finally {
      // Never over a state the exchange itself produced: the process can die,
      // or the Session be disposed, while the Agent is still deciding.
      if (this.#state === "configuring") this.#state = "idle";
    }
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
      try {
        await this.#connection?.close();
      } catch (error) {
        // A rejected disposal would be memoized here: every later teardown —
        // including the extension's own — would reject too, and the cancel-grace
        // timer calls this with nobody waiting on the promise. The Session is
        // gone either way; what went wrong belongs in the log, not in a throw.
        this.#log("error", `session ${this.#sessionId}: disposal failed: ${message(error)}`);
      }
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
      if (this.#state === "idle" || this.#state === "configuring") this.#state = "failed";
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
    const response = await this.#bounded(
      this.#requireConnection().agent.request(acp.methods.agent.session.new, {
        cwd: this.#spec.cwd,
        mcpServers: sortMcpServers(this.#spec.mcpServers),
        ...this.#directories(),
        ...(this.#spec.sessionMeta ? { _meta: this.#spec.sessionMeta } : {}),
      }),
      "session/new",
    );
    // The SDK schema-checks the notifications a Client receives, not the answers
    // to the requests it sends. Everything this Session does is addressed by this
    // id, so it is checked rather than assumed (ADR-0007).
    if (typeof response.sessionId !== "string" || response.sessionId === "") {
      throw new Error("agent answered session/new without a session id");
    }
    this.#sessionId = response.sessionId;
    this.#configOptions = asConfigOptions(response.configOptions);
  }

  async #loadSession(sessionId: string): Promise<void> {
    const connection = this.#requireConnection();
    if (!connection.handshake.agentCapabilities?.loadSession) {
      throw new Error("agent does not support session/load");
    }
    this.#sessionId = sessionId;
    const response = await this.#bounded(
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
    this.#configOptions = asConfigOptions(response?.configOptions);
  }

  /** Bounds a request on the Setup Deadline: a Runtime that never answers must
   *  not leave a caller pending with no way back. */
  #bounded<T>(work: Promise<T>, method: string): Promise<T> {
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
      this.#configOptions = asConfigOptions(notification.update.configOptions);
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
