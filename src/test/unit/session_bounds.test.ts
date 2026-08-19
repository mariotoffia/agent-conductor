import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type * as acp from "@agentclientprotocol/sdk";
import { nodeProcessPort, type AgentProcess, type ProcessPort } from "../../core/index.js";
import { harness, launchMockAgent, turnGate } from "../acp-harness.js";

const testTimeoutMs = 10_000;

function sessionTest(name: string, fn: (t: TestContext) => Promise<void>) {
  test(name, { timeout: testTimeoutMs }, fn);
}

/** Process port that holds the `session/cancel` line back until `release` resolves. */
function holdCancelPort(release: Promise<void>): ProcessPort {
  return {
    spawn(request) {
      const child = nodeProcessPort.spawn(request);
      const writer = child.stdin.getWriter();
      const decoder = new TextDecoder();
      const stdin = new WritableStream<Uint8Array>({
        async write(chunk) {
          if (decoder.decode(chunk, { stream: true }).includes('"session/cancel"')) await release;
          await writer.write(chunk);
        },
        close: () => writer.close(),
        abort: (reason) => writer.abort(reason),
      });
      return { ...child, stdin } satisfies AgentProcess;
    },
  };
}

sessionTest("a compliant cancel ends the turn, keeps the process, and disarms the grace timer", async (t) => {
  const h = harness(t);
  const gate = turnGate(h.updates);
  const session = await h.open({ launch: launchMockAgent("cancel"), onUpdate: gate.onUpdate });

  const turn = session.prompt("wait for cancellation");
  await gate.started;
  await session.cancel();
  const response = await turn;

  assert.equal(response.stopReason, "cancelled");
  assert.equal(h.methodsSent().includes("session/cancel"), true);
  assert.equal(session.state, "idle", "a cancelled turn does not end the Session");
  assert.deepEqual(h.clock.pending(), [], "the grace timer must be disarmed");
  assert.equal(
    await Promise.race([session.exited, Promise.resolve("alive")]),
    "alive",
    "the Agent process must survive a cancelled turn",
  );
});

sessionTest("cancel escalates to terminating the Session's own process after the grace period", async (t) => {
  const h = harness(t);
  const gate = turnGate(h.updates);
  const session = await h.open({
    launch: launchMockAgent("timeout"),
    cancelGraceMs: 250,
    onUpdate: gate.onUpdate,
  });

  const turn = session.prompt("never finish");
  await gate.started;
  await session.cancel();
  assert.deepEqual(h.clock.pending().map((timer) => timer.ms), [250]);
  h.clock.fire();
  const response = await turn;

  assert.equal(response.stopReason, "cancelled");
  assert.equal((await session.exited).signal, "SIGTERM");
  assert.equal(session.state, "disposed");
  assert.ok(
    h.logs.some((line) => line.includes("agent ignored cancel for 250ms")),
    h.logs.join("\n"),
  );
});

sessionTest("a cancel that loses the race to a finished turn arms no grace timer", async (t) => {
  let releaseCancel: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    releaseCancel = resolve;
  });
  const h = harness(t, { process: holdCancelPort(held) });
  const gate = turnGate(h.updates);
  const session = await h.open({
    launch: launchMockAgent("config-refresh"),
    cancelGraceMs: 250,
    onUpdate: gate.onUpdate,
  });

  const turn = session.prompt("finish while cancelling");
  await gate.started;
  const cancelling = session.cancel();
  const response = await turn; // the Agent finished before our cancel went out
  releaseCancel?.();
  await cancelling;

  assert.equal(response.stopReason, "end_turn");
  assert.equal(session.state, "idle");
  assert.deepEqual(h.clock.pending(), [], "no grace timer may outlive its turn");
});

sessionTest("a Runtime that ignores SIGTERM is escalated instead of hanging teardown", async (t) => {
  const h = harness(t);
  const session = await h.open({ launch: launchMockAgent(undefined, ["--ignore-sigterm"]) });

  const disposal = session.dispose();
  assert.equal(h.clock.pending().length, 1, "teardown must arm an escalation");
  h.clock.fire();
  await disposal;

  assert.equal((await session.exited).signal, "SIGKILL");
});

