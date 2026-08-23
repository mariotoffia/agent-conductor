import assert from "node:assert/strict";
import * as vscode from "vscode";
import type { ConductorTestHooks } from "../../../vscode/composition.js";
import type { ChatCommand } from "../../../vscode/chatSink.js";

/**
 * One direct Session, driven inside a real VS Code extension host against the
 * bundled mock Agent over ACP.
 *
 * What this proves that `make test` cannot: the extension activates, its real
 * settings are read, the trust gate resolves a real executable, a real process
 * is spawned from the host, permission routing reaches the host's own consent
 * surface, and the diff command opens a real diff editor.
 *
 * The participant is driven through the test hooks rather than through chat,
 * because VS Code offers no way to send a chat participant a turn.
 *
 * These run in order, and the participant they drive is the host's only one and
 * is shared with the suites after this. So this suite ends its Session without
 * stopping the participant: stopping is final, and the suite that runs last owns
 * it — today `sessions_tree.test.ts`, which ends with the teardown test.
 */

const EXTENSION_ID = "mariotoffia.agent-conductor";

/** Everything the participant drew, in order. */
function recordingStream() {
  const written: string[] = [];
  const buttons: ChatCommand[] = [];
  return {
    written,
    buttons,
    text: () => written.join("\n"),
    stream: {
      markdown: (value: string) => written.push(value),
      progress: (value: string) => written.push(value),
      button: (command: ChatCommand) => buttons.push(command),
    },
  };
}

const liveToken = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
};

function required(name: string): string {
  const value = process.env[name];
  assert.ok(value, `${name} must be set by the test launcher`);
  return value;
}

suite("a direct session in the extension host", () => {
  let hooks: ConductorTestHooks;
  const asked: string[] = [];

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} is not installed in this host`);
    const activated: unknown = await extension.activate();
    assert.ok(
      activated,
      "the extension returned no test hooks — is this host running from" +
        " --extensionTestsPath, so that it reports ExtensionMode.Test?",
    );
    hooks = activated as ConductorTestHooks;

    // A Runtime whose launch really starts the mock Agent. The extension host is
    // Electron, so the command is the node the launcher handed us.
    const settings = vscode.workspace.getConfiguration("agentConductor");
    await settings.update(
      "runtimes",
      {
        mock: {
          command: required("AGENT_CONDUCTOR_TEST_NODE"),
          args: [required("AGENT_CONDUCTOR_TEST_AGENT"), "--mode=full-turn"],
        },
      },
      vscode.ConfigurationTarget.Workspace,
    );
    await settings.update("defaultRuntime", "mock", vscode.ConfigurationTarget.Workspace);

    // A dialog cannot be clicked from here, so consent is answered and recorded.
    hooks.useConsent({
      ask: (message: string) => {
        asked.push(message);
        return Promise.resolve("Allow");
      },
    });
  });

  suiteTeardown(() => {
    hooks.useConsent(undefined);
  });

  test("a turn is refused until the runtime's identity is approved", async () => {
    const out = recordingStream();

    const result = await hooks.participant.handle({ prompt: "hello" }, out.stream, liveToken);

    // Nothing is approved yet, so the gate refuses before anything is started.
    assert.equal(result.metadata.stopReason, "refused");
    assert.match(out.text() + (result.errorDetails?.message ?? ""), /not trusted|wizard/i);
  });

  test("one approved session streams, asks, reads back, and offers its diff", async () => {
    const fingerprint = await hooks.grantTrust("mock");
    assert.match(fingerprint, /.+/);
    const out = recordingStream();

    const result = await hooks.participant.handle({ prompt: "hello" }, out.stream, liveToken);

    assert.equal(result.metadata.stopReason, "end_turn");
    // Streamed content, and the agent's own reasoning kept apart from it.
    assert.match(out.text(), /Mock response/);
    assert.match(out.text(), /Mock thought/);
    // Permission: the agent's tool call reached the host's consent surface, and
    // the answer decided how the call was reported.
    assert.equal(asked.length, 1, `consent was asked ${asked.length} times`);
    // Named after the Runtime this Session runs, so the dialog says which agent
    // wants this rather than a word that would be true of any of them.
    assert.match(asked[0], /^mock \(custom\) asks:/);
    assert.match(out.text(), /Edit mock file/);
    assert.match(out.text(), /✅/);
    // Read-back: what the agent reports it is running, not what was asked for.
    assert.match(out.text(), /Now running:.*mock-model-fast/s);
    // The rest of the render map, over the wire rather than over a fixture.
    assert.match(out.text(), /Exercise ACP client/);
    assert.match(out.text(), /context 100\/1000/);
    assert.match(out.text(), /compact/);
    assert.match(out.text(), /architect/);
    assert.match(out.text(), /Exercising the client/);

    // The diff command opens a real diff editor over the retained text.
    const button = out.buttons.find((entry) => entry.command === "agentConductor.openDiff");
    assert.ok(button, "a reported diff must be openable");
    const [id] = button.arguments ?? [];
    assert.equal(hooks.diffs.entry(id as string)?.oldText, "before\n");
    await vscode.commands.executeCommand("agentConductor.openDiff", id);
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(tab?.input instanceof vscode.TabInputTextDiff, "no diff editor was opened");
    assert.equal(tab.input.original.scheme, "agent-conductor-diff");
    assert.equal(tab.input.modified.scheme, "agent-conductor-diff");
  });

});
