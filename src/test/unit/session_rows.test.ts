import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  ICONS,
  LIVE_CONTEXT,
  PAST_CONTEXT,
  RESUMABLE_CONTEXT,
  SessionsTree,
  WORKTREE_MARK,
} from "../../vscode/sessionsTree.js";
import { conditions, held, liveSession, record } from "../session-fixtures.js";

/**
 * What one row in the Sessions tree says, and what it offers.
 *
 * Everything here is drawn from an Agent's or a repository's own text, so the
 * cases that matter are the hostile ones: a model id the Agent clamped silently,
 * a Runtime id written by a checked-out repository, a session id an Agent reused
 * or a value it echoed back out of its own environment.
 */

test("a row says the runtime, the state, what is verified, the cost and how long it ran", async () => {
  const tree = new SessionsTree({
    storage: held([
      record({
        // Asked for one model and confirmed running another: the clamp Read-back
        // exists to surface (ADR-0005).
        model: { requested: "opus", effective: "sonnet", verification: "verified" },
        // Asked for and never confirmed. Nothing here may claim it is running.
        effort: { requested: "high", verification: "unavailable" },
      }),
    ]),
    conditions,
    now: () => 100_000,
  });

  const [node] = await tree.getChildren();
  const item = tree.getTreeItem(node);

  assert.equal(item.label, "claude");
  // "ago", never "ran for": a record keeps when it was first and last written,
  // and a Session resumed the next day keeps its original stamp — so the span
  // between them is a day, not the minutes anybody spent in it.
  assert.equal(item.description, "disposed · model sonnet ⚠ · effort high? · cost unknown · 39s ago");
  assert.match(String(item.tooltip), /Last active 39s ago/);
  assert.match(String(item.tooltip), /requested opus, effective sonnet — mismatch/);
  assert.match(String(item.tooltip), /the agent reports no effective value \(unavailable\)/);
});

test("what a row offers follows what can actually be done with it", async () => {
  const tree = new SessionsTree({
    storage: held([
      record({ sessionId: "sess-resumable" }),
      record({ sessionId: "sess-gone", runtimeId: "ghost" }),
      record({ sessionId: "sess-elsewhere", workspace: "/other" }),
      record({ sessionId: "sess-unloadable", loadable: false }),
      record({ sessionId: "sess-worktree", worktree: { path: "/repo/.worktrees/a", branch: "conductor/a" } }),
    ]),
    conditions,
    now: () => 100_000,
  });

  const byId = new Map((await tree.getChildren()).map((node) => [node.id, node]));

  assert.equal(byId.get("sess-resumable")?.blocked, undefined);
  assert.equal(tree.getTreeItem(byId.get("sess-resumable")!).contextValue, RESUMABLE_CONTEXT);
  // Each of the four fails closed on its own terms, and says which (ADR-0008).
  assert.equal(byId.get("sess-gone")?.blocked, "runtime-gone");
  assert.equal(byId.get("sess-elsewhere")?.blocked, "workspace-closed");
  assert.equal(byId.get("sess-unloadable")?.blocked, "agent-cannot-load");
  assert.equal(tree.getTreeItem(byId.get("sess-gone")!).contextValue, PAST_CONTEXT);
  assert.match(String(tree.getTreeItem(byId.get("sess-unloadable")!).tooltip), /does not support session\/load/);
  // Only a Session with a worktree of its own offers to open one.
  assert.equal(
    tree.getTreeItem(byId.get("sess-worktree")!).contextValue,
    `${RESUMABLE_CONTEXT}${WORKTREE_MARK}`,
  );
});

// ---------------------------------------------------------------------------
// What a row can be asked to do. A tree is drawn from a file and then sat on,
// so everything the row said is checked again at the moment somebody clicks.
// ---------------------------------------------------------------------------



