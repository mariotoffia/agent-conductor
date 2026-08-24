/**
 * Allocating and giving back the git worktrees Subagents work in (ADR-0009).
 *
 * A worktree keeps *changes* apart. It is not a security boundary and nothing
 * here pretends otherwise: an agent process can read any path the operating
 * system allows it to, whatever checkout it was started in.
 *
 * Three rules shape this file, and each of them is a way a crash would otherwise
 * cost somebody real work:
 *
 * - **Write the intention down first.** The journal entry is saved before `git
 *   worktree add` runs, so an extension host killed mid-command leaves a record
 *   of what it was doing rather than a directory nothing remembers making.
 * - **One git mutation at a time.** Two `worktree add` runs against one
 *   repository race over the same index and administrative files.
 * - **Never delete a dirty worktree.** Uncommitted work is the user's, and a
 *   session that crashed is exactly when it is most likely to be there.
 */
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { describeGit, resolvedPath, type GitPort } from "./git.js";
import type { LogPort, StoragePort } from "./types.js";

/** Where the journal lives in durable storage. */
export const WORKTREE_JOURNAL_KEY = "worktrees.json";

/**
 * Where a journal that could not be understood is kept.
 *
 * Set aside rather than thrown away, and rather than left in place: leaving it
 * would disable every worktree operation in every window for good, with no way
 * back from inside the product, and deleting it would destroy the only record of
 * checkouts that are still on disk. The same rule a Persisted Session store
 * follows when it meets a file it cannot read.
 */
export const WORKTREE_JOURNAL_SUPERSEDED_KEY = "worktrees.superseded.json";

/** Prefix every branch this Client creates shares, so they can be told apart. */
export const WORKTREE_BRANCH_PREFIX = "agent-conductor";

/** How many spellings of one name are tried before allocation gives up. */
const MAX_NAME_ATTEMPTS = 20;

/** One worktree this Client allocated, as the journal remembers it. */
export interface WorktreeAllocation {
  /** How the issuer names the Session the worktree was made for. */
  sessionKey: string;
  /** Absolute repository the worktree belongs to. */
  repository: string;
  /** Absolute checkout path. */
  path: string;
  /** Branch checked out there. */
  branch: string;
  createdAt: number;
  /** `git worktree add` finished. Absent means nobody knows whether it did. */
  added?: true;
}

export interface WorktreesOptions {
  git: GitPort;
  storage: StoragePort;
  /** Absolute directory the worktrees are created under. A function, because it
   *  comes from a setting: one changed while a window is open takes effect on
   *  the next allocation rather than on the next reload. */
  root(): string;
  now(): number;
  log?: LogPort;
}

/**
 * Why a worktree was not given back.
 *
 * A discriminator rather than only a sentence, because what a caller may do
 * next differs per cause and matching on prose is how those get merged back
 * together. Only `dirty` is a refusal that asking again could reasonably
 * overturn: `uninspectable` is nobody knowing whether there is work there,
 * which is not a thing to force past, and neither of the other two is helped
 * by force at all.
 */
export type ReleaseRefusal = "not-ours" | "uninspectable" | "dirty" | "failed";

/** What git says a repository's worktrees are, and which of them it has lost. */
interface Checkouts {
  paths: Set<string>;
  /** Registered, but with no working tree where it should be. */
  prunable: Set<string>;
}

export interface ReleaseOutcome {
  removed: boolean;
  /** What kind of refusal it was. Absent when it was removed. */
  cause?: ReleaseRefusal;
  /** Why not, in words a user can act on. Absent when it was removed. */
  reason?: string;
}

export interface ReconcileOutcome {
  /** Paths git no longer knows about, dropped from the journal. */
  abandoned: string[];
  /** Paths still checked out, left exactly as they are. */
  kept: string[];
}

const allocation = z.object({
  sessionKey: z.string().min(1),
  repository: z.string().min(1),
  path: z.string().min(1),
  branch: z.string().min(1),
  createdAt: z.number(),
  added: z.literal(true).optional(),
});

