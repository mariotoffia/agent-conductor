/**
 * The bounds one spawn is measured against, and the Brief it carries.
 *
 * Apart from the Orchestrator because all of it is pure: which files a Brief may
 * name, what a Brief looks like, whether one Runtime may be handed another's
 * work, and how many Subagents run at once. Each of these is a rule somebody
 * will want to read on its own, and none of them needs a Session to decide.
 */
import { isAbsolute, resolve, sep } from "node:path";
import type { SubagentRuntime } from "./orchestrator.js";

/** Why this Runtime may not be handed this work, or nothing (ADR-0009). */
export function fanOutRefusal(runtime: SubagentRuntime, parentRuntimeId: string): string | undefined {
  // Delegating to the Runtime already running is not a crossing: it is the same
  // provider, on work the user already started there.
  if (runtime.id === parentRuntimeId || runtime.fanOut) return undefined;
  return `${runtime.id} has not been approved to receive work from another provider`;
}

/**
 * The Brief: the whole task in words, and paths.
 *
 * Never file contents and never history. A Subagent shares no conversation with
 * its parent, so anything the child needs to read it reads for itself, under the
 * same permission routing every other Session's reads go through.
 */
export function brief(text: string, files: readonly string[]): string {
  if (files.length === 0) return text;
  return `${text}\n\nFiles to read (paths, not contents):\n${files.map((file) => `- ${file}`).join("\n")}`;
}

/**
 * Whether an absolute path lies inside one of these roots.
 *
 * The roots come from the capability, which was minted on this side; the path
 * comes from an Agent. Compared after resolution, so `..` cannot walk out of a
 * root that a prefix comparison alone would have accepted.
 */
export function within(path: string, roots: readonly string[]): boolean {
  if (!isAbsolute(path)) return false;
  const target = resolve(path);
  return roots.some((root) => {
    const base = resolve(root);
    return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
  });
}

export interface Semaphore {
  /** Waits for a slot, and returns the one call that gives it back. */
  acquire(): Promise<() => void>;
}

/**
 * A counting semaphore whose limit is read afresh every time it is entered.
 *
 * Read rather than captured, because the limit is a setting: one changed while a
 * window is open takes effect on the next spawn rather than on the next reload,
 * which is how every other setting in this Client behaves.
 */
export function createSemaphore(limit: () => number): Semaphore {
  let held = 0;
  const queue: Array<() => void> = [];
  const next = (): void => {
    if (held >= limit()) return;
    const waiting = queue.shift();
    if (!waiting) return;
    held += 1;
    waiting();
  };
  return {
    async acquire() {
      await new Promise<void>((resolve) => {
        queue.push(resolve);
        next();
      });
      let released = false;
      return () => {
        // Idempotent: a slot given back twice is a limit that does not hold.
        if (released) return;
        released = true;
        held -= 1;
        next();
      };
    },
  };
}
