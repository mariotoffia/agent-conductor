import assert from "node:assert/strict";
import { test } from "node:test";
import { createOrchestrator, type SubagentResult } from "../../core/index.js";
import { call, fakeHost, grant, limits, PARENT_KEY, runtime } from "../orchestrator-fixtures.js";

const PARENT = { sessionId: "parent-acp", runtimeId: "claude", cwd: "/workspace" };
const brief = { brief: "Rename the thing" };

function attached(host = fakeHost()) {
  const orchestrator = createOrchestrator(host.ports);
  orchestrator.attach(PARENT_KEY, PARENT);
  return { host, orchestrator };
}

test("a background spawn answers with a handle at once and the result later", async (t) => {
  const { host, orchestrator } = attached();
  t.after(() => orchestrator.dispose());

  const started = (await orchestrator.handle(
    call("spawn_subagent", { ...brief, mode: "background" }),
  )) as { handle: string; state: string };
  assert.equal(started.state, "running");
  await host.opened(1);

  const polled = (await orchestrator.handle(call("check_subagent", { handle: started.handle }))) as {
    state: string;
  };
  assert.equal(polled.state, "running");

  host.children[0]?.say({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done." } });
  host.children[0]?.finish();
  const result = (await orchestrator.handle(
    call("subagent_result", { handle: started.handle }),
  )) as SubagentResult;

  assert.equal(result.state, "done");
  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.text, "done.");
});

test("a Shim may only ask about the children of its own Session", async (t) => {
  const { host, orchestrator } = attached();
  t.after(() => orchestrator.dispose());
  orchestrator.attach("other-key", { sessionId: "other-acp", runtimeId: "claude", cwd: "/workspace" });

  const mine = (await orchestrator.handle(
    call("spawn_subagent", { ...brief, mode: "background" }),
  )) as { handle: string };
  await host.opened(1);

  const stranger = grant({ sessionId: "other-key" });
  for (const method of ["check_subagent", "subagent_result", "cancel_subagent"] as const) {
    await assert.rejects(
      () => orchestrator.handle(call(method, { handle: mine.handle }, stranger)),
      /no such subagent/i,
      `${method} must not reach another Session's child`,
    );
  }
  assert.equal(host.children[0]?.cancelled, false);
});

test("cancelling a Subagent ends its turn and its process", async (t) => {
  const { host, orchestrator } = attached();
  t.after(() => orchestrator.dispose());

  const started = (await orchestrator.handle(
    call("spawn_subagent", { ...brief, mode: "background" }),
  )) as { handle: string };
  await host.opened(1);
  await orchestrator.handle(call("cancel_subagent", { handle: started.handle }));

  const result = (await orchestrator.handle(
    call("subagent_result", { handle: started.handle }),
  )) as SubagentResult;
  assert.equal(result.state, "cancelled");
  assert.equal(host.children[0]?.cancelled, true);
  assert.equal(host.children[0]?.disposed, true);
});

test("a parent that ends takes every Subagent it started with it", async (t) => {
  const { host, orchestrator } = attached();
  t.after(() => orchestrator.dispose());

  await orchestrator.handle(call("spawn_subagent", { ...brief, mode: "background" }));
  await orchestrator.handle(call("spawn_subagent", { ...brief, mode: "background" }));
  await host.opened(2);

  await orchestrator.release(PARENT_KEY);

  assert.deepEqual(
    host.children.map((child) => [child.cancelled, child.disposed]),
    [[true, true], [true, true]],
  );
});

test("the cascade follows the tree, not just the first level", async (t) => {
  const { host, orchestrator } = attached(
    fakeHost({ limits: () => limits({ maxSpawnDepth: 2, maxConcurrentSubagents: 4 }) }),
  );
  t.after(() => orchestrator.dispose());

  const child = (await orchestrator.handle(
    call("spawn_subagent", { ...brief, mode: "background" }),
  )) as { handle: string };
  await host.opened(1);
  // A handle is how the Orchestrator names that child Session, so it is also the
  // key the child's own Shim acts under, at the depth it was granted.
  orchestrator.attach(child.handle, {
    sessionId: "child-acp",
    runtimeId: "claude",
    cwd: "/workspace",
  });
  await orchestrator.handle(
    call(
      "spawn_subagent",
      { ...brief, mode: "background" },
      grant({ sessionId: child.handle, depth: 1 }),
    ),
  );
  await host.opened(2);

  await orchestrator.release(PARENT_KEY);

  assert.deepEqual(
    host.children.map((entry) => entry.cancelled),
    [true, true],
    "a grandchild whose parent was cancelled is an agent process nobody owns",
  );
});

test("a Runtime that reports no cost leaves it unknown rather than guessed", async (t) => {
  const { host, orchestrator } = attached();
  t.after(() => orchestrator.dispose());

  const spawn = orchestrator.handle(call("spawn_subagent", brief));
  await host.opened(1);
  host.children[0]?.finish();
  const result = (await spawn) as SubagentResult;

  assert.equal(result.cost, "unknown");
  assert.equal(result.budget, "unenforced");
});

test("a cost the child's Agent reported is carried back with the result", async (t) => {
  const { host, orchestrator } = attached(
    fakeHost({ runtimes: async () => [runtime({ id: "claude", budget: true })] }),
  );
  t.after(() => orchestrator.dispose());

  const spawn = orchestrator.handle(call("spawn_subagent", brief));
  await host.opened(1);
  host.children[0]?.say({ sessionUpdate: "agent_message_chunk", cost: { amount: 0.12, currency: "USD" } });
  host.children[0]?.finish();
  const result = (await spawn) as SubagentResult;

  assert.deepEqual(result.cost, { amount: 0.12, currency: "USD" });
  assert.equal(result.budget, "enforced");
});

test("a child that would not start is a failure the parent is told about", async (t) => {
  const host = fakeHost();
  const { orchestrator } = attached(host);
  t.after(() => orchestrator.dispose());
  host.failNextOpen("runtime claude: this workspace is not trusted");

  await assert.rejects(
    () => orchestrator.handle(call("spawn_subagent", brief)),
    /not trusted/,
  );

  // The refused spawn must give its slot back, or the next one waits for ever.
  const spawn = orchestrator.handle(call("spawn_subagent", brief));
  await host.opened(1);
  host.children[0]?.finish();
  assert.equal(((await spawn) as SubagentResult).state, "done");
});

test("a worktree child is given its own checkout as its working directory", async (t) => {
  const allocated: Array<{ sessionKey: string; repository: string }> = [];
  const { host, orchestrator } = attached(
    fakeHost({
      limits: () => limits({ isolation: "worktree" }),
      worktrees: {
        async allocate(request) {
          allocated.push(request);
          return { path: "/worktrees/child-1", branch: "agent-conductor/child-1" };
        },
        release: async () => ({ removed: true }),
      },
    }),
  );
  t.after(() => orchestrator.dispose());

  const spawn = orchestrator.handle(call("spawn_subagent", brief));
  await host.opened(1);
  host.children[0]?.finish();
  const result = (await spawn) as SubagentResult;

  assert.deepEqual(allocated, [{ sessionKey: "child-1", repository: "/workspace" }]);
  assert.equal(host.children[0]?.launch.cwd, "/worktrees/child-1");
  assert.deepEqual(host.children[0]?.launch.worktree, {
    path: "/worktrees/child-1",
    branch: "agent-conductor/child-1",
  });
  assert.deepEqual(result.worktree, { path: "/worktrees/child-1", branch: "agent-conductor/child-1" });
});

test("a shared child works where its parent works, and gets no worktree", async (t) => {
  const { host, orchestrator } = attached(
    fakeHost({
      limits: () => limits({ isolation: "worktree" }),
      worktrees: {
        async allocate() {
          throw new Error("no worktree should be allocated for a shared child");
        },
        release: async () => ({ removed: true }),
      },
    }),
  );
  t.after(() => orchestrator.dispose());

  void orchestrator.handle(call("spawn_subagent", { ...brief, isolation: "shared", mode: "background" }));
  await host.opened(1);

  assert.equal(host.children[0]?.launch.cwd, "/workspace");
  assert.equal(host.children[0]?.launch.worktree, undefined);
});

test("the Brief is what the child is prompted with, and it carries paths rather than contents", async (t) => {
  const { host, orchestrator } = attached();
  t.after(() => orchestrator.dispose());

  void orchestrator.handle(
    call("spawn_subagent", {
      brief: "Rename the thing",
      files: ["/workspace/src/a.ts"],
      mode: "background",
    }),
  );
  await host.opened(1);

  const prompt = host.children[0]?.prompts[0];
  assert.equal(typeof prompt, "string");
  assert.match(String(prompt), /Rename the thing/);
  assert.match(String(prompt), /\/workspace\/src\/a\.ts/);
});

test("disposing the Orchestrator ends every Subagent it is still running", async (t) => {
  const { host, orchestrator } = attached();

  await orchestrator.handle(call("spawn_subagent", { ...brief, mode: "background" }));
  await host.opened(1);
  await orchestrator.dispose();

  assert.equal(host.children[0]?.disposed, true);
  await assert.rejects(
    () => orchestrator.handle(call("spawn_subagent", brief)),
    /shut|dispos|clos/i,
    "an Orchestrator that is going away must not start an Agent nobody will own",
  );
  t.diagnostic(`children: ${host.children.length}`);
});

test("a parent that ends while a spawn is still starting takes that child too", async (t) => {
  const host = fakeHost();
  const { orchestrator } = attached(host);
  t.after(() => orchestrator.dispose());

  host.holdOpen();
  const inside = host.opening();
  const spawn = orchestrator.handle(call("spawn_subagent", { ...brief, mode: "background" }));
  await inside;
  // The parent ends while its child is still being started. Everything that
  // would have cancelled that child has already run by the time it exists.
  await orchestrator.release(PARENT_KEY);
  host.letOpen();

  await assert.rejects(spawn, /parent session/i);
  assert.equal(host.children[0]?.disposed, true, "a child whose parent is gone is nobody's process");
  assert.deepEqual(host.children[0]?.prompts, [], "and it is never given a turn to run");
});

test("teardown reaches a Subagent that was still being started when it began", async () => {
  const host = fakeHost();
  const { orchestrator } = attached(host);

  host.holdOpen();
  const inside = host.opening();
  const spawn = orchestrator.handle(call("spawn_subagent", { ...brief, mode: "background" }));
  await inside;
  await orchestrator.dispose();
  host.letOpen();

  await assert.rejects(spawn, /shut|parent session/i);
  assert.equal(host.children[0]?.disposed, true);
  assert.deepEqual(host.children[0]?.prompts, [], "a turn started after teardown is one nobody waits for");
});

test("a spawn queued behind the semaphore is refused once its parent has ended", async (t) => {
  const host = fakeHost({ limits: () => limits({ maxConcurrentSubagents: 1 }) });
  const { orchestrator } = attached(host);
  t.after(() => orchestrator.dispose());

  const first = orchestrator.handle(call("spawn_subagent", { ...brief, mode: "background" }));
  await host.opened(1);
  await first;
  const queued = orchestrator.handle(call("spawn_subagent", { ...brief, mode: "background" }));
  // Nothing has a slot yet, so the second spawn is still waiting when the parent
  // goes; releasing the first is what lets it through.
  await orchestrator.release(PARENT_KEY);
  host.children[0]?.finish();

  await assert.rejects(queued, /parent session/i);
  assert.equal(host.children.length, 1, "no agent is started for a parent that has ended");
});

test("a worktree made for a Subagent that never started is given back", async (t) => {
  const released: string[] = [];
  const host = fakeHost({
    limits: () => limits({ isolation: "worktree" }),
    worktrees: {
      allocate: async ({ sessionKey }) => ({
        path: `/worktrees/${sessionKey}`,
        branch: `agent-conductor/${sessionKey}`,
      }),
      release: async (path) => {
        released.push(path);
        return { removed: true };
      },
    },
  });
  const { orchestrator } = attached(host);
  t.after(() => orchestrator.dispose());

  host.holdOpen();
  const inside = host.opening();
  const spawn = orchestrator.handle(call("spawn_subagent", { ...brief, mode: "background" }));
  await inside;
  await orchestrator.release(PARENT_KEY);
  host.letOpen();

  await assert.rejects(spawn, /parent session/i);
  // No row will ever name that checkout, because the Session it was made for
  // never registered — so this is the only moment anything can give it back.
  assert.deepEqual(released, ["/worktrees/child-1"]);
});

test("cancelling a Subagent answers with what became of it, not with what was asked", async (t) => {
  const host = fakeHost();
  const { orchestrator } = attached(host);
  t.after(() => orchestrator.dispose());

  const started = (await orchestrator.handle(
    call("spawn_subagent", { ...brief, mode: "background" }),
  )) as { handle: string };
  await host.opened(1);

  const answer = (await orchestrator.handle(
    call("cancel_subagent", { handle: started.handle }),
  )) as { state: string };
  const result = (await orchestrator.handle(
    call("subagent_result", { handle: started.handle }),
  )) as { state: string };

  // One handle, two questions, one answer. A cancel that answered before the
  // Turn had ended would say `running` here while the result said `cancelled`.
  assert.equal(answer.state, "cancelled");
  assert.equal(result.state, "cancelled");
});

test("cancelling a Subagent that had already finished says so", async (t) => {
  const host = fakeHost();
  const { orchestrator } = attached(host);
  t.after(() => orchestrator.dispose());

  const started = (await orchestrator.handle(
    call("spawn_subagent", { ...brief, mode: "background" }),
  )) as { handle: string };
  await host.opened(1);
  host.children[0]?.finish();
  await orchestrator.handle(call("subagent_result", { handle: started.handle }));

  const answer = (await orchestrator.handle(
    call("cancel_subagent", { handle: started.handle }),
  )) as { state: string };

  assert.equal(answer.state, "done", "a Subagent that finished was not cancelled by being asked");
});

/**
 * Teardown may not depend on a Subagent's cooperation.
 *
 * Ending the tree is a loop, and written as one plain `await` per child a single
 * Agent that refuses to stop ends the loop — every sibling after it is left
 * running with nothing that can reach them, which is the orphaned process
 * ADR-0008 exists to prevent. Within one child the same applies to the two
 * steps: only `dispose` takes the process down, so a `cancel` the Agent refused
 * must not be allowed to skip it.
 */
// Its own deadline: the failure this guards against is teardown parking on a
// Turn that never ends, and the default timeout makes that a minute of silence.
test("a Subagent that refuses to stop does not keep its siblings alive", { timeout: 5_000 }, async () => {
  const said: string[] = [];
  const { host, orchestrator } = attached(fakeHost({ log: { log: (_level, text) => said.push(text) } }));

  await orchestrator.handle(call("spawn_subagent", { ...brief, mode: "background" }));
  await orchestrator.handle(call("spawn_subagent", { ...brief, mode: "background" }));
  await host.opened(2);
  const stubborn = host.children[0];
  const sibling = host.children[1];
  assert.ok(stubborn && sibling);
  stubborn.cancel = async () => {
    throw new Error("this agent refused to be cancelled");
  };
  const ended = stubborn.dispose.bind(stubborn);
  stubborn.dispose = async () => {
    await ended();
    // Deliberately without ending the Turn. Disposal is what takes the process
    // down, so one that failed leaves a Turn that never finishes — and teardown
    // may not park on it, or the window never closes at all.
    throw new Error("its process would not be signalled");
  };

  await orchestrator.dispose();

  assert.equal(stubborn.disposed, true, "a cancel that threw skipped the only step that ends a process");
  assert.equal(sibling.disposed, true, "one subagent that would not stop left its sibling running");
  assert.match(said.join("\n"), /refused to be cancelled/);
});
