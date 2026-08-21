import { basename } from "node:path";
import type * as vscode from "vscode";
import type { Assert } from "./permissions.js";

/**
 * The before/after text behind an Agent's diff, served as virtual documents so
 * VS Code's own diff editor can draw it.
 *
 * Both sides are virtual, not just the left one. The right side is what the
 * Agent *said* it wrote, and the file on disk is what is there now — they are
 * the same thing only until the next edit, and a diff that quietly re-reads the
 * file would show a comparison the Agent never reported. Neither side is ever
 * read back from the workspace.
 *
 * What is retained is bounded twice, because this outlives the turn that
 * produced it: each side is truncated, and each Session keeps only its most
 * recent diffs. Everything a Session recorded is dropped when it closes.
 */

/** URI scheme of the virtual documents; registered by the composition root. */
export const DIFF_SCHEME = "agent-conductor-diff";

/** Characters retained per side. Beyond this the diff is shown as truncated. */
export const MAX_DIFF_CHARS = 128 * 1024;

/** Diffs one Session keeps. Older ones are dropped rather than accumulated. */
export const MAX_DIFFS_PER_SESSION = 50;

const TRUNCATION_NOTE = "\n\n… truncated by Agent Conductor …\n";

const UNAVAILABLE = "This diff is no longer available.";

export interface RecordedDiff {
  path: string;
  oldText: string;
  newText: string;
}

/** What a caller needs to open one recorded diff. */
export interface DiffHandle {
  /** Opaque id; the only thing that travels through a chat button's arguments. */
  id: string;
  /** Absolute path the diff is about. */
  path: string;
  /** Editor tab title. */
  title: string;
}

/** The part of `vscode.Uri` this provider reads. */
export interface DiffUri {
  query: string;
}

export class DiffDocuments {
  readonly #entries = new Map<string, RecordedDiff>();
  /** Ids per Session, oldest first — the ring that bounds what is retained. */
  readonly #bySession = new Map<string, string[]>();
  #issued = 0;

  /** Retains one diff for a Session and answers how to open it. */
  record(sessionId: string, diff: RecordedDiff): DiffHandle {
    const id = `${++this.#issued}`;
    this.#entries.set(id, {
      path: diff.path,
      oldText: clamp(diff.oldText),
      newText: clamp(diff.newText),
    });
    const ids = this.#bySession.get(sessionId) ?? [];
    ids.push(id);
    while (ids.length > MAX_DIFFS_PER_SESSION) {
      const evicted = ids.shift();
      if (evicted !== undefined) this.#entries.delete(evicted);
    }
    this.#bySession.set(sessionId, ids);
    return { id, path: diff.path, title: `${basename(diff.path)} (agent diff)` };
  }

  /** The recorded diff, while it is still retained. */
  entry(id: string): RecordedDiff | undefined {
    return this.#entries.get(id);
  }

  /**
   * Text behind one side, addressed as `<id>:old` or `<id>:new`.
   *
   * An id that has been dropped answers with a note rather than nothing: an
   * empty document would render as "the whole file was added", which is a
   * different claim from "this is no longer kept".
   */
  content(query: string): string {
    const separator = query.lastIndexOf(":");
    const side = query.slice(separator + 1);
    const entry = separator < 0 || (side !== "old" && side !== "new")
      ? undefined
      : this.#entries.get(query.slice(0, separator));
    if (!entry) return UNAVAILABLE;
    return side === "old" ? entry.oldText : entry.newText;
  }

  /** `vscode.TextDocumentContentProvider`; registered against `DIFF_SCHEME`. */
  provideTextDocumentContent(uri: DiffUri): string {
    return this.content(uri.query);
  }

  /** Drops everything one Session recorded. Called when the Session is disposed. */
  closeSession(sessionId: string): void {
    for (const id of this.#bySession.get(sessionId) ?? []) this.#entries.delete(id);
    this.#bySession.delete(sessionId);
  }

  /** Retained diffs, for tests and for the log. */
  get size(): number {
    return this.#entries.size;
  }
}

function clamp(value: string): string {
  return value.length <= MAX_DIFF_CHARS ? value : value.slice(0, MAX_DIFF_CHARS) + TRUNCATION_NOTE;
}

/** The provider still is the VS Code call it stands for; see `config.ts`. */
export type DiffPortsMatchVsCodeApi = [
  Assert<vscode.Uri extends DiffUri ? true : false>,
  Assert<DiffDocuments extends vscode.TextDocumentContentProvider ? true : false>,
  // The gate's own self-test: a member VS Code does not implement is rejected.
  Assert<vscode.Uri extends { sparkle: string } ? false : true>,
];
