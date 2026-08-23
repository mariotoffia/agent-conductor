import type * as acp from "@agentclientprotocol/sdk";
import {
  HELD_BEAT_MS,
  message,
  redactSecrets,
  saveSession,
  type AgentExit,
  type ConductorSession,
  type EffectiveSelection,
  type LogPort,
  systemClock,
  type ClockPort,
  type SessionState,
  type StoragePort,
} from "../core/index.js";
import type { Assert } from "./permissions.js";

/**
 * Writing a live Session down as a Persisted Session (ADR-0008).
 *
 * Apart from the composition root because it decides something: a Session whose
 * launch identity is unknown is one nothing could ever re-derive resumability
 * for, and is not written at all.
 */

/** The part of a Session a record is written from. */
export interface RecordedSession {
  readonly sessionId: string;
  readonly state: SessionState;
  readonly handshake: acp.InitializeResponse;
  readonly modelSelection: EffectiveSelection;
  readonly effortSelection: EffectiveSelection;
  readonly exited: Promise<AgentExit>;
}

/**
 * Structural, so this can be exercised without an Agent process — and asserted
 * against the real class, so a `ConductorSession` that stopped offering one of
 * these fails the build here rather than at wiring time.
 */
export type SessionsAreRecordable = [
  Assert<ConductorSession extends RecordedSession ? true : false>,
];

/**
 * Remembers one Session as a Persisted Session: once when it opens, and again
 * when its process is gone, so the record says how it ended rather than only
 * that it began (ADR-0008).
 *
 * Nothing waits on either write. Saving is a convenience — every Session starts
 * without it — and a Turn must not queue behind a file, so a failure is logged
 * and the Session carries on.
 */
export function remember(
  session: RecordedSession,
  storage: StoragePort,
  log: LogPort,
  about: {
    runtimeId: string;
    fingerprint?: string;
    workspace: string;
    secrets: string[];
    /** This window's id, written beside the hold below. */
    window: string;
    /** Drives the heartbeat below; the system clock when nothing supplies one. */
    clock?: ClockPort;
  },
): void {
  // Without the fingerprint the Session ran under there is nothing to re-derive
  // resumability from later, so there is nothing worth writing down.
  const fingerprint = about.fingerprint;
  if (!fingerprint) return;
  // Wrapped, so a throw from reading the Session becomes a rejection this
  // catches rather than one nobody is waiting for.
  const clock = about.clock ?? systemClock;
  const save = (ended = false): void => {
    void (async () =>
      saveSession(
        storage,
        {
          sessionId: session.sessionId,
          runtimeId: about.runtimeId,
          fingerprint,
          workspace: about.workspace,
          state: ended ? endedState(session.state) : session.state,
          // Said while the Session is still open, and left unsaid once it is
          // not: another window reads this to tell a Session that ended from one
          // this window is still running (ADR-0008).
          ...(ended ? {} : { heldAt: Date.now(), heldBy: about.window }),
          // Both ways back into a session — `session/load` and `session/resume`
          // — take the id and nothing secret, so the id is the handle. This
          // Client sends the first and only the first, so that is the gate.
          loadable: session.handshake.agentCapabilities?.loadSession === true,
          model: session.modelSelection,
          effort: session.effortSelection,
        },
        Date.now(),
        about.secrets,
      ))().catch((error: unknown) => {
      log.log(
        "error",
        `runtime ${about.runtimeId}: this session was not saved:` +
          ` ${redactSecrets(message(error), about.secrets)}`,
      );
    });
  };
  save();
  // Said again while the Session lives, so that a window which is killed simply
  // stops saying it. A flag set once and cleared on the way out would be a flag
  // a crash leaves set for ever, and the conversation it named unreachable.
  let stopBeating = (): void => undefined;
  const beat = (): void => {
    stopBeating = clock.after(HELD_BEAT_MS, () => {
      save();
      beat();
    });
  };
  beat();
  void session.exited.then(() => {
    stopBeating();
    save(true);
  });
}

/**
 * How a Session ended, once its process is gone.
 *
 * A Session that was taking a Turn when its Agent died is left on `prompting`:
 * the Session's own exit handler only promotes the states it can be sure about,
 * and the Turn's failure lands later, after the record has been written. Left
 * as it was, the record says a Turn is under way and every window afterwards
 * draws that row as one still working — for good, because there is no third
 * write. A process that is gone ended the Session, whatever it was doing.
 *
 * A Session on `cancelling` ended because somebody asked it to, whichever side
 * did the stopping — an Agent may answer `session/cancel` by exiting. Recording
 * that as a failure would draw a broken icon over a Turn that did what it was
 * told.
 */
function endedState(state: SessionState): SessionState {
  if (state === "disposed" || state === "failed") return state;
  return state === "cancelling" ? "disposed" : "failed";
}
