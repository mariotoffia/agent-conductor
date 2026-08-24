import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Worktrees,
  WORKTREE_JOURNAL_KEY,
  WORKTREE_JOURNAL_SUPERSEDED_KEY,
  type GitPort,
  type GitResult,
  type StoragePort,
  type WorktreeAllocation,
} from "../../core/index.js";

/** Storage that keeps whatever it is given, and nothing else. */
function memory(): StoragePort & { value(key: string): string | undefined } {
  const held = new Map<string, string>();
  return {
    value: (key) => held.get(key),
    async read(key) {
      return held.get(key);
    },
    async writeAtomic(key, value) {
      held.set(key, value);
    },
  };
}

const ok = (stdout = ""): GitResult => ({ code: 0, stdout, stderr: "" });
const failed = (stderr: string): GitResult => ({ code: 128, stdout: "", stderr });

interface FakeGit extends GitPort {
  /** Every invocation, in the order git actually saw them. */
  readonly calls: string[][];
  /** The directory each of those ran in, at the same index. */
  readonly directories: string[];
  /** Invocations of one subcommand, however many arguments followed it. */
  matching(...prefix: string[]): string[][];
  /** The directories one subcommand was run in. */
  ranIn(...prefix: string[]): string[];
}

/**
 * A git that answers as told and remembers what it was asked.
 *
 * Deliberately not a real repository: what is under test is the order of the
 * journal and the mutations, which a real git would hide behind its own state —
 * and a test that has to build a repository to observe an ordering is one that
 * stops being run.
 */
function fakeGit(
  reply: (args: string[]) => GitResult | Promise<GitResult | undefined> | undefined = () => undefined,
): FakeGit {
  const calls: string[][] = [];
  const directories: string[] = [];
  // A fresh repository: no branch this Client would create exists yet, and
  // everything else succeeds. Each test then states only what it changes.
  const fresh = (args: string[]): GitResult =>
    args[0] === "rev-parse" ? failed("fatal: Needed a single revision") : ok();
  const at = (prefix: string[]): number[] =>
    calls.flatMap((call, index) =>
      prefix.every((word, position) => call[position] === word) ? [index] : []);
  return {
    calls,
    directories,
    matching: (...prefix) => at(prefix).map((index) => calls[index] as string[]),
    ranIn: (...prefix) => at(prefix).map((index) => directories[index] as string),
    async run(args, cwd) {
      calls.push([...args]);
      directories.push(cwd);
      return (await reply([...args])) ?? fresh([...args]);
    },
  };
}

function journal(store: ReturnType<typeof memory>): WorktreeAllocation[] {
  const text = store.value(WORKTREE_JOURNAL_KEY);
  if (text === undefined) return [];
  return (JSON.parse(text) as { worktrees: WorktreeAllocation[] }).worktrees;
}

function worktrees(git: GitPort, store: StoragePort, root = "/worktrees"): Worktrees {
  let clock = 1_000;
  return new Worktrees({ git, storage: store, root: () => root, now: () => (clock += 1) });
}

test("the allocation is recorded before git is asked to create anything", async () => {
  const store = memory();
  const seen: WorktreeAllocation[][] = [];
  const git = fakeGit((args) => {
    if (args[0] === "worktree" && args[1] === "add") seen.push(journal(store));
    return undefined;
  });

  await worktrees(git, store).allocate({ sessionKey: "abc", repository: "/repo" });

  assert.equal(seen.length, 1, "a worktree is created exactly once");
  assert.equal(
    seen[0]?.length,
    1,
    "an extension host killed during `git worktree add` must leave a record of what it intended",
  );
  assert.equal(seen[0]?.[0]?.added, undefined, "nothing claims the worktree exists until it does");
});

test("an allocation that git refused leaves nothing claiming a worktree exists", async () => {
  const store = memory();
  const git = fakeGit((args) =>
    args[0] === "worktree" && args[1] === "add" ? failed("fatal: already exists") : undefined,
  );

  await assert.rejects(
    () => worktrees(git, store).allocate({ sessionKey: "abc", repository: "/repo" }),
    /already exists/,
  );

  assert.deepEqual(journal(store), []);
});

