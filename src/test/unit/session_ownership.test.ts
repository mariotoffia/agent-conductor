import assert from "node:assert/strict";
import type { TurnResult } from "../../vscode/participant.js";
import { SessionsTree } from "../../vscode/sessionsTree.js";
import { conditions, held } from "../session-fixtures.js";
import {
  cancellation,
  mockRuntime,
  participantOn,
  recordingStream,
  sessionTest,
  waitFor,
} from "../participant-fixtures.js";

/**
 * Who owns an Agent process, and what reaches it.
 *
 * Every one of these drives the real participant against a real mock-Agent
 * process, because what is being checked is ownership: one process per Session
 * for its whole life, ended before another is opened, cancelled by the row that
 * names it, and never started for a Runtime nobody approved (ADR-0007,
 * ADR-0008).
 */

/** Whether a promise settled without waiting on a wall-clock guess for long. */
async function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let stop = (): void => undefined;
  const timer = new Promise<false>((resolve) => {
    const handle = setTimeout(() => resolve(false), ms);
    handle.unref?.();
    stop = () => {
      clearTimeout(handle);
      resolve(false);
    };
  });
  const settled = await Promise.race([promise.then(() => true, () => true), timer]);
  stop();
  return settled;
}

sessionTest("resuming a saved session reattaches to it rather than starting a new one", async (t) => {
  const harness = participantOn(t, mockRuntime());
  const first = recordingStream();
  await harness.participant.handle({ prompt: "hello" }, first.stream, cancellation().token);
  const original = harness.participant.currentSessionId;
  assert.ok(original);
  await harness.participant.dispose();

  await harness.participant.resume({
    sessionId: original,
    runtimeId: "mock",
    workspace: process.cwd(),
  });

  // Asserted on the wire, never on the id alone: the mock Agent numbers its
  // sessions from one per process, so a second `session/new` would answer with
  // the very same id and a test that compared them would prove nothing.
  const loads = harness.sent.filter((line) => line.method === "session/load");
  assert.deepEqual(loads.map((line) => (line.params as { sessionId?: string }).sessionId), [original]);
  assert.equal(harness.participant.currentSessionId, original);
  const again = recordingStream();
  const result = await harness.participant.handle({ prompt: "hello" }, again.stream, cancellation().token);
  assert.equal(result.metadata.stopReason, "end_turn");
});

sessionTest("an agent that cannot reattach refuses the resume and leaves no process behind", async (t) => {
  const harness = participantOn(t, mockRuntime("minimal-capabilities"));

  await assert.rejects(
    harness.participant.resume({
      sessionId: "mock-session-1",
      runtimeId: "mock",
      workspace: process.cwd(),
    }),
    /session\/load/,
  );

  assert.equal(harness.participant.currentSessionId, undefined);
  // The process it started to ask is reaped by the failure, not left running
  // for nobody to own (ADR-0008).
  for (const agent of harness.agents) await agent.exited;
});

sessionTest("a resume asked for during a turn is refused rather than allowed to replace it", async (t) => {
  const harness = participantOn(t, mockRuntime());
  harness.holdPermission();
  const out = recordingStream();
  const turn = harness.participant.handle({ prompt: "hello" }, out.stream, cancellation().token);
  await harness.permissionAsked;

  await assert.rejects(
    harness.participant.resume({
      sessionId: "mock-session-1",
      runtimeId: "mock",
      workspace: process.cwd(),
    }),
    /already running a turn/,
  );

  harness.allowPermission();
  assert.equal((await turn).metadata.stopReason, "end_turn");
});

sessionTest("cancelling one row cancels that session and nothing else", async (t) => {
  const harness = participantOn(t, mockRuntime("cancel"));
  const out = recordingStream();
  const turn = harness.participant.handle({ prompt: "hello" }, out.stream, cancellation().token);
  await waitFor(() => out.text().includes("Waiting for cancellation"));
  const live = harness.participant.currentSessionId;
  assert.ok(live);
  const cancels = (): number =>
    harness.sent.filter((line) => line.method === "session/cancel").length;

  // A row naming a Session this participant does not own must cancel nothing —
  // never reach for whichever Session happens to be live instead.
  await harness.participant.cancel("some-other-session");
  assert.equal(cancels(), 0);

  await harness.participant.cancel(live);
  assert.equal(cancels(), 1);
  assert.equal((await turn).metadata.stopReason, "cancelled");
});

