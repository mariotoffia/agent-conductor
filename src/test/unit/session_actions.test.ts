import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { sessionActions, sessionCommands } from "../../vscode/sessionActions.js";
import { SessionsTree } from "../../vscode/sessionsTree.js";
import { fileRoots, sessionFolders } from "../../vscode/spawnGate.js";
import { actionHarness, conditions, held, record, rowNode as node } from "../session-fixtures.js";

/**
 * What a row can be asked to do.
 *
 * A tree is drawn from a file and then sat on, so everything the row said is
 * checked again at the moment somebody clicks: the folder may have been closed,
 * the approval may have lapsed, and the record may name a worktree that is not a
 * path at all.
 */

test("a session is never reattached to in a folder this window does not hold", async () => {
  // The row was drawn when the folder was open. Nothing about a record proves
  // it still is, and starting an agent in a folder nobody opened is the thing
  // to refuse (ADR-0007).
  const harness = actionHarness({ workspaces: ["/elsewhere"] });

  await harness.actions.resume(node());

  assert.deepEqual(harness.resumed, []);
  assert.equal(harness.said.length, 1);
});

test("a row for a session this window is already running is not reattached to", async () => {
  const harness = actionHarness();

  await harness.actions.resume(node({ live: true }));

  // Already attached. Reattaching would end it to make room for itself.
  assert.deepEqual(harness.resumed, []);
});

test("a resumable row reattaches through the participant that owns every session", async () => {
  const harness = actionHarness();

  await harness.actions.resume(node());

  assert.deepEqual(harness.resumed, [
    { sessionId: "sess-parent", runtimeId: "claude", workspace: "/repo" },
  ]);
});

test("a refused resume is reported rather than thrown at the command host", async () => {
  const harness = actionHarness();
  harness.refuseWith(new Error("agent does not support session/load"));

  await harness.actions.resume(node());

  assert.equal(harness.said.length, 1);
  assert.match(harness.said[0], /could not be resumed/);
});

test("only a session with a worktree opens one, and only in source control", async () => {
  const harness = actionHarness();

  await harness.actions.openWorktreeDiff(node());
  assert.deepEqual(harness.executed, []);

  await harness.actions.openWorktreeDiff(
    node({ worktree: { path: "/repo/.worktrees/a", branch: "conductor/a" } }),
  );

  assert.deepEqual(harness.executed, [
    ["git.openRepository", "/repo/.worktrees/a"],
    ["workbench.view.scm"],
  ]);
});

test("cancelling a row names the session it is about", async () => {
  const harness = actionHarness();

  await harness.actions.cancel(node({ id: "sess-live", live: true }));
  await harness.actions.cancel(undefined);

  assert.deepEqual(harness.cancelled, ["sess-live"]);
});

test("every action a row offers is a command the manifest declares", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
  ) as {
    contributes: {
      commands: { command: string }[];
      menus: Record<string, { command: string; when?: string }[]>;
    };
  };
  const contributed = new Set(manifest.contributes.commands.map((entry) => entry.command));
  const rowActions = manifest.contributes.menus["view/item/context"] ?? [];

  assert.ok(rowActions.length > 0, "the tree offers no actions at all");
  for (const action of rowActions) {
    // A menu entry naming a command the manifest does not declare is a row whose
    // button VS Code will not draw at all.
    assert.ok(contributed.has(action.command), `${action.command} is not a contributed command`);
  }

  // A row's command needs the row. Left in the palette it would arrive with no
  // argument at all and quietly do nothing, which reads as a broken action.
  const palette = new Map(
    (manifest.contributes.menus.commandPalette ?? []).map((entry) => [entry.command, entry.when]),
  );
  for (const action of rowActions) {
    assert.equal(palette.get(action.command), "false", `${action.command} is offered without a row`);
  }
});

test("a worktree path that is not absolute is refused rather than handed to git", async () => {
  const harness = actionHarness();

  await harness.actions.openWorktreeDiff(
    node({ worktree: { path: "../../elsewhere", branch: "b" } }),
  );

  // The path reaches VS Code's Git extension, which runs git inside whatever
  // directory it names. Where a worktree may be is the Orchestrator's to decide
  // when it makes one; that it is a path at all is decided here.
  assert.deepEqual(harness.executed, []);
  assert.equal(harness.said.length, 1);
});

test("a window with no git extension is told so rather than left with a dead button", async () => {
  const harness = actionHarness();
  harness.refuseWith(new Error("command 'git.openRepository' not found"));

  await harness.actions.openWorktreeDiff(
    node({ worktree: { path: "/repo/.worktrees/a", branch: "b" } }),
  );

  assert.equal(harness.said.length, 1);
  assert.match(harness.said[0], /Source Control/);
});

test("a row that cannot be resumed says so rather than doing nothing", async () => {
  const harness = actionHarness();

  await harness.actions.resume(node({ fingerprint: "fp-from-before-the-upgrade" }));

  // Refused, and said out loud: a click that quietly does nothing reads as a
  // broken button rather than as an answer.
  assert.equal(harness.said.length, 1);
});

