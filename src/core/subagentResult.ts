/**
 * What a finished Subagent is worth telling its parent, and what it is built
 * from.
 *
 * Apart from the Orchestrator because a result is a *summary*: a parent shares
 * no conversation with its child, so what crosses back is the child's last
 * words and what they cost — never its transcript. Keeping the shape and the
 * thing that fills it in one file is what stops the two drifting.
 */
import type * as acp from "@agentclientprotocol/sdk";
import type { EffectiveSelection } from "./types.js";

/** Longest final message carried back to a parent. A result is a summary. */
export const MAX_RESULT_CHARS = 20_000;

export type SubagentState = "running" | "done" | "failed" | "cancelled" | "timed_out";

/** What a finished Subagent is worth telling its parent about. */
export interface SubagentResult {
  handle: string;
  runtime: string;
  /** The child Agent's own session id, empty if it never got that far. */
  sessionId: string;
  state: SubagentState;
  stopReason?: string;
  /** The child's final message, bounded. Never its conversation. */
  text?: string;
  model: EffectiveSelection;
  effort: EffectiveSelection;
  /**
   * What the child cost, when its Agent said so.
   *
   * `"unknown"` is a real answer and never a zero: a Runtime that reports
   * nothing has not reported nothing spent (ADR-0005 applied to money).
   */
  cost: { amount: number; currency: string } | "unknown";
  /** Whether the Runtime itself held the money limit, or only we did. */
  budget: "enforced" | "unenforced";
  worktree?: { path: string; branch: string };
  error?: string;
}


export interface Watcher {
  observe(notification: acp.SessionNotification): void;
  text(): string;
  cost(): { amount: number; currency: string } | undefined;
}

/**
 * What a child's Updates are worth keeping: its last words, and what it cost.
 *
 * Bounded, because this ends up inside one socket frame the Shim has to be able
 * to read — a result beyond the limit is refused wholesale, and a parent that
 * asked for a summary would get nothing at all.
 */
export function watcher(): Watcher {
  let text = "";
  let cost: { amount: number; currency: string } | undefined;
  return {
    observe(notification) {
      const update = notification.update as Record<string, unknown> | undefined;
      if (!update) return;
      const money = update.cost as { amount?: unknown; currency?: unknown } | undefined;
      if (
        typeof money?.amount === "number" &&
        Number.isFinite(money.amount) &&
        typeof money.currency === "string"
      ) {
        cost = { amount: money.amount, currency: money.currency };
      }
      if (update.sessionUpdate !== "agent_message_chunk") return;
      const content = update.content as { type?: unknown; text?: unknown } | undefined;
      if (content?.type !== "text" || typeof content.text !== "string") return;
      if (text.length < MAX_RESULT_CHARS) text = `${text}${content.text}`.slice(0, MAX_RESULT_CHARS);
    },
    text: () => text,
    cost: () => cost,
  };
}
