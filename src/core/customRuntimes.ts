import type { BaseRuntime, RuntimeOverride } from "./runtimeRegistry.js";

/**
 * Runtimes that exist only because settings describe them.
 *
 * Everything about one of these — its id, its name, the program it launches —
 * comes from `agentConductor.runtimes`, which is a scope a repository writes.
 * So this is where a repository's own text becomes something the Client shows,
 * and the two rules here are about that rather than about launching (ADR-0007).
 */

/**
 * The longest display name the catalog will produce.
 *
 * Bounded here, in the layer that composes the name, rather than left to
 * whichever dialog prints it: they all clamp from the right, and the mark that
 * says a Runtime is not a built-in is on the right.
 */
export const MAX_SHOWN_NAME_CHARS = 80;

const MARK = " (custom)";

/**
 * What a custom Runtime is called.
 *
 * Flattened, because a name with a line ending in it adds lines to the dialog
 * that approves the launch. Marked, because flattening `Claude  Code` yields
 * exactly the name of a built-in otherwise. Cut to fit before the mark is added,
 * because a name padded past what a dialog shows would lose the mark and keep
 * the familiar part — and the padding need not be visible to take up room: the
 * formatting characters are removed with the whitespace, since `\s` covers
 * neither a zero-width space nor an override that draws what follows it
 * backwards.
 */
export function customName(id: string): string {
  const flat = id.replace(/[\s\p{Cf}]+/gu, " ").trim();
  return `${flat.slice(0, MAX_SHOWN_NAME_CHARS - MARK.length)}${MARK}`;
}

/**
 * The Runtimes settings describe that the catalog does not.
 *
 * An entry that is not an object describes no Runtime at all, and dropping it
 * costs one Runtime nobody can have configured — where reading it empties the
 * picker. An entry with no command stays listed and fails when it is resolved,
 * which names the problem far better than quietly vanishing.
 */
export function customRuntimes(
  overrides: Record<string, RuntimeOverride | undefined>,
  builtInIds: ReadonlySet<string>,
): BaseRuntime[] {
  return Object.entries(overrides)
    .filter(
      ([id, override]) =>
        !builtInIds.has(id) && override !== null && typeof override === "object" && !Array.isArray(override),
    )
    .map(([id, override]) => ({
      id,
      displayName: customName(id),
      launch: { command: override?.command ?? "", args: [], env: {} },
      custom: true,
      quirks: { processScopedConfig: false, effortReadback: false, slashCommandAllowlist: [] },
    }));
}
