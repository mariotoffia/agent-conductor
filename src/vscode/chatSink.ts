import type * as vscode from "vscode";
import { isMismatch, type EffectiveSelection, type LogPort } from "../core/index.js";
import type { DiffDocuments } from "./diffDocs.js";
import { clampForDisplay, MAX_LABEL_CHARS, type Assert } from "./permissions.js";
import type { RenderItem } from "./render.js";

/**
 * Draws the render model into a stable chat response stream (ADR-0002).
 *
 * One sink belongs to one Turn on one Session. That is the whole point of it
 * being an object: an Update can only be drawn where the Turn that provoked it
 * is being written, so a Turn cannot lose its own output to a later one, and a
 * later one cannot receive output that is not its.
 *
 * Everything the Agent supplies is bounded before it is drawn or retained. What
 * is not bounded is the Agent's own prose, which is the answer the user asked
 * for; everything the Client puts around it is.
 */

/** `vscode.Command`, as far as a chat button uses one. */
export interface ChatCommand {
  title: string;
  command: string;
  arguments?: unknown[];
}

/** The part of `vscode.ChatResponseStream` a direct Session draws to. */
export interface ChatStream {
  markdown(value: string): void;
  progress(value: string): void;
  button(command: ChatCommand): void;
}

/** Command id the composition root registers for the diff button below. */
export const OPEN_DIFF_COMMAND = "agentConductor.openDiff";

/** Tool titles retained per Session, so a status-only update can still name its
 *  call. Bounded, because the ids and the titles are both the Agent's. */
export const MAX_REMEMBERED_TOOL_CALLS = 200;

export interface ChatSinkOptions {
  diffs: DiffDocuments;
  /** Session the drawn diffs are retained under. */
  sessionId: string;
  /** `agentConductor.ui.showThinking`, read per Turn. */
  showThinking: boolean;
  /** Titles by tool call id; shared across the Turns of one Session. */
  toolTitles: Map<string, string>;
  log?: LogPort;
}

export class ChatSink {
  readonly #stream: ChatStream;
  readonly #options: ChatSinkOptions;

  constructor(stream: ChatStream, options: ChatSinkOptions) {
    this.#stream = stream;
    this.#options = options;
  }

  draw(item: RenderItem): void {
    const stream = this.#stream;
    switch (item.kind) {
      case "message":
        stream.markdown(item.text);
        return;
      case "thought":
        if (this.#options.showThinking) stream.markdown(quote(item.text));
        return;
      case "userMessage":
        stream.markdown(quote(`**user:** ${item.text}`));
        return;
      case "toolCall":
        this.#drawToolCall(item);
        return;
      case "diff":
        this.#drawDiff(item);
        return;
      case "terminal":
        stream.progress(`Command output (${clampForDisplay(item.terminalId, MAX_LABEL_CHARS)})`);
        return;
      case "plan":
        stream.markdown(`\n\n${item.entries.map(planLine).join("\n")}\n\n`);
        return;
      case "planText":
        stream.markdown(`\n\n${item.text}\n\n`);
        return;
      case "planRemoved":
        stream.markdown("\n\n_(the agent withdrew its plan)_\n\n");
        return;
      case "commands":
        stream.markdown(`\n\n_Agent commands:_ ${item.commands.map(commandLabel).join(", ")}\n\n`);
        return;
      case "mode":
        stream.markdown(`\n\n_Mode:_ \`${clampForDisplay(item.modeId, MAX_LABEL_CHARS)}\`\n\n`);
        return;
      case "config":
        stream.markdown(`\n\n_Now running:_ ${configLine(item.model, item.effort)}\n\n`);
        return;
      case "usage":
        stream.markdown(`\n\n_${usageLine(item.used, item.size, item.cost)}_\n\n`);
        return;
      case "info":
        if (item.title) {
          stream.markdown(`\n\n_Session:_ ${clampForDisplay(item.title, MAX_LABEL_CHARS)}\n\n`);
        }
        return;
      default:
        // An Update this protocol version does not document. Logged rather than
        // drawn: nothing here knows what it means, and inventing a rendering
        // would put the Agent's raw payload in front of the user.
        this.#options.log?.log(
          "info",
          `agent sent an unsupported update: ${clampForDisplay(item.sessionUpdate, MAX_LABEL_CHARS)}`,
        );
    }
  }

