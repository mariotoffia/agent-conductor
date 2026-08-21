import type * as acp from "@agentclientprotocol/sdk";
import type * as vscode from "vscode";
import {
  ConductorSession,
  message,
  pickEffortChoices,
  pickModelChoices,
  resolveRuntime,
  trustedLaunch,
  type ConfigChoice,
  type ExecutablePort,
  type LogPort,
  type ModelHint,
  type RuntimeSpec,
  type RuntimeTrust,
  type SessionPorts,
  type SessionSpec,
} from "../core/index.js";
import { ChatSink, readBackLine, type ChatStream } from "./chatSink.js";
import type { DiffDocuments } from "./diffDocs.js";
import type { FormHost, QuickItem } from "./elicitation.js";
import { clampForDisplay, MAX_LABEL_CHARS, type Assert } from "./permissions.js";
import { renderUpdate } from "./render.js";

/**
 * `@conductor`: one chat turn driving one direct Session (ARCHITECTURE.md
 * §Data flows).
 *
 * The chat host is reached through structural ports, as every service in this
 * layer is, so a turn can be driven end to end against a real Agent process
 * without an extension host. `vscode` is imported as a type only.
 */

/** `vscode.CancellationToken`. */
export interface CancelToken {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => unknown): { dispose(): unknown };
}

/** The part of `vscode.ChatRequest` the dispatcher reads. */
export interface TurnRequest {
  readonly prompt: string;
  /** The slash command the user picked, without its slash. */
  readonly command?: string | undefined;
}

/**
 * `vscode.ChatResult`. The stop reason is the Agent's own word for how the Turn
 * ended, carried through unchanged — a cancelled Turn reports `cancelled`, which
 * is also what the Client answers the Agent with.
 */
export type TurnResult = {
  readonly metadata: { readonly stopReason: string };
  readonly errorDetails?: { readonly message: string };
};

// ---------------------------------------------------------------------------
// The spawn gate
// ---------------------------------------------------------------------------

export interface TrustedSessionRequest {
  spec: RuntimeSpec;
  executable: ExecutablePort;
  /** What the user approved for this Runtime, if anything. */
  trust?: RuntimeTrust;
  /** `vscode.workspace.isTrusted`. */
  workspaceTrusted: boolean;
  /** Absolute session working directory. */
  cwd: string;
  additionalDirectories?: string[];
  secretEnvironment?: Record<string, string>;
  requestedModel?: string;
  requestedEffort?: string;
  onUpdate: (notification: acp.SessionNotification) => void;
  ports: SessionPorts;
}

/**
 * The only way this layer starts an Agent.
 *
 * Two gates, in this order: the window's trust, then the Runtime's. Workspace
 * trust comes first because a repository nobody vouched for must not even get to
 * name a Runtime, and Runtime Trust is re-derived from a fresh resolution rather
 * than read from a record — an executable that moved or changed is a different
 * identity, and fails closed here (ADR-0007).
 */
export async function openTrustedSession(request: TrustedSessionRequest): Promise<ConductorSession> {
  if (!request.workspaceTrusted) {
    throw new Error(
      `runtime ${request.spec.id}: this workspace is not trusted, and agents execute code` +
        " — trust the workspace before starting a session",
    );
  }
  const runtime = await resolveRuntime(request.spec, {
    executable: request.executable,
    ...(request.trust ? { trust: request.trust } : {}),
    workspace: request.cwd,
  });
  const spec: SessionSpec = {
    runtimeId: runtime.id,
    launch: trustedLaunch(runtime),
    cwd: request.cwd,
    // Taken from the resolved Runtime, so the policy channel is the one the
    // fingerprint covers rather than one a caller composed (ADR-0004).
    ...(runtime.sessionMeta ? { sessionMeta: runtime.sessionMeta } : {}),
    ...(request.additionalDirectories?.length
      ? { additionalDirectories: request.additionalDirectories }
      : {}),
    ...(request.secretEnvironment ? { secretEnvironment: request.secretEnvironment } : {}),
    ...(request.requestedModel ? { requestedModel: request.requestedModel } : {}),
    ...(request.requestedEffort ? { requestedEffort: request.requestedEffort } : {}),
    onUpdate: request.onUpdate,
  };
  return ConductorSession.open(spec, request.ports);
}

// ---------------------------------------------------------------------------
// The participant
// ---------------------------------------------------------------------------

export interface RuntimeChoice {
  id: string;
  label: string;
  description?: string;
}

