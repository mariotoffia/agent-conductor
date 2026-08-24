/**
 * A Turn that stops and waits for `session/cancel`, as an Agent doing real work
 * does.
 *
 * Its own module because both the Mock Agent and the tests that drive it need to
 * agree on the words: the prompt that asks for it is a constant here rather than
 * a string each side spells for itself.
 */

/** Turns waiting to be cancelled, by Session id. */
const pending = new Map<string, () => void>();

/**
 * What a client sends to stop one Turn without a Runtime of its own.
 *
 * Keyed on the prompt rather than on a `--mode=`, because a VS Code extension
 * host has exactly one chat participant and it remembers the Runtime it was last
 * given — driving a Turn to a standstill in there would otherwise mean switching
 * Runtime and switching back, for no gain.
 */
export const WAIT_TO_BE_CANCELLED = "Wait to be cancelled";

/** Blocks until this Session's `session/cancel` arrives. Call it before saying
 *  anything, so a cancellation that races the first chunk is still caught. */
export function untilCancelled(sessionId: string): Promise<void> {
  return new Promise<void>((settle) => pending.set(sessionId, settle));
}

/** Releases a Turn waiting on `untilCancelled`. Safe when none is. */
export function releaseCancelled(sessionId: string): void {
  pending.get(sessionId)?.();
  pending.delete(sessionId);
}

/**
 * Says so, then waits to be cancelled — a Turn a client can catch mid-flight.
 *
 * The wait is armed before anything is said, so a cancellation that races the
 * first chunk is still caught. The reply is written the way an Agent writes it:
 * `cancelled` is the Agent's own word for how the Turn ended, and a Client that
 * reported anything else would be saying the Turn was abandoned.
 */
export async function standStill(
  sessionId: string,
  say: (text: string) => Promise<void>,
): Promise<{ stopReason: "cancelled" }> {
  const cancelled = untilCancelled(sessionId);
  await say("Waiting for cancellation");
  await cancelled;
  return { stopReason: "cancelled" };
}