  #drawToolCall(item: RenderItem & { kind: "toolCall" }): void {
    const titles = this.#options.toolTitles;
    const title = clampForDisplay(item.title ?? titles.get(item.toolCallId) ?? item.toolCallId, MAX_LABEL_CHARS);
    if (item.title) {
      // The clamped title is what is retained: an Agent chooses both the id and
      // the string, so an unbounded one would be held for the Session's life.
      if (titles.size >= MAX_REMEMBERED_TOOL_CALLS && !titles.has(item.toolCallId)) {
        const oldest = titles.keys().next();
        if (!oldest.done) titles.delete(oldest.value);
      }
      titles.set(item.toolCallId, title);
    }
    const status = item.status ?? "";
    const kind = item.toolKind ? ` (${clampForDisplay(item.toolKind, MAX_LABEL_CHARS)})` : "";
    // `progress` is replaced by the next one, which is what a running call wants;
    // a finished call has to stay on screen.
    if (status === "" || status === "pending" || status === "in_progress") {
      this.#stream.progress(`${title}${kind}`);
      return;
    }
    this.#stream.markdown(`\n\n${status === "failed" ? "❌" : "✅"} **${title}**${kind}\n\n`);
  }

  #drawDiff(item: RenderItem & { kind: "diff" }): void {
    const handle = this.#options.diffs.record(this.#options.sessionId, {
      path: item.path,
      oldText: item.oldText,
      newText: item.newText,
    });
    this.#stream.button({
      title: `Open diff: ${clampForDisplay(handle.title, MAX_LABEL_CHARS)}`,
      command: OPEN_DIFF_COMMAND,
      arguments: [handle.id],
    });
  }
}

/** Requested beside effective, and a clamp named as a mismatch (ADR-0005). */
export function readBackLine(slot: string, selection: EffectiveSelection): string {
  const requested = selection.requested ? `requested \`${selection.requested}\`` : "no request recorded";
  if (selection.verification !== "verified") {
    return `\n\n**${slot}** — ${requested}; the agent reports no effective value (unavailable).\n\n`;
  }
  const effective = `effective \`${selection.effective}\``;
  return `\n\n**${slot}** — ${requested}, ${effective}${isMismatch(selection) ? " — **mismatch**" : ""}.\n\n`;
}

function configLine(model?: string, effort?: string): string {
  const parts = [
    model ? `model \`${clampForDisplay(model, MAX_LABEL_CHARS)}\`` : undefined,
    effort ? `effort \`${clampForDisplay(effort, MAX_LABEL_CHARS)}\`` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(", ") : "the agent reports no model or effort";
}

function usageLine(used: number, size: number, cost?: { amount: number; currency: string }): string {
  const window = size > 0 ? `context ${used}/${size}` : `context ${used}`;
  // A Runtime that reports no cost leaves it unknown; it is never inferred.
  return cost
    ? `${window} · cost ${cost.amount} ${clampForDisplay(cost.currency, MAX_LABEL_CHARS)}`
    : `${window} · cost unknown`;
}

function planLine(entry: { content: string; status: string; priority: string }): string {
  return `- [${entry.status === "completed" ? "x" : " "}] ${entry.content} _(${entry.priority})_`;
}

function commandLabel(command: { name: string }): string {
  return `\`/${clampForDisplay(command.name, MAX_LABEL_CHARS)}\``;
}

/**
 * Agent text inside a blockquote. Blank lines are collapsed rather than
 * prefixed: a blank line ends a Markdown blockquote, so a thought containing one
 * would go on rendering outside it as ordinary prose — which is exactly the
 * separation `showThinking` exists to draw.
 */
function quote(text: string): string {
  return `\n\n> ${text.replace(/\n\s*\n/g, "\n").replace(/\n/g, "\n> ")}\n\n`;
}

/** The chat ports still are the VS Code API they stand for; see `config.ts`. */
export type ChatSinkPortsMatchVsCodeApi = [
  Assert<vscode.ChatResponseStream extends ChatStream ? true : false>,
  Assert<ChatCommand extends vscode.Command ? true : false>,
  // The gate's own self-test: a member VS Code does not implement is rejected.
  Assert<vscode.ChatResponseStream extends { sparkle(): void } ? false : true>,
];