sessionTest("resuming while a session is live ends that one before another is opened", async (t) => {
  const harness = participantOn(t, mockRuntime());
  const out = recordingStream();
  await harness.participant.handle({ prompt: "hello" }, out.stream, cancellation().token);
  const original = harness.participant.currentSessionId;
  assert.ok(original);

  await harness.participant.resume({
    sessionId: original,
    runtimeId: "mock",
    workspace: process.cwd(),
  });

  assert.equal(harness.agents.length, 2, "reattaching runs a second agent process");
  // The first one must be gone. A session left running with the field that
  // carried it already replaced is a process nothing can ever stop (ADR-0008).
  assert.ok(
    await settledWithin(harness.agents[0].exited, 5_000),
    "the session that was live is still running",
  );
});

sessionTest("a resume that fails changes neither the runtime nor what the next prompt does", async (t) => {
  const harness = participantOn(t, mockRuntime("minimal-capabilities"));
  const first = recordingStream();
  await harness.participant.handle({ prompt: "hello" }, first.stream, cancellation().token);
  const before = harness.sent.filter((line) => line.method === "session/new").length;

  await assert.rejects(
    harness.participant.resume({
      sessionId: "mock-session-1",
      runtimeId: "another-runtime",
      workspace: process.cwd(),
    }),
  );

  const out = recordingStream();
  const result = await harness.participant.handle({ prompt: "hello" }, out.stream, cancellation().token);

  assert.equal(result.metadata.stopReason, "end_turn");
  // A new conversation, on the Runtime the user was already on. A failed
  // reattach that kept either would silently move somebody to another CLI, or
  // make the next prompt ask to load a Session the Agent has refused once.
  assert.deepEqual(harness.opened, ["mock", "another-runtime", "mock"]);
  assert.equal(harness.sent.filter((line) => line.method === "session/new").length, before + 1);
  // Nothing went out on the wire for the reattach: an Agent that never
  // advertised `loadSession` is refused by this Client before it is asked.
  assert.equal(harness.sent.filter((line) => line.method === "session/load").length, 0);
});

sessionTest("a runtime nobody approved never has its credentials read", async (t) => {
  const spec = mockRuntime();
  let resolved = 0;
  const harness = participantOn(t, spec, {
    trusted: false,
    secretEnvironment: async () => {
      resolved += 1;
      return { MOCK_API_KEY: "s3cr3t" };
    },
  });
  const out = recordingStream();

  const result = await harness.participant.handle({ prompt: "hello" }, out.stream, cancellation().token);

  assert.equal(result.metadata.stopReason, "refused");
  // Reading a credential out of SecretStorage for a launch the gate is about to
  // refuse puts it in this process for no reason at all (ADR-0007).
  assert.equal(resolved, 0, "a secret was read for a launch that was refused");
});

sessionTest("a turn in flight is one the view is told about while it is in flight", async (t) => {
  const harness = participantOn(t, mockRuntime("cancel"));
  const out = recordingStream();
  const chat = cancellation();

  const turn = harness.participant.handle({ prompt: "hello" }, out.stream, chat.token);
  await waitFor(() => out.text().includes("Waiting for cancellation"));
  chat.cancel();
  await turn;

  // A view drawing itself from these events has to see the turn happening. Told
  // only when it starts and when it is over, a row says `idle` for the whole of
  // it — for minutes — and the state a Sessions tree exists to show is one it
  // can never draw.
  const states = harness.drawnStates().map((snapshot) => snapshot.join(","));
  assert.ok(states.includes("prompting"), `never drawn mid-turn: ${states.join(" | ")}`);
  assert.ok(states.includes("cancelling"), `never drawn cancelling: ${states.join(" | ")}`);
});