test("git mutations are serialized, whatever order they were asked for in", async () => {
  const store = memory();
  let inside = 0;
  let overlapped = false;
  const git = fakeGit(async (args) => {
    if (args[0] !== "worktree" || args[1] !== "add") return undefined;
    inside += 1;
    if (inside > 1) overlapped = true;
    await new Promise((resolve) => setTimeout(resolve, 5));
    inside -= 1;
    return ok();
  });
  const trees = worktrees(git, store);

  await Promise.all([
    trees.allocate({ sessionKey: "one", repository: "/repo" }),
    trees.allocate({ sessionKey: "two", repository: "/repo" }),
    trees.allocate({ sessionKey: "three", repository: "/repo" }),
  ]);

  assert.equal(overlapped, false, "two `git worktree add` runs in one repository race each other");
  assert.equal(git.matching("worktree", "add").length, 3);
  assert.equal(journal(store).length, 3);
});

test("a branch name that is already taken is stepped past rather than reused", async () => {
  const store = memory();
  // `rev-parse --verify` succeeds for a ref that exists, which is what a
  // leftover branch from a previous run looks like.
  const git = fakeGit((args) =>
    args[0] === "rev-parse" && args.at(-1)?.endsWith("/abc") === true ? ok("deadbeef") : undefined,
  );

  const allocation = await worktrees(git, store).allocate({ sessionKey: "abc", repository: "/repo" });

  assert.notEqual(allocation.branch, "agent-conductor/abc");
  assert.match(allocation.branch, /^agent-conductor\/abc-2$/);
  assert.match(allocation.path, /abc-2$/);
});

test("the branch and the path a session gets are derived from its own identity", async () => {
  const store = memory();
  const git = fakeGit();

  const allocation = await worktrees(git, store).allocate({
    sessionKey: "Sess ion/../..#7",
    repository: "/repo",
  });

  assert.equal(
    /^[A-Za-z0-9._-]+$/.test(allocation.branch.replace("agent-conductor/", "")),
    true,
    "an agent-chosen session id must not be able to name a path or a ref of its own",
  );
  assert.equal(allocation.path.includes(".."), false);
});

test("a worktree with uncommitted changes is never removed automatically", async () => {
  const store = memory();
  const git = fakeGit((args) =>
    args[0] === "status" ? ok(" M src/core/session.ts\n?? notes.md\n") : undefined,
  );
  const trees = worktrees(git, store);
  const allocation = await trees.allocate({ sessionKey: "abc", repository: "/repo" });

  const outcome = await trees.release(allocation.path);

  assert.equal(outcome.removed, false);
  assert.match(outcome.reason ?? "", /uncommitted/i);
  assert.deepEqual(git.matching("worktree", "remove"), [], "the removal must not even be attempted");
  assert.equal(journal(store).length, 1, "a worktree still on disk stays in the journal");
});

test("a clean worktree is removed, and the branch it holds is left alone", async () => {
  const store = memory();
  const git = fakeGit();
  const trees = worktrees(git, store);
  const allocation = await trees.allocate({ sessionKey: "abc", repository: "/repo" });

  const outcome = await trees.release(allocation.path);

  assert.equal(outcome.removed, true);
  assert.deepEqual(git.matching("worktree", "remove")[0]?.slice(0, 3), [
    "worktree",
    "remove",
    allocation.path,
  ]);
  assert.deepEqual(git.matching("branch", "-D"), [], "committed work lives on the branch");
  assert.deepEqual(journal(store), []);
});

test("a dirty worktree is removed only when the removal was asked for explicitly", async () => {
  const store = memory();
  const git = fakeGit((args) => (args[0] === "status" ? ok(" M file\n") : undefined));
  const trees = worktrees(git, store);
  const allocation = await trees.allocate({ sessionKey: "abc", repository: "/repo" });

  const outcome = await trees.release(allocation.path, { force: true });

  assert.equal(outcome.removed, true);
  assert.equal(git.matching("worktree", "remove")[0]?.includes("--force"), true);
  assert.deepEqual(journal(store), []);
});

