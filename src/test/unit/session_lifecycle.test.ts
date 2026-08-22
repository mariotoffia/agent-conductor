import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { nodeProcessPort, type AgentProcess } from "../../core/index.js";
import { harness, launchMockAgent, turnGate } from "../acp-harness.js";

const testTimeoutMs = 10_000;

function sessionTest(name: string, fn: (t: TestContext) => Promise<void>) {
  test(name, { timeout: testTimeoutMs }, fn);
}

sessionTest("a turn dispatches every Update to the sink and returns the Agent's stop reason", async (t) => {
  const h = harness(t);
  const session = await h.open();

  const response = await session.prompt("script the turn");

  assert.equal(response.stopReason, "end_turn");
  assert.equal(session.state, "idle");
  assert.deepEqual(h.updates.map((notification) => notification.update.sessionUpdate), [
    "agent_message_chunk",
    "agent_thought_chunk",
    "tool_call",
    "tool_call_update",
    "plan",
    "usage_update",
  ]);
  assert.ok(h.updates.every((notification) => notification.sessionId === session.sessionId));
});

sessionTest("permission requests reach the permission port and the chosen outcome reaches the Agent", async (t) => {
  const h = harness(t);
  const session = await h.open();

  await session.prompt("edit the mock file");

  assert.equal(h.permissions.length, 1);
  assert.equal(h.permissions[0].sessionId, session.sessionId);
  assert.equal(h.permissions[0].toolCall.toolCallId, "mock-tool");
  assert.deepEqual(
    h.permissions[0].options.map((option) => option.optionId),
    ["allow", "reject"],
  );
  // The Agent acts on the outcome we returned, so the tool call completes.
  const update = h.updates.find((notification) => notification.update.sessionUpdate === "tool_call_update");
  assert.equal(update?.update.sessionUpdate === "tool_call_update" && update.update.status, "completed");
});

sessionTest("a Session with no permission port answers cancelled instead of consenting", async (t) => {
  const h = harness(t, { permission: undefined });
  const session = await h.open();

  const response = await session.prompt("edit the mock file");

  assert.equal(response.stopReason, "end_turn");
  assert.equal(h.permissions.length, 0);
  const update = h.updates.find((notification) => notification.update.sessionUpdate === "tool_call_update");
  assert.equal(update?.update.sessionUpdate === "tool_call_update" && update.update.status, "failed");
});

sessionTest("an unsolicited config_option_update replaces the Session's Config Options", async (t) => {
  const h = harness(t);
  const session = await h.open({ launch: launchMockAgent("config-refresh") });
  assert.deepEqual(
    session.configOptions.map((option) => option.currentValue),
    ["mock-model", "medium"],
  );

  await session.prompt("refresh the options");

  assert.deepEqual(
    session.configOptions.map((option) => option.currentValue),
    ["mock-model-fast", "low"],
  );
  assert.equal(h.updates.at(-1)?.update.sessionUpdate, "config_option_update");
});

sessionTest("terminating one Session leaves another Session's process and turns untouched", async (t) => {
  const hung = harness(t);
  const gate = turnGate(hung.updates);
  const healthy = harness(t);
  const hungSession = await hung.open({ launch: launchMockAgent("timeout"), onUpdate: gate.onUpdate });
  const healthySession = await healthy.open();
  assert.notEqual(hungSession.pid, healthySession.pid, "each Session owns its own process");

  const hungTurn = hungSession.prompt("never finish");
  await gate.started;
  await hungSession.cancel();
  hung.clock.fire();
  await hungTurn;

  assert.equal((await hungSession.exited).signal, "SIGTERM");
  const response = await healthySession.prompt("still working");
  assert.equal(response.stopReason, "end_turn");
  assert.equal(healthySession.state, "idle");
  assert.equal(
    await Promise.race([healthySession.exited, Promise.resolve("alive")]),
    "alive",
  );
});

sessionTest("losing the Agent process fails the turn and the Session", async (t) => {
  const h = harness(t);
  const gate = turnGate(h.updates);
  const session = await h.open({ launch: launchMockAgent("timeout"), onUpdate: gate.onUpdate });
  const turn = session.prompt("never finish");
  await gate.started;

  const pid = session.pid;
  assert.ok(pid);
  process.kill(pid, "SIGKILL");

  await assert.rejects(turn, /session mock-session-1: turn failed|agent process/);
  assert.equal((await session.exited).signal, "SIGKILL");
  assert.equal(session.state, "failed");
  await assert.rejects(session.prompt("try again"), /is failed; it cannot start a turn/);
});

sessionTest("dispose is idempotent and a disposed Session refuses new turns", async (t) => {
  const h = harness(t);
  const session = await h.open();

  assert.equal(session.dispose(), session.dispose(), "dispose must not start a second teardown");
  await Promise.all([session.dispose(), session.dispose()]);
  await session.dispose();

  assert.equal(session.state, "disposed");
  assert.equal((await session.exited).signal, "SIGTERM");
  await assert.rejects(session.prompt("too late"), /is disposed; it cannot start a turn/);
});

