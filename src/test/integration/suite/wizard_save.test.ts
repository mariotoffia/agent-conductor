import assert from "node:assert/strict";
import * as vscode from "vscode";
import type { ConductorTestHooks } from "../../../vscode/composition.js";
import type { FormHost, QuickItem } from "../../../vscode/elicitation.js";
import { handBackTo, required } from "./handover.js";

/**
 * The connection wizard, run to the end inside a real VS Code extension host.
 *
 * The wizard's flow has a suite of its own under `make test`, driven against a
 * real Agent process with every port faked. What is faked there is the half only
 * a host has: settings written at a chosen scope through `WorkspaceConfiguration`
 * and read back through `inspect`, and a credential put into `SecretStorage`.
 *
 * So this asserts what the fakes stand in for, and the invariant that matters
 * most about a save: what lands in settings is the *name* of a secret, and the
 * value is somewhere settings cannot reach (ADR-0010). A settings file is
 * synced, shared and committed; the wizard writing a key into one would be the
 * kind of defect nothing else here would ever notice.
 *
 * It runs first, before any suite has approved anything, because the Runtime it
 * connects is one nothing else uses and because connecting starts an Agent —
 * which the window's own trust gates exactly as it gates a Session.
 */

const EXTENSION_ID = "mariotoffia.agent-conductor";

/** The Runtime this suite connects. Its own, so nothing else's approval or
 *  settings can make this pass. */
const RUNTIME = "wizardmock";
/** The Runtime every suite after this one uses. Named here because handing the
 *  participant back is this suite's business, not theirs. */
const HANDOVER = "mock";
const VARIABLE = "MOCK_API_KEY";
/** The credential this suite types. Named by the launcher, because the Agent it
 *  connects refuses to start on anything else — which is what makes the second
 *  test below say the *value* survived SecretStorage, not merely something. */
const SECRET = required("AGENT_CONDUCTOR_TEST_EXPECT_KEY");

/**
 * A window that answers by the title of the question it is asked.
 *
 * Anything unscripted takes the first offer, which is what somebody clicking
 * through the defaults does — and what the questions this suite does not care
 * about should not have to be listed for.
 */
function scriptedForm(
  answers: Record<string, string>,
  seen: string[],
): FormHost {
  const choose = (items: readonly QuickItem[], title: string): QuickItem | undefined => {
    seen.push(title);
    const wanted = answers[title];
    if (wanted === undefined) return items[0];
    return items.find((item) => item.label.includes(wanted));
  };
  return {
    input: (options) => {
      seen.push(options.title);
      return Promise.resolve(answers[options.title]);
    },
    pick: (items, options) => Promise.resolve(choose(items, options.title)),
    pickMany: (items, options) => Promise.resolve([choose(items, options.title)].flatMap((one) => one ?? [])),
  };
}

suite("the connection wizard saving in the extension host", () => {
  let hooks: ConductorTestHooks;
  const asked: string[] = [];

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} is not installed in this host`);
    const activated: unknown = await extension.activate();
    assert.ok(activated, "the extension returned no test hooks");
    hooks = activated as ConductorTestHooks;
  });

  suiteTeardown(() => {
    hooks.useForm(undefined);
    hooks.useConsent(undefined);
  });

  test("a connection is written to the scope that was chosen, with the key kept out of it", async () => {
    const seen: string[] = [];
    hooks.useForm(
      scriptedForm(
        {
          "Connect a CLI": "custom ACP agent",
          "Custom ACP agent": RUNTIME,
          "Launch command": required("AGENT_CONDUCTOR_TEST_NODE"),
          // The Agent refuses to open a Session until the variable below is set,
          // which is what takes the wizard down its authentication branch.
          "Launch arguments": JSON.stringify([
            required("AGENT_CONDUCTOR_TEST_AGENT"),
            "--mode=needs-key",
          ]),
          "Environment variable": VARIABLE,
          "API key": SECRET,
          "Where to save this connection": "Workspace",
        },
        seen,
      ),
    );
    hooks.useConsent({
      ask: (message: string, _options: unknown, ...choices: string[]) => {
        asked.push(message);
        // The credential branch offers to store one; everything else is approved
        // with whatever it offers first, which is the affirmative choice.
        return Promise.resolve(choices.find((choice) => choice.startsWith("Store")) ?? choices[0]);
      },
    });

    await vscode.commands.executeCommand("agentConductor.connectCli");

    // The scope that was picked, and only that one: a connection saved to user
    // settings when the workspace was chosen follows the person to every project.
    const written = vscode.workspace
      .getConfiguration("agentConductor")
      .inspect<Record<string, { command?: string; secretEnvironment?: Record<string, string> }>>(
        "runtimes",
      );
    const entry = written?.workspaceValue?.[RUNTIME];
    assert.ok(entry, `nothing was saved for ${RUNTIME}; the wizard was asked: ${seen.join(", ")}`);
    assert.equal(entry.command, required("AGENT_CONDUCTOR_TEST_NODE"));
    assert.equal(written?.globalValue?.[RUNTIME], undefined, "it was saved to the wrong scope too");

    // The invariant. Settings hold the *reference*; the value is not in there
    // under any key, at any depth, however the entry was composed.
    assert.equal(entry.secretEnvironment?.[VARIABLE], `agentConductor.${RUNTIME}.${VARIABLE}`);
    assert.equal(
      JSON.stringify(written?.workspaceValue ?? {}).includes(SECRET),
      false,
      "the credential itself was written into settings",
    );
    assert.equal(
      JSON.stringify(written?.globalValue ?? {}).includes(SECRET),
      false,
      "the credential itself was written into user settings",
    );
  });

  test("what was saved is a runtime that starts, on the credential it was given", async () => {
    // The proof that the reference resolves: the Agent this Runtime launches
    // refuses to open a Session unless the variable really carries the value,
    // and nothing but SecretStorage can supply it now.
    const settings = vscode.workspace.getConfiguration("agentConductor");
    await settings.update("defaultRuntime", RUNTIME, vscode.ConfigurationTarget.Workspace);
    const said: string[] = [];

    const result = await hooks.participant.handle(
      { prompt: "Reply with exactly: OK" },
      { markdown: (text: string) => said.push(text), progress: () => undefined, button: () => undefined },
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) },
    );

    // Approved by the wizard rather than by the test hook: a Runtime it took
    // through to the end is one a Session start trusts, which is the whole point
    // of recording the identity that was actually probed (ADR-0007).
    assert.equal(result.metadata.stopReason, "end_turn", said.join("\n"));
    assert.match(said.join("\n"), /OK/);
    // And the credential is nowhere in what the window drew.
    assert.equal(said.join("\n").includes(SECRET), false, "the credential reached the chat");

    await vscode.commands.executeCommand("agentConductor.newSession");
  });

  test("the runtime is handed back to the suites that follow", async () => {
    await handBackTo(hooks, HANDOVER);
  });
});
