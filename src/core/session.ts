import * as acp from "@agentclientprotocol/sdk";
import {
  connectAgent,
  DEFAULT_SETUP_TIMEOUT_MS,
  systemClock,
  withDeadline,
  type AgentConnection,
} from "./acpClient.js";
import { additionalDirectories } from "./sessionRoots.js";
import { message, stageError, stallError, turnError } from "./failures.js";
import {
  applyRequestedSelections,
  asConfigOptions,
  discoverConfig,
  readBack,
  selectorSlot,
  type DiscoveredConfig,
} from "./discovery.js";
import { redactSecrets } from "./redaction.js";
import {
  DEFAULT_CANCEL_GRACE_MS,
  DEFAULT_STALL_TIMEOUT_MS,
  sortMcpServers,
  validateSessionSpec,
  type SessionSpec,
} from "./sessionSpec.js";
import type {
  AgentExit, ClockPort, EffectiveSelection, LogLevel, SessionPorts, SessionState,
} from "./types.js";

/**
 * One ACP session on one Agent process (ADR-0008). It owns that subprocess for
 * its whole life, so a cancellation that escalates to termination — or an Agent
 * crash — can only ever affect this Session. Cancellation is two-layered:
 * `session/cancel`, then the process.
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

  /** Reattaches to a previous session (`session/load`); `session/resume` is not
   *  used. Servers and roots are re-sent; needs the `loadSession` capability. */
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

  /** Latest complete Config Option array reported by the Agent (ADR-0005).
   *  ponytail: handed out by reference — harmless while only `config` and tests
   *  read it, and it is replaced wholesale rather than edited. Copy on the way
   *  out once view code consumes it directly. */
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

  /** Sets one Config Option and adopts the complete array the Agent answers
   *  with. Only between Turns: applying a change to the Turn already in flight
   *  would silently rewrite what it started under. Booleans are not settable —
   *  the Client does not advertise that capability, so it must not send them. */
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
      // An exchange that did not complete leaves the configuration genuinely
      // unknown: the Agent may have applied the change, answered nothing useful,
      // or died. Keeping the old array would let Read-back go on calling a
      // superseded value verified, so the Session forgets it instead. The
      // pickers survive on the catalog fallback.
      this.#configOptions = [];
      // Rethrown redacted, here rather than in each caller: this is what every
      // one of them routes through, and what they draw goes into a transcript
      // that is kept (ADR-0010).
      throw new Error(redactSecrets(message(error), this.#secrets()), { cause: error });
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
      if (this.#stalled) throw stallError(this.#sessionId, this.#spec.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS);
      // Checked, not trusted: the SDK schema-checks notifications, not answers
      // to requests, and how a Turn ended is read off this (ADR-0007).
      if (typeof (response as acp.PromptResponse | undefined)?.stopReason !== "string") {
        throw new Error(`session ${this.#sessionId}: agent ended the turn with no stop reason`);
      }
      return response;
    } catch (error) {
      // The stall is the reason the turn ended, whatever the Agent said after.
      if (this.#stalled) throw stallError(this.#sessionId, this.#spec.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS);
      const lost = this.#lost();
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
      throw turnError(
        { runtimeId: this.#spec.runtimeId, sessionId: this.#sessionId, secrets: this.#secrets() },
        error,
        this.#exit,
        this.#requireConnection().stderrTail(),
      );
    } finally {
      this.#clearGrace();
      this.#clearStall();
      if (this.#inTurn()) this.#state = "idle";
    }
  }

  /** Cancels the active turn: `session/cancel`, then terminates only this
   *  Session's process if the Agent has not stopped within the grace period. */
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
      // Here, so the real port ends them before anything below runs.
      this.#endCommands();
      try {
        await this.#connection?.close();
      } catch (error) {
        // A rejected disposal would be memoized here: every later teardown would
        // reject too, and the cancel-grace timer calls this with nobody waiting
        // on the promise. The Session is gone either way; what went wrong belongs
        // in the log, not in a throw.
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
      // What it started outlives it otherwise, until something reaches this
      // Session again — which may be never (ADR-0008).
      this.#endCommands();
    });
    try {
      await (sessionId === undefined ? this.#createSession() : this.#loadSession(sessionId));
      // A new Session only: a reattached one carries a conversation produced
      // under some configuration, and changing that halfway through is nobody's
      // default. Inside the guard, so nothing throwing before `open` resolves
      // can leave an Agent process nobody owns (ADR-0008).
      if (sessionId === undefined) {
        await applyRequestedSelections(
          this,
          { model: this.#requestedModel, effort: this.#requestedEffort },
          // "Could not set", never "refused": the Agent may simply have died.
          (slot, value, error) =>
            this.#log("error", `session ${this.#sessionId}: could not set ${slot} ${value}: ${message(error)}`),
        );
        // A refusal is survivable and a death is not, and that callback cannot
        // tell them apart. Asked of the connection, never of the state: a
        // request in flight rejects as the pipe closes and puts the state back
        // before the exit handler runs.
        if (this.#lost()) throw new Error("the agent died while it was being configured");
      }
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
        this.#secrets(),
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

  /** Bounds a request on the Setup Deadline. */
  #bounded<T>(work: Promise<T>, method: string): Promise<T> {
    const ms = this.#spec.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS;
    return withDeadline(work, ms, this.#clock, () =>
      new Error(`agent did not answer ${method} within ${ms}ms`));
  }

  #directories(): { additionalDirectories?: string[] } {
    return additionalDirectories(
      this.#spec.additionalDirectories ?? [],
      this.#requireConnection().handshake.agentCapabilities,
      (text) => this.#log("info", `runtime ${this.#spec.runtimeId}: ${text}`),
    );
  }

  /** Restarts the silence timer: time the Client owes the Agent an answer never
   *  counts against the limit. */
  #restartStallLimit(): void {
    this.#clearStall();
    const ms = this.#spec.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    if (ms <= 0 || this.#state !== "prompting" || this.#owedAnswers > 0) return;
    this.#clearStallLimit = this.#clock.after(ms, () => {
      if (this.#state !== "prompting") return;
      this.#stalled = true;
      this.#log("error", `session ${this.#sessionId}: no agent activity for ${ms}ms — cancelling the turn`);
      void this.cancel();
    });
  }

  #clearStall(): void {
    this.#clearStallLimit?.();
    this.#clearStallLimit = undefined;
  }

  #handleUpdate(notification: acp.SessionNotification): void {
    this.#restartStallLimit(); // the Agent is alive and working
    // One process serves one Session, so any id but ours — foreign, or any at all
    // before setup answered — is a confused Agent: render it, never adopt it.
    const ours = notification.sessionId === this.#sessionId;
    // A complete refreshed array, prompted or not; always render the latest.
    if (ours && notification.update.sessionUpdate === "config_option_update") {
      this.#configOptions = asConfigOptions(notification.update.configOptions);
    }
    this.#spec.onUpdate?.(notification);
  }

  /** Read through a call so the compiler keeps live mutations in view. */
  /** Gone: it exited, or the connection closed. */
  #lost(): boolean {
    return this.#exit !== undefined || this.#connection?.closed.aborted === true;
  }

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

  /** Ends what this Session's Agent started. Never awaited: teardown may not
   *  queue behind a host service, since the escalation guaranteeing the Agent
   *  dies is armed by `close()` (ADR-0008). Wrapped so a synchronous throw
   *  becomes a rejection this catches. */
  #endCommands(): void {
    void (async () => this.#ports.terminal?.dispose?.())().catch((error: unknown) => {
      this.#log("error", `session ${this.#sessionId}: ending its commands failed: ${message(error)}`);
    });
  }

  /** Values this Session's Agent was started with. Nothing the Agent says goes
   *  anywhere readable without passing them (ADR-0010). */
  #secrets(): string[] {
    return Object.values(this.#spec.secretEnvironment ?? {});
  }

  #log(level: LogLevel, text: string): void {
    this.#ports.log?.log(level, redactSecrets(text, this.#secrets()));
  }
}