sessionTest("an Agent that refuses a turn keeps the Session usable", async (t) => {
  const h = harness(t);
  const session = await h.open({ launch: launchMockAgent("prompt-error") });

  await assert.rejects(session.prompt("refuse this"), /session mock-session-1: turn failed/);

  assert.equal(session.state, "idle", "one refused turn must not end the Session");
  assert.equal(
    await Promise.race([session.exited, Promise.resolve("alive")]),
    "alive",
  );
  // The Session still accepts work: it fails on the Agent, not on our own state.
  await assert.rejects(session.prompt("refuse again"), /session mock-session-1: turn failed/);
});

sessionTest("disposing during a turn leaves the Session disposed, not failed", async (t) => {
  const h = harness(t);
  const gate = turnGate(h.updates);
  const session = await h.open({ launch: launchMockAgent("timeout"), onUpdate: gate.onUpdate });

  const turn = session.prompt("never finish");
  const rejected = assert.rejects(turn, /turn failed|agent process/);
  await gate.started;
  await session.dispose();

  await rejected;
  assert.equal(session.state, "disposed", "a deliberate teardown is not a failure");
});

sessionTest("an Agent that crashes during a cancel reports the crash, not a clean cancel", async (t) => {
  const h = harness(t);
  const gate = turnGate(h.updates);
  const session = await h.open({ launch: launchMockAgent("timeout"), onUpdate: gate.onUpdate });

  const turn = session.prompt("never finish");
  await gate.started;
  await session.cancel(); // grace timer armed but never fired: we did not kill it
  const pid = session.pid;
  assert.ok(pid);
  process.kill(pid, "SIGKILL");

  await assert.rejects(turn, /turn failed|agent process/);
  assert.equal((await session.exited).signal, "SIGKILL");
  assert.equal(session.state, "failed", "a crash during cancellation is still a crash");
});

sessionTest("a permission request during a cancelled turn is answered cancelled", async (t) => {
  const h = harness(t);
  const gate = turnGate(h.updates);
  const session = await h.open({
    launch: launchMockAgent("permission-after-cancel"),
    onUpdate: gate.onUpdate,
  });

  const turn = session.prompt("ask after cancelling");
  await gate.started;
  await session.cancel();
  const response = await turn;

  assert.equal(response.stopReason, "cancelled");
  assert.equal(h.permissions.length, 0, "a cancelled turn must not prompt the user");
  const update = h.updates.find((notification) => notification.update.sessionUpdate === "tool_call_update");
  assert.equal(update?.update.sessionUpdate === "tool_call_update" && update.update.status, "failed");
});

sessionTest("Config Options from another session id never overwrite this Session's", async (t) => {
  const h = harness(t);
  const session = await h.open({ launch: launchMockAgent("foreign-config-update") });
  const own = session.configOptions;

  await session.prompt("send a foreign refresh");

  assert.deepEqual(session.configOptions, own, "a foreign id must not change our selection");
  assert.equal(h.updates.at(-1)?.update.sessionUpdate, "config_option_update", "still rendered");
});

sessionTest("a failed turn carries the Agent's own diagnostics", async (t) => {
  let sawDiagnostic: (() => void) | undefined;
  const diagnosed = new Promise<void>((resolve) => {
    sawDiagnostic = resolve;
  });
  const h = harness(t, {
    log: {
      log: (_level, text) => {
        if (text.includes("agent diagnostic")) sawDiagnostic?.();
      },
    },
  });
  const gate = turnGate(h.updates);
  const session = await h.open({
    launch: launchMockAgent("timeout", ["--stderr-in-turn"]),
    onUpdate: gate.onUpdate,
  });

  const turn = session.prompt("fail loudly");
  const failed = assert.rejects(turn, /recent agent output:[\s\S]*agent diagnostic: heap exhausted/);
  await gate.started;
  await diagnosed; // the captured tail now holds the Agent's own message
  const pid = session.pid;
  assert.ok(pid);
  process.kill(pid, "SIGKILL");

  await failed;
});

test("an agent that answers session/new without a session id gets no session", async (t) => {
  const h = harness(t);

  // Responses to the requests a client sends are not schema-checked by the SDK,
  // so the field the whole session identity rests on has to be checked here.
  await assert.rejects(h.open({ launch: launchMockAgent("no-session-id") }), /session id/i);
});

test("a disposal that fails is neither unhandled nor permanent", async (t) => {
  const failures: string[] = [];
  const started: AgentProcess[] = [];
  const h = harness(t, {
    process: {
      spawn(request) {
        const child = nodeProcessPort.spawn(request);
        started.push(child);
        return {
          ...child,
          kill: () => {
            failures.push("kill");
            throw new Error("signal refused");
          },
        };
      },
    },
  });
  // Nothing else will: the port under test is the thing refusing to signal.
  t.after(() => {
    for (const child of started) child.kill("SIGKILL");
  });
  const session = await h.open();

  // A rejected disposal is memoized, so a later teardown — the extension's own —
  // would reject too, on a promise nobody is waiting on.
  await session.dispose();
  await session.dispose();

  assert.ok(failures.length > 0, "the disposal never tried to stop the process");
  assert.equal(session.state, "disposed");
});

