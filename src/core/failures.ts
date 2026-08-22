import { redactSecrets } from "./redaction.js";
import type { AgentExit } from "./types.js";

/**
 * How a failure is described.
 *
 * Kept together because the hard part is not the wording but what each kind of
 * failure is allowed to claim: a Runtime that shut down politely exits exactly
 * like one that crashed, so the cause is reported rather than inferred, and an
 * Agent's own diagnostics travel with every message because they are usually
 * the only thing that says what actually went wrong.
 */

function describeExit(exit: AgentExit): string {
  return exit.error
    ? `could not be started: ${exit.error.message}`
    : `exited with ${exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`}`;
}

/** Failure message for a process that ended when we still needed it. */
export function exitError(runtimeId: string, exit: AgentExit, stderrTail: string): Error {
  return new Error(`runtime ${runtimeId}: agent process ${describeExit(exit)}${tailOf(stderrTail)}`, {
    cause: exit.error,
  });
}

/** Setup failure: which stage failed, why, and how the Agent process ended. */
export function stageError(
  runtimeId: string,
  stage: string,
  error: unknown,
  exit: AgentExit | undefined,
  stderrTail: string,
  /** Values the Agent was started with. Required, not defaulted: a call site
   *  that forgot them would otherwise compile and quietly print one. */
  secrets: string[],
): Error {
  const ending = exit ? ` (agent process ${describeExit(exit)})` : "";
  const said = redactSecrets(message(error), secrets);
  return new Error(`runtime ${runtimeId}: ${stage} failed: ${said}${ending}${tailOf(stderrTail)}`, {
    cause: error,
  });
}

/**
 * Why a Turn failed. The Agent's exit status when we have it, and its own recent
 * output either way — the exit event can trail the connection close, so the
 * status may still be unknown while the diagnostics are the useful part.
 */
export function turnError(
  session: { runtimeId: string; sessionId: string; secrets?: string[] },
  error: unknown,
  exit: AgentExit | undefined,
  stderrTail: string,
): Error {
  if (exit) return exitError(session.runtimeId, exit, stderrTail);
  // The Agent's own words, and it was started with resolved credentials in its
  // environment: an error it composes is as likely to quote one as its stderr
  // is, and this message reaches a log and a transcript (ADR-0010).
  const said = redactSecrets(message(error), session.secrets ?? []);
  return new Error(`session ${session.sessionId}: turn failed: ${said}${tailOf(stderrTail)}`, {
    cause: error,
  });
}

/** A Turn the Client ended because the Agent went quiet for too long. */
export function stallError(sessionId: string, ms: number): Error {
  return new Error(`session ${sessionId}: agent produced no output for ${ms}ms; the turn was ended`);
}

/** Labels the Agent's own output: the buffer spans the connection, not one Turn. */
export function tailOf(stderrTail: string): string {
  const tail = stderrTail.trim();
  return tail ? `\nrecent agent output:\n${tail}` : "";
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