test("opening a folder starts an agent only where the setting says so", async () => {
  const saved = held([record({ sessionId: "sess-saved" })]);
  const off = actionHarness();
  await sessionActions({
    participant: { dispose: async () => undefined, cancel: async () => undefined, resume: off.resume },
    host: off.host,
    workspaces: () => ["/repo"],
    storage: saved,
    conditions,
    resumeOnStartup: () => false,
  }).resumeOnStartup();
  assert.deepEqual(off.resumed, [], "activating an extension is not a request to run anything");

  const on = actionHarness();
  await sessionActions({
    participant: { dispose: async () => undefined, cancel: async () => undefined, resume: on.resume },
    host: on.host,
    workspaces: () => ["/repo"],
    storage: saved,
    conditions,
    resumeOnStartup: () => true,
  }).resumeOnStartup();

  assert.deepEqual(on.resumed, [
    { sessionId: "sess-saved", runtimeId: "claude", workspace: "/repo" },
  ]);
});

test("nothing is resumed on startup for a runtime this window cannot start", async () => {
  const harness = actionHarness();

  await sessionActions({
    participant: { dispose: async () => undefined, cancel: async () => undefined, resume: harness.resume },
    host: harness.host,
    workspaces: () => ["/repo"],
    storage: held([record({ sessionId: "sess-saved", runtimeId: "ghost" })]),
    conditions,
    resumeOnStartup: () => true,
  }).resumeOnStartup();

  assert.deepEqual(harness.resumed, []);
});

test("every action offered from the view's title bar is a command the manifest declares", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
  ) as {
    contributes: { commands: { command: string }[]; menus: Record<string, { command: string }[]> };
  };
  const contributed = new Set(manifest.contributes.commands.map((entry) => entry.command));
  const titleActions = manifest.contributes.menus["view/title"] ?? [];

  assert.ok(titleActions.length > 0, "the view offers nothing from its title bar");
  for (const action of titleActions) {
    assert.ok(contributed.has(action.command), `${action.command} is not a contributed command`);
  }
});

test("a reattached session runs in the folder it was created in, and only if that folder is open", () => {
  const roots = ["/first", "/second"];

  // A new Session takes the first folder and is told about the rest.
  assert.deepEqual(sessionFolders("claude", roots), {
    cwd: "/first",
    additionalDirectories: ["/second"],
  });
  // A reattached one takes its own, wherever in the list it is: `session/load`
  // re-sends the cwd, and an Agent may refuse a different one.
  assert.deepEqual(sessionFolders("claude", roots, { workspace: "/second" }), {
    cwd: "/second",
    additionalDirectories: ["/first"],
  });
  // The row was drawn when the folder was open. Nothing about a record proves
  // it still is, and starting an agent in a folder nobody opened is what to
  // refuse.
  assert.throws(
    () => sessionFolders("claude", roots, { workspace: "/elsewhere" }),
    /does not have open/,
  );
  assert.throws(() => sessionFolders("claude", []), /open a folder/);
});

test("the words an agent failed with are drawn as text and bounded", async () => {
  const harness = actionHarness();
  harness.refuseWith(
    new Error(`**Agent Conductor**: [do this](https://example.invalid) ${"x".repeat(4000)}`),
  );

  await harness.actions.resume(node());

  // Straight after words this Client wrote in bold, and into a notification VS
  // Code renders through its own linked-text parser (ADR-0007).
  assert.equal(harness.said.length, 1);
  assert.doesNotMatch(harness.said[0], /\*\*/);
  assert.doesNotMatch(harness.said[0], /:\/\//);
  assert.ok(harness.said[0].length <= 2_100, `said ${harness.said[0].length} characters`);
});

test("every command the view offers runs the action it is named for", async () => {
  const harness = actionHarness();
  const commands = sessionCommands(harness.actions);
  const row = node({ id: "sess-row" });

  await commands["agentConductor.newSession"]();
  await commands["agentConductor.cancelAll"]();
  await commands["agentConductor.cancelSession"](row);
  await commands["agentConductor.resumeSession"](row);
  await commands["agentConductor.openWorktreeDiff"](
    node({ worktree: { path: "/repo/w", branch: "b" } }),
  );

  // Each one reached what it says it does, and nothing reached anything else. A
  // registration bound to the wrong function, or to none, is a button that
  // silently does nothing and a manifest that still looks right.
  assert.equal(harness.disposals(), 1);
  // And says so: a session that ends with no word for it reads as a click that
  // did nothing.
  assert.equal(harness.said.length, 1);
  // The window's cancel-all names no Session, and must not therefore mean none.
  assert.deepEqual(harness.cancelled, [undefined, "sess-row"]);
  assert.deepEqual(harness.resumed, [
    { sessionId: "sess-row", runtimeId: "claude", workspace: "/repo" },
  ]);
  assert.deepEqual(harness.executed[0], ["git.openRepository", "/repo/w"]);
});

test("the commands the manifest contributes for the view are exactly the ones wired", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
  ) as { contributes: { menus: Record<string, { command: string }[]> } };
  const offered = new Set(
    [...(manifest.contributes.menus["view/title"] ?? []), ...(manifest.contributes.menus["view/item/context"] ?? [])]
      .map((entry) => entry.command),
  );
  const wired = new Set(Object.keys(sessionCommands(actionHarness().actions)));
  const composition = await readFile(new URL("../../vscode/composition.ts", import.meta.url), "utf8");

  // Both directions. A command in the menus and not in the table is a dead
  // button; one in the table and not in the menus is a command nobody can find.
  assert.deepEqual([...offered].sort(), [...wired].sort());
  // And the table is what the window registers, rather than a second list.
  assert.match(composition, /Object\.entries\(sessionCommands\(actions\)\)/);
});

