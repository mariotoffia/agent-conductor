import assert from "node:assert/strict";
import * as vscode from "vscode";
import type { ConductorTestHooks } from "../../../vscode/composition.js";
import type { SessionNode } from "../../../vscode/sessionsTree.js";
import { WAIT_TO_BE_CANCELLED } from "../../mock-agent-cancellation.js";

/**
 * Cancelling a Turn that is really running, inside a real VS Code extension host.
 *
 * What this proves that `make test` cannot: a `vscode.CancellationTokenSource`
 * — the host's own event machinery, not a fake with a `dispose` that does
 * nothing — reaches the Agent as ACP `session/cancel`, and the Turn answers
 * `cancelled` rather than being abandoned; and the row action a user clicks in
 * the Sessions view reaches the Turn in flight on that Session.
 *
 * It runs between the direct-session suite and the sessions-tree one, on the
 * Session the first of them left open. The Agent is asked to stand still by the
 * prompt rather than by a Runtime of its own: the host has one participant and
 * it remembers the Runtime it was last given, so a second Runtime would have to
 * be switched to and switched back for no gain.
 */

const EXTENSION_ID = "mariotoffia.agent-conductor";
const RUNTIME = "mock";

/**
 * Polls until the tree holds this Session, which is written with nothing waiting
 * on it.
 *
 * Matched on all three parts, as the store keys a record: an Agent chooses its
 * own session id, and every Mock Agent numbers its Sessions from one, so an id
 * on its own also matches a Session another suite ran under another Runtime.
 * The action under test compares only the id today — which is exactly why the
 * row handed to it has to be the right one, or this proves nothing about rows.
 */
async function rowFor(hooks: ConductorTestHooks, id: string): Promise<SessionNode> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(folder, "the host was launched without a folder");
  for (;;) {
    const rows = await hooks.sessions.getChildren();
    const row = rows.find(
      (entry) => entry.id === id && entry.runtimeId === RUNTIME && entry.workspace === folder,
    );
    if (row) return row;
    await new Promise((settle) => setTimeout(settle, 25));
  }
}

/** Waits for the Agent to say it has stopped, so the cancellation lands on a
 *  Turn that is under way rather than on one still starting its process. */
function waitingStream(reached: () => void) {
  return {
    markdown: (text: string) => {
      if (text.includes("Waiting for cancellation")) reached();
    },
    progress: () => undefined,
    button: () => undefined,
  };
}

suite("cancelling a running turn in the extension host", () => {
  let hooks: ConductorTestHooks;

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} is not installed in this host`);
    const activated: unknown = await extension.activate();
    assert.ok(activated, "the extension returned no test hooks");
    hooks = activated as ConductorTestHooks;
    // Nothing here asks for permission, but the real modal is what an unanswered
    // question would reach, and a modal in a headless host never comes back.
    hooks.useConsent({ ask: () => Promise.resolve("Allow") });
  });

  suiteTeardown(() => {
    hooks.useConsent(undefined);
  });

  test("the host's cancellation token ends a turn the agent is still running", async () => {
    const source = new vscode.CancellationTokenSource();
    let started: () => void = () => undefined;
    const running = new Promise<void>((settle) => {
      started = settle;
    });

    const turn = hooks.participant.handle(
      { prompt: WAIT_TO_BE_CANCELLED },
      waitingStream(started),
      source.token,
    );
    await running;
    source.cancel();
    const result = await turn;
    source.dispose();

    // The cancellation reached the Agent at all: this Agent answers nothing until
    // `session/cancel` arrives, so a Turn that came back is one it received. A
    // Client that only gave up locally would leave this promise unsettled and
    // the test would time out rather than fail on the word.
    assert.equal(result.metadata.stopReason, "cancelled");
    // And the Session is still there to be used, which is what tells a cancelled
    // Turn apart from a killed process.
    assert.ok(hooks.participant.currentSessionId, "cancelling a turn ended the session");
  });

  test("the row action a user clicks cancels the turn that session is running", async () => {
    const live = hooks.participant.currentSessionId;
    assert.ok(live);
    const row = await rowFor(hooks, live);
    let started: () => void = () => undefined;
    const running = new Promise<void>((settle) => {
      started = settle;
    });

    // A token that is never cancelled, so nothing but the command can end this.
    const turn = hooks.participant.handle({ prompt: WAIT_TO_BE_CANCELLED }, waitingStream(started), {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose: () => undefined }),
    });
    await running;
    await vscode.commands.executeCommand("agentConductor.cancelSession", row);

    assert.equal((await turn).metadata.stopReason, "cancelled");
  });

  test("a token cancelled before the turn begins ends it without reaching the agent", async () => {
    const source = new vscode.CancellationTokenSource();
    source.cancel();
    const said: string[] = [];

    const result = await hooks.participant.handle(
      { prompt: WAIT_TO_BE_CANCELLED },
      { markdown: (text: string) => said.push(text), progress: () => undefined, button: () => undefined },
      source.token,
    );
    source.dispose();

    assert.equal(result.metadata.stopReason, "cancelled");
    // The Agent never saw it. Asked this, it says so before it stands still — so
    // its own words are what tells a Turn that was short-circuited apart from one
    // that was started and then stopped, which report the same stop reason.
    assert.equal(
      said.join("\n").includes("Waiting for cancellation"),
      false,
      "the prompt reached the agent despite the turn being cancelled first",
    );
    // Still usable: an ordinary Turn after a cancelled one works.
    const after = await hooks.participant.handle(
      { prompt: "Reply with exactly: OK" },
      { markdown: () => undefined, progress: () => undefined, button: () => undefined },
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) },
    );
    assert.equal(after.metadata.stopReason, "end_turn");
  });
});
