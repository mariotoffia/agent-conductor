import type * as acp from "@agentclientprotocol/sdk";
import {
  ConductorSession,
  message,
  pickEffortChoices,
  pickModelChoices,
} from "../core/index.js";
import { ChatSink, readBackLine, type ChatStream } from "./chatSink.js";
import { asQuickItem, type QuickItem } from "./elicitation.js";
import {
  failureText,
  type CancelToken,
  type ParticipantOptions,
  type SavedSession,
  type TurnRequest,
  type TurnResult,
} from "./participantPorts.js";
import { clampForDisplay, MAX_DETAIL_CHARS, MAX_LABEL_CHARS } from "./permissions.js";
import { renderUpdate } from "./render.js";
import { inlineText, plainText } from "./sealing.js";

export type {
  CancelToken,
  ParticipantOptions,
  RuntimeChoice,
  SavedSession,
  TurnRequest,
  TurnResult,
} from "./participantPorts.js";

/**
 * `@conductor`: one chat turn driving one direct Session (ARCHITECTURE.md
 * §Data flows).
 *
 * The chat host is reached through structural ports, as every service in this
 * layer is, so a turn can be driven end to end against a real Agent process
 * without an extension host. `vscode` is imported as a type only.
 */

const REFUSED = "refused";
const STOPPED = "Agent Conductor is shutting down; no session can be started.";
const CANCELLED = "cancelled";
const DONE = "end_turn";

export class ConductorParticipant {
  readonly #options: ParticipantOptions;
  #session?: ConductorSession;
  #runtimeId?: string;
  /**
   * A Turn is under way. Set synchronously, before anything is awaited, because
   * the window that matters opens at the first `await` — starting an Agent is
   * the slowest part of a Turn, and a second submission that raced through it
   * would open a second Session whose process nobody then owns (ADR-0008).
   */
  #busy = false;
  /**
   * Where Updates are drawn while a Turn is in flight, and nothing between
   * Turns. Exactly one Turn may own it, which is what stops a second Turn from
   * taking an in-flight Turn's output — or losing it to the log.
   */
  #sink?: ChatSink;
  /** The Session being opened, so concurrent callers share one Agent process. */
  #opening?: Promise<ConductorSession>;
  /**
   * Bumped by every disposal. A Session that finishes starting under a
   * superseded generation belongs to nobody — the field that would carry it has
   * already been cleared — so it ends itself rather than being adopted.
   */
  #generation = 0;
  /** Teardown has happened; no further Session may be opened. */
  #stopped = false;
  /** The saved Session the next open must reattach to, set only for the moment
   *  `resume` is opening one. An ordinary prompt always creates a new Session. */
  #loading?: SavedSession;
  /** A `resume` holds the participant for as long as it takes to start an Agent
   *  and reattach. Told apart from a Turn because what a user has to do about it
   *  is different: there is nothing to cancel, and waiting is the whole answer. */
  #reopening = false;
  /** Titles by tool call id, so a status-only update still names its call. */
  readonly #toolTitles = new Map<string, string>();

  constructor(options: ParticipantOptions) {
    this.#options = options;
  }

  /** Session id of the live Session, or `undefined` when none is open. */
  get currentSessionId(): string | undefined {
    return this.#session?.sessionId;
  }

