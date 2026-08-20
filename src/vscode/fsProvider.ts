import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { methods } from "@agentclientprotocol/sdk";
import type { FsPort } from "../core/index.js";
import { clientOperation, type Consent } from "./permissions.js";

/**
 * The Client's `fs/*` handlers.
 *
 * Serving open editor buffers is the entire point of the capability: an Agent
 * that reads from disk sees the last save, not what the user is looking at. So a
 * dirty buffer wins over disk on the way out, and an open document is written
 * through the editor on the way back in, where it joins the user's undo stack
 * instead of appearing underneath it.
 *
 * Every path is canonicalized before anything is read or written, and a path that
 * lands outside the Session's roots is refused rather than offered for consent —
 * the roots are what the Session was opened over, not a preference (ADR-0007).
 * Those roots are fixed for the life of the instance: a Session whose roots
 * change gets a new one rather than a mutable guard.
 *
 * ponytail: paths are compared exactly. On a case-insensitive filesystem an
 * Agent that spells a root differently is refused rather than admitted — the
 * safe direction, and it costs nothing while Agents use the paths the Client
 * gave them. Compare per-root case-insensitively, detected by inode, if a real
 * Runtime turns out to rewrite them.
 */

/** Open editor documents; `vscode.workspace.textDocuments` plus a `WorkspaceEdit`. */
export interface OpenDocuments {
  /** Text of the open document for this absolute path, saved or not. */
  text(path: string): string | undefined;
  /** Replaces an open document's whole text through the editor's undo stack.
   *  `false` when no document is open for that path. */
  replace(path: string, text: string): PromiseLike<boolean>;
}

export interface WorkspaceFsOptions {
  /** Absolute Session roots: the session `cwd` and any additional directories. */
  roots: readonly string[];
  documents: OpenDocuments;
  consent: Consent;
}

export class WorkspaceFs implements FsPort {
  readonly #options: WorkspaceFsOptions;
  readonly #confine: RootGuard;

  constructor(options: WorkspaceFsOptions) {
    this.#options = options;
    this.#confine = rootGuard(options.roots);
  }

  async readTextFile(request: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    const path = await this.#admit(request.path, methods.client.fs.readTextFile);
    const open = this.#openText(path, request.path);
    const content = open ?? (await readFile(path, "utf8"));
    return { content: slice(content, request.line, request.limit) };
  }

  async writeTextFile(request: acp.WriteTextFileRequest): Promise<void> {
    const path = await this.#admit(request.path, methods.client.fs.writeTextFile);
    // Through the editor when the file is open, so the change is undoable and
    // does not collide with what the user has unsaved.
    if (await this.#replaceOpenText(path, request.path, request.content)) return;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, request.content, "utf8");
  }

  /**
   * Canonicalize, confine to the roots, then obtain consent — in that order. The
   * operation consent is asked for comes from the ACP method, so what the user
   * approves is what the Client is about to do rather than what the Agent called
   * it (ADR-0007).
   */
  async #admit(requested: string, method: string): Promise<string> {
    const operation = clientOperation(method);
    if (!operation) throw new Error(`${method}: no client operation to authorize under`);
    const path = await this.#confine(requested, operation);
    if (!(await this.#options.consent.authorize(operation, path))) {
      throw new Error(`${operation}: refused for "${path}"`);
    }
    return path;
  }

  /**
   * Both spellings are tried: the editor knows a document by the path the user
   * opened it under, which need not be the canonical one — on macOS a workspace
   * under `/tmp` is really under `/private/tmp`. Missing the buffer would mean
   * silently serving the last save instead of what is on screen.
   */
  #openText(path: string, requested: string): string | undefined {
    return this.#options.documents.text(path) ?? this.#options.documents.text(requested);
  }

  async #replaceOpenText(path: string, requested: string, content: string): Promise<boolean> {
    if (await this.#options.documents.replace(path, content)) return true;
    return path === requested ? false : this.#options.documents.replace(requested, content);
  }
}

/**
 * Confines a path to a Session's roots and answers where it really lands.
 *
 * Shared with the terminal handlers, whose `cwd` is confined the same way: the
 * roots are what the Session was opened over, so one guard serves every ACP
 * argument that names a place on the machine. Canonical roots are resolved once —
 * they do not change while a Session lives.
 */
export type RootGuard = (requested: string, operation: string) => Promise<string>;

export function rootGuard(roots: readonly string[]): RootGuard {
  let canonicalRoots: Promise<string[]> | undefined;
  return async (requested, operation) => {
    if (!isAbsolute(requested)) {
      throw new Error(`${operation}: ACP paths must be absolute, got "${requested}"`);
    }
    const path = await canonicalize(resolve(requested));
    canonicalRoots ??= Promise.all(roots.map((root) => canonicalize(resolve(root))));
    const admitted = await canonicalRoots;
    if (!admitted.some((root) => path === root || path.startsWith(root + sep))) {
      throw new Error(`${operation}: "${requested}" is outside this session's roots`);
    }
    return path;
  };
}

/**
 * The path a read or write would really land on, symlinks resolved. A file that
 * does not exist yet resolves as far as its nearest existing ancestor, so a new
 * file inside a root is admitted while one behind a symlink pointing out of the
 * roots is not.
 */
async function canonicalize(target: string): Promise<string> {
  const tail: string[] = [];
  let current = target;
  for (;;) {
    try {
      return join(await realpath(current), ...tail);
    } catch {
      const parent = dirname(current);
      if (parent === current) return target; // nothing on this path exists
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

/** ACP's optional 1-based `line` and `limit` window over the content. */
function slice(content: string, line?: number | null, limit?: number | null): string {
  if (line == null && limit == null) return content;
  const lines = content.split("\n");
  const start = Math.max(1, line ?? 1) - 1;
  const end = limit == null ? lines.length : start + Math.max(0, limit);
  return lines.slice(start, end).join("\n");
}