test("a row whose runtime is no longer approved is refused before anything is ended", async () => {
  // The row was drawn before the CLI was reconnected, so it still offers Resume.
  // Left to the spawn gate, the refusal arrives after the live Session has been
  // ended for it — and the conversation somebody was in is gone for a reattach
  // that was never going to happen (ADR-0007).
  const harness = actionHarness();

  await harness.actions.resume(node({ runtimeId: "reconnected-since" }));

  assert.deepEqual(harness.resumed, []);
  assert.equal(harness.said.length, 1);
});

test("a folder that is not a real directory is not a folder a session runs in", () => {
  // A workspace folder can be served by a virtual filesystem — a remote, an
  // archive, a source-control view — and its path exists nowhere. Handed to a
  // spawn as a `cwd`, that is a process that fails to start or one that starts
  // somewhere else entirely.
  const roots = fileRoots([
    { uri: { scheme: "file", fsPath: "/repo" } },
    { uri: { scheme: "vscode-vfs", fsPath: "/github/org/repo" } },
    { uri: { scheme: "untitled", fsPath: "/nowhere" } },
  ]);

  assert.deepEqual(roots, ["/repo"]);
});

test("the window opens the sessions view, wires its commands, and offers back what it saved", async () => {
  const composition = await readFile(new URL("../../vscode/composition.ts", import.meta.url), "utf8");

  // Each of these is a single call with no other caller, and each is a whole
  // feature: without them the view is never registered, no row action is bound,
  // and a saved session is never offered back on startup.
  for (const wiring of [
    /createTreeView\("agentConductor\.sessions"/,
    /fileRoots\(vscode\.workspace\.workspaceFolders/,
    /onChanged: \(\) => sessions\.refresh\(\)/,
    /onDidChangeWorkspaceFolders\(\(\) => sessions\.refresh\(\)\)/,
    /Object\.entries\(sessionCommands\(actions\)\)/,
    /actions\.resumeOnStartup\(\)/,
    /saved: \(\) => savesSettled\(storage\)/,
  ]) {
    assert.match(composition, wiring);
  }
});

test("a row recorded under an approval that has since been replaced is refused", async () => {
  // The tree was drawn, then the user reconnected the CLI and approved a new
  // identity. The row still offers Resume. Left to the spawn gate, the refusal
  // arrives after the live Session has been ended for it (ADR-0008).
  const harness = actionHarness();

  await harness.actions.resume(node({ fingerprint: "fp-from-before-the-upgrade" }));

  assert.deepEqual(harness.resumed, []);
  assert.equal(harness.said.length, 1);
});

test("a row whose agent could never be reattached to is refused", async () => {
  const harness = actionHarness();

  await harness.actions.resume(node({ loadable: false }));

  assert.deepEqual(harness.resumed, []);
});

test("a row built by the tree is one the actions can read back", async () => {
  // The node the command receives is the one the tree built, so the fields
  // resumability is re-derived from have to survive that trip.
  const tree = new SessionsTree({
    storage: held([record({ sessionId: "sess-saved" })]),
    conditions,
    now: () => 0,
  });
  const [row] = await tree.getChildren();
  const harness = actionHarness();

  await harness.actions.resume(row);

  assert.deepEqual(harness.resumed, [
    { sessionId: "sess-saved", runtimeId: "claude", workspace: "/repo" },
  ]);
});

test("a row the tree built under an approval that has lapsed is refused", async () => {
  const tree = new SessionsTree({
    storage: held([record({ sessionId: "sess-saved", fingerprint: "fp-from-before" })]),
    conditions,
    now: () => 0,
  });
  const [row] = await tree.getChildren();
  const harness = actionHarness();

  await harness.actions.resume(row);

  assert.deepEqual(harness.resumed, []);
});

test("a row the tree built for an agent that cannot reattach is refused", async () => {
  const tree = new SessionsTree({
    storage: held([record({ sessionId: "sess-saved", loadable: false })]),
    conditions,
    now: () => 0,
  });
  const [row] = await tree.getChildren();
  const harness = actionHarness();

  await harness.actions.resume(row);

  assert.deepEqual(harness.resumed, []);
});