test("every context value the tree produces is one the manifest offers an action for", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
  ) as { contributes: { menus: Record<string, { command: string; when?: string }[]> } };
  const clauses = (manifest.contributes.menus["view/item/context"] ?? []).map((entry) => {
    const match = /viewItem =~ \/(.+?)\//.exec(entry.when ?? "");
    assert.ok(match, `${entry.command} does not match on a context value`);
    return { command: entry.command, pattern: new RegExp(match[1]) };
  });
  const tree = new SessionsTree({
    storage: held([
      record({ sessionId: "sess-resumable" }),
      record({ sessionId: "sess-past", runtimeId: "ghost" }),
      record({ sessionId: "sess-worktree", worktree: { path: "/repo/w", branch: "b" } }),
    ]),
    conditions,
    now: () => 0,
  });
  tree.track(
    {
      sessionId: "sess-live",
      runtimeId: "claude",
      state: "prompting",
      modelSelection: { verification: "unavailable" },
      effortSelection: { verification: "unavailable" },
      exited: new Promise(() => undefined),
    },
    { workspace: "/repo" },
  );

  const offered = new Map<string, string[]>();
  for (const row of await tree.getChildren()) {
    const context = tree.getTreeItem(row).contextValue ?? "";
    offered.set(
      row.id,
      clauses.filter((clause) => clause.pattern.test(context)).map((clause) => clause.command),
    );
  }

  // The manifest matches on the literal these constants hold, so renaming one
  // without the other silently removes the button from every row.
  assert.deepEqual(offered.get("sess-live"), ["agentConductor.cancelSession"]);
  assert.deepEqual(offered.get("sess-resumable"), ["agentConductor.resumeSession"]);
  assert.deepEqual(offered.get("sess-past"), []);
  assert.deepEqual(offered.get("sess-worktree"), [
    "agentConductor.resumeSession",
    "agentConductor.openWorktreeDiff",
  ]);
});


test("a row's icon follows the state it is in", async () => {
  const tree = new SessionsTree({
    storage: held([
      record({ sessionId: "s-failed", state: "failed" }),
      record({ sessionId: "s-disposed", state: "disposed" }),
    ]),
    conditions,
    now: () => 0,
    icon: (id) => id,
  });
  tree.track(liveSession({ state: "prompting" }), { workspace: "/repo" });

  const icons = new Map(
    (await tree.getChildren()).map((row) => [row.id, tree.getTreeItem(row).iconPath]),
  );

  assert.equal(icons.get("sess-live"), ICONS.running);
  assert.equal(icons.get("s-failed"), ICONS.broken);
  assert.equal(icons.get("s-disposed"), ICONS.ended);
});

test("a live session's worktree is offered while it is running, not only afterwards", async () => {
  const tree = new SessionsTree({ storage: held([]), conditions, now: () => 0 });
  tree.track(liveSession(), {
    workspace: "/repo",
    worktree: { path: "/repo/.worktrees/a", branch: "conductor/a" },
  });

  const item = tree.getTreeItem((await tree.getChildren())[0]);

  // Watching what a subagent is changing is worth most while it is changing it.
  assert.equal(item.contextValue, `${LIVE_CONTEXT}${WORKTREE_MARK}`);
  assert.match(String(item.tooltip), /Worktree \/repo\/.worktrees\/a on conductor\/a/);
});

test("a long-running session is reported in hours", async () => {
  const tree = new SessionsTree({ storage: held([]), conditions, now: () => 0 });
  tree.track(liveSession(), { workspace: "/repo" });
  const later = new SessionsTree({
    storage: held([record({ updatedAt: 0, createdAt: 0 })]),
    conditions,
    now: () => 3 * 60 * 60_000 + 25 * 60_000,
  });

  assert.match(String(tree.getTreeItem((await tree.getChildren())[0]).description), / 0s$/);
  assert.match(String(later.getTreeItem((await later.getChildren())[0]).description), / 3h25m ago$/);
});

