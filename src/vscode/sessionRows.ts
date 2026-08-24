import {
  isMismatch,
  redactSecrets,
  type EffectiveSelection,
  type ResumeBlock,
  type SessionState,
} from "../core/index.js";
import { clampForDisplay, MAX_DETAIL_CHARS, MAX_LABEL_CHARS } from "./permissions.js";
import { plainText } from "./sealing.js";
import type { SessionCost, SessionNode } from "./sessionsTree.js";

/**
 * What one row in the Sessions tree says.
 *
 * Apart from the tree because it is the half with a rule of its own: everything
 * drawn here is an Agent's or a repository's own text on its way onto the
 * screen, so it is redacted against the values that Session's process was
 * started with, sealed for a surface with no markdown, and bounded — a Runtime
 * id comes from settings a repository can write, and a model id is the Agent's
 * to choose (ADR-0007, ADR-0010).
 */

/** Icon ids the tree names. The composition root turns them into ThemeIcons. */
export const ICONS: Record<"running" | "waiting" | "broken" | "ended", string> = {
  running: "loading~spin",
  waiting: "circle-filled",
  broken: "error",
  ended: "circle-outline",
};

/** Context values the manifest's `when` clauses match on. */
export const LIVE_CONTEXT = "agentConductor.session.live";
export const RESUMABLE_CONTEXT = "agentConductor.session.resumable";
export const PAST_CONTEXT = "agentConductor.session.past";
/**
 * Appended when another window says it still has this Session open.
 *
 * Its own mark rather than a shade of `past`, because what it stops is
 * different: a Session this window merely cannot resume is still one whose
 * leftovers it may clear up, and a Session somebody else is *running* is not.
 * Sessions are remembered per machine and worktrees live under one root, so
 * "not live here" is not the same as "not live".
 */
export const HELD_MARK = ".held";

/** Appended to any of the above when the Session has a worktree of its own. */
export const WORKTREE_MARK = ".worktree";

export function contextValue(node: SessionNode): string {
  const base = node.live ? LIVE_CONTEXT : node.blocked ? PAST_CONTEXT : RESUMABLE_CONTEXT;
  const held = node.blocked === "held-elsewhere" ? HELD_MARK : "";
  return `${base}${held}${node.worktree ? WORKTREE_MARK : ""}`;
}

export function iconFor(state: SessionState): keyof typeof ICONS {
  if (state === "prompting" || state === "configuring") return "running";
  if (state === "cancelling" || state === "idle") return "waiting";
  return state === "failed" ? "broken" : "ended";
}

