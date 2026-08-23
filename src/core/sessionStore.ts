import { z } from "zod";
import { redactSecrets } from "./redaction.js";
import type { EffectiveSelection, SessionState, StoragePort } from "./types.js";

/**
 * Persisted Sessions: what is remembered about a Session once its process is
 * gone, so a later window can offer to reattach to it (ADR-0008).
 *
 * Metadata only. There is no field here for a prompt, a tool payload, hidden
 * context or a credential — which is the point: a record cannot carry what the
 * shape has nowhere to put, and an unknown key read back off disk is dropped
 * rather than kept. That is a stronger guarantee than a rule about what callers
 * should write, because it is one a test can check.
 *
 * ACP v1 has no resume token. Both ways back into a session — `session/load`
 * and `session/resume` — take the session id, the `cwd`, the MCP servers and the
 * additional directories, and nothing secret, so the id *is* the handle. This
 * Client sends `session/load` and only that, which is what `loadable` records:
 * an Agent offering `sessionCapabilities.resume` alone is one nothing here can
 * reattach to, so its Sessions are history rather than something to offer back.
 * Should a Runtime ever hand out a token of its own, it is a credential: it goes
 * to SecretStorage and this record holds the key it is stored under, never the
 * value.
 */

/** Storage key holding every Persisted Session for this installation. */
export const SESSIONS_KEY = "sessions.json";

/**
 * Where a store written under another version is put before it is replaced.
 *
 * Bumping the version makes every existing record unreadable, and the save that
 * follows — the user's next ordinary session — would replace the file with one
 * record and nothing could ever get the rest back. Kept aside instead, so the
 * migration that should have come with the bump can still be written afterwards.
 * Only a document whose envelope this build recognises is worth keeping: corrupt
 * text is not something a later build could read either.
 *
 * Keyed by the version it holds, because one name would mean the second bump
 * destroyed what the first one kept — and two bumps with no migration written in
 * between is ordinary, since nothing here forces one to be written.
 */
export function supersededKey(version: number): string {
  // A number out of a file decides part of a filename here. It is safe because
  // the envelope has already made it an integer, and no integer's text carries a
  // path separator — a sanitiser on top of that would be a branch nothing can
  // reach, which is its own kind of untruth.
  return `sessions.superseded.${version}.json`;
}

/**
 * Shape of the file on disk. Bumped when a field changes meaning; a file
 * written under any other version is not read, because a record half-understood
 * is worse than one forgotten — this is metadata a Session can be started
 * without (ADR-0008).
 */
export const SESSIONS_VERSION = 1;

/**
 * Longest any one stored string may be.
 *
 * An Agent chooses its own session id and words what it reports running, so
 * without a ceiling the size of this file is the Agent's to decide. Generous
 * enough for the longest thing that is really in here — an absolute path.
 */
export const MAX_RECORD_CHARS = 1024;

/** How many Sessions are remembered. A window that opens one per turn would
 *  otherwise grow this file for as long as the extension is installed. */
export const MAX_SESSIONS = 200;

/** Ceiling on the file itself, applied before it is parsed: what the two caps
 *  above allow, with room to spare, and far less than a host should ever hold. */
export const MAX_SESSIONS_TEXT = 4 * 1024 * 1024;

/** What a Session is, once it is only a record. */
export interface SessionFacts {
  /** The Agent's own session id — what `session/load` is addressed with. */
  sessionId: string;
  runtimeId: string;
  /** Runtime Trust fingerprint the Session ran under. Evidence, not a verdict:
   *  resumability is re-derived from it against what the Runtime resolves to
   *  now, so a launch that changed takes its saved Sessions with it (ADR-0008). */
  fingerprint: string;
  /** Absolute session `cwd`. */
  workspace: string;
  /** Where the Session stopped. */
  state: SessionState;
  /** The Agent advertised `loadSession`, the one way back this Client sends.
   *  Without it there is nothing to reattach to, whatever else the record says. */
  loadable: boolean;
  model?: EffectiveSelection;
  effort?: EffectiveSelection;
  /** The Session that spawned this one, for the Subagent tree. */
  parentSessionId?: string;
  worktree?: { path: string; branch: string };
}

/** One saved Session: the facts, plus when they were first and last written. */
export interface PersistedSession extends SessionFacts {
  createdAt: number;
  updatedAt: number;
}

/** Compile-time assertion: `Assert<false>` is a type error. */
type Assert<T extends true> = T;

/**
 * The states a record may carry, and proof that they are exactly the Session's.
 *
 * Two lists of one thing drift, and this pair drifts silently in the worst
 * direction: a state added to `SessionState` and not here would make every
 * record in it fail to validate, so those Sessions would simply stop appearing.
 */
const STATES = ["idle", "configuring", "prompting", "cancelling", "failed", "disposed"] as const;

