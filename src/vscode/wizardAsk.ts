import { redactSecrets } from "../core/index.js";
import type { FormHost, QuickItem } from "./elicitation.js";
import { clampForDisplay, MAX_DETAIL_CHARS, MAX_LABEL_CHARS } from "./permissions.js";
import { plainText } from "./sealing.js";
import type { Connection, WizardPorts } from "./wizardPorts.js";

/**
 * How the connection wizard asks, and how it answers back.
 *
 * Shared by both halves of the flow — choosing what to connect, and driving the
 * Agent — so that neither has to import the other. Every question here is
 * cancellable in the same way, and everything said here is safe to say.
 */

/** A dismissed question. Not a failure: it means write nothing and say so. */
export class Cancelled extends Error {}

/** The Agent's own words, made safe to put in front of somebody (ADR-0010).
 *
 *  Redaction is a string match, so it runs on both sides of the sealing and
 *  against both forms of every value. Sealing changes the text either way: it
 *  collapses the whitespace inside a value — a PEM key has line endings — and
 *  it takes a character from *outside* one, since breaking an address consumes
 *  the character before the `@` that the Agent chose. A value matches the text
 *  before that, or after it, and one pass alone would miss whichever it was.
 *  Clamping is last, because a credential cut in half matches nothing.
 *
 *  Every place the wizard shows Agent text goes through here, so there is one
 *  order to get right rather than one per dialog. */
export function safeText(text: string, stored: readonly string[], limit: number): string {
  const values = [...stored, ...stored.map(plainText)];
  return clampForDisplay(redactSecrets(plainText(redactSecrets(text, values)), values), limit);
}

/** A Runtime's name as a dialog may show it.
 *
 *  A custom Runtime's name is its settings key, from a scope a repository
 *  writes, and it leads almost everything the wizard puts on screen — a modal's
 *  heading, a progress notification, a report. Sealed once here rather than at
 *  each of those, because the one that gets forgotten is the one that matters. */
export function shownName(name: string): string {
  // Cut first, sealed second. Sealing inserts characters — breaking an address
  // costs two — so a name cut afterwards loses whatever sealing pushed past the
  // budget, and what is on the right-hand end is the mark saying the name is a
  // repository's own. The name arrives already bounded; sealing widens it by a
  // few characters and nothing is lost.
  return plainText(clampForDisplay(name, MAX_LABEL_CHARS));
}

/** Says something carrying the Agent's own words. */
export function report(ports: WizardPorts, state: Connection | undefined, text: string): void {
  ports.say(safeText(text, Object.values(state?.secretEnvironment ?? {}), MAX_DETAIL_CHARS));
}

/** One quick pick, answered by position. Never by label: labels are clamped, so
 *  two can arrive as the same string — and the Runtime picked would not be the
 *  Runtime connected. */
export async function pickIndex(
  ports: WizardPorts,
  items: readonly QuickItem[],
  options: { title: string; placeHolder: string },
): Promise<number> {
  const chosen = await ports.form.pick(items, { ...options, ignoreFocusOut: true });
  if (!chosen) throw new Cancelled();
  const at = items.indexOf(chosen);
  // A host that answered with something it was never offered is not answering
  // this question; treating that as an answer is how the wrong thing gets saved.
  if (at < 0) throw new Cancelled();
  return at;
}

/** One input box. `ignoreFocusOut` throughout: the answers here are a path and a
 *  credential, and both are things people leave the window to fetch. */
export async function ask(ports: WizardPorts, options: Parameters<FormHost["input"]>[0]): Promise<string> {
  const typed = await ports.form.input({ ...options, ignoreFocusOut: true });
  if (typed === undefined) throw new Cancelled();
  return typed;
}
