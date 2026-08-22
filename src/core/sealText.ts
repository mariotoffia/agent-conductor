/**
 * Sealing rules that need no display budget: what is removed from an Agent's —
 * or a repository's — own text before anything renders it (UBIQUITOUS.md).
 *
 * Here rather than in the VS Code layer because they are pure, and because a
 * message composed in the core is read by a human just as surely as one composed
 * beside the dialog that shows it. The two rules that need to know how much room
 * they have — a code span, and a line this Client wrote — stay up there.
 */

/**
 * The characters that reorder text rather than add to it.
 *
 * A right-to-left override draws everything after it backwards, so an Agent
 * string that ends in one turns the Client's own words around it into something
 * else — and it is neither whitespace nor markdown, so nothing else here would
 * touch it. Removed rather than escaped, since there is no escaping them.
 *
 * The zero-width joiner is deliberately not on this list: it builds one emoji
 * out of several rather than moving anything, and a tool title may contain one.
 */
export const REORDERING = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * Every way a markdown renderer turns text into something to click, broken
 * rather than escaped.
 *
 * Broken, because this same text is also read where a backslash is a backslash:
 * a notification, a log file, `errorDetails`. Breaking leaves it legible in both
 * — `https: //example.invalid` still says where it pointed.
 *
 * All five forms, not the one an Agent happened to use. A fix that covers the
 * syntax its test sends is a fix that agrees with its test: `[x](y)` and `<x:y>`
 * are CommonMark, and a bare `www.` or an address with an `@` in it are made
 * into links by any renderer with GitHub's extensions turned on — which is every
 * renderer this Client draws into.
 */
export function breakLinks(text: string): string {
  return text
    .replace(/\]\(/g, "] (")
    .replace(/:\/\//g, ": //")
    // An autolink needs only `<scheme:` — `<mailto:someone@example.invalid>` has
    // no slashes in it at all, and `mailto` is a scheme editors do follow.
    .replace(/<([A-Za-z][A-Za-z0-9+.-]*:)/g, "< $1")
    // And the angle form of an address needs no scheme at all. Its local part
    // admits a dozen characters the rule below does not, so it is broken on the
    // bracket rather than on what precedes the `@`.
    .replace(/<([^\s<>]*@)/g, "< $1")
    // Anywhere, not only at a word boundary: the renderer linkifies `www.` in the
    // middle of a word too, so `9www.example.invalid` is a link.
    .replace(/(www)\./gi, "$1 .")
    // Any label followed by a dot, which is what a renderer needs before it makes
    // an address a link — digits and underscores included. Narrower than that and
    // the forms it leaves are still clickable; the cost is that a version written
    // `package@1.2.3` is broken too, which is legible and not something to click.
    //
    // Matched without consuming either side, so that one pass is a fixed point:
    // a rule that ate the character before the `@` skipped the next address in
    // `a@b.@c.example`, and a second pass over the same text then found more to
    // do — which is a line that no longer fits the budget it was sized against.
    .replace(/(?<=[A-Za-z0-9._%+-])@(?=[A-Za-z0-9_-]+\.)/g, " @ ");
}

/**
 * One agent-chosen string bound for somewhere with no markdown of its own — a
 * notification, a modal's detail, a log record.
 *
 * Nothing is escaped, because a backslash would be read as a backslash. What is
 * removed is what would make the text look like a second voice, and what is
 * broken is what would make it clickable: a notification is rendered through
 * VS Code's own linked-text parser, which follows `[label](target)`.
 *
 * Flattened, because these are read one line at a time and whoever chooses where
 * the line ends chooses what is read.
 */
export function plainText(text: string): string {
  return breakLinks(text.replace(REORDERING, "").replace(/[*`~]/g, "").replace(/\s+/g, " "));
}