test("every state a session can be in has an icon of its own meaning", async () => {
  const tree = new SessionsTree({
    storage: held([
      record({ sessionId: "s-idle", state: "idle" }),
      record({ sessionId: "s-configuring", state: "configuring" }),
      record({ sessionId: "s-cancelling", state: "cancelling" }),
      record({ sessionId: "s-prompting", state: "prompting" }),
      record({ sessionId: "s-failed", state: "failed" }),
      record({ sessionId: "s-disposed", state: "disposed" }),
    ]),
    conditions,
    now: () => 0,
    icon: (id) => id,
  });

  const icons = new Map(
    (await tree.getChildren()).map((row) => [row.id, tree.getTreeItem(row).iconPath]),
  );

  // Working, waiting, broken, over. A row whose icon says the same thing in
  // every state is a row nobody can read at a glance, which is the point of one.
  assert.equal(icons.get("s-prompting"), ICONS.running);
  assert.equal(icons.get("s-configuring"), ICONS.running);
  assert.equal(icons.get("s-idle"), ICONS.waiting);
  assert.equal(icons.get("s-cancelling"), ICONS.waiting);
  assert.equal(icons.get("s-failed"), ICONS.broken);
  assert.equal(icons.get("s-disposed"), ICONS.ended);
});

test("a read-back never claims a value the agent did not report", async () => {
  const tree = new SessionsTree({
    storage: held([
      // Verified, and the Agent named nothing. There is no effective value here
      // to draw, and inventing one is the whole thing Read-back exists to stop.
      record({ sessionId: "s-empty", model: { requested: "opus", verification: "verified" }, effort: undefined }),
      // Nothing was asked for, and the Agent reported what it runs.
      record({ sessionId: "s-unasked", model: { effective: "sonnet", verification: "verified" } }),
    ]),
    conditions,
    now: () => 0,
  });

  const byId = new Map((await tree.getChildren()).map((row) => [row.id, tree.getTreeItem(row)]));

  assert.doesNotMatch(String(byId.get("s-empty")?.description), /model/);
  assert.match(String(byId.get("s-empty")?.tooltip), /Effort: not recorded/);
  assert.match(String(byId.get("s-unasked")?.description), /model sonnet/);
  assert.doesNotMatch(String(byId.get("s-unasked")?.description), /⚠/);
  assert.match(String(byId.get("s-unasked")?.tooltip), /no request recorded, effective sonnet/);
});

test("a record written by a clock ahead of this one is not drawn as the future", async () => {
  // Two windows share the store and each stamps with its own clock, so a record
  // can be newer than now. Time since is what the row says, and a negative one
  // renders as a session that ran before it started.
  const tree = new SessionsTree({
    storage: held([record({ updatedAt: 500_000 })]),
    conditions,
    now: () => 0,
  });

  assert.match(String(tree.getTreeItem((await tree.getChildren())[0]).description), / 0s ago$/);
});

test("a clock that steps back during a session is not drawn as a negative age", async () => {
  // `Date.now()` is not monotonic: an NTP correction or a hand-set clock moves
  // it backwards under a session that is still running.
  const clock = { now: 100_000 };
  const tree = new SessionsTree({ storage: held([]), conditions, now: () => clock.now });
  tree.track(liveSession(), { workspace: "/repo" });
  clock.now = 0;

  assert.match(String(tree.getTreeItem((await tree.getChildren())[0]).description), / 0s$/);
});

test("a tooltip says everything a row is too narrow for", async () => {
  const tree = new SessionsTree({
    storage: held([record({ sessionId: "sess-past", updatedAt: 40_000 })]),
    conditions,
    now: () => 100_000,
  });
  tree.track(
    liveSession({
      sessionId: "sess-now",
      modelSelection: { requested: "opus", effective: "sonnet", verification: "verified" },
    }),
    { workspace: "/repo", worktree: { path: "/repo/w", branch: "conductor/w" } },
  );
  const byId = new Map((await tree.getChildren()).map((row) => [row.id, tree.getTreeItem(row)]));
  const running = String(byId.get("sess-now")?.tooltip);
  const past = String(byId.get("sess-past")?.tooltip);

  // Every line, because each is the only place its fact appears at all.
  assert.match(running, /^Running on claude$/m);
  assert.match(running, /^Session sess-now$/m);
  assert.match(running, /^Folder \/repo$/m);
  assert.match(running, /^Model: requested opus, effective sonnet — mismatch$/m);
  assert.match(running, /^Cost: unknown$/m);
  assert.match(running, /^Running for 0s$/m);
  assert.match(running, /^Worktree \/repo\/w on conductor\/w$/m);
  assert.match(past, /^Ended on claude$/m);
  assert.match(past, /^Last active 1m ago$/m);
});