sessionTest("a view that fails is not allowed to fail the turn it was drawing", async (t) => {
  const harness = participantOn(t, mockRuntime(), {
    onChanged: () => {
      throw new Error("the view is gone");
    },
  });
  const out = recordingStream();

  const result = await harness.participant.handle({ prompt: "hello" }, out.stream, cancellation().token);

  assert.equal(result.metadata.stopReason, "end_turn");
});

sessionTest("cancelling every session cancels the one this window is running", async (t) => {
  // The window's own cancel-all names no session, and must not therefore mean
  // no session — it is the way out of a turn that will not stop.
  const harness = participantOn(t, mockRuntime("cancel"));
  const out = recordingStream();
  const turn = harness.participant.handle({ prompt: "hello" }, out.stream, cancellation().token);
  await waitFor(() => out.text().includes("Waiting for cancellation"));

  await harness.participant.cancel();

  assert.equal(harness.sent.filter((line) => line.method === "session/cancel").length, 1);
  assert.equal((await turn).metadata.stopReason, "cancelled");
});

sessionTest("a session whose name holds a credential can still be cancelled", async (t) => {
  // What a row draws is redacted; what it is addressed by cannot be, or the
  // button reaches a session id no session has and quietly does nothing.
  const harness = participantOn(t, mockRuntime("cancel"));
  const out = recordingStream();
  const turn = harness.participant.handle({ prompt: "hello" }, out.stream, cancellation().token);
  await waitFor(() => out.text().includes("Waiting for cancellation"));
  const live = harness.participant.currentSessionId;
  assert.ok(live);
  const tree = new SessionsTree({ storage: held([]), conditions, now: () => 0 });
  tree.track(
    {
      sessionId: live,
      runtimeId: "mock",
      state: "prompting",
      modelSelection: { verification: "unavailable" },
      effortSelection: { verification: "unavailable" },
      exited: new Promise(() => undefined),
    },
    { workspace: process.cwd(), secrets: [live] },
  );
  const [row] = await tree.getChildren();
  assert.doesNotMatch(String(tree.getTreeItem(row).tooltip), new RegExp(live));

  await harness.participant.cancel(row.id);

  assert.equal(harness.sent.filter((line) => line.method === "session/cancel").length, 1);
  assert.equal((await turn).metadata.stopReason, "cancelled");
});

sessionTest("a prompt sent while a saved session is being reopened is told what is happening", async (t) => {
  const harness = participantOn(t, mockRuntime());
  harness.holdOpen();
  const resuming = harness.participant.resume({
    sessionId: "mock-session-1",
    runtimeId: "mock",
    workspace: process.cwd(),
  });
  const out = recordingStream();
  const cancelled = recordingStream();
  let refused: TurnResult;
  try {
    await harness.openStarted;
    refused = await harness.participant.handle({ prompt: "hello" }, out.stream, cancellation().token);
    await harness.participant.handle({ prompt: "", command: "cancel" }, cancelled.stream, cancellation().token);
  } finally {
    // Released whatever happened: a held-open session left held is an agent
    // process this file never reaps, and the run hangs instead of reporting.
    harness.allowOpen();
    await resuming.catch(() => undefined);
  }

  // Not "already running a turn — cancel it with /cancel first", which is false
  // and sends somebody to a command that then says there is nothing to cancel.
  assert.equal(refused.metadata.stopReason, "refused");
  assert.match(out.text(), /reopen|resum/i);
  assert.match(cancelled.text(), /reopen|resum/i);
});

sessionTest("a view whose failure cannot even be logged still does not fail the turn", async (t) => {
  const harness = participantOn(t, mockRuntime(), {
    onChanged: () => {
      throw new Error("the view is gone");
    },
    log: () => {
      throw new Error("and the window is going too");
    },
  });
  const out = recordingStream();

  const result = await harness.participant.handle({ prompt: "hello" }, out.stream, cancellation().token);

  // The guard is only a guard if the thing it does when it catches cannot itself
  // throw — this one reaches settings, which reach the host.
  assert.equal(result.metadata.stopReason, "end_turn");
});

