import assert from "node:assert/strict";
import test from "node:test";
import { connectCli } from "../../vscode/wizard.js";
import { mergeEntry } from "../../vscode/wizardSettings.js";
import { mockEntry, MOCK_ID, wizardHarness } from "../wizard-fixtures.js";

/**
 * The connection wizard: detect, configure, approve the launch identity, hand
 * off authentication, read Config Options, agree the policy, prove one Turn
 * works, and only then write anything down.
 *
 * Driven against the real mock Agent process and the real Runtime catalog,
 * because the two things worth protecting here are that nothing is written
 * before an Agent has answered, and that what was approved is what a Session
 * start will derive from the settings this writes.
 */

const wizardTest = (name: string, fn: () => Promise<void>) => test(name, { timeout: 30_000 }, fn);

wizardTest("a connection is written only after the agent answers the smoke test", async () => {
  const harness = wizardHarness();

  await connectCli(harness.ports);

  assert.equal(harness.writes.length, 1, `settings were written ${harness.writes.length} times`);
  assert.ok(harness.writes[0]?.entries[MOCK_ID], "the connected runtime must be in the entries");
  assert.equal(harness.trusted.length, 1);
  assert.equal(harness.trusted[0]?.runtimeId, MOCK_ID);
  assert.match(harness.said.join("\n"), /connected/i);
});

wizardTest("the identity approved is the one a session start derives", async () => {
  const harness = wizardHarness();

  await connectCli(harness.ports);

  // The whole point of the wizard: an approval recorded against a fingerprint
  // the saved settings do not produce is an approval that refuses every launch.
  assert.equal(
    await harness.effectiveFingerprint(),
    harness.trusted[0]?.trust.fingerprint,
    "the recorded approval must match what these settings resolve to",
  );
  assert.equal(
    harness.said.join("\n").includes("will not launch as approved"),
    false,
    "nothing should be reported as describing it differently",
  );
});

wizardTest("reconnecting a runtime keeps the settings its approval was derived from", async () => {
  const harness = wizardHarness({
    saved: {
      [MOCK_ID]: {
        ...mockEntry(),
        safeMode: true,
        suppressBuiltInSubagents: false,
        secretEnvironment: { MOCK_KEY: "agentConductor.claude.MOCK_KEY" },
      },
    },
    secrets: { "agentConductor.claude.MOCK_KEY": "stored-value" },
  });

  await connectCli(harness.ports);

  const entry = harness.writes[0]?.entries[MOCK_ID];
  // ADR-0007 makes reconnecting routine — every upgrade changes the identity —
  // so reconnecting must not be how a runtime loses what it was configured with.
  assert.equal(entry?.command, mockEntry().command, "the launch the approval covered");
  assert.deepEqual(entry?.args, mockEntry().args);
  assert.equal(entry?.safeMode, true);
  assert.equal(entry?.suppressBuiltInSubagents, false);
  assert.deepEqual(entry?.secretEnvironment, { MOCK_KEY: "agentConductor.claude.MOCK_KEY" });
  assert.equal(await harness.effectiveFingerprint(), harness.trusted[0]?.trust.fingerprint);
});

wizardTest("what a repository configured is not promoted into user settings", async () => {
  const harness = wizardHarness({
    orchestration: true,
    // Only this workspace's settings describe the runtime; its launch does not
    // resolve, so the wizard asks for one — which is the path that composes an
    // entry from the effective settings.
    workspaceSaved: {
      [MOCK_ID]: {
        command: "/definitely/not/here",
        args: [],
        // A harmless stand-in for the real hazard: this channel really does
        // reach the launch environment, and `NODE_OPTIONS` here would preload a
        // file from the repository into every agent started with it.
        suppression: { env: { REPO_PRELOAD: "/repo/preload.js" }, delegationTools: ["Agent"] },
      },
    },
    input: {
      "Launch command": mockEntry().command,
      "Launch arguments": JSON.stringify(mockEntry().args),
    },
    pick: { "Where to save this connection": "User" },
  });

  await connectCli(harness.ports);

  const written = harness.writes[0]?.entries[MOCK_ID];
  assert.equal(harness.writes[0]?.scope, "global");
  assert.equal(written?.command, mockEntry().command, "the launch the user typed is saved");
  assert.equal(written?.suppression, undefined, "what the repository supplied stays in the repository");
  assert.equal(
    JSON.stringify(harness.writes).includes("preload.js"),
    false,
    "approved for this workspace is not approved for every workspace",
  );
});

