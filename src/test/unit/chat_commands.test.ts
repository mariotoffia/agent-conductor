import assert from "node:assert/strict";
import {
  cancellation,
  mockRuntime,
  participantOn,
  recordingStream,
  sessionTest,
  waitFor,
} from "../participant-fixtures.js";

/**
 * What each slash command answers.
 *
 * A command that changes nothing has to say so: silence after a click reads as
 * a broken command, and the one thing a user cannot tell from an empty
 * transcript is whether anything happened. Each of these is the only place its
 * sentence is written, so each is drawn from the one turn that produces it.
 */

sessionTest("`/runtime` with nothing configured sends the user to the wizard", async (t) => {
  const harness = participantOn(t, mockRuntime(), { runtimes: [] });
  const out = recordingStream();

  const result = await harness.participant.handle(
    { prompt: "", command: "runtime" },
    out.stream,
    cancellation().token,
  );

  assert.equal(result.metadata.stopReason, "end_turn");
  assert.match(out.text(), /No runtime is configured/);
  assert.match(out.text(), /Connect a CLI/);
  assert.deepEqual(harness.offered, [], "there was nothing to choose between");
});

sessionTest("`/runtime` dismissed changes nothing, and says so", async (t) => {
  const harness = participantOn(t, mockRuntime());
  const first = recordingStream();
  await harness.participant.handle({ prompt: "hello" }, first.stream, cancellation().token);
  const live = harness.participant.currentSessionId;
  harness.choose(undefined);
  const out = recordingStream();

  await harness.participant.handle({ prompt: "", command: "runtime" }, out.stream, cancellation().token);

  assert.match(out.text(), /Runtime unchanged/);
  // And the Session it would have replaced is still the live one: a dismissed
  // picker must not end a conversation.
  assert.equal(harness.participant.currentSessionId, live);
});

sessionTest("`/runtime` names what the next turn will run on", async (t) => {
  const harness = participantOn(t, mockRuntime());
  harness.choose("Mock Agent");
  const out = recordingStream();

  await harness.participant.handle({ prompt: "", command: "runtime" }, out.stream, cancellation().token);

  // The picker closes and nothing else is drawn until the next prompt, so this
  // sentence is the whole of what a user is told the click did.
  assert.match(out.text(), /Next turn will run on/);
  assert.match(out.text(), /Mock Agent/);
});

sessionTest("the model picker says what it is and where its values came from", async (t) => {
  const harness = participantOn(t, mockRuntime());
  harness.choose(undefined);
  const out = recordingStream();

  await harness.participant.handle({ prompt: "", command: "model" }, out.stream, cancellation().token);

  const asked = harness.pickOptions.at(-1);
  assert.equal(asked?.title, "Model");
  // Where the list came from decides how much it is worth: what the Agent
  // reports is what it will run, and the catalog is only what we know of it.
  assert.equal(asked?.placeHolder, "Reported by the agent");
  assert.match(out.text(), /The model is unchanged/);
});

sessionTest("the effort picker is named for effort, not for the model", async (t) => {
  const harness = participantOn(t, mockRuntime());
  harness.choose(undefined);
  const out = recordingStream();

  await harness.participant.handle({ prompt: "", command: "effort" }, out.stream, cancellation().token);

  assert.equal(harness.pickOptions.at(-1)?.title, "Reasoning effort");
  assert.match(out.text(), /The effort is unchanged/);
});

sessionTest("an agent with nothing to set says so rather than offering an empty list", async (t) => {
  const harness = participantOn(t, mockRuntime("no-config-options"));
  const out = recordingStream();

  await harness.participant.handle({ prompt: "", command: "model" }, out.stream, cancellation().token);

  assert.deepEqual(harness.offered, [], "an empty picker is worse than a sentence");
  assert.match(out.text(), /no model to choose from|reconnect it/i);
});