test("each reason a session cannot be resumed is its own reason", async () => {
  const tree = new SessionsTree({
    storage: held([
      record({ sessionId: "s-gone", runtimeId: "ghost" }),
      record({ sessionId: "s-changed", fingerprint: "fp-was-reconnected" }),
      record({ sessionId: "s-closed", workspace: "/other" }),
      record({ sessionId: "s-unloadable", loadable: false }),
    ]),
    conditions,
    now: () => 0,
  });

  const reasons = new Map(
    (await tree.getChildren()).map((row) => [
      row.id,
      /Cannot be resumed: (.+)\./.exec(String(tree.getTreeItem(row).tooltip))?.[1] ?? "",
    ]),
  );

  // Four different things are wrong, and being told which is the whole point of
  // saying anything: three of them are things the user can put right.
  assert.match(reasons.get("s-gone") ?? "", /no longer configured or approved/);
  assert.match(reasons.get("s-changed") ?? "", /identity has changed/);
  assert.match(reasons.get("s-closed") ?? "", /folder is not open/);
  assert.match(reasons.get("s-unloadable") ?? "", /does not support session\/load/);
  assert.equal(new Set(reasons.values()).size, 4);
});

test("why a session cannot be resumed is said before anything that can crowd it out", async () => {
  const tree = new SessionsTree({
    storage: held([
      record({
        workspace: `/${"deep/".repeat(198)}repo`,
        worktree: { path: `/${"work/".repeat(198)}tree`, branch: "b" },
      }),
    ]),
    conditions: () => ({ fingerprints: new Map([["claude", "fp-claude"]]), workspaces: [], now: 0, window: "this-window" }),
    now: () => 0,
  });

  const tooltip = String(tree.getTreeItem((await tree.getChildren())[0]).tooltip);

  // The tooltip is bounded as a whole, and two of its lines carry a path a
  // repository chose the length of. The one line that tells the user what to do
  // about it must not be the one that falls off the end.
  assert.match(tooltip, /^Cannot be resumed: its folder is not open in this window\./m);
});