/** `state · model · effort · cost · duration`, in that order. */
export function describe(node: SessionNode): string {
  return [
    node.state,
    selectionText("model", node.model),
    selectionText("effort", node.effort),
    costText(node.cost),
    node.runningMs === undefined
      ? node.lastActiveMs === undefined
        ? undefined
        : `${durationText(node.lastActiveMs)} ago`
      : durationText(node.runningMs),
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
}

/**
 * One selection, with the two markers Read-back exists for (ADR-0005).
 *
 * `?` is a value that was asked for and never confirmed — the Agent reports no
 * effective value, so nothing here may claim it is running. `⚠` is the clamp
 * itself: the Agent confirmed something other than what was requested.
 */
export function selectionText(slot: string, selection?: EffectiveSelection): string | undefined {
  if (!selection) return undefined;
  if (selection.verification !== "verified") {
    return selection.requested ? `${slot} ${label(selection.requested)}?` : undefined;
  }
  const effective = selection.effective;
  if (!effective) return undefined;
  return `${slot} ${label(effective)}${isMismatch(selection) ? " ⚠" : ""}`;
}

/** A Runtime that reports no cost leaves it unknown; it is never inferred. */
export function costText(cost?: SessionCost): string {
  return cost ? `cost ${cost.amount} ${label(cost.currency)}` : "cost unknown";
}

export function durationText(elapsedMs: number): string {
  // Not clamped here: what can be negative is `now` minus a stamp another window
  // wrote, and that is clamped where it is computed. Two clamps on one value are
  // two no test can break.
  const seconds = Math.round(elapsedMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

const BLOCKED_REASON: Record<ResumeBlock, string> = {
  "held-elsewhere": "another window still has it open",
  "runtime-gone": "its runtime is no longer configured or approved",
  "trust-changed": "its runtime's approved identity has changed since it ran",
  "workspace-closed": "its folder is not open in this window",
  "agent-cannot-load": "that agent does not support session/load",
};

export function tooltip(node: SessionNode): string {
  const worktree = node.worktree;
  const lines = [
    // First, not last: the tooltip is bounded as a whole and two of the lines
    // below carry a path somebody else chose the length of. The one line that
    // says what to do about the row must not be the one that falls off the end.
    node.blocked ? `Cannot be resumed: ${BLOCKED_REASON[node.blocked]}.` : undefined,
    `${node.live ? "Running" : "Ended"} on ${label(node.runtimeId)}`,
    `Session ${label(node.shownId)}`,
    `Folder ${label(node.shownWorkspace, MAX_DETAIL_CHARS)}`,
    readBack("Model", node.model),
    readBack("Effort", node.effort),
    `Cost: ${costText(node.cost).replace(/^cost /, "")}`,
    node.runningMs === undefined
      ? node.lastActiveMs === undefined
        ? undefined
        : `Last active ${durationText(node.lastActiveMs)} ago`
      : `Running for ${durationText(node.runningMs)}`,
    worktree
      ? `Worktree ${label(worktree.path, MAX_DETAIL_CHARS)} on ${label(worktree.branch)}`
      : undefined,
  ];
  // Bounded as a whole, not only per part: two of these carry a path, and a
  // tooltip sized only by its pieces is one whose length is somebody else's.
  return clampForDisplay(
    lines.filter((line): line is string => line !== undefined).join("\n"),
    MAX_DETAIL_CHARS,
  );
}

export function readBack(slot: string, selection?: EffectiveSelection): string {
  if (!selection) return `${slot}: not recorded`;
  const requested = selection.requested ? `requested ${label(selection.requested)}` : "no request recorded";
  if (selection.verification !== "verified") {
    return `${slot}: ${requested}; the agent reports no effective value (unavailable)`;
  }
  // Read the same way the row reads it: `verified` with no value is an Agent
  // naming a selector and no current value, which is not an effective value.
  if (!selection.effective) {
    return `${slot}: ${requested}; the agent reports no effective value`;
  }
  const effective = `effective ${label(selection.effective)}`;
  return `${slot}: ${requested}, ${effective}${isMismatch(selection) ? " — mismatch" : ""}`;
}

/**
 * One Agent- or repository-chosen string on its way into a row.
 *
 * A tree label has no markdown of its own, so this is the plain-text rule and
 * not the inline one — and it is bounded, because a Runtime id comes from
 * settings a repository can write and a model id is the Agent's to choose.
 */
export function label(text: string, limit = MAX_LABEL_CHARS): string {
  return clampForDisplay(plainText(text).trim(), limit);
}

/** What an Agent worded, with the values its process was started with taken out
 *  — the same barrier a record passes on its way to disk (ADR-0010). */
export function safeText(text: string, secrets: readonly string[]): string {
  return secrets.length === 0 ? text : redactSecrets(text, secrets);
}

export function safeSelection(
  selection: EffectiveSelection,
  secrets: readonly string[],
): EffectiveSelection {
  if (secrets.length === 0) return selection;
  return {
    ...(selection.requested === undefined ? {} : { requested: safeText(selection.requested, secrets) }),
    ...(selection.effective === undefined ? {} : { effective: safeText(selection.effective, secrets) }),
    verification: selection.verification,
  };
}