sessionTest("a Turn with no Agent activity is ended by the stall limit", async (t) => {
  const h = harness(t);
  const gate = turnGate(h.updates);
  const session = await h.open({
    launch: launchMockAgent("timeout"),
    stallTimeoutMs: 1_000,
    cancelGraceMs: 250,
    onUpdate: gate.onUpdate,
  });

  const turn = session.prompt("go quiet");
  const stalled = assert.rejects(turn, /agent produced no output for 1000ms/);
  await gate.started;
  assert.deepEqual(h.clock.pending().map((timer) => timer.ms), [1_000], "the stall limit is armed");
  h.clock.fire(); // the silence expires, so the turn is cancelled
  await h.clock.armedMs(250);
  h.clock.fire(); // the Agent ignores that too, so its process goes
  await stalled;

  assert.equal(session.state, "disposed");
  assert.ok(
    h.logs.some((line) => line.includes("no agent activity for 1000ms")),
    h.logs.join("\n"),
  );
});

sessionTest("the stall limit pauses while the Client owes the Agent an answer", async (t) => {
  let asked: (() => void) | undefined;
  const asking = new Promise<void>((resolve) => {
    asked = resolve;
  });
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = harness(t, {
    permission: {
      requestPermission: (): Promise<acp.RequestPermissionResponse> => {
        asked?.();
        return held.then(() => ({ outcome: { outcome: "selected", optionId: "allow" } }));
      },
    },
  });
  const session = await h.open({ stallTimeoutMs: 777 });

  const turn = session.prompt("ask before finishing");
  assert.deepEqual(
    h.clock.pending().map((timer) => timer.ms),
    [777],
    "the limit runs while the Agent owes us output",
  );
  await asking;
  assert.equal(
    h.clock.pending().some((timer) => timer.ms === 777),
    false,
    "the Agent is waiting on the Client, so it is not stalling",
  );
  release?.();
  const response = await turn;

  assert.equal(response.stopReason, "end_turn");
});

sessionTest("a late answer from an earlier Turn cannot unpause the stall limit", async (t) => {
  const gates: (() => void)[] = [];
  let onAsk: (() => void) | undefined;
  const h = harness(t, {
    permission: {
      requestPermission: (): Promise<acp.RequestPermissionResponse> =>
        new Promise((resolve) => {
          gates.push(() => resolve({ outcome: { outcome: "selected", optionId: "allow" } }));
          onAsk?.();
        }),
    },
  });
  const askedAtLeast = (count: number) =>
    gates.length >= count
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
        onAsk = () => {
          if (gates.length >= count) resolve();
        };
      });
  const settled = () => new Promise((resolve) => setImmediate(resolve));
  const armed = () => h.clock.pending().some((timer) => timer.ms === 5_000);
  const session = await h.open({ launch: launchMockAgent("stray-permission"), stallTimeoutMs: 5_000 });

  // The first Turn ends while the answer it asked for is still outstanding.
  assert.equal((await session.prompt("ask and move on")).stopReason, "end_turn");
  await askedAtLeast(1);
  const second = session.prompt("ask and wait");
  await askedAtLeast(2);
  assert.equal(armed(), false, "we owe this Turn an answer");

  gates[0](); // the stale answer from the first Turn lands now
  await settled();

  assert.equal(armed(), false, "a stale answer must not unpause a Turn still owed one");
  gates[1]();
  assert.equal((await second).stopReason, "end_turn");
});

sessionTest("an unanswered request from an earlier Turn cannot silence a later one", async (t) => {
  const h = harness(t, {
    permission: { requestPermission: () => new Promise<never>(() => undefined) },
  });
  const gate = turnGate(h.updates);
  const session = await h.open({
    launch: launchMockAgent("stray-then-silent"),
    stallTimeoutMs: 1_000,
    cancelGraceMs: 250,
    onUpdate: gate.onUpdate,
  });

  // The first Turn asks for an answer it never waits for, and never gets one.
  assert.equal((await session.prompt("ask and move on")).stopReason, "end_turn");

  const second = session.prompt("go quiet");
  const stalled = assert.rejects(second, /agent produced no output for 1000ms/);
  await gate.started;
  await h.clock.armedMs(1_000); // the abandoned request must not disable the limit
  h.clock.fire();
  await h.clock.armedMs(250);
  h.clock.fire();
  await stalled;

  assert.equal(session.state, "disposed");
});