  /** One chat turn: a slash command, or a prompt for the Agent. */
  async handle(request: TurnRequest, stream: ChatStream, token: CancelToken): Promise<TurnResult> {
    // A Session runs one Turn at a time, so a second chat submission is refused
    // rather than allowed to disturb the one in flight. `/cancel` is the way out
    // and is therefore the one command that may run alongside it — it is also
    // the only one that neither starts a Session nor waits on the user.
    const exclusive = request.command !== "cancel";
    if (this.#busy && exclusive) {
      const text = this.#reopening
        ? "A saved session is being reopened; this prompt was not sent — send it again once it is open."
        : "This session is already running a turn — cancel it with /cancel first.";
      stream.markdown(text);
      return { metadata: { stopReason: REFUSED }, errorDetails: { message: text } };
    }
    if (exclusive) this.#busy = true;
    this.#changed();
    try {
      switch (request.command) {
        case "runtime":
          return await this.#switchRuntime(stream);
        case "model":
        case "effort":
          return await this.#configure(request.command, stream);
        case "cancel":
          return await this.#cancelTurn(stream);
        default:
          return await this.#prompt(request.prompt, stream, token);
      }
    } catch (error) {
      const text = failureText(error);
      stream.markdown(`\n\n**Agent Conductor refused this turn.** ${text}`);
      return { metadata: { stopReason: REFUSED }, errorDetails: { message: text } };
    } finally {
      if (exclusive) this.#busy = false;
      this.#changed();
    }
  }

  /**
   * Cancels the Turn in flight, if there is one. Safe when there is not.
   *
   * With a Session id, only that Session's Turn is cancelled — the Sessions tree
   * cancels the row a user picked, and this participant owns one Session at a
   * time, so a id that is not the live one cancels nothing rather than the
   * wrong thing.
   */
  async cancel(sessionId?: string): Promise<void> {
    const session = this.#session;
    if (!session || (sessionId !== undefined && session.sessionId !== sessionId)) return;
    if (session.state === "prompting") await session.cancel();
    this.#changed();
  }

  /**
   * Reattaches to a saved Session and makes it the live one (`session/load`).
   *
   * Through this participant rather than beside it: a Session opened anywhere
   * else would be a second owner of an Agent process, and the process a second
   * owner starts is one teardown cannot stop (ADR-0008). The live Session is
   * ended first, for the same reason `/runtime` ends it — one process per
   * Session, for its whole life.
   */
  async resume(saved: SavedSession): Promise<void> {
    if (this.#busy) {
      throw new Error("This session is already running a turn — cancel it with /cancel first.");
    }
    this.#busy = true;
    this.#reopening = true;
    const previous = this.#runtimeId;
    let attached = false;
    try {
      await this.dispose();
      this.#runtimeId = saved.runtimeId;
      this.#loading = saved;
      await this.#live();
      attached = true;
    } finally {
      // Cleared whatever happened: a failed reattach must not make the next
      // ordinary prompt try to load a Session the Agent has already refused.
      this.#loading = undefined;
      // And the Runtime goes back where it was unless the reattach worked. A
      // failure that kept it would move the user to another CLI for the rest of
      // the window, silently, on the strength of a click that did nothing.
      if (!attached) this.#runtimeId = previous;
      this.#reopening = false;
      this.#busy = false;
      this.#changed();
    }
  }

  /**
   * Ends this participant for good: the extension is going away.
   *
   * Distinct from `dispose`, because ending a Session has two meanings and only
   * one of them is final. `/runtime` and a new Session end one so that the next
   * prompt opens another, and must keep doing so. Teardown ends one so that
   * nothing runs afterwards — and a turn parked in the wait for a dead Session
   * would otherwise resume and start an Agent process behind a teardown that
   * had already reported itself done (ADR-0008).
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    await this.dispose();
  }

  /**
   * Ends the live Session and drops everything it retained. Idempotent.
   *
   * Drains rather than takes a snapshot. Ending one Session yields, and what
   * appears during that wait would not be in a list read before it — teardown
   * would report done with an Agent process still starting behind it. Each pass
   * re-reads, so the loop ends only once there is nothing left to end.
   */
  async dispose(): Promise<void> {
    this.#generation += 1;
    this.#sink = undefined;
    this.#toolTitles.clear();
    while (this.#session || this.#opening) {
      this.#generation += 1;
      const session = this.#session;
      const opening = this.#opening;
      this.#session = undefined;
      this.#opening = undefined;
      if (session) {
        this.#options.diffs.closeSession(session.sessionId);
        await session.dispose();
      }
      // A Session still starting is one nothing else can reach: its process
      // already exists and no field carries it yet, so a teardown that looked
      // only at `#session` would leave it running with nobody able to stop it
      // (ADR-0008). `#openSession` ends it once it sees the generation has
      // moved; waiting here is what makes teardown wait for the process rather
      // than merely ask for it.
      if (opening) await opening.catch(() => undefined);
      this.#sink = undefined;
    }
    // Neither branch above can throw — a Session's disposal is memoized and
    // catches, and a rejected open is swallowed — so what draws this is told
    // once, here, rather than from a guard that could never fire.
    this.#changed();
  }

