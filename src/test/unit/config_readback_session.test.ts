import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { isMismatch, pickModelChoices } from "../../core/index.js";
import { harness, launchMockAgent, turnGate } from "../acp-harness.js";

/**
 * Config Option discovery and Read-back as a Session actually experiences them:
 * over the wire, against an Agent whose answers are not schema-checked and whose
 * effective values are the only ones that count (ADR-0005, ADR-0007).
 */
const sessionTest = (name: string, fn: (t: TestContext) => Promise<void>) =>
  test(name, { timeout: 10_000 }, fn);

sessionTest("setting a Config Option adopts the complete refreshed array", async (t) => {
  const h = harness(t);
  const session = await h.open();
  assert.deepEqual(session.config.model?.choices.map((choice) => choice.value), ["mock-model"]);

  const config = await session.setConfigOption("model", "mock-model-fast");

  // The Agent answered with a longer list and a different current value; the
  // Session renders that array rather than patching the one it had.
  assert.deepEqual(config.model?.choices.map((choice) => choice.value), [
    "mock-model",
    "mock-model-fast",
  ]);
  assert.equal(config.model?.currentValue, "mock-model-fast");
  assert.deepEqual(h.paramsOf("session/set_config_option"), {
    sessionId: session.sessionId,
    configId: "model",
    value: "mock-model-fast",
  });
});

sessionTest("a value the Agent no longer offers disappears from the picker", async (t) => {
  const h = harness(t);
  const session = await h.open();
  assert.deepEqual(session.config.effort?.choices.map((choice) => choice.value), ["low", "medium"]);

  await session.setConfigOption("effort", "medium");

  // The refreshed array offers only `low`, and that is what the Agent runs.
  assert.deepEqual(session.config.effort?.choices.map((choice) => choice.value), ["low"]);
  assert.deepEqual(session.effortSelection, {
    requested: "medium",
    effective: "low",
    verification: "verified",
  });
  assert.equal(isMismatch(session.effortSelection), true);
});

sessionTest("a set is a request; the Agent's answer is the effective value", async (t) => {
  const h = harness(t);
  const session = await h.open();

  await session.setConfigOption("model", "mock-model-fast");

  assert.deepEqual(session.modelSelection, {
    requested: "mock-model-fast",
    effective: "mock-model-fast",
    verification: "verified",
  });
  assert.equal(isMismatch(session.modelSelection), false);
});

sessionTest("an unsolicited config_option_update re-renders the pickers and Read-back", async (t) => {
  const h = harness(t);
  const session = await h.open({
    launch: launchMockAgent("config-refresh"),
    requestedModel: "mock-model",
  });
  assert.deepEqual(session.modelSelection, {
    requested: "mock-model",
    effective: "mock-model",
    verification: "verified",
  });

  await session.prompt("refresh the options");

  assert.deepEqual(session.modelSelection, {
    requested: "mock-model",
    effective: "mock-model-fast",
    verification: "verified",
  });
  assert.equal(isMismatch(session.modelSelection), true);
});

sessionTest("a requested value stays unverified when the Agent exposes no Config Options", async (t) => {
  const h = harness(t);
  const session = await h.open({
    launch: launchMockAgent("no-config-options"),
    // Set through argv on a process-scoped Runtime, so the Agent was never asked.
    requestedModel: "from-argv",
    requestedEffort: "high",
  });

  assert.deepEqual(session.config, { other: [] });
  assert.deepEqual(session.modelSelection, { requested: "from-argv", verification: "unavailable" });
  assert.deepEqual(session.effortSelection, { requested: "high", verification: "unavailable" });
  assert.equal(session.modelSelection.effective, undefined);
});

sessionTest("an unknown Config Option id is refused before it reaches the Agent", async (t) => {
  const h = harness(t);
  const session = await h.open();

  await assert.rejects(
    () => session.setConfigOption("no-such-option", "value"),
    /unknown config option "no-such-option"/,
  );
  assert.equal(h.methodsSent().includes("session/set_config_option"), false);
});

sessionTest("a disposed Session cannot set a Config Option", async (t) => {
  const h = harness(t);
  const session = await h.open();
  await session.dispose();

  await assert.rejects(() => session.setConfigOption("model", "mock-model-fast"), /disposed/);
});

sessionTest("a Config Option cannot be set while a Turn is in flight", async (t) => {
  const h = harness(t);
  const gate = turnGate(h.updates);
  const session = await h.open({ launch: launchMockAgent("cancel"), onUpdate: gate.onUpdate });
  const turn = session.prompt("hold the turn open");
  await gate.started;

  await assert.rejects(
    () => session.setConfigOption("model", "mock-model-fast"),
    /is prompting; it cannot set a config option/,
  );

  await session.cancel();
  await turn;
  assert.equal(h.methodsSent().includes("session/set_config_option"), false);
});

