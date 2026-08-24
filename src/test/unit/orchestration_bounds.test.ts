import assert from "node:assert/strict";
import { test } from "node:test";
import { createOrchestrator, type SubagentResult } from "../../core/index.js";
import { call, fakeHost, grant, limits, PARENT_KEY, runtime } from "../orchestrator-fixtures.js";

const PARENT = { sessionId: "parent-acp", runtimeId: "claude", cwd: "/workspace" };

/** An Orchestrator whose parent is live, which is what every call needs. */
function attached(host = fakeHost()) {
  const orchestrator = createOrchestrator(host.ports);
  orchestrator.attach(PARENT_KEY, PARENT);
  return { host, orchestrator };
}

const brief = { brief: "Rename the thing" };

test("a call for a parent this window is not running is refused", async () => {
  const orchestrator = createOrchestrator(fakeHost().ports);

  await assert.rejects(
    () => orchestrator.handle(call("spawn_subagent", brief)),
    /parent session/i,
    "authority outlives nothing: a capability without a live parent authorises nothing",
  );
});

test("a Session at the spawn depth cap is refused even if it somehow asks", async () => {
  const { orchestrator } = attached();

  await assert.rejects(
    () =>
      orchestrator.handle(
        call("spawn_subagent", brief, grant({ depth: 1 })),
      ),
    /depth/i,
  );
});

test("the aggregate spawn count bounds one parent over its whole life", async (t) => {
  const { host, orchestrator } = attached(
    fakeHost({ limits: () => limits({ maxSubagentsPerSession: 2, maxConcurrentSubagents: 2 }) }),
  );
  t.after(() => orchestrator.dispose());

  const first = orchestrator.handle(call("spawn_subagent", { ...brief, mode: "background" }));
  const second = orchestrator.handle(call("spawn_subagent", { ...brief, mode: "background" }));
  await Promise.all([first, second]);
  await host.opened(2);
  for (const child of host.children) child.finish();
  // Both have finished, so nothing is in flight — only the aggregate is left.
  await orchestrator.handle(call("subagent_result", { handle: "child-1" }));
  await orchestrator.handle(call("subagent_result", { handle: "child-2" }));

  await assert.rejects(
    () => orchestrator.handle(call("spawn_subagent", brief)),
    /spawn/i,
    "a loop that keeps spawning must stop, not merely queue",
  );
  assert.equal(host.children.length, 2);
});

test("two spawns that arrive together cannot both slip past the aggregate count", async (t) => {
  const { host, orchestrator } = attached(
    fakeHost({ limits: () => limits({ maxSubagentsPerSession: 1, maxConcurrentSubagents: 4 }) }),
  );
  t.after(() => orchestrator.dispose());

  const both = await Promise.allSettled([
    orchestrator.handle(call("spawn_subagent", { ...brief, mode: "background" })),
    orchestrator.handle(call("spawn_subagent", { ...brief, mode: "background" })),
  ]);

  assert.deepEqual(both.map((outcome) => outcome.status), ["fulfilled", "rejected"]);
  assert.equal(host.children.length, 1, "a limit read before an await and written after is not a limit");
});

test("concurrency is bounded, and the ones over the limit wait rather than fail", async (t) => {
  const { host, orchestrator } = attached(
    fakeHost({ limits: () => limits({ maxConcurrentSubagents: 1, maxSubagentsPerSession: 3 }) }),
  );
  t.after(() => orchestrator.dispose());

  const spawns = [
    orchestrator.handle(call("spawn_subagent", brief)),
    orchestrator.handle(call("spawn_subagent", brief)),
  ];
  await host.opened(1);
  assert.equal(host.children.length, 1, "the second child is not even started until a slot frees");

  host.children[0]?.finish();
  await host.opened(2);
  host.children[1]?.finish();
  await Promise.all(spawns);

  assert.equal(host.peakConcurrent(), 1);
});

test("a turn that outlives its timeout is cancelled and reported as such", async (t) => {
  const timers: Array<{ ms: number; run: () => void }> = [];
  const { host, orchestrator } = attached(
    fakeHost({
      limits: () => limits({ defaultTimeoutMs: 5_000 }),
      clock: {
        after(ms, run) {
          const timer = { ms, run };
          timers.push(timer);
          return () => timers.splice(timers.indexOf(timer), 1);
        },
      },
    }),
  );
  t.after(() => orchestrator.dispose());

  const spawn = orchestrator.handle(call("spawn_subagent", brief));
  await host.opened(1);
  assert.equal(timers[0]?.ms, 5_000);
  timers[0]?.run();
  const result = (await spawn) as SubagentResult;

  assert.equal(result.state, "timed_out");
  assert.equal(host.children[0]?.cancelled, true);
  assert.equal(host.children[0]?.disposed, true, "a timed-out child's process must not survive it");
});

test("an agent may ask for less time than the limit but never for more", async (t) => {
  const asked: number[] = [];
  const { host, orchestrator } = attached(
    fakeHost({
      limits: () => limits({ defaultTimeoutMs: 5_000, maxTimeoutMs: 10_000 }),
      clock: {
        after(ms) {
          asked.push(ms);
          return () => undefined;
        },
      },
    }),
  );
  t.after(() => orchestrator.dispose());

  void orchestrator.handle(call("spawn_subagent", { ...brief, mode: "background", timeout_ms: 1_000 }));
  await host.opened(1);
  void orchestrator.handle(
    call("spawn_subagent", { ...brief, mode: "background", timeout_ms: 9_000_000 }),
  );
  await host.opened(2);

  assert.deepEqual(asked, [1_000, 10_000]);
});