/**
 * A Session owns the commands its Agent started, not just the Agent (ADR-0008).
 *
 * The terminal port spawns those in their own process group precisely so that
 * ending a Session ends them too; without disposal here they outlive the Agent,
 * the Session, and the extension host that spawned them.
 */

sessionTest("disposing a session ends the commands its agent started", async (t) => {
  let disposed = 0;
  const h = harness(t, {
    terminal: {
      createTerminal: async () => ({ terminalId: "t1" }),
      terminalOutput: async () => ({ output: "", truncated: false }),
      waitForTerminalExit: async () => ({}),
      killTerminal: async () => undefined,
      releaseTerminal: async () => undefined,
      dispose: () => {
        disposed += 1;
      },
    },
  });
  const session = await h.open();

  await session.dispose();

  assert.equal(disposed, 1, "the terminal port was never told the session ended");
});

sessionTest("teardown terminates the agent without waiting on the terminal port", async (t) => {
  const h = harness(t, {
    terminal: {
      createTerminal: async () => ({ terminalId: "t1" }),
      terminalOutput: async () => ({ output: "", truncated: false }),
      waitForTerminalExit: async () => ({}),
      killTerminal: async () => undefined,
      releaseTerminal: async () => undefined,
      // A host service that never finishes. Ending the Agent must not queue
      // behind it: the escalation to SIGKILL is armed by closing the connection.
      dispose: () => new Promise<void>(() => undefined),
    },
  });
  const session = await h.open({ launch: launchMockAgent(undefined, ["--ignore-sigterm"]) });

  void session.dispose();

  await h.clock.armed(1);
  assert.equal(h.clock.pending().length, 1, "teardown must arm an escalation regardless");
  h.clock.fire();
  assert.equal((await session.exited).signal, "SIGKILL");
});

sessionTest("a terminal port that throws on disposal does not fail the teardown", async (t) => {
  const h = harness(t, {
    terminal: {
      createTerminal: async () => ({ terminalId: "t1" }),
      terminalOutput: async () => ({ output: "", truncated: false }),
      waitForTerminalExit: async () => ({}),
      killTerminal: async () => undefined,
      releaseTerminal: async () => undefined,
      dispose: () => {
        throw new Error("could not signal the process group");
      },
    },
  });
  const session = await h.open();

  // Disposal is memoized and awaited by the extension's own teardown; a
  // rejection here would be remembered and re-thrown at every later teardown.
  await session.dispose();

  assert.ok(h.logs.some((line) => /could not signal/.test(line)), h.logs.join("\n"));
});

sessionTest("a prompt response that is not one fails the turn, not the reader", async (t) => {
  const h = harness(t);
  const session = await h.open({ launch: launchMockAgent("bad-prompt-response") });

  // The SDK schema-checks notifications, not the answers to requests we send,
  // and the Agent is not trusted (ADR-0007). A turn that cannot be read has
  // failed; nothing downstream should meet a stop reason that is not a string.
  await assert.rejects(session.prompt("go"), /stop reason/i);
  assert.notEqual(session.state, "prompting");
});

sessionTest("an agent that dies takes the commands it started with it", async (t) => {
  let disposed = 0;
  const h = harness(t, {
    terminal: {
      createTerminal: async () => ({ terminalId: "t1" }),
      terminalOutput: async () => ({ output: "", truncated: false }),
      waitForTerminalExit: async () => ({}),
      killTerminal: async () => undefined,
      releaseTerminal: async () => undefined,
      dispose: () => {
        disposed += 1;
      },
    },
  });
  const session = await h.open();

  // Nothing may reach this Session again — the user can close the window — so
  // what it started cannot wait for a next turn to be cleaned up (ADR-0008).
  h.children[0]?.kill("SIGKILL");
  await session.exited;
  // The exit handler runs on the process's own event, so wait for the effect
  // rather than assuming it has already happened.
  const deadline = Date.now() + 5_000;
  while (disposed === 0 && Date.now() < deadline) {
    await new Promise((wake) => setTimeout(wake, 10));
  }

  assert.ok(disposed > 0, "a crashed agent left its commands running");
});

sessionTest("an agent that dies while it is being configured fails the session start", async (t) => {
  const h = harness(t);

  // A refused option leaves a usable Session and a death does not, and the
  // callback that reports both cannot tell them apart. Resolving here would hand
  // back a Session whose process is gone, and whose first Turn says only that it
  // is failed — rather than what the exit status and the stderr say (ADR-0008).
  await assert.rejects(
    h.open({ launch: launchMockAgent("die-in-set"), requestedEffort: "low" }),
    /session setup failed|agent process exited with code 3/,
  );
});