const journal = z.object({ version: z.number().int(), worktrees: z.array(allocation) });

/**
 * A name derived from a Session's identity that can safely be a path and a ref.
 *
 * An Agent chooses its own session id, so this is the boundary where that string
 * stops being able to name anything: everything outside a small alphabet becomes
 * a dash, `..` cannot survive it, and the result is bounded.
 */
function slugOf(sessionKey: string): string {
  const cleaned = sessionKey
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.+/g, ".")
    .replace(/^[.\-]+|[.\-]+$/g, "")
    .slice(0, 40)
    .replace(/[.\-]+$/g, "");
  return cleaned === "" ? "session" : cleaned;
}

export class Worktrees {
  readonly #options: WorktreesOptions;
  /** Every git mutation and every journal write, in one line (ADR-0009). */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: WorktreesOptions) {
    this.#options = options;
  }

  /**
   * Everything this Client believes it has allocated.
   *
   * The one reader that never throws, because it changes nothing: showing no
   * worktrees is a worse answer than showing them, but it is not a destructive
   * one. Everything that writes the file back goes through `#read` and fails
   * instead.
   */
  async list(): Promise<WorktreeAllocation[]> {
    try {
      return await this.#read();
    } catch (error) {
      this.#options.log?.log(
        "error",
        `the worktree journal could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }

  /**
   * Makes one worktree, having first written down that it is about to.
   *
   * The branch and the directory are derived from the Session's own identity, so
   * two Sessions cannot collide; a name already taken — the leftover of a run
   * that crashed — is stepped past rather than reused, because checking out a
   * branch somebody else's work is on is how that work gets lost.
   */
  allocate(request: { sessionKey: string; repository: string }): Promise<WorktreeAllocation> {
    return this.#serial(async () => {
      const { git, now } = this.#options;
      // Checked on what the setting says, before anything resolves it: resolving
      // a relative path silently anchors it to whatever directory the extension
      // host happens to be running in, which is a worktree somewhere nobody
      // chose.
      const asked = this.#options.root();
      if (!isAbsolute(asked)) throw new Error(`worktree root must be absolute, got "${asked}"`);
      // Resolved, because git reports the realpath of a worktree rather than the
      // path it was given — and everything afterwards compares the two as
      // strings. A root reached through a symlink (`/tmp` is one on macOS, and
      // is the obvious thing to type into the setting) would otherwise never
      // match what git lists: the first reconciliation would call the checkout
      // abandoned and drop it while it sat on disk holding a Subagent's work,
      // and nothing could reach it again.
      const root = await resolvedPath(asked);
      if (!isAbsolute(request.repository)) {
        throw new Error(`repository must be absolute, got "${request.repository}"`);
      }
      const entries = await this.#read();
      const taken = new Set(entries.map((entry) => entry.path));
      const base = slugOf(request.sessionKey);
      let name = base;
      for (let attempt = 1; ; attempt += 1) {
        if (attempt > MAX_NAME_ATTEMPTS) {
          throw new Error(`could not find a free worktree name for "${base}"`);
        }
        name = attempt === 1 ? base : `${base}-${attempt}`;
        if (taken.has(join(root, name))) continue;
        const branch = `${WORKTREE_BRANCH_PREFIX}/${name}`;
        const probe = await git.run(
          ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
          request.repository,
        );
        if (probe.code !== 0) break;
      }
      const entry: WorktreeAllocation = {
        sessionKey: request.sessionKey,
        repository: request.repository,
        path: join(root, name),
        branch: `${WORKTREE_BRANCH_PREFIX}/${name}`,
        createdAt: now(),
      };
      // Before the command, not after: this is the only thing that survives a
      // host killed while git is running.
      await this.#write([...entries, entry]);
      const added = await git.run(
        ["worktree", "add", "-b", entry.branch, entry.path],
        request.repository,
      );
      if (added.code !== 0) {
        // Nothing was created, so nothing may claim it was. The record is taken
        // back rather than left for reconciliation, which would keep a row
        // offering a worktree that never existed until the next activation.
        await this.#write((await this.#read()).filter((held) => held.path !== entry.path));
        throw new Error(`git worktree add failed: ${describeGit(added)}`);
      }
      const done: WorktreeAllocation = { ...entry, added: true };
      await this.#write((await this.#read()).map((held) => (held.path === entry.path ? done : held)));
      return done;
    });
  }

  /**
   * Gives one worktree back, unless doing so would destroy work.
   *
   * Anything but a clean checkout is refused — including a `git status` that
   * could not be run at all, because "we could not tell" and "there is nothing
   * there" must not have the same consequence. `force` is the user saying it
   * anyway; nothing in this Client sets it on its own.
   */
  release(path: string, options: { force?: boolean } = {}): Promise<ReleaseOutcome> {
    return this.#serial(async () => {
      const entries = await this.#read();
      const entry = entries.find((held) => held.path === path);
      // A path this Client never allocated is not this Client's to delete.
      if (!entry) {
        return {
          removed: false,
          cause: "not-ours",
          reason: `${path} is not a worktree this window allocated`,
        };
      }
      const { git } = this.#options;
      let force = options.force === true;
      if (!force) {
        const status = await git.run(["status", "--porcelain"], entry.path);
        if (status.code !== 0) {
          // `git status` fails two ways that mean opposite things. Ask git which
          // one this is: a worktree it calls *prunable* has no working tree left
          // — its directory is gone — so there is no uncommitted work to lose,
          // and the only reason `remove` needs `--force` is that git will not
          // take a broken checkout out of its records without it. Anything else
          // is nobody knowing what is in there, which is not a thing to force
          // past however the question were worded.
          const listed = await this.#checkouts(entry.repository);
          if (!listed?.prunable.has(entry.path)) {
            return {
              removed: false,
              cause: "uninspectable",
              reason: `the worktree could not be inspected: ${describeGit(status)}`,
            };
          }
          force = true;
        } else if (status.stdout.trim() !== "") {
          return {
            removed: false,
            cause: "dirty",
            reason: `${path} has uncommitted changes — commit or remove them, then try again`,
          };
        }
      }
      const removed = await git.run(
        ["worktree", "remove", ...(force ? ["--force"] : []), entry.path],
        entry.repository,
      );
      if (removed.code !== 0) return { removed: false, cause: "failed", reason: describeGit(removed) };
      // The branch stays. Whatever was committed on it is the only place that
      // work now lives, and deleting it is not a cleanup, it is a loss.
      await this.#write((await this.#read()).filter((held) => held.path !== path));
      return { removed: true };
    });
  }

  /**
   * Settles the journal against what git actually has, at activation.
   *
   * The two disagree whenever a host was killed: an allocation whose `git
   * worktree add` never ran, or one whose directory somebody has since deleted.
   * Both are dropped and git's administrative files pruned. Nothing is *removed*
   * here — a worktree git still knows about may hold work nobody has merged.
   */
  reconcile(): Promise<ReconcileOutcome> {
    return this.#serial(async () => {
      const entries = await this.#read();
      const abandoned: string[] = [];
      const kept: WorktreeAllocation[] = [];
      const repositories = new Set(entries.map((entry) => entry.repository));
      const registered = new Map<string, Checkouts | undefined>();
      for (const repository of repositories) {
        registered.set(repository, await this.#checkouts(repository));
      }
      for (const entry of entries) {
        const checkouts = registered.get(entry.repository);
        // A repository git could not be asked about is one nothing is known
        // about. Its allocations are kept exactly as they are: a drive that is
        // not mounted, a repository that has moved, or a `git` missing from
        // PATH would otherwise declare every worktree under it abandoned and
        // forget a checkout that is sitting on disk holding somebody's work.
        if (checkouts === undefined) {
          kept.push(entry);
          continue;
        }
        if (checkouts.paths.has(entry.path)) {
          // Registered but unmarked is a host killed between the command and the
          // record of it finishing: the worktree is real, so the record says so.
          kept.push(entry.added ? entry : { ...entry, added: true });
          continue;
        }
        abandoned.push(entry.path);
      }
      // Deliberately no `git worktree prune`. Git lists a worktree whose
      // directory is missing rather than forgetting it, so every entry dropped
      // above is one git already has no record of — there is nothing of ours
      // left to prune. What prune would reach is the opposite: a worktree still
      // registered whose directory is not there *right now*, which is a drive
      // that is not mounted, and as likely to be one the user made themselves.
      if (abandoned.length > 0) await this.#write(kept);
      return { abandoned, kept: kept.map((entry) => entry.path) };
    });
  }

  /**
   * Absolute checkout paths this repository has, or `undefined` if git could not
   * say.
   *
   * The two are not the same answer and must not become one: an empty set means
   * this repository has no worktrees, and `undefined` means nobody knows —
   * which is what a moved repository, an unmounted drive, or a missing `git`
   * looks like from here.
   */
  async #checkouts(repository: string): Promise<Checkouts | undefined> {
    const listed = await this.#options.git.run(["worktree", "list", "--porcelain"], repository);
    if (listed.code !== 0) {
      this.#options.log?.log(
        "error",
        `git could not list the worktrees of ${repository}: ${describeGit(listed)}`,
      );
      return undefined;
    }
    const paths = new Set<string>();
    const prunable = new Set<string>();
    // One block per worktree, blank-line separated: a `worktree` line and then
    // that worktree's attributes, `prunable` among them.
    let current: string | undefined;
    for (const line of listed.stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        current = line.slice("worktree ".length).trim();
        paths.add(current);
        continue;
      }
      if (line.trim() === "") current = undefined;
      else if (current !== undefined && line.startsWith("prunable")) prunable.add(current);
    }
    return { paths, prunable };
  }

  /**
   * The journal as it stands.
   *
   * Throws when it cannot be read, and every path that goes on to *write* the
   * whole file back reads through here. That matters more than it looks: a
   * transient failure answered with an empty list would have the next
   * allocation replace two real worktrees with one, and the journal entry is
   * the only thing that makes a directory removable through this Client —
   * committed work survives on its branch, uncommitted work would be stranded
   * with no way to reach it.
   */
  async #read(): Promise<WorktreeAllocation[]> {
    // A read that failed is not an empty journal, and is not recoverable from
    // here: the file probably still says what it said, and whoever asked will
    // ask again.
    const text = await this.#options.storage.read(WORKTREE_JOURNAL_KEY);
    if (text === undefined) return [];
    try {
      return journal.parse(JSON.parse(text)).worktrees;
    } catch (error) {
      // A file this build cannot understand is a different thing: it will not
      // start making sense, so refusing for ever would disable worktrees in
      // every window with no way back from inside the product. It is set aside
      // whole — it names checkouts that may still be on disk — and this window
      // carries on with none.
      await this.#options.storage.writeAtomic(WORKTREE_JOURNAL_SUPERSEDED_KEY, text);
      this.#options.log?.log(
        "error",
        `the worktree journal could not be understood and was kept as` +
          ` ${WORKTREE_JOURNAL_SUPERSEDED_KEY}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }

  async #write(worktrees: WorktreeAllocation[]): Promise<void> {
    await this.#options.storage.writeAtomic(
      WORKTREE_JOURNAL_KEY,
      JSON.stringify({ version: 1, worktrees }),
    );
  }

  /** One at a time, in the order asked for, whatever the caller did. */
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    // Swallowed on the chain only: the caller still gets the rejection, but a
    // failed allocation must not fail every allocation queued behind it.
    this.#queue = next.catch(() => undefined);
    return next;
  }
}
