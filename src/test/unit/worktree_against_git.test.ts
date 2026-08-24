import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { nodeGitPort, Worktrees, type StoragePort } from "../../core/index.js";

/**
 * The worktree lifecycle against real git, once.
 *
 * Everything else about this file is tested with a git that answers as it is
 * told, which is the only way to pin *when* things happen relative to the
 * journal. What a fake cannot show is what git actually says: it reports the
 * realpath of a worktree rather than the path it was given, so a root reached
 * through a symlink — and `os.tmpdir()` is one on macOS, as is anything under
 * `/tmp` — produces a journal whose paths never match what git lists. The fake
 * echoes back whatever path the test wrote, so it agrees with itself forever.
 *
 * Git is required rather than skipped around. A test that quietly does not run
 * is one that reports success for a broken branch, and `make doctor` already
 * insists on git.
 */

function memory(): StoragePort {
  const held = new Map<string, string>();
  return {
    async read(key) {
      return held.get(key);
    },
    async writeAtomic(key, value) {
      held.set(key, value);
    },
  };
}

/** A repository with one commit, under a directory the platform may symlink. */
async function repository(t: TestContext): Promise<{ home: string; repo: string }> {
  const home = await mkdtemp(join(tmpdir(), "conductor-worktree-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const repo = join(home, "repo");
  await mkdir(repo, { recursive: true });
  const identity = ["-c", "user.email=test@example.com", "-c", "user.name=Test"];
  for (const args of [
    ["init", "--initial-branch=main"],
    [...identity, "commit", "--allow-empty", "-m", "first"],
  ]) {
    const result = await nodeGitPort.run(args, repo);
    assert.equal(result.code, 0, `git ${args.join(" ")}: ${result.stderr}`);
  }
  return { home, repo };
}

function worktrees(home: string, storage: StoragePort): Worktrees {
  let clock = 0;
  return new Worktrees({
    git: nodeGitPort,
    storage,
    root: () => join(home, "worktrees"),
    now: () => (clock += 1),
  });
}

test("a real worktree survives the reconciliation that follows it", { timeout: 30_000 }, async (t) => {
  const { home, repo } = await repository(t);
  const storage = memory();
  const trees = worktrees(home, storage);

  const allocation = await trees.allocate({ sessionKey: "child", repository: repo });
  const settled = await trees.reconcile();

  // The journal has to name the checkout the way git names it, or the very next
  // activation calls it abandoned and drops it — while it sits on disk holding
  // whatever the Subagent did.
  assert.deepEqual(settled.abandoned, [], "the worktree it just made must not read as abandoned");
  assert.deepEqual(settled.kept, [allocation.path]);
  assert.deepEqual(
    (await trees.list()).map((entry) => entry.path),
    [allocation.path],
  );
});

test("a real worktree with work in it is refused, and given back once it is clean", { timeout: 30_000 }, async (t) => {
  const { home, repo } = await repository(t);
  const trees = worktrees(home, memory());
  const allocation = await trees.allocate({ sessionKey: "child", repository: repo });

  await writeFile(join(allocation.path, "unsaved.txt"), "work nobody has committed\n");
  const refused = await trees.release(allocation.path);
  assert.equal(refused.removed, false);
  assert.equal(refused.cause, "dirty");

  await rm(join(allocation.path, "unsaved.txt"));
  const removed = await trees.release(allocation.path);
  assert.equal(removed.removed, true, removed.reason);

  // The branch is what committed work would live on, so removing a checkout
  // never removes it.
  const branch = await nodeGitPort.run(["rev-parse", "--verify", allocation.branch], repo);
  assert.equal(branch.code, 0, "the branch was deleted with the worktree");
});

test("a real worktree whose directory somebody deleted can still be cleared", { timeout: 30_000 }, async (t) => {
  const { home, repo } = await repository(t);
  const storage = memory();
  const trees = worktrees(home, storage);
  const allocation = await trees.allocate({ sessionKey: "child", repository: repo });

  // The most ordinary manual cleanup there is. `git status` cannot run in a
  // directory that is not there, and git reports the worktree as prunable —
  // which is the difference between "nobody knows what is in there" and "there
  // is provably nothing there".
  await rm(allocation.path, { recursive: true, force: true });

  const removed = await trees.release(allocation.path);

  assert.equal(removed.removed, true, removed.reason);
  assert.deepEqual(await trees.list(), []);
  const listed = await nodeGitPort.run(["worktree", "list", "--porcelain"], repo);
  assert.equal(listed.stdout.includes(allocation.path), false, "git still has a record of it");
});
