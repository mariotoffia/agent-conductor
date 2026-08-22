/**
 * Every way a markdown renderer turns text into something to click.
 *
 * Meant to be read off the renderer's grammar rather than off the rules that
 * seal text against it, because a list transcribed from those rules asks the
 * same question twice and answers it the same way both times — which is how a
 * form stayed live in production and clean by this list for five rounds.
 *
 * In practice most of these patterns do coincide with the sealing rules, and a
 * reader should not take the coincidence for confirmation. What is checked here
 * is only that the syntax is gone; that the syntax is the *right* syntax is
 * settled by rendering with `marked`, which is what VS Code draws with. Where
 * the two are deliberately apart it is said: the local part of an address below
 * is CommonMark's, which admits a dozen characters the sealing rule does not.
 */
const FORMS: [string, RegExp][] = [
  ["an inline link", /\]\(/],
  ["an address", /:\/\//],
  ["an autolink", /<[A-Za-z][A-Za-z0-9+.-]*:/],
  // CommonMark's angle-bracket email autolink: `<local@domain>`, whose local
  // part admits `!#$%&'*+/=?^_`{|}~-` as well as letters, digits and dots.
  ["an angled address", /<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@/],
  ["a www literal", /www\./i],
  ["an email literal", /[A-Za-z0-9._%+-]@[A-Za-z0-9_-]+\./],
];

/** The first clickable form in `text`, or `undefined` when there is none. */
export function linkish(text: string): string | undefined {
  return FORMS.find(([, pattern]) => pattern.test(text))?.[0];
}
