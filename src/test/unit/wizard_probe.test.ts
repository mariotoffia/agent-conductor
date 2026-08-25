import assert from "node:assert/strict";
import test from "node:test";
import { connectCli } from "../../vscode/wizard.js";
import { mockEntry, MOCK_ID, wizardHarness } from "../wizard-fixtures.js";

/**
 * What the wizard does with a running Agent: opening a Probe Session, handing
 * authentication back to the CLI that owns it, reading Config Options, agreeing
 * the policy, and one short Turn.
 *
 * Driven against the real mock Agent process, because what is protected here is
 * how an untrusted Agent's answers are treated — its refusals survived, its
 * text redacted, and what it reports never taken for what was asked.
 */

const wizardTest = (name: string, fn: () => Promise<void>) => test(name, { timeout: 30_000 }, fn);

wizardTest("the probe runs with the credentials a real session would carry", async () => {
  const harness = wizardHarness({
    saved: { [MOCK_ID]: { ...mockEntry(), secretEnvironment: { MOCK_KEY: "agentConductor.claude.MOCK_KEY" } } },
    secrets: { "agentConductor.claude.MOCK_KEY": "stored-value" },
  });

  await connectCli(harness.ports);

  assert.equal(
    harness.spawns[0]?.env.MOCK_KEY,
    "stored-value",
    "probing without the credential proves a configuration that will never run",
  );
  assert.equal(
    JSON.stringify(harness.writes).includes("stored-value"),
    false,
    "settings hold the name of a secret, never its value",
  );
});

wizardTest("an agent that fails the smoke test leaves nothing approved", async () => {
  // A `chatty` agent answers a one-word question with prose.
  const harness = wizardHarness({ mode: "chatty" });

  await connectCli(harness.ports);

  assert.deepEqual(harness.writes, [], "nothing may be persisted for a runtime that failed");
  assert.deepEqual(harness.trusted, [], "an unproven identity must not stay approved");
  assert.match(harness.said.join("\n"), /smoke test|OK/i);
});

wizardTest("cancelling a picker ends the probe session too", async () => {
  const harness = wizardHarness({ pick: { Model: undefined } });

  await connectCli(harness.ports);

  assert.deepEqual(harness.writes, []);
  const agent = harness.agents[0];
  assert.ok(agent, "the probe did start an agent");
  // The point of the test: a cancelled wizard leaves no process running.
  assert.ok(await agent.exited, "the probe's agent process must be gone");
  assert.match(harness.said.join("\n"), /cancelled/i);
});

wizardTest("a runtime that never starts is given up on, not retried forever", async () => {
  const harness = wizardHarness({
    mode: "crash-on-session-new",
    consent: (message, choices) =>
      /could not open/i.test(message) ? choices.find((choice) => /try again/i.test(choice)) : choices[0],
  });

  await connectCli(harness.ports);

  assert.equal(harness.spawns.length, 3, "the wizard stops asking after three attempts");
  assert.match(harness.said.join("\n"), /did not open a session/i);
  assert.deepEqual(harness.writes, []);
});

wizardTest("an agent that refuses to set a config option is still connectable", async () => {
  // Copilot-shaped: it reports a model and fixes it when the process starts.
  const harness = wizardHarness({ mode: "bad-set-response" });

  await connectCli(harness.ports);

  assert.equal(harness.writes.length, 1, "a runtime that keeps its own default still connects");
  assert.match(harness.said.join("\n"), /refused that model/i);
});

wizardTest("model and effort are offered from what the agent reports", async () => {
  const harness = wizardHarness();

  await connectCli(harness.ports);

  const model = harness.offered.find((pick) => pick.title === "Model");
  assert.deepEqual(model?.labels, ["Mock Model"], "the agent's own model list, not a catalog");
  // Setting the model returns a whole refreshed array whose effort levels are
  // narrower than the ones the session opened with. The picker offers what the
  // agent says now, never the list it started from (ADR-0005).
  const effort = harness.offered.find((pick) => pick.title === "Reasoning effort");
  assert.deepEqual(effort?.labels, ["Low"]);
});

wizardTest("a runtime that exposes no config options is still connectable", async () => {
  const harness = wizardHarness({ mode: "no-config-options" });

  await connectCli(harness.ports);

  assert.equal(harness.writes.length, 1);
  assert.equal(harness.writes[0]?.entries[MOCK_ID]?.defaultModel, undefined);
  assert.match(harness.said.join("\n"), /exposes no model/i);
});

