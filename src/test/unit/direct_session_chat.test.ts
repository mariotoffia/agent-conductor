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
 * The direct Session slice as a user drives it: a chat turn on a trusted
 * Runtime, streamed from a real Agent process over ACP, with the permission,
 * read-back and diff paths the participant is responsible for.
 */

sessionTest("a prompt streams the agent's message, thought and tool call", async (t) => {
  const h = participantOn(t, mockRuntime());
  const out = recordingStream();

  const result = await h.participant.handle({ prompt: "hello" }, out.stream, cancellation().token);

  assert.equal(result.metadata.stopReason, "end_turn");
  assert.match(out.text(), /Mock response/);
  assert.match(out.text(), /Mock thought/);
  assert.match(out.text(), /Edit mock file/);
  assert.match(out.text(), /Exercise ACP client/, "the agent's plan should be rendered");
});

sessionTest("thinking is withheld when the setting says so", async (t) => {
  const h = participantOn(t, mockRuntime());
  // The setting is read per turn, not once when the participant is built.
  h.hideThinking();
  const out = recordingStream();

  await h.participant.handle({ prompt: "hello" }, out.stream, cancellation().token);

  assert.match(out.text(), /Mock response/);
  assert.doesNotMatch(out.text(), /Mock thought/);
});

sessionTest("a diff the agent reports is retained and offered as a button", async (t) => {
  const h = participantOn(t, mockRuntime());
  const out = recordingStream();

  await h.participant.handle({ prompt: "hello" }, out.stream, cancellation().token);

  const button = out.buttons.find((entry) => entry.command === "agentConductor.openDiff");
  assert.ok(button, "a reported diff must be openable");
  const [id] = button.arguments ?? [];
  assert.equal(typeof id, "string");
  assert.equal(h.diffs.entry(id as string)?.oldText, "before\n");
  assert.equal(h.diffs.entry(id as string)?.newText, "after\n");
});

sessionTest("a cancelled chat turn cancels the session and answers cancelled", async (t) => {
  const h = participantOn(t, mockRuntime("cancel"));
  const out = recordingStream();
  const chat = cancellation();

  const turn = h.participant.handle({ prompt: "hello" }, out.stream, chat.token);
  // Cancel once the agent has actually started the turn.
  await waitFor(() => out.text().includes("Waiting for cancellation"));
  chat.cancel();
  const result = await turn;

  assert.equal(result.metadata.stopReason, "cancelled");
});

sessionTest("an untrusted workspace refuses the spawn and says why", async (t) => {
  const h = participantOn(t, mockRuntime(), { workspaceTrusted: false });
  const out = recordingStream();

  const result = await h.participant.handle({ prompt: "hello" }, out.stream, cancellation().token);

  assert.equal(result.metadata.stopReason, "refused");
  assert.match(out.text() + (result.errorDetails?.message ?? ""), /trust/i);
  // The gate has to refuse before anything is started, not after.
  assert.equal(h.agents.length, 0, "no agent process may exist");
});

sessionTest("a runtime the user never approved refuses the spawn", async (t) => {
  const h = participantOn(t, mockRuntime(), { trusted: false });
  const out = recordingStream();

  const result = await h.participant.handle({ prompt: "hello" }, out.stream, cancellation().token);

  assert.equal(result.metadata.stopReason, "refused");
  assert.match(out.text() + (result.errorDetails?.message ?? ""), /not trusted|wizard/i);
  assert.equal(h.agents.length, 0, "no agent process may exist");
});

sessionTest("/model sets the config option and reports what the agent runs", async (t) => {
  const h = participantOn(t, mockRuntime());
  const out = recordingStream();
  await h.participant.handle({ prompt: "hello" }, out.stream, cancellation().token);
  h.choose("Mock Model");

  const picker = recordingStream();
  const result = await h.participant.handle(
    { command: "model", prompt: "" },
    picker.stream,
    cancellation().token,
  );

  assert.equal(result.metadata.stopReason, "end_turn");
  // Requested and effective are both reported; the agent kept what was asked.
  assert.match(picker.text(), /requested `mock-model`/);
  assert.match(picker.text(), /effective `mock-model`/);
  assert.doesNotMatch(picker.text(), /mismatch/i);
});

sessionTest("/effort surfaces a clamp as a mismatch rather than echoing the request", async (t) => {
  const h = participantOn(t, mockRuntime());
  const out = recordingStream();
  await h.participant.handle({ prompt: "hello" }, out.stream, cancellation().token);
  h.choose("Medium");

  const picker = recordingStream();
  await h.participant.handle({ command: "effort", prompt: "" }, picker.stream, cancellation().token);

  // The agent's refreshed array offers only `low`, so `medium` was clamped.
  assert.match(picker.text(), /medium/);
  assert.match(picker.text(), /low/);
  assert.match(picker.text(), /mismatch/i);
});

sessionTest("a picked model is identified by choice, not by the label it renders as", async (t) => {
  const h = participantOn(t, mockRuntime("colliding-models"));
  await h.participant.handle({ prompt: "hello" }, recordingStream().stream, cancellation().token);
  // Both of this agent's models render as the same clamped label; the user
  // picks the second one.
  h.chooseAt(1);

  const picker = recordingStream();
  await h.participant.handle({ command: "model", prompt: "" }, picker.stream, cancellation().token);

  assert.equal(h.offered[0]?.[0]?.label, h.offered[0]?.[1]?.label, "the labels must collide");
  // The agent echoes what it was actually asked for.
  assert.match(picker.text(), /effective `collide-b`/);
  assert.doesNotMatch(picker.text(), /collide-a/);
});

sessionTest("/runtime replaces the session, and the old agent process is stopped", async (t) => {
  const h = participantOn(t, mockRuntime());
  const first = recordingStream();
  await h.participant.handle({ prompt: "hello" }, first.stream, cancellation().token);
  assert.equal(h.agents.length, 1);
  h.choose("Mock Agent");

  const out = recordingStream();
  await h.participant.handle({ command: "runtime", prompt: "" }, out.stream, cancellation().token);
  // A Session owns one agent process for its whole life (ADR-0008), so
  // switching runtime ends that process rather than reconfiguring it.
  await h.agents[0].exited;
  const second = recordingStream();
  await h.participant.handle({ prompt: "again" }, second.stream, cancellation().token);

  assert.equal(h.agents.length, 2, "the next prompt must run on a new agent process");
  assert.match(second.text(), /Mock response/);
});
