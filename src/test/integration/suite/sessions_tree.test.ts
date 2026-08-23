import assert from "node:assert/strict";
import * as vscode from "vscode";
import type { ConductorTestHooks } from "../../../vscode/composition.js";
import type { SessionNode } from "../../../vscode/sessionsTree.js";

/**
 * The Sessions tree, inside a real VS Code extension host.
 *
 * What this proves that `make test` cannot: the view is registered against this
 * provider, the rows it builds are `TreeItem`s VS Code itself accepts — an icon
 * has to be a real `ThemeIcon`, and a plain object shaped like one is silently
 * dropped — and the row commands are registered in the host and reach the
 * Session the row is about.
 *
 * That resuming really sends `session/load` rather than opening a second
 * conversation is asserted on the wire by the unit suite, which can read what
 * this Client wrote; from in here the two are indistinguishable, because the
 * mock Agent numbers its sessions from one per process.
 *
 * It runs after the direct-session suite, on the same Runtime and the same
 * participant — the host has one of each, and the participant remembers the
 * Runtime it was last given. Being last, it also owns the teardown, which is the
 * one thing about a participant that cannot be undone.
 */

const EXTENSION_ID = "mariotoffia.agent-conductor";
const RUNTIME = "mock";

function required(name: string): string {
  const value = process.env[name];
  assert.ok(value, `${name} must be set by the test launcher`);
  return value;
}

const silentStream = {
  markdown: () => undefined,
  progress: () => undefined,
  button: () => undefined,
};

const liveToken = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
};

/** Polls until the tree says what the test is waiting for; the timeout is the
 *  suite's own. Records are written with nothing waiting on them. */
async function untilRow(
  hooks: ConductorTestHooks,
  ready: (node: SessionNode | undefined) => boolean,
  id: string,
): Promise<SessionNode> {
  // Matched on all three, as the store keys a record: an Agent chooses its own
  // session id and this one numbers its sessions from one per process, so the id
  // alone would also match a Session saved by an earlier run in a folder that no
  // longer exists.
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(folder, "the host was launched without a folder");
  for (;;) {
    const rows = await hooks.sessions.getChildren();
    const row = rows.find(
      (entry) => entry.id === id && entry.runtimeId === RUNTIME && entry.workspace === folder,
    );
    if (ready(row)) return row as SessionNode;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

suite("the sessions tree in the extension host", () => {
  let hooks: ConductorTestHooks;
  let ended: string;

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} is not installed in this host`);
    const activated: unknown = await extension.activate();
    assert.ok(activated, "the extension returned no test hooks");
    hooks = activated as ConductorTestHooks;

    const settings = vscode.workspace.getConfiguration("agentConductor");
    await settings.update(
      "runtimes",
      {
        [RUNTIME]: {
          command: required("AGENT_CONDUCTOR_TEST_NODE"),
          args: [required("AGENT_CONDUCTOR_TEST_AGENT"), "--mode=full-turn"],
        },
      },
      vscode.ConfigurationTarget.Workspace,
    );
    await settings.update("defaultRuntime", RUNTIME, vscode.ConfigurationTarget.Workspace);
    hooks.useConsent({ ask: () => Promise.resolve("Allow") });
    // Recorded again rather than assumed from the suite before: what a suite
    // needs to hold has to be something this suite established.
    await hooks.grantTrust(RUNTIME);
  });

  suiteTeardown(() => {
    hooks.useConsent(undefined);
  });

  test("a live session is a row the host can draw, and its actions are registered", async () => {
    // Subscribed before the turn: the view learns that a Session moved from the
    // event, and polling `getChildren` — which is what these tests otherwise do
    // — would pass with nothing joined up at all.
    let redraws = 0;
    const listening = hooks.sessions.onDidChangeTreeData(() => {
      redraws += 1;
    });
    await hooks.participant.handle({ prompt: "hello" }, silentStream, liveToken);
    listening.dispose();
    assert.ok(redraws > 0, "the window never told the view that a turn had happened");
    const live = hooks.participant.currentSessionId;
    assert.ok(live);

    const row = await untilRow(hooks, (node) => node?.live === true, live);
    const item = hooks.sessions.getTreeItem(row);

    assert.equal(item.label, RUNTIME);
    // The read-back the agent reported, in the row rather than only in the chat.
    assert.match(String(item.description), /mock-model-fast/);
    // The figure the mock Agent actually reported, not merely the word: "cost
    // unknown" satisfies /cost/ and would prove nothing about the usage path.
    assert.match(String(item.description), /cost 0\.01 USD/);
    // Only the host can prove this: VS Code drops an icon that is merely shaped
    // like a ThemeIcon, so a row built with one would quietly lose its icon.
    assert.ok(item.iconPath instanceof vscode.ThemeIcon, "the row's icon is not a ThemeIcon");

    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      "agentConductor.cancelSession",
      "agentConductor.resumeSession",
      "agentConductor.openWorktreeDiff",
    ]) {
      assert.ok(commands.includes(command), `${command} is not registered in this host`);
    }
    // Nothing is running between turns, so this is the no-op path — it must
    // still reach the participant rather than throw at the command host.
    await vscode.commands.executeCommand("agentConductor.cancelSession", row);
    ended = live;
  });

  test("ending the session from the window leaves the row as one that can be picked up", async () => {
    assert.equal(hooks.participant.currentSessionId, ended);

    await vscode.commands.executeCommand("agentConductor.newSession");

    // The command the view's title bar offers really ends the Session, rather
    // than only saying so in the log.
    assert.equal(hooks.participant.currentSessionId, undefined);
  });

  test("an ended session becomes a row that can be resumed, and resuming it makes it live", async () => {
    // Not merely "no longer live": the record that replaces the live row is
    // written with nothing waiting on it, so a row read the moment the process
    // goes is one whose Session has not been written down as ended yet.
    const row = await untilRow(hooks, (node) => node?.state === "disposed", ended);
    assert.equal(row.blocked, undefined, "the session it just ran should be resumable");
    assert.equal(hooks.sessions.getTreeItem(row).contextValue, "agentConductor.session.resumable");

    await vscode.commands.executeCommand("agentConductor.resumeSession", row);

    assert.equal(hooks.participant.currentSessionId, ended);
    await untilRow(hooks, (node) => node?.live === true, ended);
    // Reattached and usable, which is the whole point of offering it back.
    const result = await hooks.participant.handle({ prompt: "hello" }, silentStream, liveToken);
    assert.equal(result.metadata.stopReason, "end_turn");
  });
  test("teardown ends the session and drops what it retained", async () => {
    // Last, and terminal: it stops the participant for good, which is what
    // teardown means. A test appended after it would be refused rather than fail
    // on its own terms — put new ones above it, here or in an earlier suite.
    assert.ok(hooks.participant.currentSessionId, "a session should still be open");
    assert.ok(hooks.diffs.size > 0);

    await hooks.participant.stop();

    assert.equal(hooks.participant.currentSessionId, undefined);
    assert.equal(hooks.diffs.size, 0);
    // And the tree stops claiming to hold a Session nothing is running.
    const rows = await hooks.sessions.getChildren();
    assert.equal(rows.filter((row) => row.live).length, 0);
  });
});