  async #prompt(prompt: string, stream: ChatStream, token: CancelToken): Promise<TurnResult> {
    if (token.isCancellationRequested) return { metadata: { stopReason: CANCELLED } };
    const session = await this.#live(stream);
    // Starting an Agent takes time a user can cancel through; checked again so
    // the outcome does not depend on when the host delivers the notification.
    if (token.isCancellationRequested) return { metadata: { stopReason: CANCELLED } };
    // Installed before the request goes out: Updates arrive while it is in flight.
    const sink = new ChatSink(stream, {
      diffs: this.#options.diffs,
      sessionId: session.sessionId,
      showThinking: this.#options.showThinking(),
      // The user's list together with what the catalog knows this CLI can be
      // asked safely: both are allowlists of commands safe to surface.
      slashCommands: [
        ...(this.#options.slashCommands?.() ?? []),
        ...(this.#options.runtimeQuirks?.(session.runtimeId)?.slashCommandAllowlist ?? []),
      ],
      toolTitles: this.#toolTitles,
      ...(this.#options.log ? { log: this.#options.log } : {}),
    });
    this.#sink = sink;
    const subscription = token.onCancellationRequested(() => {
      // This Session, not whichever is live: a disposal during the Turn may have
      // replaced it, and cancelling the wrong one is worse than cancelling none.
      // `cancel` moves it to `cancelling` before it yields, so saying so here is
      // saying something true.
      void session.cancel();
      this.#changed();
    });
    try {
      // Started, then said, then awaited. `prompt` moves the Session to
      // `prompting` before it yields, so this is the one moment anything drawing
      // this participant can learn that a Turn is under way — told only when it
      // is over, a Sessions tree would say `idle` for the whole of it.
      const turn = session.prompt(prompt);
      this.#changed();
      const response = await turn;
      return { metadata: { stopReason: response.stopReason } };
    } catch (error) {
      const text = failureText(error);
      stream.markdown(`\n\n**The turn failed.** ${text}`);
      return { metadata: { stopReason: "failed" }, errorDetails: { message: text } };
    } finally {
      subscription.dispose();
      // Only ever its own: a disposal during the Turn may already have replaced it.
      if (this.#sink === sink) this.#sink = undefined;
    }
  }

  /**
   * Cancels the Turn in flight. A Turn the user cancels answers `cancelled`,
   * which is also what the Client owes the Agent for any permission request it
   * left open (ADR-0007).
   */
  async #cancelTurn(stream: ChatStream): Promise<TurnResult> {
    if (this.#session?.state !== "prompting") {
      // Told apart on purpose: a turn still starting its Agent has nothing to
      // cancel yet, and saying "nothing is running" to somebody who was just
      // told to cancel it would be the opposite of an explanation.
      stream.markdown(
        this.#reopening
          ? "A saved session is being reopened; there is no turn to cancel yet."
          : this.#busy
            ? "The turn is still starting its agent; there is no turn to cancel yet."
            : "There is nothing running to cancel.",
      );
      return { metadata: { stopReason: DONE } };
    }
    await this.cancel();
    stream.markdown("Cancelling the current turn…");
    return { metadata: { stopReason: CANCELLED } };
  }

  /**
   * Switches Runtime. The live Session is ended rather than reconfigured: a
   * Session is one Agent process for its whole life (ADR-0008), so the next
   * prompt opens a new one.
   */
  async #switchRuntime(stream: ChatStream): Promise<TurnResult> {
    const runtimes = await this.#options.runtimes();
    if (runtimes.length === 0) {
      stream.markdown("No runtime is configured. Run **Agent Conductor: Connect a CLI…** first.");
      return { metadata: { stopReason: DONE } };
    }
    const picked = await this.#choose(
      runtimes,
      (runtime) => ({
        // Both sealed: a Runtime's label and the reason shown against it are
        // settings text, and `agentConductor.runtimes` is a scope a repository
        // can write (ADR-0007).
        label: clampForDisplay(plainText(runtime.label).trim(), MAX_LABEL_CHARS),
        ...(runtime.description
          ? { description: clampForDisplay(plainText(runtime.description).trim(), MAX_DETAIL_CHARS) }
          : {}),
      }),
      { title: "Runtime for this session", placeHolder: "Pick the CLI to run" },
    );
    if (!picked) {
      stream.markdown("Runtime unchanged.");
      return { metadata: { stopReason: DONE } };
    }
    await this.dispose();
    this.#runtimeId = picked.id;
    stream.markdown(`Next turn will run on **${inlineText(picked.label, MAX_LABEL_CHARS)}**.`);
    return { metadata: { stopReason: DONE } };
  }

