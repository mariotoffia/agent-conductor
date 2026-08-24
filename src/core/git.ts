/**
 * Running git, and nothing else.
 *
 * A port with one method, and the Node implementation of it. Apart from the
 * worktree lifecycle because the two answer different questions: this one is
 * "how does this machine run git", and that one is "what may be done to a
 * checkout". A test of the second needs a git that answers as it is told, which
 * is the whole reason this is an interface at all.
 */
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Running git, and nothing else.
 *
 * A port rather than a direct call so the ordering rules above can be tested
 * without a repository — the thing under test is *when* a command runs relative
 * to the journal, which a real git would hide behind its own state.
 */
export interface GitPort {
  /** Runs git with these arguments in this directory. Never through a shell. */
  run(args: readonly string[], cwd: string): Promise<GitResult>;
}

/**
 * A path as git would report it: every symlink resolved, including in the part
 * that does not exist yet.
 *
 * The root is usually the directory about to be created, so the deepest
 * ancestor that does exist is what can be resolved, and the rest is put back on
 * top. A path nothing at all resolves is returned as it came: unchanged is the
 * answer that changes nothing.
 */
export async function resolvedPath(path: string): Promise<string> {
  const tail: string[] = [];
  let head = path;
  for (;;) {
    try {
      return join(await realpath(head), ...tail);
    } catch {
      const parent = dirname(head);
      if (parent === head) return path;
      tail.unshift(basename(head));
      head = parent;
    }
  }
}

export function describeGit(result: GitResult): string {
  const said = (result.stderr || result.stdout).trim().split("\n")[0] ?? "";
  return said === "" ? `git exited ${result.code}` : said;
}

/**
 * Git as this machine has it.
 *
 * `execFile` rather than `exec`: every argument here is derived from a Session
 * identity an Agent chose, and a shell is the one thing that would give such a
 * string a meaning of its own.
 */
export const nodeGitPort: GitPort = {
  run(args, cwd) {
    return new Promise((resolve) => {
      execFile(
        "git",
        [...args],
        // Bounded, because `git status` in a repository somebody has just
        // unpacked can be very long, and none of it is worth the extension
        // host's memory. Never a shell.
        { cwd, maxBuffer: 4 * 1024 * 1024, shell: false, windowsHide: true },
        (error, stdout, stderr) => {
          const code = (error as (Error & { code?: number }) | null)?.code;
          resolve({
            code: error ? (typeof code === "number" ? code : 1) : 0,
            stdout: String(stdout),
            stderr: stderr === "" && error ? error.message : String(stderr),
          });
        },
      );
    });
  },
};