test("an allocation abandoned before git ran is reconciled away on the next activation", async () => {
  const store = memory();
  await store.writeAtomic(
    WORKTREE_JOURNAL_KEY,
    JSON.stringify({
      version: 1,
      worktrees: [
        { sessionKey: "gone", repository: "/repo", path: "/worktrees/gone", branch: "agent-conductor/gone", createdAt: 1 },
        { sessionKey: "live", repository: "/repo", path: "/worktrees/live", branch: "agent-conductor/live", createdAt: 2, added: true },
      ],
    }),
  );
  const git = fakeGit((args) =>
    args[0] === "worktree" && args[1] === "list"
      ? ok("worktree /repo\n\nworktree /worktrees/live\nbranch refs/heads/agent-conductor/live\n\n")
      : undefined,
  );

  const outcome = await worktrees(git, store).reconcile();

  assert.deepEqual(outcome.abandoned, ["/worktrees/gone"]);
  assert.deepEqual(journal(store).map((entry) => entry.path), ["/worktrees/live"]);
});

test("reconciliation never deletes a worktree git still knows about", async () => {
  const store = memory();
  await store.writeAtomic(
    WORKTREE_JOURNAL_KEY,
    JSON.stringify({
      version: 1,
      worktrees: [
        { sessionKey: "live", repository: "/repo", path: "/worktrees/live", branch: "agent-conductor/live", createdAt: 2, added: true },
      ],
    }),
  );
  const git = fakeGit((args) =>
    args[0] === "worktree" && args[1] === "list"
      ? ok("worktree /repo\n\nworktree /worktrees/live\nbranch refs/heads/agent-conductor/live\n\n")
      : undefined,
  );

  const outcome = await worktrees(git, store).reconcile();

  assert.deepEqual(outcome.abandoned, []);
  assert.deepEqual(git.matching("worktree", "remove"), [], "somebody's unmerged work is not ours to delete");
  assert.equal(journal(store).length, 1);
});

test("a journal this build cannot understand is kept, not written over in place", async () => {
  const store = memory();
  await store.writeAtomic(WORKTREE_JOURNAL_KEY, "{ not json");
  const git = fakeGit();

  assert.deepEqual(await worktrees(git, store).list(), []);
  // It will not start making sense, so refusing for ever would disable
  // worktrees in every window with no way back from inside the product. It is
  // set aside whole, because it names checkouts that may still be on disk.
  const allocation = await worktrees(git, store).allocate({ sessionKey: "abc", repository: "/repo" });

  assert.equal(store.value(WORKTREE_JOURNAL_SUPERSEDED_KEY), "{ not json");
  assert.deepEqual(journal(store).map((entry) => entry.path), [allocation.path]);
});

test("one storage failure does not trade every allocation for the next one", async () => {
  const store = memory();
  await store.writeAtomic(
    WORKTREE_JOURNAL_KEY,
    JSON.stringify({
      version: 1,
      worktrees: [
        { sessionKey: "a", repository: "/repo", path: "/worktrees/a", branch: "agent-conductor/a", createdAt: 1, added: true },
        { sessionKey: "b", repository: "/repo", path: "/worktrees/b", branch: "agent-conductor/b", createdAt: 2, added: true },
      ],
    }),
  );
  const held = store.read.bind(store);
  let failures = 1;
  const flaky: StoragePort = {
    read: async (key) => {
      if (failures-- > 0) throw new Error("EIO");
      return held(key);
    },
    writeAtomic: (key, value) => store.writeAtomic(key, value),
  };
  const trees = new Worktrees({
    git: fakeGit(),
    storage: flaky,
    root: () => "/worktrees",
    now: () => 3,
  });

  await assert.rejects(() => trees.allocate({ sessionKey: "c", repository: "/repo" }), /EIO/);

  assert.deepEqual(
    journal(store).map((entry) => entry.path),
    ["/worktrees/a", "/worktrees/b"],
    "a transient read answered as an empty journal would have stranded both of these",
  );
});

test("a worktree root that is not absolute is refused before anything is created", async () => {
  const store = memory();
  const git = fakeGit();

  await assert.rejects(
    () => worktrees(git, store, "relative/worktrees").allocate({ sessionKey: "abc", repository: "/repo" }),
    /absolute/,
  );
  assert.deepEqual(git.calls, []);
});