export interface ParticipantOptions {
  /** Opens a trusted Session; `openTrustedSession` with the host's ports bound. */
  open(
    runtimeId: string,
    onUpdate: (notification: acp.SessionNotification) => void,
  ): Promise<ConductorSession>;
  /** Runtimes the user may switch between, in display order. */
  runtimes(): Promise<RuntimeChoice[]>;
  /** `agentConductor.defaultRuntime`, read per turn so a change takes effect. */
  defaultRuntimeId(): string;
  pick: FormHost["pick"];
  diffs: DiffDocuments;
  /** `agentConductor.ui.showThinking`, read per turn. */
  showThinking(): boolean;
  /** Picker fallback for a Runtime whose Agent exposes no Config Option. */
  modelCatalog?(runtimeId: string): ModelHint[];
  log?: LogPort;
}

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
      const text = "This session is already running a turn — cancel it with /cancel first.";
      stream.markdown(text);
      return { metadata: { stopReason: REFUSED }, errorDetails: { message: text } };
    }
    if (exclusive) this.#busy = true;
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
      const text = message(error);
      stream.markdown(`\n\n**Agent Conductor refused this turn.** ${text}`);
      return { metadata: { stopReason: REFUSED }, errorDetails: { message: text } };
    } finally {
      if (exclusive) this.#busy = false;
    }
  }

  /** Cancels the Turn in flight, if there is one. Safe when there is not. */
  async cancel(): Promise<void> {
    if (this.#session?.state === "prompting") await this.#session.cancel();
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
      toolTitles: this.#toolTitles,
      ...(this.#options.log ? { log: this.#options.log } : {}),
    });
    this.#sink = sink;
    const subscription = token.onCancellationRequested(() => void session.cancel());
    try {
      const response = await session.prompt(prompt);
      return { metadata: { stopReason: response.stopReason } };
    } catch (error) {
      const text = message(error);
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
      stream.markdown(this.#busy
        ? "The turn is still starting its agent; there is no turn to cancel yet."
        : "There is nothing running to cancel.");
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
        label: clampForDisplay(runtime.label, MAX_LABEL_CHARS),
        ...(runtime.description ? { description: runtime.description } : {}),
      }),
      { title: "Runtime for this session", placeHolder: "Pick the CLI to run" },
    );
    if (!picked) {
      stream.markdown("Runtime unchanged.");
      return { metadata: { stopReason: DONE } };
    }
    await this.dispose();
    this.#runtimeId = picked.id;
    stream.markdown(`Next turn will run on **${clampForDisplay(picked.label, MAX_LABEL_CHARS)}**.`);
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
      stream.markdown(`This agent exposes no ${slot} to choose from.`);
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
      stream.markdown(
        `This runtime fixes its ${slot} when the process starts;` +
          " reconnect it with the value you want.",
      );
      return { metadata: { stopReason: DONE } };
    }
    await session.setConfigOption(selector.id, picked.value);
    stream.markdown(
      readBackLine(slot, slot === "model" ? session.modelSelection : session.effortSelection),
    );
    return { metadata: { stopReason: DONE } };
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
  async #live(stream: ChatStream): Promise<ConductorSession> {
    if (this.#stopped) throw new Error(STOPPED);
    const existing = this.#session;
    if (existing && existing.state !== "failed" && existing.state !== "disposed") return existing;
    if (existing) await this.dispose();
    // Asked again after the wait: teardown lands inside it, the participant
    // looks quiet from the outside while it does, and what follows starts a
    // process.
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

  async #openSession(stream: ChatStream): Promise<ConductorSession> {
    const generation = this.#generation;
    const runtimeId = this.#runtimeId ?? this.#options.defaultRuntimeId();
    stream.progress(`Starting ${clampForDisplay(runtimeId, MAX_LABEL_CHARS)}…`);
    const session = await this.#options.open(runtimeId, (notification) => this.#onUpdate(notification));
    if (generation !== this.#generation) {
      await session.dispose();
      throw new Error(`runtime ${runtimeId}: the session was ended while it was starting`);
    }
    this.#session = session;
    this.#runtimeId = runtimeId;
    return session;
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

function asQuickItem(choice: ConfigChoice): QuickItem {
  return {
    label: clampForDisplay(choice.group ? `${choice.group} · ${choice.label}` : choice.label, MAX_LABEL_CHARS),
    description: choice.value,
  };
}

/** The chat ports still are the VS Code API they stand for; see `config.ts`. */
export type ChatPortsMatchVsCodeApi = [
  Assert<vscode.CancellationToken extends CancelToken ? true : false>,
  Assert<vscode.ChatRequest extends TurnRequest ? true : false>,
  Assert<TurnResult extends vscode.ChatResult ? true : false>,
  // The gate's own self-test: a member VS Code does not implement is rejected.
  Assert<vscode.ChatRequest extends { sparkle: string } ? false : true>,
];
