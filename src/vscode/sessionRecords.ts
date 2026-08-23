import type * as acp from "@agentclientprotocol/sdk";
import {
  message,
  redactSecrets,
  saveSession,
  type AgentExit,
  type ConductorSession,
  type EffectiveSelection,
  type LogPort,
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
  about: { runtimeId: string; fingerprint?: string; workspace: string; secrets: string[] },
): void {
  // Without the fingerprint the Session ran under there is nothing to re-derive
  // resumability from later, so there is nothing worth writing down.
  const fingerprint = about.fingerprint;
  if (!fingerprint) return;
  // Wrapped, so a throw from reading the Session becomes a rejection this
  // catches rather than one nobody is waiting for.
  const save = (): void => {
    void (async () =>
      saveSession(
        storage,
        {
          sessionId: session.sessionId,
          runtimeId: about.runtimeId,
          fingerprint,
          workspace: about.workspace,
          state: session.state,
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
  void session.exited.then(save);
}
