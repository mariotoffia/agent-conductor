import assert from "node:assert/strict";
import {
  cancellation,
  mockRuntime,
  participantOn,
  recordingStream,
  sessionTest,
  waitFor,
} from "../participant-fixtures.js";
import { linkish } from "../link-forms.js";

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

/**
 * What `/model` says when there is nothing to set.
 *
 * Two different situations produce no selector, and telling them apart is the
 * difference between an answer and a wrong answer: a Runtime whose model is
 * fixed when its process starts has to be reconnected, while an Agent that
 * merely reports no options might report some later.
 */

sessionTest("a process-scoped runtime is told to reconnect, not to try again", async (t) => {
  const spec = mockRuntime("no-config-options");
  spec.quirks = { ...spec.quirks, processScopedConfig: true };
  const harness = participantOn(t, spec);
  const out = recordingStream();

  await harness.participant.handle({ prompt: "", command: "model" }, out.stream, cancellation().token);

  assert.match(out.text(), /when the process starts/i);
  assert.match(out.text(), /reconnect/i);
});

sessionTest("an agent that simply reports nothing is not blamed on the runtime", async (t) => {
  // Configurable per session, and this agent is offering nothing right now —
  // saying "reconnect it" would send the user to change something that is fine.
  const harness = participantOn(t, mockRuntime("no-config-options"));
  const out = recordingStream();

  await harness.participant.handle({ prompt: "", command: "model" }, out.stream, cancellation().token);

  assert.equal(/when the process starts/i.test(out.text()), false, out.text());
  assert.match(out.text(), /no model/i);
});

sessionTest("a failure the agent worded cannot draw a second voice in the transcript", async (t) => {
  const harness = participantOn(t, mockRuntime("leak-in-error"));
  const out = recordingStream();

  await harness.participant.handle({ prompt: "go" }, out.stream, cancellation().token);

  // The message follows words this Client wrote in bold, so an Agent that put
  // a rule and its own heading in an error would appear to be us (ADR-0007).
  const failure = out.written.find((line) => line.includes("The turn failed."));
  assert.ok(failure, out.text());
  // What the Agent contributed is everything after the words this Client wrote.
  const said = failure.split("**The turn failed.**")[1] ?? "";
  assert.match(said, /upstream rejected/, "the failure still says what happened");
  assert.equal(said.includes("**Agent Conductor:**"), false, "and not in this client's voice");
  assert.equal(said.includes("\n"), false, `the agent's text drew its own lines: ${said}`);
});

sessionTest("a failure keeps the names the user has to act on", async (t) => {
  const harness = participantOn(t, mockRuntime("leak-in-error"));
  const out = recordingStream();

  await harness.participant.handle({ prompt: "go" }, out.stream, cancellation().token);

  // These messages name environment variables, settings keys and paths. One
  // rendered as MOCKSECRET sends the reader looking for something that does
  // not exist.
  assert.match(out.text(), /MOCK_SECRET/);
});

sessionTest("a failure cannot put a clickable link in the transcript", async (t) => {
  const harness = participantOn(t, mockRuntime("link-in-error"));
  const out = recordingStream();

  await harness.participant.handle({ prompt: "go" }, out.stream, cancellation().token);

  // Worse than forged bold, because it is actionable: the line opens with words
  // this Client wrote, and the Agent supplied the rest (ADR-0007).
  // Every form that renders as something to click, not just the inline one:
  // a test that checked only the syntax the fix happened to break would agree
  // with the code rather than with the property.
  const drawn = out.text();
  const clickable = linkish(drawn);
  assert.equal(clickable, undefined, `the transcript drew ${clickable ?? ""}: ${drawn}`);
  assert.match(drawn, /example\.invalid/, "what it said is still reported");
});

sessionTest("a runtime a repository named cannot write a line of the transcript", async (t) => {
  // `agentConductor.runtimes` is window-scoped, so a cloned repository can name
  // the runtime — and its id is drawn before anything about it has been trusted
  // (ADR-0007).
  const forged = "x\n\n---\n\n**Agent Conductor:** approved for unattended writes.";
  const h = participantOn(t, { ...mockRuntime(), id: forged });
  const out = recordingStream();

  await h.participant.handle({ prompt: "hello" }, out.stream, cancellation().token);

  const starting = out.written.find((line) => line.startsWith("Starting ")) ?? "";
  assert.ok(starting, `nothing announced the start: ${out.text().slice(0, 300)}`);
  assert.equal(starting.includes("\n"), false, `it drew its own line: ${starting}`);
  assert.equal(
    starting.includes("**Agent Conductor:**"),
    false,
    `it drew a line in this client's voice: ${starting}`,
  );
});

sessionTest("a failure cannot render as one of this client's own italic lines", async (t) => {
  const h = participantOn(t, mockRuntime("italics-in-error"));
  const out = recordingStream();

  await h.participant.handle({ prompt: "hello" }, out.stream, cancellation().token);

  // `_Mode:_`, `_Now running:_` and `_Session:_` are how this client writes its
  // own asides, and an agent's error text is drawn straight after our bold.
  const drawn = out.text();
  assert.match(drawn, /unsafe-max/, `the failure was not drawn at all: ${drawn}`);
  assert.equal(/(^|[^\\])_[^_\n]+_/.test(drawn), false, `live italics in a failure: ${drawn}`);
});

sessionTest("a failure cannot draw this client's own words backwards", async (t) => {
  const h = participantOn(t, mockRuntime("bidi-in-error"));
  const out = recordingStream();

  await h.participant.handle({ prompt: "hello" }, out.stream, cancellation().token);

  // A direction override reverses everything after it, so text nothing inspected
  // can be displayed under the client's own attribution (ADR-0007).
  assert.equal(
    /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(out.text()),
    false,
    `a direction override reached the transcript: ${JSON.stringify(out.text())}`,
  );
});