test("a repository git could not be asked about keeps every allocation it has", async () => {
  const store = memory();
  await store.writeAtomic(
    WORKTREE_JOURNAL_KEY,
    JSON.stringify({
      version: 1,
      worktrees: [
        { sessionKey: "live", repository: "/repo", path: "/worktrees/live", branch: "agent-conductor/live", createdAt: 2, added: true },
      ],
    }),
  );
  // What an unmounted drive, a moved repository, or a `git` missing from PATH
  // looks like from here. None of them means the worktree is gone.
  const git = fakeGit(() => failed("fatal: not a git repository"));

  const outcome = await worktrees(git, store).reconcile();

  assert.deepEqual(outcome.abandoned, []);
  assert.deepEqual(journal(store).map((entry) => entry.path), ["/worktrees/live"]);
  assert.deepEqual(git.matching("worktree", "prune"), [], "nothing is pruned on a guess");
});

test("nothing is pruned, because what git still lists is not ours to forget", async () => {
  const store = memory();
  await store.writeAtomic(
    WORKTREE_JOURNAL_KEY,
    JSON.stringify({
      version: 1,
      worktrees: [
        { sessionKey: "gone", repository: "/repo-a", path: "/worktrees/gone", branch: "agent-conductor/gone", createdAt: 1 },
        { sessionKey: "live", repository: "/repo-b", path: "/worktrees/live", branch: "agent-conductor/live", createdAt: 2, added: true },
      ],
    }),
  );
  const git = fakeGit((args) =>
    args[0] === "worktree" && args[1] === "list"
      ? ok("worktree /worktrees/live\nbranch refs/heads/agent-conductor/live\n\n")
      : undefined,
  );

  await worktrees(git, store).reconcile();

  // Git lists a worktree whose directory is missing rather than forgetting it,
  // so every entry reconciliation drops is one git already has no record of —
  // there is nothing of ours left to prune. What prune *would* reach is a
  // worktree still registered whose directory is not there right now: an
  // unmounted drive, and as likely to be one the user made themselves.
  assert.deepEqual(git.matching("worktree", "prune"), []);
  assert.deepEqual(journal(store).map((entry) => entry.path), ["/worktrees/live"]);
});

test("a worktree whose directory is gone can still be cleared", async () => {
  const store = memory();
  const git = fakeGit((args) => {
    if (args[0] === "status") return failed("fatal: cannot change to '/worktrees/abc'");
    if (args[0] === "worktree" && args[1] === "list") {
      // What real git says about a worktree it still has a record of and whose
      // working tree is not there.
      return ok(
        "worktree /repo\n\nworktree /worktrees/abc\nbranch refs/heads/agent-conductor/abc\n" +
          "prunable gitdir file points to non-existent location\n\n",
      );
    }
    return undefined;
  });
  const trees = worktrees(git, store);
  const allocation = await trees.allocate({ sessionKey: "abc", repository: "/repo" });

  const outcome = await trees.release(allocation.path);

  // Somebody deleted the directory by hand, which is the most ordinary manual
  // cleanup there is. There is no working tree, so there is no uncommitted work
  // to protect and nothing to ask about — git needs `--force` only because it
  // will not take a broken checkout out of its records without it.
  assert.equal(outcome.removed, true);
  assert.equal(git.matching("worktree", "remove")[0]?.includes("--force"), true);
  assert.deepEqual(journal(store), []);
});

test("a worktree git could not be asked about at all is still refused", async () => {
  const store = memory();
  const trees = worktrees(fakeGit(), store);
  const allocation = await trees.allocate({ sessionKey: "abc", repository: "/repo" });
  const blind = worktrees(
    fakeGit((args) => (args[0] === "status" || args[1] === "list" ? failed("no git here") : undefined)),
    store,
  );

  const outcome = await blind.release(allocation.path);

  assert.equal(outcome.removed, false);
  assert.equal(outcome.cause, "uninspectable");
  assert.deepEqual(journal(store).length, 1);
});