test("a currency an agent chose is drawn as text and bounded", async () => {
  const tree = new SessionsTree({ storage: held([]), conditions, now: () => 0 });
  tree.track(liveSession(), { workspace: "/repo" });
  tree.observe("sess-live", {
    sessionUpdate: "usage_update",
    cost: { amount: 1, currency: `**USD** [x](https://example.invalid) ${"y".repeat(300)}` },
  });

  const description = String(tree.getTreeItem((await tree.getChildren())[0]).description);

  assert.doesNotMatch(description, /\*\*/);
  assert.doesNotMatch(description, /:\/\//);
  assert.ok(description.length < 300, `description was ${description.length} characters`);
});

test("a session that replaces one an agent gave the same name does not inherit its bill", async () => {
  let exit = (): void => undefined;
  const exited = new Promise<void>((settle) => {
    exit = settle;
  });
  const tree = new SessionsTree({ storage: held([]), conditions, now: () => 0 });
  tree.track(liveSession({ exited }), { workspace: "/repo" });
  tree.observe("sess-live", { sessionUpdate: "usage_update", cost: { amount: 9, currency: "USD" } });

  // The one it replaces has not finished going away — an Agent may reuse an id,
  // and the handler that would have cleared the figure has not run yet.
  tree.track(liveSession(), { workspace: "/repo" });
  exit();
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();

  assert.match(String(tree.getTreeItem((await tree.getChildren())[0]).description), /cost unknown/);
});

test("a read-back with nothing effective in it says so rather than showing a gap", async () => {
  const tree = new SessionsTree({
    storage: held([record({ model: { requested: "opus", verification: "verified" } })]),
    conditions,
    now: () => 0,
  });

  const tooltip = String(tree.getTreeItem((await tree.getChildren())[0]).tooltip);

  // `verified` with no value is the Agent naming a selector and no current
  // value. The row leaves the slot out; the tooltip must not write "effective "
  // and stop — two readings of one thing on one row.
  assert.doesNotMatch(tooltip, /effective\s*$/m);
  assert.match(tooltip, /Model: requested opus; the agent reports no effective value/);
});

test("a live row reports both halves of what the agent says it is running", async () => {
  const tree = new SessionsTree({ storage: held([]), conditions, now: () => 0 });
  tree.track(
    liveSession({
      modelSelection: { requested: "opus", effective: "opus", verification: "verified" },
      effortSelection: { requested: "high", effective: "low", verification: "verified" },
    }),
    { workspace: "/repo" },
  );

  const description = String(tree.getTreeItem((await tree.getChildren())[0]).description);

  // Effort as much as model: a Runtime that clamps the effort and not the model
  // is the ordinary case, and a row that only ever shows one of them hides it.
  assert.match(description, /model opus/);
  assert.match(description, /effort low ⚠/);
});

test("the four states a row can be in are told apart by four different icons", () => {
  const drawn = Object.values(ICONS);

  // Not merely mapped: a codicon id that is empty or repeated draws a blank
  // where the state was, or the same picture for working and broken.
  assert.equal(new Set(drawn).size, 4);
  for (const icon of drawn) assert.match(icon, /^[a-z][a-z~-]+$/);
});

test("a figure whose currency is not a word is not a cost", async () => {
  const tree = new SessionsTree({ storage: held([]), conditions, now: () => 0 });
  tree.track(liveSession(), { workspace: "/repo" });

  // Both halves have to be what they claim, either way round: a currency that
  // is a number reads as `cost 3 7`, and an amount that is a string is a figure
  // this Client never checked (ADR-0005).
  for (const cost of [{ amount: 3, currency: 7 }, { amount: "3", currency: "USD" }]) {
    tree.observe("sess-live", { sessionUpdate: "usage_update", cost });
    assert.match(String(tree.getTreeItem((await tree.getChildren())[0]).description), /cost unknown/);
  }
});

test("a selection redacted for the screen is still the selection it was", async () => {
  const tree = new SessionsTree({ storage: held([]), conditions, now: () => 0 });
  tree.track(
    liveSession({
      // Asked for and never confirmed, on a Session that carries a credential.
      modelSelection: { requested: "opus", verification: "unavailable" },
    }),
    { workspace: "/repo", secrets: ["s3cr3t-value"] },
  );

  const item = tree.getTreeItem((await tree.getChildren())[0]);

  // Taking the secret out must not also turn "the agent reports nothing" into
  // "the agent confirmed it" — the one claim Read-back exists to prevent.
  assert.match(String(item.description), /model opus\?/);
  assert.match(String(item.tooltip), /no effective value/);
});

test("a figure that is not a number is not a cost either", async () => {
  const tree = new SessionsTree({ storage: held([]), conditions, now: () => 0 });
  tree.track(liveSession(), { workspace: "/repo" });

  for (const amount of [Number.POSITIVE_INFINITY, Number.NaN, -Number.MAX_VALUE * 2]) {
    tree.observe("sess-live", { sessionUpdate: "usage_update", cost: { amount, currency: "USD" } });
    // `cost Infinity USD` is not a cost the Agent reported; it is a shape this
    // Client failed to check (ADR-0005).
    assert.match(String(tree.getTreeItem((await tree.getChildren())[0]).description), /cost unknown/);
  }
});