sessionTest("every moment what this window owns changes is a moment the view hears about", async (t) => {
  const harness = participantOn(t, mockRuntime());
  // What a view drawing itself from the event would have seen, in order. Read as
  // a sequence rather than a count, because one operation passes several of
  // these moments and a count cannot tell which of them went missing.
  const seen = (): string[] => harness.drawnStates().map((snapshot) => snapshot.join(","));

  harness.holdOpen();
  const turn = harness.participant.handle(
    { prompt: "hello" },
    recordingStream().stream,
    cancellation().token,
  );
  let started: string[];
  try {
    await harness.openStarted;
    started = seen();
  } finally {
    // Released whatever happened: a held-open session left held is an agent
    // process this file never reaps, and the run hangs instead of reporting.
    harness.allowOpen();
  }
  await turn;
  // A turn was submitted, and no agent existed yet.
  assert.deepEqual(started, [""]);
  // The session was adopted, the turn went out, the turn came back.
  assert.deepEqual(seen(), ["", "idle", "prompting", "idle"]);

  await harness.participant.dispose();
  assert.deepEqual(seen().slice(4), ["disposed"]);

  await harness.participant.resume({
    sessionId: "mock-session-1",
    runtimeId: "mock",
    workspace: process.cwd(),
  });
  // Ending the one that was live, adopting the reattached one, and finishing.
  assert.deepEqual(seen().slice(5), ["disposed", "disposed,idle", "disposed,idle"]);

  await harness.participant.cancel();
  assert.deepEqual(seen().slice(8), ["disposed,idle"]);
});

sessionTest("once a saved session is open, the window stops saying one is being reopened", async (t) => {
  const harness = participantOn(t, mockRuntime());
  await harness.participant.resume({
    sessionId: "mock-session-1",
    runtimeId: "mock",
    workspace: process.cwd(),
  });

  const out = recordingStream();
  await harness.participant.handle({ prompt: "", command: "cancel" }, out.stream, cancellation().token);

  // A flag left set turns every later message into one about something that
  // finished minutes ago.
  assert.doesNotMatch(out.text(), /reopen/i);
  assert.match(out.text(), /nothing running to cancel/i);
});

sessionTest("a runtime named by a repository is offered as text, not as markup", async (t) => {
  const spec = mockRuntime();
  const harness = participantOn(t, {
    ...spec,
    displayName: `**Agent Conductor**: [pick me](https://example.invalid) ${"x".repeat(300)}`,
  });
  harness.choose(undefined);
  const out = recordingStream();

  await harness.participant.handle({ prompt: "", command: "runtime" }, out.stream, cancellation().token);

  const [offered] = harness.offered;
  assert.ok(offered?.[0]);
  // `agentConductor.runtimes` is a scope a checked-out repository can write, and
  // this is a list the user picks from (ADR-0007).
  assert.doesNotMatch(offered[0].label, /\*\*/);
  assert.doesNotMatch(offered[0].label, /:\/\//);
  assert.ok(offered[0].label.length <= 80, `label was ${offered[0].label.length} characters`);
});

sessionTest("the reason shown against a runtime is offered as text, not as markup", async (t) => {
  const spec = mockRuntime();
  const harness = participantOn(t, spec, {
    runtimeChoice: {
      id: spec.id,
      label: spec.displayName,
      description: `**unavailable**: [see why](https://example.invalid) ${"x".repeat(4000)}`,
    },
  });
  harness.choose(undefined);
  const out = recordingStream();

  await harness.participant.handle({ prompt: "", command: "runtime" }, out.stream, cancellation().token);

  const [offered] = harness.offered;
  const description = String(offered?.[0]?.description);
  // The catalog composes this from settings a repository can write — the pin it
  // could not honour, the command it could not resolve (ADR-0007).
  assert.doesNotMatch(description, /\*\*/);
  assert.doesNotMatch(description, /:\/\//);
  assert.ok(description.length <= 2_000, `description was ${description.length} characters`);
});
