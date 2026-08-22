import { breakLinks, REORDERING } from "../core/index.js";
import { clampForDisplay } from "./permissions.js";

/**
 * Sealing: making an Agent's — or a repository's — own text safe to draw inside
 * a line this Client wrote (UBIQUITOUS.md).
 *
 * One module, because the rule follows the *destination* and not the source, and
 * every place that got its own version of it drifted: three rounds of review
 * each found a string drawn unsealed somewhere the round before had not thought
 * of. There are exactly two destinations — inside a code span, and everywhere
 * else — and one rule about links that both share.
 */

/**
 * One agent-chosen string bound for a code span.
 *
 * Backticks and line endings are all that can leave one: inside `` ` `` every
 * other character is literal, so escaping there would show the user backslashes
 * the Agent never sent — and a model id is meant to be what it said (ADR-0005).
 * Links are literal in there too, so they are left as they are.
 *
 * A code span and nothing else. A progress line takes a plain `string` where the
 * markdown parts take a `MarkdownString`, which reads as though nothing in it
 * renders — but VS Code builds the part with the same conversion and draws it
 * with the same renderer, so what goes there is sealed with `inlineText`.
 */
export function spanText(text: string, limit: number): string {
  return clampForDisplay(text.replace(REORDERING, "").replace(/[`\r\n]+/g, " ").trim(), limit);
}

/**
 * One agent-chosen string bound for a line this Client wrote — bold, or bare.
 *
 * Emphasis is escaped rather than deleted, because a glob is the most common
 * thing in a tool title and `**\/*.ts` cut down to ` / .ts` names a file nobody
 * has. The backslash is escaped first and for the same reason it exists: an
 * Agent supplying its own would otherwise escape our escape and free the
 * delimiter after it.
 *
 * Not idempotent, so nothing may seal a string twice — what is retained between
 * Updates is the Agent's own text, sealed on the way out.
 */
export function inlineText(text: string, limit: number): string {
  const sealed = breakLinks(
    text.replace(REORDERING, "").replace(/[`\r\n]+/g, " ").replace(/([\\*_~])/g, "\\$1"),
  ).trim();
  return clampForDisplay(sealed, limit);
}

/** Re-exported so the one place that seals is the one place to import from. */
export { plainText } from "../core/index.js";