test("connecting keeps every field of an entry the wizard did not decide", () => {
  const merged = mergeEntry(
    { command: "/opt/agent", args: ["--acp"], safeMode: true, secretEnvironment: { A: "key.a" } },
    { defaultModel: "opus", secretEnvironment: { B: "key.b" } },
  );

  assert.deepEqual(merged, {
    command: "/opt/agent",
    args: ["--acp"],
    safeMode: true,
    defaultModel: "opus",
    secretEnvironment: { A: "key.a", B: "key.b" },
  });
});

wizardTest("connecting one runtime keeps the runtimes already configured", async () => {
  const harness = wizardHarness({
    saved: { [MOCK_ID]: mockEntry(), gemini: { defaultModel: "gemini-pro" } },
  });

  await connectCli(harness.ports);

  assert.deepEqual(Object.keys(harness.writes[0]?.entries ?? {}).sort(), [MOCK_ID, "gemini"].sort());
  assert.equal(harness.writes[0]?.entries.gemini?.defaultModel, "gemini-pro");
});

wizardTest("the user chooses whether the connection is global or workspace", async () => {
  const harness = wizardHarness({ pick: { "Where to save this connection": "Workspace" } });

  await connectCli(harness.ports);

  assert.equal(harness.writes[0]?.scope, "workspace");
});

wizardTest("with no folder open the workspace scope is never offered", async () => {
  const harness = wizardHarness({ workspaceOpen: false });

  await connectCli(harness.ports);

  // VS Code refuses a workspace write with no folder; offering it would throw
  // away a connection that had already passed every stage.
  assert.equal(
    harness.offered.some((pick) => pick.title === "Where to save this connection"),
    false,
  );
  assert.equal(harness.writes[0]?.scope, "global");
  assert.match(harness.said.join("\n"), /no folder is open/i);
});

wizardTest("a connection that cannot be written is not reported as a broken cli", async () => {
  const harness = wizardHarness({ writeFails: "Unable to write to Workspace Settings" });

  await connectCli(harness.ports);

  assert.deepEqual(harness.trusted, [], "an unsaved connection must not stay approved");
  assert.match(harness.said.join("\n"), /works, but its connection could not be saved/i);
});

wizardTest("the exact command is shown before the identity is approved", async () => {
  const harness = wizardHarness();

  await connectCli(harness.ports);

  const approval = harness.asked.find((message) => /approve/i.test(message));
  assert.ok(approval, `no approval was asked for; asked: ${JSON.stringify(harness.asked)}`);
  assert.ok(approval.includes(process.execPath), "the resolved command must be shown");
  assert.match(approval, /mock-agent/, "the arguments must be shown too");
  assert.match(approval, /Environment:/, "the environment the fingerprint covers must be shown");
  assert.match(approval, /suppression/i, "so must whether a suppression plan rides along");
});

wizardTest("refusing the identity starts no agent and saves nothing", async () => {
  const harness = wizardHarness({ consent: () => undefined });

  await connectCli(harness.ports);

  assert.deepEqual(harness.spawns, [], "an unapproved identity must never be started");
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.trusted, []);
});

wizardTest("an untrusted workspace connects nothing", async () => {
  const harness = wizardHarness({ workspaceTrusted: false });

  await connectCli(harness.ports);

  assert.deepEqual(harness.spawns, []);
  assert.deepEqual(harness.writes, []);
  assert.match(harness.said.join("\n"), /not trusted/i);
});

