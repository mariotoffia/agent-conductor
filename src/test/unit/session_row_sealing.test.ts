import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionsTree } from "../../vscode/sessionsTree.js";
import { conditions, held, liveSession, record } from "../session-fixtures.js";

/**
 * A row as a place somebody else's text ends up.
 *
 * Every string on a row was chosen by an Agent or written into settings a
 * checked-out repository controls, so these are the hostile cases: a value the
 * Agent read out of its own environment, a name written to look like this
 * Client's own voice, one long enough to decide how big a row is, and the id the
 * view writes down where it outlives the window (ADR-0007, ADR-0010).
 */

test("a value the agent's process was started with never reaches a row", async () => {
  const tree = new SessionsTree({ storage: held([]), conditions, now: () => 0 });
  tree.track(
    liveSession({
      sessionId: "sess-s3cr3t-value",
      modelSelection: { requested: "opus-s3cr3t-value", effective: "model-s3cr3t-value", verification: "verified" },
      effortSelection: { requested: "high-s3cr3t-value", verification: "unavailable" },
    }),
    {
      workspace: "/repo",
      secrets: ["s3cr3t-value"],
      worktree: { path: "/repo/w-s3cr3t-value", branch: "b-s3cr3t-value" },
    },
  );
  // An Agent reads its own environment, and everything it words comes back
  // through here: the id it chose, what it says it is running, what it says it
  // asked for, and the currency it puts on a figure (ADR-0010).
  tree.observe("sess-s3cr3t-value", {
    sessionUpdate: "usage_update",
    cost: { amount: 1.5, currency: "s3cr3t-value" },
  });

  const item = tree.getTreeItem((await tree.getChildren())[0]);
  const drawn = `${String(item.label)}
${String(item.description)}
${String(item.tooltip)}`;

  assert.doesNotMatch(drawn, /s3cr3t-value/);
  // And a record is redacted on its way to disk for the same reason, so a row
  // that is on screen all day is not the weaker of the two.
  assert.match(String(item.description), /cost 1\.5/);
});

test("a hostile runtime id or model name is drawn as text and bounded", async () => {
  const tree = new SessionsTree({
    storage: held([]),
    conditions,
    now: () => 0,
  });
  tree.track(
    liveSession({
      runtimeId: "**Agent Conductor**: [click](https://example.invalid)",
      modelSelection: { effective: "x".repeat(500), verification: "verified" },
    }),
    { workspace: "/repo" },
  );

  const item = tree.getTreeItem((await tree.getChildren())[0]);

  // A Runtime id comes from settings a repository can write, and a model id is
  // the Agent's to choose. Neither may look like this Client's own voice, and
  // neither may decide how long a row is (ADR-0007).
  assert.doesNotMatch(String(item.label), /\*\*/);
  assert.doesNotMatch(String(item.label), /:\/\//);
  assert.ok(String(item.label).length <= 80, `label was ${String(item.label).length} characters`);
  assert.ok(String(item.description).includes("…"), "an unbounded model name was drawn whole");
});

test("what the view remembers a row by carries none of the agent's own words", async () => {
  const tree = new SessionsTree({ storage: held([]), conditions, now: () => 0 });
  tree.track(liveSession({ sessionId: "sess-s3cr3t-value" }), {
    workspace: "/repo",
    secrets: ["s3cr3t-value"],
  });

  const item = tree.getTreeItem((await tree.getChildren())[0]);

  // VS Code keeps which rows are open and selected under this id, in storage
  // that outlives the window. An Agent chooses its own session id, so the id
  // this Client hands over is derived rather than passed through (ADR-0010).
  assert.doesNotMatch(String(item.id), /s3cr3t-value/);
  assert.doesNotMatch(String(item.id), /sess-/);
  assert.match(String(item.id), /^[0-9a-f]{32}$/);
});

test("a tooltip's length is this client's to decide, not a repository's", async () => {
  const tree = new SessionsTree({
    // Each string is inside what a record may hold; the tooltip is the sum.
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

  // A workspace path and a worktree path are each bounded, and a tooltip made of
  // several of them has to be bounded again as a whole.
  assert.ok(tooltip.length <= 2_000, `tooltip was ${tooltip.length} characters`);
});

test("a name padded with space is bounded by what it says, not by the padding", async () => {
  const tree = new SessionsTree({ storage: held([]), conditions, now: () => 0 });
  tree.track(liveSession({ runtimeId: `${" ".repeat(200)}claude` }), { workspace: "/repo" });

  assert.equal(tree.getTreeItem((await tree.getChildren())[0]).label, "claude");
});

test("taking a credential out of what the agent said does not change what it said", async () => {
  const tree = new SessionsTree({ storage: held([]), conditions, now: () => 0 });
  tree.track(
    liveSession({
      // Confirmed by the Agent, on a Session that carries a credential.
      modelSelection: { requested: "opus", effective: "opus", verification: "verified" },
    }),
    { workspace: "/repo", secrets: ["s3cr3t-value"] },
  );

  const description = String(tree.getTreeItem((await tree.getChildren())[0]).description);

  // Redaction rewrites the values; it must not rewrite whether the Agent
  // confirmed them. Turning `verified` into anything else silently downgrades a
  // read-back, and turning anything else into `verified` invents one — the
  // claim Read-back exists to prevent (ADR-0005).
  assert.match(description, /model opus(?! ⚠)/);
  assert.doesNotMatch(description, /model opus\?/);
});

test("the folder a live session runs in is drawn with the same barrier as its record", async () => {
  const tree = new SessionsTree({ storage: held([]), conditions, now: () => 0 });
  tree.track(liveSession(), { workspace: "/Users/me/s3cr3t-value", secrets: ["s3cr3t-value"] });

  const item = tree.getTreeItem((await tree.getChildren())[0]);

  // A record redacts every string on its way to disk, so a live row that draws
  // one of them raw makes the row and its own record disagree (ADR-0010).
  assert.doesNotMatch(String(item.tooltip), /s3cr3t-value/);
});