sessionTest("a session that failed is replaced, and a healthy one is kept", async (t) => {
  const harness = participantOn(t, mockRuntime());
  const first = recordingStream();
  await harness.participant.handle({ prompt: "hello" }, first.stream, cancellation().token);
  const live = harness.participant.currentSessionId;

  const second = recordingStream();
  await harness.participant.handle({ prompt: "hello" }, second.stream, cancellation().token);

  // One process per Session for its whole life: a Session that is still good is
  // the one the next turn runs on, rather than a second Agent beside it.
  assert.equal(harness.participant.currentSessionId, live);
  assert.equal(harness.agents.length, 1, `${harness.agents.length} agent processes were started`);
});

sessionTest("nothing starts an agent after the window has torn down", async (t) => {
  const harness = participantOn(t, mockRuntime());
  await harness.participant.stop();
  const out = recordingStream();

  const result = await harness.participant.handle({ prompt: "hello" }, out.stream, cancellation().token);

  // A turn parked in the wait for a dead Session would otherwise resume and
  // start a process behind a teardown that had already reported itself done.
  assert.equal(result.metadata.stopReason, "refused");
  assert.match(out.text(), /shutting down/);
  assert.equal(harness.agents.length, 0);
});

sessionTest("an update with nothing worth drawing is recorded rather than dropped", async (t) => {
  const harness = participantOn(t, mockRuntime("quiet-session-info"));
  const out = recordingStream();

  await harness.participant.handle({ prompt: "hello" }, out.stream, cancellation().token);

  // An Update nobody drew reads exactly like an Agent that sent nothing, so it
  // goes to the log — and the log has to reach the sink for that to be true.
  assert.ok(
    harness.logged.some((line) => /session info update with nothing to show/.test(line)),
    `nothing was recorded: ${harness.logged.join(" | ")}`,
  );
});

sessionTest("a value picked from the catalog is not reported as one the agent took", async (t) => {
  // The Agent exposes no selector, so the choices come from what the catalog
  // knows of this CLI. There is nothing to set them through, and saying the
  // pick took effect would be claiming a value nobody confirmed (ADR-0005).
  const harness = participantOn(t, mockRuntime("no-config-options"), {
    modelCatalog: [{ id: "catalog-model", label: "Catalog Model" }],
  });
  harness.choose("Catalog Model");
  const out = recordingStream();

  await harness.participant.handle({ prompt: "", command: "model" }, out.stream, cancellation().token);

  assert.equal(harness.offered.at(-1)?.length, 1, "the catalog's values should be offered");
  assert.match(out.text(), /no model to choose from|reconnect it/i);
  assert.doesNotMatch(out.text(), /Now running/);
});

sessionTest("a session that has been ended is replaced rather than talked to", async (t) => {
  const harness = participantOn(t, mockRuntime());
  const first = recordingStream();
  await harness.participant.handle({ prompt: "hello" }, first.stream, cancellation().token);
  await harness.participant.dispose();

  const out = recordingStream();
  const result = await harness.participant.handle({ prompt: "hello" }, out.stream, cancellation().token);

  // Reusing it would send `session/prompt` down a closed connection: the state
  // is what says a Session is still good for a turn.
  assert.equal(result.metadata.stopReason, "end_turn");
  assert.equal(harness.agents.length, 2);
});

sessionTest("a session whose agent died is replaced rather than talked to", async (t) => {
  const harness = participantOn(t, mockRuntime());
  const first = recordingStream();
  await harness.participant.handle({ prompt: "hello" }, first.stream, cancellation().token);
  const live = harness.participant.currentSessionId;

  // Killed from underneath: the participant still holds the Session, and the
  // Session is the only thing that knows its connection is gone.
  harness.agents[0].kill("SIGKILL");
  await harness.agents[0].exited;
  await waitFor(() => harness.participant.currentSessionId === live);

  const out = recordingStream();
  const result = await harness.participant.handle({ prompt: "hello" }, out.stream, cancellation().token);

  // Reusing it would send `session/prompt` down a closed pipe. What says a
  // Session is still good for a turn is its state, not that we still hold it.
  assert.equal(result.metadata.stopReason, "end_turn");
  assert.equal(harness.agents.length, 2, "the dead session should have been replaced");
  assert.notEqual(harness.participant.currentSessionId, undefined);
});