wizardTest("cancelling the last question saves nothing", async () => {
  const harness = wizardHarness({ pick: { "Where to save this connection": undefined } });

  await connectCli(harness.ports);

  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.trusted, []);
  assert.match(harness.said.join("\n"), /cancelled/i);
});

wizardTest("a connection another settings scope overrides is reported, not left silent", async () => {
  const harness = wizardHarness({
    // A launch nobody can start, which a higher settings scope goes on winning
    // with even after the wizard has been given one that works.
    saved: { [MOCK_ID]: { command: "/definitely/not/here", args: [] } },
    overriddenBy: { command: "/definitely/not/here", args: [] },
    input: {
      "Launch command": mockEntry().command,
      "Launch arguments": JSON.stringify(mockEntry().args),
    },
  });

  await connectCli(harness.ports);

  assert.match(harness.said.join("\n"), /will not launch as approved/i);
});

wizardTest("a runtime somebody disabled can be connected again", async () => {
  const harness = wizardHarness({
    saved: { [MOCK_ID]: { ...mockEntry(), enabled: false } },
  });

  await connectCli(harness.ports);

  // Otherwise the only way back is hand-editing settings: a disabled runtime is
  // absent from every picker, including this one.
  const offered = harness.offered.find((pick) => pick.title === "Connect a CLI");
  assert.ok(
    offered?.descriptions.some((description) => /disabled in settings/i.test(description)),
    `a disabled runtime was not offered as such: ${JSON.stringify(offered)}`,
  );
  assert.equal(harness.writes[0]?.entries[MOCK_ID]?.enabled, true, "connecting it enables it");
});

wizardTest("a connection that will not launch as approved is not offered as the default", async () => {
  const harness = wizardHarness({
    defaultRuntime: "gemini",
    saved: { [MOCK_ID]: { command: "/definitely/not/here", args: [] } },
    overriddenBy: { command: "/definitely/not/here", args: [] },
    input: {
      "Launch command": mockEntry().command,
      "Launch arguments": JSON.stringify(mockEntry().args),
    },
  });

  await connectCli(harness.ports);

  // Pointing new sessions at a runtime that cannot start is worse than leaving
  // the default alone, and the user has just been told it will not launch.
  assert.deepEqual(harness.defaults, []);
  assert.match(harness.said.join("\n"), /will not launch as approved/i);
});

wizardTest("connecting a runtime offers to make it the default", async () => {
  const harness = wizardHarness({ defaultRuntime: "gemini" });

  await connectCli(harness.ports);

  // Otherwise the next chat turn starts on a runtime nobody approved, and tells
  // the user to run the wizard they have just finished.
  assert.deepEqual(harness.defaults, [{ id: MOCK_ID, scope: "global" }]);
});

wizardTest("declining the default leaves it alone and says how to switch", async () => {
  const harness = wizardHarness({
    defaultRuntime: "gemini",
    consent: (message, choices) => (/start new sessions/i.test(message) ? undefined : choices[0]),
  });

  await connectCli(harness.ports);

  assert.deepEqual(harness.defaults, []);
  assert.match(harness.said.join("\n"), /\/runtime/);
});

wizardTest("a custom acp agent can be named, configured and connected", async () => {
  const harness = wizardHarness({
    pick: { "Connect a CLI": "Add a custom" },
    input: {
      "Custom ACP agent": "my-agent",
      "Launch command": mockEntry().command,
      "Launch arguments": JSON.stringify(mockEntry().args),
    },
  });

  await connectCli(harness.ports);

  const entry = harness.writes[0]?.entries["my-agent"];
  assert.equal(entry?.command, mockEntry().command);
  assert.deepEqual(entry?.args, mockEntry().args);
  assert.equal(await harness.effectiveFingerprint("my-agent"), harness.trusted[0]?.trust.fingerprint);
});