export type RecordStatesMatchSessionState = [
  Assert<SessionState extends (typeof STATES)[number] ? true : false>,
  Assert<(typeof STATES)[number] extends SessionState ? true : false>,
];

const text = z
  .string()
  .min(1)
  .max(MAX_RECORD_CHARS, `is over ${MAX_RECORD_CHARS} characters — too long to save`);

const selection = z.object({
  requested: text.optional(),
  effective: text.optional(),
  verification: z.enum(["verified", "unavailable"]),
});

const record = z.object({
  sessionId: text,
  runtimeId: text,
  fingerprint: text,
  workspace: text,
  state: z.enum(STATES),
  loadable: z.boolean(),
  model: selection.optional(),
  effort: selection.optional(),
  parentSessionId: text.optional(),
  worktree: z.object({ path: text, branch: text }).optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

const envelope = z.object({ version: z.number().int(), sessions: z.array(z.unknown()) });

/**
 * Every Persisted Session, most recently written first.
 *
 * Never throws. Resuming is a convenience — every Session can be started
 * without it — so a file that cannot be read, parsed or recognised is no saved
 * Sessions rather than a window that will not open.
 */
export async function readSessions(storage: StoragePort): Promise<PersistedSession[]> {
  try {
    return (await loadSessions(storage)).sessions;
  } catch {
    return [];
  }
}

/**
 * The same, but a store that could not be *read* is a failure rather than an
 * absence.
 *
 * That distinction is the whole of it. A save is a read and a replace, so a
 * momentary read failure reported as "there is nothing here" would have the
 * save write one record over every record it could not see. Only the read
 * itself may throw: a file that is missing, oversized, unparseable, of an
 * unrecognised version or full of records that do not validate is genuinely
 * unusable, and replacing one of those is the right thing to do.
 */
async function loadSessions(
  storage: StoragePort,
): Promise<{ raw?: string; sessions: PersistedSession[] }> {
  const raw = await storage.read(SESSIONS_KEY);
  if (raw === undefined || raw.length > MAX_SESSIONS_TEXT) return { sessions: [] };
  return { raw, sessions: readable(raw) };
}

/**
 * The version of a store some other build wrote: an envelope whose shape this
 * one knows, carrying a version it does not. `undefined` for anything else.
 *
 * Asked only when a document yielded no Sessions at all, so the ordinary save
 * never pays for it twice.
 */
function supersededVersion(raw: string): number | undefined {
  try {
    const parsed = envelope.safeParse(JSON.parse(raw));
    if (!parsed.success || parsed.data.version === SESSIONS_VERSION) return undefined;
    return parsed.data.version;
  } catch {
    return undefined;
  }
}

/** What a stored document yields, dropping whatever it cannot account for. A
 *  record that does not validate is dropped on its own, so one bad entry does
 *  not cost the rest. */
function readable(raw: string): PersistedSession[] {
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    return [];
  }
  const parsed = envelope.safeParse(document);
  if (!parsed.success || parsed.data.version !== SESSIONS_VERSION) return [];
  const sessions: PersistedSession[] = [];
  for (const entry of parsed.data.sessions) {
    // Unknown keys are stripped rather than kept: a file written by another
    // build may carry fields this one does not understand, and a record is
    // metadata — nothing read back off disk earns a place it has no field for.
    const one = record.safeParse(entry);
    if (one.success) sessions.push(one.data);
  }
  return sessions.sort((left, right) => right.updatedAt - left.updatedAt);
}

/**
 * Writes one Session's metadata, replacing what was known about it before.
 *
 * `secrets` are the values this Session's Agent was started with. Everything an
 * Agent chooses — the session id most of all, and whatever it reports running —
 * passes through them on the way to a file that outlives the process (ADR-0010).
 *
 * Two windows share one storage directory, so a save is a read and a replace and
 * the later one wins. What is at stake is one record of metadata written in the
 * same moment by another window; the Session itself is unaffected, and a Session
 * can always be started without any of this.
 */
export function saveSession(
  storage: StoragePort,
  facts: SessionFacts,
  now: number,
  secrets: Iterable<string> = [],
): Promise<void> {
  const write = (): Promise<void> => replace(storage, facts, now, [...secrets]);
  // Queued here rather than left to callers: a save is a read and a replace, so
  // two in flight together read the same file and the later one writes the
  // earlier one away. A caller that has to remember an ordering rule is a caller
  // that will forget it, and the Session that vanishes is somebody else's.
  // A predecessor that failed is still a predecessor — it must not take the
  // saves queued behind it down with it.
  const queued = (writes.get(storage) ?? Promise.resolve()).then(write, write);
  // The chain itself never rejects; the caller's own promise still does.
  writes.set(storage, queued.catch(() => undefined));
  return queued;
}

/** One write at a time per store. Keyed weakly so a store nothing holds any
 *  more takes its queue with it. */
const writes = new WeakMap<StoragePort, Promise<unknown>>();

/**
 * Settles once every save already queued against this store has run.
 *
 * Saves are fire-and-forget — a Turn must never queue behind a file — so this is
 * how anything that needs them finished waits for them without holding one up.
 */
export function savesSettled(storage: StoragePort): Promise<void> {
  return (writes.get(storage) ?? Promise.resolve()).then(() => undefined);
}

async function replace(
  storage: StoragePort,
  facts: SessionFacts,
  now: number,
  secrets: string[],
): Promise<void> {
  // Redacted before anything is compared: a stored record has been through this
  // and a fresh one has not, so matching them on raw text would file every
  // update as a new Session.
  const fresh = check(facts.runtimeId, persisted(facts, now, secrets));
  // Deliberately the reading that throws: replacing a store this could not read
  // would write one Session over all of them.
  const stored = await loadSessions(storage);
  const kept = stored.sessions;
  if (stored.raw !== undefined && kept.length === 0) {
    const version = supersededVersion(stored.raw);
    if (version !== undefined) await storage.writeAtomic(supersededKey(version), stored.raw);
  }
  const previous = kept.find((entry) => sameSession(entry, fresh));
  const written: PersistedSession = { ...fresh, createdAt: previous?.createdAt ?? now };
  // Sorted before it is cut, never merely prepended: the newest Session is
  // whichever has the latest stamp, and the one being written is not always it —
  // a clock that stepped back, or a second window, is enough.
  const sessions = [written, ...kept.filter((entry) => !sameSession(entry, fresh))]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_SESSIONS);
  await storage.writeAtomic(SESSIONS_KEY, JSON.stringify({ version: SESSIONS_VERSION, sessions }));
}

