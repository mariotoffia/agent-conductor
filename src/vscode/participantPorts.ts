import type * as acp from "@agentclientprotocol/sdk";
import type * as vscode from "vscode";
import {
  ConductorSession,
  message,
  type LogPort,
  type ModelHint,
  type RuntimeQuirks,
} from "../core/index.js";
import type { DiffDocuments } from "./diffDocs.js";
import type { FormHost } from "./elicitation.js";
import { clampForDisplay, MAX_DETAIL_CHARS, type Assert } from "./permissions.js";
import { plainText } from "./sealing.js";

/**
 * The ports `@conductor` is driven through, and the one piece of drawing that
 * belongs to none of its commands.
 *
 * Beside the participant rather than inside it because the file has a size to
 * keep; everything here is the shape of the chat host, proved against the real
 * VS Code API at the bottom.
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
// The participant
// ---------------------------------------------------------------------------

export interface RuntimeChoice {
  id: string;
  label: string;
  description?: string;
}

/** A Persisted Session, as much of one as reattaching to it needs. */
export interface SavedSession {
  readonly sessionId: string;
  readonly runtimeId: string;
  /** The `cwd` that Session was created with; `session/load` re-sends it. */
  readonly workspace: string;
}

export interface ParticipantOptions {
  /**
   * Opens a trusted Session; `openTrustedSession` with the host's ports bound.
   *
   * With `load`, the Agent is asked to reattach to that Session (`session/load`)
   * in the folder it was created in, rather than to create a new one.
   */
  open(
    runtimeId: string,
    onUpdate: (notification: acp.SessionNotification) => void,
    load?: SavedSession,
  ): Promise<ConductorSession>;
  /** Runtimes the user may switch between, in display order. */
  runtimes(): Promise<RuntimeChoice[]>;
  /** `agentConductor.defaultRuntime`, read per turn so a change takes effect. */
  defaultRuntimeId(): string;
  pick: FormHost["pick"];
  diffs: DiffDocuments;
  /** `agentConductor.ui.showThinking`, read per turn. */
  showThinking(): boolean;
  /** `agentConductor.ui.slashCommandAllowlist`, read per turn. */
  slashCommands?(): readonly string[];
  /** Picker fallback for a Runtime whose Agent exposes no Config Option. */
  modelCatalog?(runtimeId: string): ModelHint[];
  /** Traits of the Runtime behind a Session, for telling the user why there is
   *  nothing to set. Absent leaves the message the weaker of the two. */
  runtimeQuirks?(runtimeId: string): RuntimeQuirks | undefined;
  /** Called whenever what this participant owns changes: a Session opened, a
   *  Turn started or ended, a Session went away. Never awaited — a Turn must not
   *  queue behind whatever draws it. */
  onChanged?(): void;
  log?: LogPort;
}

/**
 * A failure, as it may be drawn.
 *
 * Most of what these say is the Agent's own text, written straight after words
 * this Client put in bold. So it is bounded, kept to one line, and stripped of
 * the markers that make text look like ours: an Agent answering with a rule and
 * a heading of its own would otherwise appear to be us (ADR-0007).
 */
export function failureText(error: unknown): string {
  // An `_` between two word characters is kept, and every other one goes. These
  // messages name environment variables, settings keys and paths, and one drawn
  // as `MOCKSECRET` sends the reader looking for something that does not exist —
  // while `_Now running:_` is how this Client writes its own asides, and an
  // Agent's words are drawn straight after our bold. Markdown cannot emphasise
  // an underscore inside a word, so keeping those costs nothing. Flattening
  // already defeats every block-level construct, since the text is appended
  // mid-line. Links go through the one rule there is — see `sealing.ts`.
  // The underscores go first, and everything else is the one sealing there is.
  // First, because removing a character can put a link back together — `http:_//`
  // is not an address until the `_` is gone — and `plainText` breaks links last.
  const said = message(error).replace(/(?<![A-Za-z0-9])_+|_+(?![A-Za-z0-9])/g, "");
  return clampForDisplay(plainText(said).trim(), MAX_DETAIL_CHARS);
}

/** The chat ports still are the VS Code API they stand for; see `config.ts`. */
export type ChatPortsMatchVsCodeApi = [
  Assert<vscode.CancellationToken extends CancelToken ? true : false>,
  Assert<vscode.ChatRequest extends TurnRequest ? true : false>,
  Assert<TurnResult extends vscode.ChatResult ? true : false>,
  // The gate's own self-test: a member VS Code does not implement is rejected.
  Assert<vscode.ChatRequest extends { sparkle: string } ? false : true>,
];
