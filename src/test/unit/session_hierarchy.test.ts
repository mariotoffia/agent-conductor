import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionsTree } from "../../vscode/sessionsTree.js";
import { conditions, held, liveSession, record } from "../session-fixtures.js";

/**
 * Which row sits under which.
 *
 * A Subagent names its parent by session id, and an Agent chooses that id — so
 * the lineage is read from a file two windows write, and every shape it can hold
 * has to leave rows behind. A view that comes back empty is one from which no
 * Session can be cancelled.
 */

test("a subagent is drawn under the session that spawned it", async () => {
  const tree = new SessionsTree({
    storage: held([
      record(),
      record({ sessionId: "sess-child", parentSessionId: "sess-parent", runtimeId: "codex" }),
    ]),
    conditions,
    now: () => 100_000,
  });

  const roots = await tree.getChildren();

  assert.deepEqual(roots.map((node) => node.id), ["sess-parent"]);
  const children = await tree.getChildren(roots[0]);
  assert.deepEqual(children.map((node) => node.id), ["sess-child"]);
});

test("two sessions an agent gave the same name are two rows, not one", async () => {
  // An Agent chooses its own session id, and nothing makes it unique across
  // runtimes or folders — the store says as much, keying a record on all three.
  // Keyed on the id alone, one of these would silently never be drawn, and a
  // Session nothing draws is a Session nothing can cancel or resume.
  const tree = new SessionsTree({
    storage: held([
      record({ sessionId: "session-1", runtimeId: "claude", workspace: "/repo" }),
      record({ sessionId: "session-1", runtimeId: "codex", workspace: "/repo" }),
      record({ sessionId: "session-1", runtimeId: "claude", workspace: "/other" }),
    ]),
    conditions: () => ({
      fingerprints: new Map([["claude", "fp-claude"], ["codex", "fp-claude"]]),
      workspaces: ["/repo", "/other"], now: 0, window: "this-window",
    }),
    now: () => 100_000,
  });

  const roots = await tree.getChildren();

  assert.equal(roots.length, 3);
  // And each row is its own row as far as the view is concerned.
  assert.equal(new Set(roots.map((entry) => tree.getTreeItem(entry).id)).size, 3);
});

test("a session with subagents is drawn as something the view can expand", async () => {
  const tree = new SessionsTree({
    storage: held([
      record(),
      record({ sessionId: "sess-child", parentSessionId: "sess-parent", runtimeId: "codex" }),
      record({ sessionId: "sess-alone" }),
    ]),
    conditions: () => ({
      fingerprints: new Map([["claude", "fp-claude"], ["codex", "fp-claude"]]),
      workspaces: ["/repo"], now: 0, window: "this-window",
    }),
    now: () => 100_000,
  });

  const byId = new Map((await tree.getChildren()).map((entry) => [entry.id, entry]));

  // VS Code only ever asks for the children of a row it was told has some, so a
  // leaf here is a Subagent nobody can reach.
  assert.equal(tree.getTreeItem(byId.get("sess-parent")!).collapsibleState, 1);
  assert.equal(tree.getTreeItem(byId.get("sess-alone")!).collapsibleState, 0);
});

test("a record that names itself, or a pair that name each other, still leaves rows", async () => {
  // The lineage is read from a file two windows write. A cycle in it must not be
  // able to empty the view: every node would be a child of another and none a
  // root, and a Session nothing shows is a Session nothing can cancel.
  const tree = new SessionsTree({
    storage: held([
      record({ sessionId: "s-self", parentSessionId: "s-self" }),
      record({ sessionId: "s-a", parentSessionId: "s-b" }),
      record({ sessionId: "s-b", parentSessionId: "s-a" }),
    ]),
    conditions,
    now: () => 0,
  });

  const roots = await tree.getChildren();

  assert.deepEqual(roots.map((row) => row.id).sort(), ["s-a", "s-b", "s-self"]);
  assert.deepEqual(roots.flatMap((row) => row.children), []);
});

test("a subagent this window is running is drawn under the session that spawned it", async () => {
  // The lineage of a live Subagent is in its own record, and the live row is the
  // one drawn — so the record has to be read for its parent even when its row
  // is not the one used.
  const tree = new SessionsTree({
    storage: held([
      record(),
      record({ sessionId: "sess-live", parentSessionId: "sess-parent", runtimeId: "codex" }),
    ]),
    conditions: () => ({
      fingerprints: new Map([["claude", "fp-claude"], ["codex", "fp-claude"]]),
      workspaces: ["/repo"], now: 0, window: "this-window",
    }),
    now: () => 0,
  });
  tree.track(liveSession({ runtimeId: "codex" }), { workspace: "/repo" });

  const roots = await tree.getChildren();

  assert.deepEqual(roots.map((row) => row.id), ["sess-parent"]);
  assert.deepEqual(roots[0].children.map((row) => [row.id, row.live]), [["sess-live", true]]);
});

test("a session that names itself as its own parent is still a row", async () => {
  const tree = new SessionsTree({
    storage: held([record({ sessionId: "s-self", parentSessionId: "s-self" })]),
    conditions,
    now: () => 0,
  });

  const roots = await tree.getChildren();

  // Its own child, endlessly expandable, is what the guard exists to stop.
  assert.deepEqual(roots.map((row) => row.id), ["s-self"]);
  assert.deepEqual(roots[0].children, []);
});

test("a ring of three sessions naming each other still leaves three rows", async () => {
  const tree = new SessionsTree({
    storage: held([
      record({ sessionId: "s-a", parentSessionId: "s-b" }),
      record({ sessionId: "s-b", parentSessionId: "s-c" }),
      record({ sessionId: "s-c", parentSessionId: "s-a" }),
    ]),
    conditions,
    now: () => 0,
  });

  // Walked to the top, not one step: a ring longer than two is what a single
  // self-check misses, and it empties the whole view.
  assert.deepEqual((await tree.getChildren()).map((row) => row.id).sort(), ["s-a", "s-b", "s-c"]);
});

test("a lineage that loops back on itself part way up still leaves rows", async () => {
  // Not a ring through the row being drawn: this one walks up into a loop that
  // does not include it. A walk that only remembered where it started would go
  // round it for ever, and the view would never be drawn at all.
  const tree = new SessionsTree({
    storage: held([
      record({ sessionId: "s-a", parentSessionId: "s-b" }),
      record({ sessionId: "s-b", parentSessionId: "s-c" }),
      record({ sessionId: "s-c", parentSessionId: "s-b" }),
    ]),
    conditions,
    now: () => 0,
  });

  const rows = await tree.getChildren();

  assert.deepEqual(rows.map((row) => row.id).sort(), ["s-a", "s-b", "s-c"]);
});
