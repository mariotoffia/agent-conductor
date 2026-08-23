import { HELD_STALE_MS, type PersistedSession, type SessionFacts } from "./sessionStore.js";

/**
 * Whether a saved Session may be reattached to.
 *
 * Pure, and told what is true rather than reading it: the settings, the trust
 * store, the open folders and the clock all live on the other side of the seam,
 * and a rule that fetches its own inputs is one no test can put in a state
 * (ADR-0003).
 */

/** What is true in this window right now. */
export interface ResumeConditions {
  /**
   * Runtime id to the Runtime Trust fingerprint it resolves to now. A Runtime
   * that is absent is one this window cannot start at all — unconfigured,
   * unavailable, or never approved.
   */
  fingerprints: ReadonlyMap<string, string>;
  /** Absolute workspace roots open in this window. */
  workspaces: readonly string[];
  /** Now, for judging whether another window's hold has gone stale. */
  now: number;
  /** This window's own id, so that its own hold is not read as somebody else's. */
  window: string;
}

/**
 * Everything the answer depends on, and nothing else.
 *
 * Narrower than a whole record on purpose: a caller re-deriving this for a row
 * has to supply exactly the four facts that decide it, and cannot pass three of
 * them plus a fourth this never reads and think it said something.
 */
export type Resumable = Pick<
  SessionFacts,
  "runtimeId" | "fingerprint" | "workspace" | "loadable" | "heldAt" | "heldBy"
>;

/** Why a saved Session cannot be reattached to. */
export type ResumeBlock =
  | "held-elsewhere"
  | "runtime-gone"
  | "trust-changed"
  | "workspace-closed"
  | "agent-cannot-load";

/**
 * What stands between a saved Session and `session/load`, or `undefined` when
 * nothing does.
 *
 * Re-derived every time from what holds now, never read off the record: trust
 * recorded once is trust that outlives the launch it was granted for, which is
 * the whole reason `ResolvedRuntime` re-earns it per spawn (ADR-0007).
 *
 * It does not know which Sessions this window already owns. A caller holding
 * live Sessions leaves them out, or it will offer to open a second process for a
 * conversation it is already in.
 */
export function resumeBlock(
  session: Resumable,
  conditions: ResumeConditions,
): ResumeBlock | undefined {
  // First, and on a stamp rather than a flag: a window that is still running
  // this Session keeps saying so, and one that was killed stops — so a hold
  // ages out instead of outliving the window that took it.
  if (
    session.heldAt !== undefined &&
    session.heldBy !== conditions.window &&
    conditions.now - session.heldAt < HELD_STALE_MS
  ) {
    return "held-elsewhere";
  }
  const fingerprint = conditions.fingerprints.get(session.runtimeId);
  if (fingerprint === undefined) return "runtime-gone";
  if (fingerprint !== session.fingerprint) return "trust-changed";
  // `session/load` re-sends the `cwd` it was created with, and an Agent may
  // refuse a different one. A folder nobody opened is also a folder nobody
  // agreed to run an Agent in.
  if (!conditions.workspaces.includes(session.workspace)) return "workspace-closed";
  // Not "the protocol offers no way back": ACP also defines `session/resume`,
  // which this Client does not send. What is being asked is whether *we* can
  // reattach, and the answer has to be about what we actually do.
  if (!session.loadable) return "agent-cannot-load";
  return undefined;
}

/** The saved Sessions that could be reattached to now, most recent first. */
export function resumableSessions(
  sessions: readonly PersistedSession[],
  conditions: ResumeConditions,
): PersistedSession[] {
  return [...sessions]
    .filter((session) => resumeBlock(session, conditions) === undefined)
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

/**
 * The one Session, if any, that opening a folder may start an Agent for.
 *
 * Off unless `agentConductor.sessions.resumeOnStartup` says otherwise, because
 * activating an extension is not a request to run anything. One at most, and
 * only the most recent: a window that opened an Agent per saved Session would
 * turn a setting into a fork bomb with a friendly name.
 */
export function startupResume(
  sessions: readonly PersistedSession[],
  conditions: ResumeConditions,
  resumeOnStartup: boolean,
): PersistedSession | undefined {
  if (!resumeOnStartup) return undefined;
  return resumableSessions(sessions, conditions)[0];
}
