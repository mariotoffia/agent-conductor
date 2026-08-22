import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";
import type { ExecutablePort, ResolvedExecutable } from "./types.js";

/**
 * Finding the file a launch command would really run, without running it
 * (ADR-0007).
 *
 * Resolution answers two questions the trust fingerprint depends on: which file
 * this name lands on after symlinks, and what that file contains. Both are read;
 * neither is executed.
 *
 * Both answers describe the file as it was when it was read, not as it will be
 * when it is spawned. Nothing here can close that window — it is inherent to
 * approving a program before running it — which is why resolution happens once
 * per Session start rather than once per window.
 */

const WINDOWS = process.platform === "win32";

/**
 * Extensions Windows will execute from a bare name. `.cmd` and `.bat` are
 * deliberately absent: Node refuses to spawn them without a shell, and a shell
 * is exactly what argv taken from settings must never reach. A Runtime that only
 * ships a `.cmd` wrapper resolves to nothing here, which refuses the launch
 * rather than starting it through `cmd.exe`.
 */
export const WINDOWS_EXECUTABLE_EXTENSIONS = [".exe", ".com"];

export interface ExecutablePortOptions {
  /** `PATH` to search for a bare name; the process environment's by default. */
  path?: string;
  /** Largest file a digest is computed over. Beyond it the path alone is bound. */
  maxDigestBytes?: number;
}

/**
 * How large an artifact may be before its contents stop being hashed. Adapters
 * are scripts and small binaries; something far larger is not one, and reading
 * it into the extension host to hash it would cost more than the binding is
 * worth. Trust then covers the path only, which `ResolvedRuntime` reports.
 */
export const MAX_DIGEST_BYTES = 64 * 1024 * 1024;

/**
 * Commands whose whole purpose is to fetch code and run or install it. Naming one
 * as a launch command is a mistake rather than a choice — what it downloads is
 * decided at launch time, so no fingerprint the user approved can describe it
 * (ADR-0007), and installing an Adapter is a separate exact-version wizard action.
 *
 * General-purpose runtimes (`node`, `bun`, `deno`) are deliberately absent, because
 * refusing them would refuse every locally installed agent that ships as a script.
 * They can reach the network too (`deno run https://…`), which is why the guarantee
 * does not rest here: the whole argv is fingerprinted, so a launch that fetches
 * through one of them is one the user approved by sight (ADR-0007).
 */
const PACKAGE_RUNNERS = new Set([
  "npx", "pnpx", "bunx", "uvx", "pipx",
  "npm", "pnpm", "yarn", "corepack", "uv", "pip", "pip3",
]);

/** Extensions Windows appends to an executable, possibly stacked. */
const WINDOWS_EXECUTABLE_SUFFIX = /(?:\.(?:exe|cmd|bat|ps1|com))+$/;

/** The name the operating system would actually look up: Windows discards
 *  trailing dots and spaces, and an extension says nothing about what runs. */
function commandName(command: string): string {
  const separator = Math.max(command.lastIndexOf("/"), command.lastIndexOf("\\"));
  return command
    .slice(separator + 1)
    .toLowerCase()
    .replace(/[.\s]+$/, "")
    .replace(WINDOWS_EXECUTABLE_SUFFIX, "");
}

/** Whether a command is one of those runners, judged by the name the operating
 *  system would actually look up rather than by what was typed. */
export function isPackageRunner(command: string): boolean {
  return PACKAGE_RUNNERS.has(commandName(command));
}

/** PATH lookup and content digest over the real filesystem. */
export function executablePort(options: ExecutablePortOptions = {}): ExecutablePort {
  const searchPath = options.path ?? process.env.PATH ?? "";
  const maxBytes = options.maxDigestBytes ?? MAX_DIGEST_BYTES;
  return {
    async resolve(command: string): Promise<ResolvedExecutable | undefined> {
      const name = command.trim();
      if (!name) return undefined;
      for (const candidate of candidates(name, searchPath)) {
        const found = await describe(candidate, maxBytes);
        if (found) return found;
      }
      return undefined;
    },
  };
}

/**
 * Paths a command name could name, in the order the system would try them. An
 * absolute or relative path is only ever itself; a bare name is looked up in
 * each PATH entry, and on Windows under each executable extension.
 */
function candidates(command: string, searchPath: string): string[] {
  if (isAbsolute(command) || /[/\\]/.test(command)) return withExtensions(resolve(command));
  return searchPath
    .split(delimiter)
    .filter((entry) => entry !== "")
    .flatMap((entry) => withExtensions(join(entry, command)));
}

/**
 * A dot in a name does not make it executable: `my.agent` is a perfectly good
 * program name, and on Windows what runs is `my.agent.exe`. Only an extension
 * Windows would actually execute means the name is already complete.
 */
function withExtensions(target: string): string[] {
  if (!WINDOWS) return [target];
  const extension = extname(target).toLowerCase();
  if (WINDOWS_EXECUTABLE_EXTENSIONS.includes(extension)) return [target];
  return WINDOWS_EXECUTABLE_EXTENSIONS.map((candidate) => target + candidate);
}

/**
 * One candidate, if it is a file this process could execute.
 *
 * A missing digest is not a failure — `ResolvedRuntime.artifactVerified` says so
 * — but it narrows Runtime Trust to the path, so it is only ever given up for a
 * file too large to read or one whose contents cannot be read at all.
 */
async function describe(candidate: string, maxBytes: number): Promise<ResolvedExecutable | undefined> {
  try {
    const details = await stat(candidate);
    if (!details.isFile()) return undefined;
    // Windows has no execute bit; the extension is what makes a file runnable.
    if (!WINDOWS) await access(candidate, constants.X_OK);
    const path = await realpath(candidate);
    return { path, ...(details.size > maxBytes ? {} : await digestOf(path)) };
  } catch {
    return undefined;
  }
}

async function digestOf(path: string): Promise<{ digest?: string }> {
  try {
    return { digest: createHash("sha256").update(await readFile(path)).digest("hex") };
  } catch {
    return {};
  }
}