sessionTest("an Agent that answers a set without Config Options loses its verified Read-back", async (t) => {
  const h = harness(t);
  const session = await h.open({ launch: launchMockAgent("bad-set-response") });

  await assert.rejects(
    () => session.setConfigOption("model", "mock-model-fast"),
    /answered session\/set_config_option without config options/,
  );

  // Nothing stale may keep passing for verified truth once the Agent has
  // contradicted the protocol.
  assert.deepEqual(session.configOptions, []);
  assert.deepEqual(session.modelSelection, {
    requested: "mock-model-fast",
    verification: "unavailable",
  });
});

sessionTest("an Agent whose Config Options are malformed opens a usable, unverified Session", async (t) => {
  const h = harness(t);
  const session = await h.open({
    launch: launchMockAgent("bad-config-options"),
    requestedModel: "from-argv",
  });

  assert.equal(session.state, "idle");
  // Nothing untrustworthy is presented, and nothing throws on the render path.
  assert.equal(session.config.model, undefined);
  assert.equal(session.config.effort, undefined);
  assert.deepEqual(session.modelSelection, { requested: "from-argv", verification: "unavailable" });
  // The raw array the Session exposes never contradicts its own type either.
  assert.ok(session.configOptions.every((option) => typeof option.id === "string"));
  // The well-formed options survive — including the boolean that claims the
  // model category, which is kept as an option and refused as a picker.
  assert.deepEqual(session.config.other.map((option) => option.id), ["posing", "web"]);
  // A Session that cannot verify its model still answers turns.
  assert.equal((await session.prompt("still usable")).stopReason, "end_turn");
});

sessionTest("a boolean Config Option is never set: the client does not advertise booleans", async (t) => {
  const h = harness(t);
  const session = await h.open({ launch: launchMockAgent("bad-config-options") });
  assert.deepEqual(session.config.other.map((option) => option.id), ["posing", "web"]);

  await assert.rejects(
    () => session.setConfigOption("web", "true"),
    /config option "web" is not a select/,
  );
  assert.equal(h.methodsSent().includes("session/set_config_option"), false);
});

sessionTest("a Turn cannot start while a Config Option set is still on the wire", async (t) => {
  const h = harness(t);
  const session = await h.open({ launch: launchMockAgent("hang-set") });

  // The Agent accepted the set and has not answered it.
  const setting = session.setConfigOption("model", "mock-model-fast").catch(() => undefined);

  await assert.rejects(
    () => session.prompt("sneak a turn in"),
    /is configuring; it cannot start a turn/,
  );
  // A second set is refused for the same reason, so two answers cannot race.
  await assert.rejects(
    () => session.setConfigOption("effort", "low"),
    /is configuring; it cannot set a config option/,
  );
  assert.equal(h.methodsSent().filter((method) => method === "session/set_config_option").length, 1);

  await session.dispose();
  await setting;
});

sessionTest("a reattached Session reads back the Config Options the Agent reports on load", async (t) => {
  const h = harness(t);
  const opened = await h.open();
  const sessionId = opened.sessionId;
  await opened.dispose();

  const reloaded = await h.load(sessionId, { requestedEffort: "high" });

  assert.equal(reloaded.config.model?.currentValue, "mock-model");
  // Reattaching does not make an unverifiable request verified: the Agent
  // reports `medium`, so the Preset's `high` is a mismatch, not the truth.
  assert.deepEqual(reloaded.effortSelection, {
    requested: "high",
    effective: "medium",
    verification: "verified",
  });
  assert.equal(isMismatch(reloaded.effortSelection), true);
});

sessionTest("a set the Agent never answers leaves the Session unable to verify anything", async (t) => {
  const h = harness(t);
  const session = await h.open({ launch: launchMockAgent("hang-set"), setupTimeoutMs: 50 });
  assert.equal(session.modelSelection.verification, "verified");

  const setting = assert.rejects(
    () => session.setConfigOption("model", "mock-model-fast"),
    /did not answer session\/set_config_option within 50ms/,
  );
  await h.clock.armedMs(50);
  h.clock.fire();
  await setting;

  // The Agent may or may not have applied the change: the honest state is that
  // nothing is known, not the array from before the request.
  assert.deepEqual(session.configOptions, []);
  assert.equal(session.modelSelection.verification, "unavailable");
  assert.equal(session.modelSelection.effective, undefined);
  // The picker survives regardless — that is what the catalog fallback is for.
  assert.deepEqual(pickModelChoices(session.config, [{ id: "m", label: "M" }]), {
    choices: [{ value: "m", label: "M" }],
    source: "catalog",
  });
  // And the Session is still usable.
  assert.equal(session.state, "idle");
});