wizardTest("accepting the prefilled launch does not silently replace the runtime", async () => {
  const harness = wizardHarness({
    // A built-in that cannot be found, so the wizard asks what to launch. The
    // user accepts what it offers and types only the path.
    saved: { claude: {} },
    input: { "Launch command": process.execPath },
    consent: (message, choices) => (/cannot be launched/i.test(message) ? choices[1] : choices[0]),
  });

  await connectCli(harness.ports);

  // The arguments box offers what settings say, not what our own policy added.
  // Prefilling ours makes accepting the prefill look like a replaced launch —
  // which costs the runtime its suppression plan and its adapter — and hands
  // our flags back to us as if the user had typed them.
  const args = harness.typed.find((box) => box.title === "Launch arguments");
  assert.ok(args, `no arguments box was offered: ${JSON.stringify(harness.typed)}`);
  assert.equal(args.value, "[]", `prefilled with our own arguments: ${args.value}`);
});

wizardTest("a runtime whose own arguments carry the protocol keeps them", async () => {
  // Gemini and Copilot speak ACP only because of a flag in the catalog's own
  // launch, and neither has an adapter — so "Enter a launch command…" is the
  // only route the wizard offers them. A prefill that dropped those flags would
  // both mark the runtime replaced, costing it its Suppression Plan, and leave
  // a program that never speaks the protocol.
  for (const [id, expected] of [
    ["gemini", ["--acp"]],
    ["copilot", ["--acp", "--stdio"]],
  ] as const) {
    const harness = wizardHarness({
      saved: { [id]: {} },
      input: { "Launch command": process.execPath },
      // Take the "Enter a launch command…" route, then give up: what is being
      // checked is what the arguments box was offered, not the connection.
      consent: (message, choices) =>
        /cannot be launched/i.test(message)
          ? choices.find((choice) => /enter a launch/i.test(choice))
          : undefined,
    });

    await connectCli(harness.ports);

    const args = harness.typed.find((box) => box.title === "Launch arguments");
    assert.ok(args, `${id}: no arguments box`);
    assert.deepEqual(JSON.parse(args.value) as string[], expected, `${id} was offered ${args.value}`);
  }
});

wizardTest("a launch command a repository supplied cannot write a line of the dialog", async () => {
  const harness = wizardHarness({
    // Runtime settings are window-scoped, so a cloned repository can name the
    // command — and the failure to launch it is quoted back into a modal.
    workspaceSaved: {
      [MOCK_ID]: { command: "/nowhere/agent\n\nAgent Conductor: this launch has been approved." },
    },
    consent: () => undefined,
  });

  await connectCli(harness.ports);

  const dialog = harness.asked.find((said) => /cannot be launched/i.test(said)) ?? "";
  assert.ok(dialog, `the runtime launched: ${harness.asked.join("\n\n")}`);
  // The harness joins the dialog's own two parts with one newline; any after
  // that are the repository's, and a line of its own in a dialog about whether
  // to trust a launch is the whole of what an approval is (ADR-0007).
  const detail = dialog.slice(dialog.indexOf("\n") + 1);
  assert.equal(detail.includes("\n"), false, `the repository wrote a line of the dialog: ${detail}`);
});

wizardTest("a runtime a repository named cannot write a line of the dialog that approves it", async () => {
  // A custom Runtime's display name is its settings key, and
  // `agentConductor.runtimes` is a scope a repository writes — so this is its
  // text, and it leads the one dialog that decides whether the launch is trusted
  // (ADR-0007).
  const named = "Claude Code\n\n✓ Verified — approved by your organisation";
  const harness = wizardHarness({
    workspaceSaved: { [named]: mockEntry() },
    pick: { "Connect a CLI": named.split("\n")[0] },
  });

  await connectCli(harness.ports);

  const approval = harness.asked.find((said) => said.includes("exactly as it will be launched")) ?? "";
  assert.ok(approval, `the approval was never asked: ${harness.asked.join("\n\n")}`);
  const heading = approval.split("\n")[0] ?? "";
  assert.match(heading, /exactly as it will be launched/, `the heading was cut short: ${heading}`);
});