test("a monetary limit is forwarded only to a Runtime that enforces one", async (t) => {
  const { host, orchestrator } = attached(
    fakeHost({
      limits: () => limits({ budgetUsdPerSubagent: 2 }),
      runtimes: async () => [
        runtime({ id: "claude", budget: false }),
        runtime({ id: "codex", budget: true, fanOut: true }),
      ],
    }),
  );
  t.after(() => orchestrator.dispose());

  void orchestrator.handle(call("spawn_subagent", { ...brief, mode: "background" }));
  await host.opened(1);
  void orchestrator.handle(
    call("spawn_subagent", { ...brief, runtime: "codex", mode: "background" }),
  );
  await host.opened(2);

  assert.equal(host.children[0]?.launch.budgetUsd, undefined, "a runtime that cannot enforce it is not told");
  assert.equal(host.children[1]?.launch.budgetUsd, 2);
});

test("an agent cannot ask for a larger budget than the user allowed", async (t) => {
  const { host, orchestrator } = attached(
    fakeHost({
      limits: () => limits({ budgetUsdPerSubagent: 2 }),
      runtimes: async () => [runtime({ id: "claude", budget: true })],
    }),
  );
  t.after(() => orchestrator.dispose());

  void orchestrator.handle(
    call("spawn_subagent", { ...brief, mode: "background", budget_usd: 500 }),
  );
  await host.opened(1);

  assert.equal(host.children[0]?.launch.budgetUsd, 2);
});

test("what a brief leaves out comes from the user's own defaults", async (t) => {
  const { host, orchestrator } = attached(
    fakeHost({
      limits: () =>
        limits({ defaultRuntimeId: "codex", defaultModel: "gpt-5", defaultEffort: "high" }),
      runtimes: async () => [runtime({ id: "codex", fanOut: true })],
    }),
  );
  t.after(() => orchestrator.dispose());

  void orchestrator.handle(call("spawn_subagent", { ...brief, mode: "background" }));
  await host.opened(1);

  const launch = host.children[0]?.launch;
  assert.equal(launch?.runtimeId, "codex");
  assert.equal(launch?.requestedModel, "gpt-5");
  assert.equal(launch?.requestedEffort, "high");
  assert.equal(launch?.depth, 1, "a child of a root sits one level down");
  assert.equal(launch?.parentSessionId, "parent-acp", "lineage is recorded by the Agent's own id");
});

test("a Runtime the user has not configured cannot be spawned onto", async (t) => {
  const { orchestrator } = attached();
  t.after(() => orchestrator.dispose());

  await assert.rejects(
    () => orchestrator.handle(call("spawn_subagent", { ...brief, runtime: "constructor" })),
    /runtime/i,
  );
});

test("a Runtime that cannot launch is refused with the reason it cannot", async (t) => {
  const { orchestrator } = attached(
    fakeHost({
      runtimes: async () => [runtime({ id: "claude", available: false, unavailable: "not installed" })],
    }),
  );
  t.after(() => orchestrator.dispose());

  await assert.rejects(
    () => orchestrator.handle(call("spawn_subagent", brief)),
    /not installed/,
  );
});

test("handing work to another provider needs the consent that names that Runtime", async (t) => {
  const { orchestrator } = attached(
    fakeHost({
      runtimes: async () => [runtime({ id: "claude" }), runtime({ id: "gemini", fanOut: false })],
    }),
  );
  t.after(() => orchestrator.dispose());

  await assert.rejects(
    () => orchestrator.handle(call("spawn_subagent", { ...brief, runtime: "gemini" })),
    /consent|agreed|approve/i,
    "delegating across providers moves repository data that a direct session never would",
  );
});

test("a Brief may only name files inside the roots the capability was granted", async (t) => {
  const { host, orchestrator } = attached();
  t.after(() => orchestrator.dispose());

  await assert.rejects(
    () =>
      orchestrator.handle(
        call("spawn_subagent", { ...brief, files: ["/workspace/a.ts", "/etc/shadow"] }),
      ),
    /root/i,
  );
  assert.equal(host.children.length, 0, "nothing is started for a brief that was refused");
});

test("list_runtimes says which Runtimes may actually be spawned onto, and why not", async () => {
  const { orchestrator } = attached(
    fakeHost({
      runtimes: async () => [
        runtime({ id: "claude" }),
        runtime({ id: "gemini", fanOut: false }),
        runtime({ id: "codex", fanOut: true }),
      ],
    }),
  );

  const listed = (await orchestrator.handle(call("list_runtimes", {}))) as {
    runtimes: Array<{ id: string; spawnable: boolean; reason?: string }>;
  };

  assert.deepEqual(
    listed.runtimes.map((entry) => [entry.id, entry.spawnable]),
    [["claude", true], ["gemini", false], ["codex", true]],
  );
  assert.match(listed.runtimes[1]?.reason ?? "", /consent|agreed|approve/i);
});