wizardTest("what the agent clamps is reported as a mismatch, not saved as effective", async () => {
  // A `clamp` agent answers every set with its own values: the silent clamp
  // Read-back exists to surface (ADR-0005).
  const harness = wizardHarness({ mode: "clamp" });

  await connectCli(harness.ports);

  const report = harness.said.find((line) => /answered/i.test(line));
  // On one line, because a notification shows one line: a mismatch the user
  // never sees is a mismatch nobody acted on.
  assert.ok(report, "the smoke test must report what happened");
  assert.match(report, /mismatch/i);
  assert.match(report, /mock-model-fast/, "the agent's own value is reported");
  assert.equal(
    harness.writes[0]?.entries[MOCK_ID]?.defaultModel,
    "mock-model",
    "what was asked for is saved; what the agent clamped to is not",
  );
});

wizardTest("a runtime that will not start offers its login command and waits", async () => {
  const seen: string[] = [];
  const harness = wizardHarness({
    mode: "crash-on-session-new",
    consent: (message, choices) => {
      seen.push(message);
      if (/approve/i.test(message)) return choices[0];
      if (/running/i.test(message)) return undefined; // give up while it runs
      return choices.find((choice) => /log in/i.test(choice));
    },
  });

  await connectCli(harness.ports);

  assert.deepEqual(
    harness.terminals.map((terminal) => terminal.command),
    ["claude /login"],
    "the runtime's own login command is opened",
  );
  // Retrying before the user has typed anything spends an attempt for nothing.
  assert.ok(
    seen.some((message) => /running/i.test(message)),
    "the wizard must wait for the login to finish",
  );
  assert.deepEqual(harness.writes, []);
});

wizardTest("a runtime that is not installed offers to install its adapter", async () => {
  const harness = wizardHarness({
    saved: { codex: {} },
    consent: (message, choices) =>
      /cannot be launched/i.test(message)
        ? choices.find((choice) => /^Install/.test(choice))
        : undefined,
  });

  await connectCli(harness.ports);

  assert.deepEqual(
    harness.terminals.map((terminal) => terminal.command),
    [
      'npm install --prefix "/home/user/Application Support/conductor/adapters"' +
        " @agentclientprotocol/codex-acp@1.4.0",
    ],
    "the exact version the catalog names, into this extension's own directory",
  );
  assert.deepEqual(harness.writes, [], "an install that changed nothing connects nothing");
});

wizardTest("fanning out across providers needs its own acknowledgement", async () => {
  const harness = wizardHarness({ orchestration: true });

  await connectCli(harness.ports);

  const notice = harness.asked.find((message) => /subagent|another provider/i.test(message));
  assert.ok(notice, `no fan-out notice was shown; asked: ${JSON.stringify(harness.asked)}`);
  assert.equal(harness.trusted[0]?.trust.fanOut, true);
});

wizardTest("declining the fan-out notice still connects the runtime for direct use", async () => {
  const harness = wizardHarness({
    orchestration: true,
    // Declined by choosing to decline, not by dismissing: every other question
    // in the wizard treats dismissal as cancelling the run.
    consent: (message, choices) =>
      /subagent|another provider/i.test(message)
        ? choices.find((choice) => /direct sessions only/i.test(choice))
        : choices[0],
  });

  await connectCli(harness.ports);

  assert.equal(harness.writes.length, 1, "a direct session is configured independently");
  assert.notEqual(harness.trusted[0]?.trust.fanOut, true, "consent nobody gave must not be recorded");
});

wizardTest("dismissing the fan-out notice cancels the run like every other question", async () => {
  const harness = wizardHarness({
    orchestration: true,
    consent: (message, choices) => (/subagent|another provider/i.test(message) ? undefined : choices[0]),
  });

  await connectCli(harness.ports);

  // Dismissal is not an answer. Reading it as "declined, carry on" makes this
  // the one question where closing the dialog decides something.
  assert.deepEqual(harness.writes, []);
  assert.match(harness.said.join("\n"), /cancelled/i);
});

