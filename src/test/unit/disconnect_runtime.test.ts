import assert from "node:assert/strict";
import test from "node:test";
import { disconnectCli, type DisconnectPorts } from "../../vscode/disconnect.js";
import { MOCK_ID, mockEntry, wizardHarness, type Script } from "../wizard-fixtures.js";

/**
 * Taking a CLI back out again.
 *
 * Connecting writes three things — a settings entry, a Runtime Trust approval,
 * and an Adapter installed under this extension's own storage. A disconnection
 * that leaves any of them behind is what makes a CLI look connected when it is
 * not, so what is protected here is that all three go, in the order that fails
 * closed if one of them cannot.
 */

function harnessFor(script: Script = {}) {
  const harness = wizardHarness(script);
  const forgotten: string[] = [];
  const ports: DisconnectPorts = {
    ...harness.ports,
    forgetTrust: async (runtimeId) => {
      forgotten.push(runtimeId);
    },
  };
  return { ...harness, ports, forgotten };
}

/** A Runtime launched by the Adapter the catalog names, rather than by a
 *  command the user supplied — which is the only kind with one of ours to
 *  remove. `mockEntry` replaces the launch, and a replaced launch has no
 *  Adapter by the catalog's own rule. */
const WITH_ADAPTER: Script = { saved: { codex: {} }, workspaceSaved: {} };

test("disconnecting drops the approval, the entry, and offers the adapter back", async () => {
  const harness = harnessFor(WITH_ADAPTER);

  await disconnectCli(harness.ports);

  assert.deepEqual(harness.forgotten, ["codex"]);
  assert.deepEqual(harness.saved(), {});
  // The Adapter is the only thing on the machine this Client put there; the CLI
  // itself was the user's to install and stays theirs.
  assert.equal(harness.terminals.length, 1);
  assert.match(harness.terminals[0].command, /^npm uninstall --prefix /);
  assert.ok(harness.terminals[0].command.includes("@agentclientprotocol/codex-acp"));
});

test("a runtime the user pointed at their own program has no adapter of ours to remove", async () => {
  // Nothing installed it here, so nothing here offers to uninstall it — and
  // asking would invite the user to remove a program that is theirs.
  const harness = harnessFor();

  await disconnectCli(harness.ports);

  assert.deepEqual(harness.forgotten, [MOCK_ID]);
  assert.deepEqual(harness.saved(), {});
  assert.deepEqual(harness.terminals, []);
  assert.ok(harness.asked.every((question) => !/Remove the adapter/.test(question)));
});

test("the approval goes before the entry, so a failed removal refuses to launch", async () => {
  // The direction a half-finished removal has to fail in: an entry with no
  // approval is refused at the next turn and says why, while an approval left
  // behind for an entry nobody can see is one nothing would ever ask about.
  const harness = harnessFor({ writeFails: "settings are read-only here" });

  await disconnectCli(harness.ports);

  assert.deepEqual(harness.forgotten, [MOCK_ID]);
  assert.deepEqual(harness.saved(), { [MOCK_ID]: mockEntry() });
  assert.ok(harness.said.some((line) => /was not removed/.test(line)), harness.said.join("\n"));
});

test("dismissing the confirmation leaves the connection exactly as it was", async () => {
  const harness = harnessFor({ consent: (message) => (/^Disconnect/.test(message) ? undefined : "yes") });

  await disconnectCli(harness.ports);

  assert.deepEqual(harness.forgotten, []);
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.terminals, []);
});

test("declining the adapter removal still disconnects, and leaves it installed", async () => {
  const harness = harnessFor({
    ...WITH_ADAPTER,
    consent: (message, choices) => (/^Remove the adapter/.test(message) ? undefined : choices[0]),
  });

  await disconnectCli(harness.ports);

  assert.deepEqual(harness.forgotten, ["codex"]);
  assert.deepEqual(harness.saved(), {});
  assert.deepEqual(harness.terminals, []);
});

test("an entry is removed from every scope that holds it, not just the first", async () => {
  // A connection saved for every workspace and then re-saved in a folder leaves
  // two entries. Removing one of them is a CLI that comes back on the next
  // window, from a file the user was never shown.
  const harness = harnessFor({
    saved: { [MOCK_ID]: mockEntry() },
    workspaceSaved: { [MOCK_ID]: mockEntry() },
  });

  await disconnectCli(harness.ports);

  assert.deepEqual(harness.writes.map((write) => write.scope).sort(), ["global", "workspace"]);
  assert.deepEqual(harness.saved(), {});
});

test("with no folder open, no workspace write is attempted", async () => {
  // VS Code throws on a workspace write with no folder open, and a throw here
  // would abandon a disconnection that had already dropped the approval.
  const harness = harnessFor({ workspaceOpen: false });

  await disconnectCli(harness.ports);

  assert.deepEqual(harness.writes.map((write) => write.scope), ["global"]);
});

test("nothing connected is said, not offered as an empty list", async () => {
  const harness = harnessFor({ saved: {}, workspaceSaved: {} });

  await disconnectCli(harness.ports);

  assert.deepEqual(harness.offered, []);
  assert.deepEqual(harness.forgotten, []);
  assert.ok(harness.said.some((line) => /No CLI is connected/.test(line)));
});

test("a default runtime that was just disconnected is said, never silently moved", async () => {
  // Nothing here knows which of the others should take its place, and a default
  // pointed somewhere the user did not choose is worse than one that says it is
  // wrong at the next turn.
  const harness = harnessFor({ defaultRuntime: MOCK_ID });

  await disconnectCli(harness.ports);

  assert.deepEqual(harness.defaults, []);
  assert.ok(harness.said.some((line) => /still start on/.test(line)), harness.said.join("\n"));
});
