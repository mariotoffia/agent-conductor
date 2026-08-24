import assert from "node:assert/strict";
import { test } from "node:test";
import { actionHarness, rowNode as node } from "../session-fixtures.js";

/**
 * Giving a worktree back.
 *
 * Its own file rather than another section of the row actions, because it is the
 * one action that destroys something: everything here is about what has to be
 * true, and said, before a checkout is deleted. Nothing in this Client removes
 * one on its own (ADR-0009).
 */

/** A worktree row, with somewhere for its removal to be recorded. */
function removalHarness(over: {
  confirmations?: boolean[];
  outcomes?: Array<{ removed: boolean; cause?: string; reason?: string }>;
} = {}) {
  const calls: Array<{ path: string; force: boolean }> = [];
  const outcomes = [...(over.outcomes ?? [])];
  const harness = actionHarness({
    ...(over.confirmations ? { confirmations: over.confirmations } : {}),
    releaseWorktree: async (path, options) => {
      calls.push({ path, force: options?.force === true });
      return (outcomes.shift() ?? { removed: true }) as { removed: boolean; reason?: string };
    },
  });
  return { ...harness, calls };
}

const worktreeRow = node({
  worktree: { path: "/worktrees/child", branch: "agent-conductor/child" },
});

test("a worktree is not removed until somebody asks for it", async () => {
  const harness = removalHarness({ confirmations: [false] });

  await harness.actions.removeWorktree(worktreeRow);

  assert.deepEqual(harness.calls, [], "dismissing the question is not agreeing to it");
  assert.equal(harness.asked.length, 1);
});

test("a clean worktree is removed once, and its branch is left alone", async () => {
  const harness = removalHarness({ confirmations: [true] });

  await harness.actions.removeWorktree(worktreeRow);

  assert.deepEqual(harness.calls, [{ path: "/worktrees/child", force: false }]);
  assert.match(harness.said.join("\n"), /branch was left alone/);
});

test("a worktree with uncommitted changes is only removed when the user says so again", async () => {
  const harness = removalHarness({
    confirmations: [true, true],
    outcomes: [
      { removed: false, cause: "dirty", reason: "/worktrees/child has uncommitted changes" },
      { removed: true },
    ],
  });

  await harness.actions.removeWorktree(worktreeRow);

  assert.deepEqual(harness.calls, [
    { path: "/worktrees/child", force: false },
    { path: "/worktrees/child", force: true },
  ]);
  // The second question has to say what is being lost: refusing the first time
  // is only worth anything if the reason is read before the second.
  assert.match(harness.asked[1] ?? "", /uncommitted changes/);
});

test("changes are kept when the second question is answered any other way", async () => {
  const harness = removalHarness({
    confirmations: [true, false],
    outcomes: [{ removed: false, cause: "dirty", reason: "it has uncommitted changes" }],
  });

  await harness.actions.removeWorktree(worktreeRow);

  assert.deepEqual(harness.calls, [{ path: "/worktrees/child", force: false }]);
  assert.match(harness.said.join("\n"), /was kept/);
});

test("a worktree path that is not absolute is not handed to git at all", async () => {
  const harness = removalHarness({ confirmations: [true, true] });

  await harness.actions.removeWorktree(
    node({ worktree: { path: "../elsewhere", branch: "agent-conductor/child" } }),
  );

  assert.deepEqual(harness.calls, []);
  assert.deepEqual(harness.asked, []);
});

test("a window with no orchestration says so rather than doing nothing", async () => {
  const harness = actionHarness({ confirmations: [true] });

  await harness.actions.removeWorktree(worktreeRow);

  assert.match(harness.said.join("\n"), /no orchestration/i);
});


test("a worktree nobody could inspect is never forced past", async () => {
  const harness = removalHarness({
    confirmations: [true, true],
    outcomes: [
      { removed: false, cause: "uninspectable", reason: "the worktree could not be inspected: no git" },
    ],
  });

  await harness.actions.removeWorktree(worktreeRow);

  // Nothing established that there was work in that checkout, so there is
  // nothing to offer to give up. Asking "remove it anyway, losing those
  // changes" would be a sentence about changes nobody has seen.
  assert.deepEqual(harness.calls, [{ path: "/worktrees/child", force: false }]);
  assert.equal(harness.asked.length, 1);
  assert.match(harness.said.join("\n"), /was kept/);
});

test("a refusal force could not fix is not offered a second question", async () => {
  for (const cause of ["not-ours", "failed"]) {
    const harness = removalHarness({
      confirmations: [true, true],
      outcomes: [{ removed: false, cause, reason: `refused because ${cause}` }],
    });

    await harness.actions.removeWorktree(worktreeRow);

    assert.deepEqual(harness.calls, [{ path: "/worktrees/child", force: false }], cause);
    assert.equal(harness.asked.length, 1, cause);
  }
});

test("a worktree a session is still running in is not removed", async () => {
  const harness = removalHarness({ confirmations: [true, true] });

  await harness.actions.removeWorktree(
    node({ live: true, worktree: { path: "/worktrees/child", branch: "agent-conductor/child" } }),
  );

  // The row does not offer it, and the command refuses it anyway: a command is
  // invocable without a row.
  assert.deepEqual(harness.calls, []);
  assert.deepEqual(harness.asked, []);
  assert.match(harness.said.join("\n"), /still running/i);
});


test("a worktree another window's agent is working in is not removed", async () => {
  const harness = removalHarness({ confirmations: [true, true] });

  await harness.actions.removeWorktree(
    node({
      blocked: "held-elsewhere",
      worktree: { path: "/worktrees/child", branch: "agent-conductor/child" },
    }),
  );

  // Sessions are remembered per machine and every window's worktrees live under
  // one root, so a window that is not running this Session still draws its row.
  // This window cannot cancel that Session, so refusing is the only answer.
  assert.deepEqual(harness.calls, []);
  assert.deepEqual(harness.asked, []);
  assert.match(harness.said.join("\n"), /another window/i);
});