/**
 * One record, built field by field.
 *
 * Never by spreading what the caller handed over: that would make the caller's
 * object the shape of the file, and a prompt, a tool payload or a credential
 * that rode along on it would be on disk before anything looked at it. Copying
 * the named fields is what makes "a record holds metadata only" true of the
 * file, and it is the only thing that does on this side — `check` validates what
 * comes out of here rather than reshaping it, so this discipline is something a
 * test can break rather than something another layer quietly covers for.
 */
function persisted(facts: SessionFacts, now: number, secrets: string[]): PersistedSession {
  const safe = (value: string): string => redactSecrets(value, secrets);
  const safely = (value: EffectiveSelection): EffectiveSelection => ({
    ...(value.requested === undefined ? {} : { requested: safe(value.requested) }),
    ...(value.effective === undefined ? {} : { effective: safe(value.effective) }),
    verification: value.verification,
  });
  return {
    sessionId: safe(facts.sessionId),
    runtimeId: safe(facts.runtimeId),
    fingerprint: safe(facts.fingerprint),
    workspace: safe(facts.workspace),
    state: facts.state,
    loadable: facts.loadable,
    ...(facts.model ? { model: safely(facts.model) } : {}),
    ...(facts.effort ? { effort: safely(facts.effort) } : {}),
    ...(facts.parentSessionId ? { parentSessionId: safe(facts.parentSessionId) } : {}),
    ...(facts.worktree
      ? { worktree: { path: safe(facts.worktree.path), branch: safe(facts.worktree.branch) } }
      : {}),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Refuses a record the store could not read back.
 *
 * Checked on the way in rather than only on the way out, so a write can never
 * produce a file whose records are silently dropped at the next read. The
 * failure names the field and the rule, never the value: what overflowed is an
 * Agent's own text, and this message is going to a log (ADR-0010).
 */
function check(runtimeId: string, written: PersistedSession): PersistedSession {
  const parsed = record.safeParse(written);
  // What was validated, not the copy the schema stripped: a second barrier here
  // would silently cover for `persisted` losing its discipline, and a guarantee
  // no test can break is one nobody finds out has gone. Stripping still happens
  // where a document arrives from outside, which is where it is the answer.
  if (parsed.success) return written;
  const issue = parsed.error.issues[0];
  throw new Error(
    `runtime ${runtimeId}: this session cannot be saved —` +
      ` ${issue?.path.join(".") || "a field"} ${issue?.message ?? "is invalid"}`,
  );
}

/** One Session is one Agent's id in one workspace: an ACP session id is unique
 *  to the Agent that issued it and to nothing beyond it. */
function sameSession(left: SessionFacts, right: SessionFacts): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.runtimeId === right.runtimeId &&
    left.workspace === right.workspace
  );
}

// ---------------------------------------------------------------------------
// Whether a saved Session may be reattached to. Pure, and told what is true
// rather than reading it: the settings, the trust store and the open folders all
// live on the other side of the seam, and a rule that fetches its own inputs is
// one no test can put in a state (ADR-0003).
// ---------------------------------------------------------------------------

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
}

/** Why a saved Session cannot be reattached to. */
export type ResumeBlock =
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
  session: PersistedSession,
  conditions: ResumeConditions,
): ResumeBlock | undefined {
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