  /**
   * Sets one of the two pickers, then reports what the Agent says it is running.
   *
   * The value the user picked is never reported as effective on its own: a
   * Runtime whose configuration is fixed when its process starts has no option
   * to set, so the pick is declined outright rather than recorded as though it
   * had taken effect (ADR-0005).
   */
  async #configure(slot: "model" | "effort", stream: ChatStream): Promise<TurnResult> {
    const session = await this.#live(stream);
    const config = session.config;
    const catalog = this.#options.modelCatalog?.(session.runtimeId) ?? [];
    const source = slot === "model"
      ? pickModelChoices(config, catalog)
      : pickEffortChoices(config, catalog.find((hint) => hint.id === config.model?.currentValue));
    if (source.choices.length === 0) {
      stream.markdown(this.#nothingToSet(session.runtimeId, slot));
      return { metadata: { stopReason: DONE } };
    }
    const picked = await this.#choose(source.choices, asQuickItem, {
      title: slot === "model" ? "Model" : "Reasoning effort",
      placeHolder: source.source === "agent" ? "Reported by the agent" : "From the runtime catalog",
    });
    if (!picked) {
      stream.markdown(`The ${slot} is unchanged.`);
      return { metadata: { stopReason: DONE } };
    }
    const selector = slot === "model" ? config.model : config.effort;
    if (!selector) {
      stream.markdown(this.#nothingToSet(session.runtimeId, slot));
      return { metadata: { stopReason: DONE } };
    }
    await session.setConfigOption(selector.id, picked.value);
    stream.markdown(
      readBackLine(slot, slot === "model" ? session.modelSelection : session.effortSelection),
    );
    return { metadata: { stopReason: DONE } };
  }

  /**
   * Why there is nothing to set, told apart rather than guessed at.
   *
   * A Runtime whose configuration is fixed when its process starts has to be
   * reconnected with the value the user wants; an Agent that merely reports no
   * options right now might report some later, and sending that user off to
   * reconnect something that is fine is the wrong answer (ADR-0005).
   */
  #nothingToSet(runtimeId: string, slot: string): string {
    return this.#options.runtimeQuirks?.(runtimeId)?.processScopedConfig === true
      ? `This runtime fixes its ${slot} when the process starts;` +
          " reconnect it with the value you want."
      : `This agent exposes no ${slot} to choose from.`;
  }

  /**
   * One quick pick over values the Agent supplied.
   *
   * The chosen value is read back by position, never by matching the label:
   * labels are the Agent's and are clamped for display, so two of them can
   * become the same string — and the model that was picked would then not be
   * the model that was set.
   */
  async #choose<T>(
    values: readonly T[],
    label: (value: T) => QuickItem,
    options: { title: string; placeHolder: string },
  ): Promise<T | undefined> {
    const items = values.map(label);
    const chosen = await this.#options.pick(items, options);
    if (!chosen) return undefined;
    const at = items.indexOf(chosen);
    // A host that answered with something it was never given is not answering
    // the question that was asked; changing nothing is the only safe reading.
    return at < 0 ? undefined : values[at];
  }

  /**
   * The live Session, opening one when there is none or the last one died.
   *
   * An open in flight is shared rather than repeated. `#busy` already stops two
   * chat turns reaching here together; this makes the guarantee the Session
   * owns — one process, owned for its whole life — hold for any caller, because
   * the process a second open would start is one nothing afterwards can stop.
   */
  async #live(stream?: ChatStream): Promise<ConductorSession> {
    const existing = this.#session;
    if (existing && existing.state !== "failed" && existing.state !== "disposed") return existing;
    if (existing) await this.dispose();
    // Asked here and only here. A check before the wait as well would be one no
    // test could ever fail on, because this one catches the same call: what has
    // to be true is that nothing starts a process *after* teardown, and teardown
    // lands inside the wait above — the participant looks quiet from the outside
    // while it does, and what follows starts a process (ADR-0008).
    if (this.#stopped) throw new Error(STOPPED);
    if (!this.#opening) {
      const opening = this.#openSession(stream);
      this.#opening = opening;
      // Cleared only while it is still the one in flight. A disposal may have
      // replaced it already, and a settled open clearing its successor would
      // let a third Agent process start behind both of them.
      void opening.catch(() => undefined).then(() => {
        if (this.#opening === opening) this.#opening = undefined;
      });
    }
    return this.#opening;
  }

  async #openSession(stream?: ChatStream): Promise<ConductorSession> {
    const generation = this.#generation;
    const load = this.#loading;
    const runtimeId = this.#runtimeId ?? this.#options.defaultRuntimeId();
    // A Runtime id is a settings key, and `agentConductor.runtimes` is a scope a
    // repository can write — so this is its text, drawn before anything about it
    // has been trusted (ADR-0007). Sealed like any other, and a progress line is
    // rendered as markdown whatever its signature suggests.
    stream?.progress(`Starting ${inlineText(runtimeId, MAX_LABEL_CHARS)}…`);
    const session = await this.#options.open(
      runtimeId,
      (notification) => this.#onUpdate(notification),
      load,
    );
    if (generation !== this.#generation) {
      await session.dispose();
      throw new Error(`runtime ${runtimeId}: the session was ended while it was starting`);
    }
    this.#session = session;
    this.#runtimeId = runtimeId;
    this.#changed();
    return session;
  }

  /** Tells whatever draws this participant that what it owns has moved. Never
   *  throws into a Turn: a drawing surface is not allowed to fail one. */
  #changed(): void {
    try {
      this.#options.onChanged?.();
    } catch (error) {
      // Logging is itself a call into the window — it re-reads the configured
      // level — so it goes inside the guard too. A catch that can throw is not
      // one, and this one is called from a Turn's `finally`, where a throw would
      // replace what the Turn was about to answer.
      try {
        this.#options.log?.log("error", `sessions view refused an update: ${message(error)}`);
      } catch {
        // Nothing left to tell.
      }
    }
  }

  /**
   * Between Turns there is no sink — an Agent may keep talking after a Turn ends
   * — so an Update goes to the log rather than being dropped.
   */
  #onUpdate(notification: acp.SessionNotification): void {
    const sink = this.#sink;
    for (const item of renderUpdate(notification.update)) {
      if (sink) sink.draw(item);
      else this.#options.log?.log("debug", `update outside a turn: ${item.kind}`);
    }
  }
}
