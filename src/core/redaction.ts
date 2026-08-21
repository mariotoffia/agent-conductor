/**
 * Keeping resolved secrets out of everything a human or a log file will read
 * (ADR-0010).
 *
 * Values are removed from text, never masked in place and never summarised: a
 * partially shown credential is still a credential. Redaction happens wherever a
 * stream becomes a buffer — which is more places than it looks, because two
 * adjacent log records are joined by whoever reads them just as surely as two
 * chunks are joined by `+`.
 */

const REDACTED = "[redacted]";

/**
 * Shortest value worth removing. Below this a value is not distinguishing
 * enough to be worth mangling an unrelated message over — and a caller deciding
 * how much text to hold back must use the same threshold, or it will hold back
 * text for a value that would never have been removed anyway.
 */
export const MIN_REDACTED_CHARS = 8;

/** Removes resolved secret values from text on its way to a message or a log. */
export function redactSecrets(text: string, values: Iterable<string>): string {
  let redacted = text;
  for (const value of values) {
    if (value.length < MIN_REDACTED_CHARS) continue;
    redacted = redacted.split(value).join(REDACTED);
  }
  return redacted;
}

/**
 * How much of the end of a buffer must be withheld before it is safe to cut.
 *
 * A value may contain a newline of its own — a PEM key does — so a writer that
 * flushed at one inside it would split it across two records before redaction
 * ever saw it whole. Holding back the longest redactable value makes that
 * impossible.
 */
export function redactionGuard(values: Iterable<string>): number {
  let guard = 0;
  for (const value of values) {
    if (value.length >= MIN_REDACTED_CHARS) guard = Math.max(guard, value.length);
  }
  return guard;
}