wizardTest("an api key is stored as a secret, and the saved entry holds only its name", async () => {
  const harness = wizardHarness({
    // A CLI that refuses to open a session until it has a credential.
    mode: "needs-key",
    consent: (message, choices) =>
      /could not open/i.test(message)
        ? choices.find((choice) => /key/i.test(choice))
        : choices[0],
    input: { "Environment variable": "MOCK_API_KEY", "API key": "sk-not-a-real-key" },
  });

  await connectCli(harness.ports);

  assert.equal(harness.secrets["agentConductor.claude.MOCK_API_KEY"], "sk-not-a-real-key");
  // The reference is part of the launch identity, and it was added after the
  // first approval — so what was approved has to be what these settings now
  // produce, or every turn is refused for a runtime the wizard called connected.
  assert.equal(
    await harness.effectiveFingerprint(),
    harness.trusted[0]?.trust.fingerprint,
    "the approval recorded is not the identity the saved settings resolve to",
  );
  assert.deepEqual(harness.writes[0]?.entries[MOCK_ID]?.secretEnvironment, {
    MOCK_API_KEY: "agentConductor.claude.MOCK_API_KEY",
  });
  assert.equal(
    JSON.stringify(harness.writes).includes("sk-not-a-real-key"),
    false,
    "the value never reaches settings (ADR-0010)",
  );
});

wizardTest("the wizard says what it is doing while an agent starts", async () => {
  const harness = wizardHarness();

  await connectCli(harness.ports);

  // A probe can take a Setup Deadline to fail; a window that says nothing for
  // twenty seconds looks hung.
  assert.match(harness.progress.join("\n"), /starting/i);
});

wizardTest("a connection whose stored credential is gone is not saved", async () => {
  const harness = wizardHarness({
    // A reference in settings with nothing behind it — the shape left by a
    // secret store that was cleared, or a settings file copied between machines.
    saved: {
      [MOCK_ID]: {
        ...mockEntry(),
        secretEnvironment: { MOCK_SECRET: "agentConductor.claude.MOCK_SECRET" },
      },
    },
    secrets: {},
  });

  await connectCli(harness.ports);

  // The agent may well start without it; the first real turn would then fail
  // where a session start resolves the same reference (ADR-0010).
  assert.deepEqual(harness.writes, [], "a connection that cannot run was saved");
  assert.deepEqual(harness.trusted, []);
  assert.match(harness.said.join("\n"), /secret/i);
  // And the way out is offered: settings sync carries these references between
  // machines while secret storage does not, so this is the ordinary second
  // machine, and "connect the runtime again" has to lead somewhere.
  assert.ok(
    harness.asked.some((message) => /could not open|store an api key/i.test(message)),
    `no way to store the missing credential was offered: ${JSON.stringify(harness.asked)}`,
  );
});

wizardTest("a credential stored for a reference with nothing behind it recovers the run", async () => {
  const harness = wizardHarness({
    mode: "needs-key",
    saved: {
      [MOCK_ID]: {
        ...mockEntry("needs-key"),
        secretEnvironment: { MOCK_API_KEY: "agentConductor.claude.MOCK_API_KEY" },
      },
    },
    secrets: {},
    consent: (message, choices) =>
      /could not open/i.test(message) ? choices.find((choice) => /key/i.test(choice)) : choices[0],
    input: { "Environment variable": "MOCK_API_KEY", "API key": "restored-value" },
  });

  await connectCli(harness.ports);

  assert.equal(harness.writes.length, 1, `the run did not recover: ${harness.said.join(" | ")}`);
  assert.equal(harness.secrets["agentConductor.claude.MOCK_API_KEY"], "restored-value");
  assert.equal(await harness.effectiveFingerprint(), harness.trusted[0]?.trust.fingerprint);
});

wizardTest("a credential recovers a reference whatever the old one was called", async () => {
  const harness = wizardHarness({
    mode: "needs-key",
    // A key somebody named themselves — settings sync carries the reference,
    // and the next attempt has to use the one just repaired rather than the
    // one that is missing.
    saved: {
      [MOCK_ID]: {
        ...mockEntry("needs-key"),
        secretEnvironment: { MOCK_API_KEY: "my-own-key-name" },
      },
    },
    secrets: {},
    consent: (message, choices) =>
      /could not open/i.test(message) ? choices.find((choice) => /key/i.test(choice)) : choices[0],
    input: { "Environment variable": "MOCK_API_KEY", "API key": "restored-value" },
  });

  await connectCli(harness.ports);

  assert.equal(harness.writes.length, 1, `the run did not recover: ${harness.said.join(" | ")}`);
  assert.equal(
    harness.writes[0]?.entries[MOCK_ID]?.secretEnvironment?.MOCK_API_KEY,
    "agentConductor.claude.MOCK_API_KEY",
    "the repaired reference is what gets saved",
  );
});

