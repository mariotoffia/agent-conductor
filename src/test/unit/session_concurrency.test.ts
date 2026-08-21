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
 * One Session runs one Turn at a time, and every Agent process it starts is
 * owned by something that can stop it (ADR-0008).
 *
 * Each of these pins a window that was once open: the wait while an Agent
 * starts, the wait on a quick pick, the wait on a dying Session, and teardown
 * landing inside any of them. What they assert is how many processes exist and
 * which stream received the output — the two facts that tell a fix from a bug.
 */

sessionTest("a turn submitted while the agent is still starting is refused, not raced", async (t) => {
  const h = participantOn(t, mockRuntime());
  const first = recordingStream();
  const second = recordingStream();

  // Neither turn has a session yet: starting the agent is the slowest part of a
  // turn, and it is exactly the window a second submission lands in.
  const one = h.participant.handle({ prompt: "one" }, first.stream, cancellation().token);
  const two = h.participant.handle({ prompt: "two" }, second.stream, cancellation().token);
  const [resultOne, resultTwo] = await Promise.all([one, two]);

  // Two sessions would mean two agent processes, and only one of them reachable
  // — the other owned by nobody, and stopped by nothing (ADR-0008).
  assert.equal(h.agents.length, 1, "only one agent process may be started");
  assert.equal(resultOne.metadata.stopReason, "end_turn");
  assert.equal(resultTwo.metadata.stopReason, "refused");
  assert.equal(first.buttons.length, 1, "the first turn keeps its own diff button");
  assert.equal(second.buttons.length, 0, "nothing from the first turn may land on the second");
});

sessionTest("a runtime pick cannot be undercut by a prompt submitted underneath it", async (t) => {
  const h = participantOn(t, mockRuntime());
  const first = recordingStream();
  await h.participant.handle({ prompt: "hello" }, first.stream, cancellation().token);
  h.holdPick();
  h.choose("Mock Agent");

  // `/runtime` waits on a quick pick the user has not answered yet.
  const picker = recordingStream();
  const switching = h.participant.handle({ command: "runtime", prompt: "" }, picker.stream, cancellation().token);
  await h.pickOffered;
  const during = recordingStream();
  const blocked = await h.participant.handle({ prompt: "meanwhile" }, during.stream, cancellation().token);
  h.allowPick();
  await switching;

  // Otherwise the pick disposes the session the prompt is running on, and the
  // user is told their turn failed for a reason they never caused.
  assert.equal(blocked.metadata.stopReason, "refused");
  assert.match(during.text(), /already running/i);
  assert.equal(h.agents.length, 1, "the blocked prompt must not have started anything");
});

sessionTest("a second turn is refused, and never takes over the first turn's stream", async (t) => {
  const h = participantOn(t, mockRuntime());
  h.holdPermission();
  const first = recordingStream();
  const turn = h.participant.handle({ prompt: "one" }, first.stream, cancellation().token);
  await h.permissionAsked;

  // A second chat tab submits while the first turn is still streaming.
  const second = recordingStream();
  const blocked = await h.participant.handle(
    { prompt: "two" },
    second.stream,
    cancellation().token,
  );
  h.allowPermission();
  const result = await turn;

  assert.equal(blocked.metadata.stopReason, "refused");
  assert.match(second.text(), /already running/i);
  // Everything the agent sent after the interleave still belongs to turn one:
  // its diff button, its plan and its usage line must not have been lost.
  assert.equal(result.metadata.stopReason, "end_turn");
  assert.equal(first.buttons.length, 1, "the first turn must keep its diff button");
  assert.match(first.text(), /Exercise ACP client/);
  assert.match(first.text(), /context 100\/1000/);
  assert.equal(second.buttons.length, 0, "nothing from turn one may land on turn two");
});

sessionTest("/cancel is the one command allowed alongside a live turn", async (t) => {
  const h = participantOn(t, mockRuntime("cancel"));
  const first = recordingStream();
  const turn = h.participant.handle({ prompt: "one" }, first.stream, cancellation().token);
  await waitFor(() => first.text().includes("Waiting for cancellation"));

  const out = recordingStream();
  const cancelled = await h.participant.handle(
    { command: "cancel", prompt: "" },
    out.stream,
    cancellation().token,
  );
  const result = await turn;

  assert.equal(cancelled.metadata.stopReason, "cancelled");
  assert.match(out.text(), /Cancelling/);
  // The turn it cancelled reports the ACP outcome, on its own stream.
  assert.equal(result.metadata.stopReason, "cancelled");
  assert.doesNotMatch(first.text(), /already running/);
});

sessionTest("/cancel with nothing running says so instead of failing", async (t) => {
  const h = participantOn(t, mockRuntime());
  const out = recordingStream();

  const result = await h.participant.handle(
    { command: "cancel", prompt: "" },
    out.stream,
    cancellation().token,
  );

  assert.equal(result.metadata.stopReason, "end_turn");
  assert.match(out.text(), /nothing/i);
});

sessionTest("nothing starts an agent after the extension has been torn down", async (t) => {
  const h = participantOn(t, mockRuntime());
  await h.participant.stop();

  const out = recordingStream();
  const result = await h.participant.handle({ prompt: "hello" }, out.stream, cancellation().token);

  // Teardown is terminal. Ending a session to start another — `/runtime`, a new
  // session — is not, and keeps working; this is the other meaning.
  assert.equal(result.metadata.stopReason, "refused");
  assert.equal(h.agents.length, 0, "no agent process may be started after teardown");
});

sessionTest("teardown during the wait for a dead session leaves nothing behind", async (t) => {
  const h = participantOn(t, mockRuntime());
  await h.participant.handle({ prompt: "hello" }, recordingStream().stream, cancellation().token);
  // The agent dies on its own, which is routine; the session is now failed, so
  // the next turn ends it and opens another.
  h.agents[0].kill("SIGKILL");
  await h.agents[0].exited;

  const out = recordingStream();
  const turn = h.participant.handle({ prompt: "again" }, out.stream, cancellation().token);
  // The window is the wait for the dead session to be ended: the participant
  // looks quiet, and the replacement has not been registered yet.
  await Promise.resolve();
  await h.participant.stop();
  await turn.catch(() => undefined);

  assert.equal(h.agents.length, 1, "a replacement agent was started after teardown returned");
  assert.equal(h.participant.currentSessionId, undefined);
});

sessionTest("disposing while a session is still starting does not orphan its process", async (t) => {
  const h = participantOn(t, mockRuntime());
  h.holdOpen();
  const out = recordingStream();
  const turn = h.participant.handle({ prompt: "hello" }, out.stream, cancellation().token);
  await h.openStarted;

  // The window a window-close lands in: the process exists, but the field that
  // would carry the session it belongs to is not assigned yet.
  const teardown = h.participant.dispose();
  h.allowOpen();
  await teardown;
  await turn.catch(() => undefined);

  assert.equal(h.agents.length, 1);
  // Nothing else can reach it, so if teardown did not end it, nothing ever will.
  await h.agents[0].exited;
  assert.equal(h.participant.currentSessionId, undefined);
});

sessionTest("disposing the participant ends the agent process and drops its diffs", async (t) => {
  const h = participantOn(t, mockRuntime());
  const out = recordingStream();
  await h.participant.handle({ prompt: "hello" }, out.stream, cancellation().token);
  assert.ok(h.diffs.size > 0);

  await h.participant.dispose();

  assert.equal(h.diffs.size, 0);
  assert.equal(h.participant.currentSessionId, undefined);
});
