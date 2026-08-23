import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_FRAME_BYTES, type OrchestrationCall } from "../../core/index.js";
import { connectedShim, errorCode, ipcServer, rawClient, SHIM_CAPABILITY } from "../ipc-fixtures.js";

test("a request frame over the limit is refused as it arrives, not once it is whole", async (t) => {
  const calls: OrchestrationCall[] = [];
  const { client } = await connectedShim(
    t,
    async (call) => {
      calls.push(call);
      return {};
    },
    { maxFrameBytes: 4_096 },
  );

  // The peer is reset part-way through this write, which is the point of it.
  await client
    .sendRaw(`{"id":1,"method":"spawn_subagent","params":{"brief":"${"x".repeat(8_192)}`)
    .catch(() => {});
  const answer = await client.readLine();

  assert.match(answer ?? "", /too_large/);
  assert.equal(await client.closed(), true, "a stream that overran cannot be resynchronised");
  assert.deepEqual(calls, []);
});

test("a frame that is not a readable request ends the connection rather than hanging it", async (t) => {
  for (const broken of ["{not json", '"a string"', "[1,2,3]", '{"method":"list_runtimes"}']) {
    const calls: OrchestrationCall[] = [];
    const { client } = await connectedShim(t, async (call) => {
      calls.push(call);
      return {};
    });

    await client.sendRaw(`${broken}\n`);
    const answer = JSON.parse((await client.readLine()) ?? "{}") as Record<string, unknown>;

    assert.equal(errorCode(answer), "invalid_frame", broken);
    assert.equal(await client.closed(), true, `a frame with no answerable id must not strand its caller: ${broken}`);
    assert.deepEqual(calls, []);
  }
});

test("a request that arrives with the handshake is judged by the request's own limit", async (t) => {
  const calls: OrchestrationCall[] = [];
  const server = await ipcServer(t, {
    handler: async (call) => {
      calls.push(call);
      return { ok: true };
    },
    now: () => 0,
  });
  const capability = server.issue(SHIM_CAPABILITY);
  const client = rawClient(t, server.address);

  // One write, as a Shim that connects and calls in the same breath produces:
  // the handshake's own tight limit must not still be in force by the time the
  // request behind it is read, or every real brief is refused as oversized.
  const request = JSON.stringify({
    id: 1,
    method: "spawn_subagent",
    params: { brief: "x".repeat(2_000) },
  });
  await client.sendRaw(`${capability.secret}\n${request}\n`);
  const answer = JSON.parse((await client.readLine()) ?? "{}") as Record<string, unknown>;

  assert.deepEqual(answer.result, { ok: true }, "a brief longer than a secret is still a brief");
  assert.equal(calls.length, 1);
});

test("a brief survives the newlines and characters a real one is made of", async (t) => {
  const calls: OrchestrationCall[] = [];
  const { client } = await connectedShim(t, async (call) => {
    calls.push(call);
    return { ok: true };
  });

  // Newlines are what the frame is cut on, so a brief full of them is the one
  // thing this protocol could get wrong; the emoji is there to be split.
  const brief = "Rewrite:\n\n- one\r\n- two\n\nSee ARCHITECTURE.md — the “Spawn” flow 🛠\n";
  const frame = Buffer.from(`${JSON.stringify({ id: 1, method: "spawn_subagent", params: { brief } })}\n`);
  const cut = frame.indexOf(Buffer.from("🛠")) + 2;
  await client.sendRaw(frame.subarray(0, cut));
  // A real pause, not just a flushed write: two writes down a local socket
  // arrive as one read, and a split the reader never sees proves nothing.
  await new Promise((resolve) => setTimeout(resolve, 20));
  await client.sendRaw(frame.subarray(cut));

  const answer = JSON.parse((await client.readLine()) ?? "{}") as Record<string, unknown>;

  assert.deepEqual(answer.result, { ok: true });
  assert.equal(
    (calls[0]?.params as { brief?: string }).brief,
    brief,
    "a frame split inside a character must arrive as the character",
  );
});

test("an answer cannot be pushed past the frame limit by what it has to quote", async (t) => {
  const calls: OrchestrationCall[] = [];
  const { client } = await connectedShim(t, async (call) => {
    calls.push(call);
    return { ok: true };
  });

  // A request inside the limit, almost all of it the id — which every answer
  // has to carry back. An answer bigger than the limit is one the Shim refuses
  // wholesale, taking every call in flight on that link down with it.
  const id = "A".repeat(MAX_FRAME_BYTES - 100);
  await client.sendRaw(`${JSON.stringify({ id, method: "list_runtimes", params: {} })}\n`).catch(() => {});
  const answer = await client.readLine();

  assert.ok(
    (answer ?? "").length < MAX_FRAME_BYTES,
    `the answer was ${(answer ?? "").length} bytes, which the peer is bound to refuse`,
  );
  assert.match(answer ?? "", /invalid_frame/);
  assert.deepEqual(calls, []);
});

test("a method that refuses to be described is still answered", async (t) => {
  const { client } = await connectedShim(t, async () => ({ ok: true }));

  // Neither key is callable, so turning this into a string throws — and a
  // throw on the way to composing a refusal is a call that never comes back,
  // which is the one failure the Shim cannot recover from: it waits on that id
  // for the rest of the Agent's turn.
  const answer = await client.request({
    id: 1,
    method: { toString: 1, valueOf: 2 },
    params: {},
  });

  assert.equal(answer?.id, 1, "every frame with an id gets an answer carrying it");
  assert.ok(answer?.error, "and the answer is a refusal");
});

test("an unknown method is refused by name and the connection carries on", async (t) => {
  const calls: OrchestrationCall[] = [];
  const { client } = await connectedShim(t, async (call) => {
    calls.push(call);
    return { ok: true };
  });

  const refused = await client.request({ id: 1, method: "orchestrator_status", params: {} });
  const after = await client.request({ id: 2, method: "list_runtimes", params: {} });

  assert.equal(errorCode(refused), "unknown_method");
  assert.deepEqual(after?.result, { ok: true }, "a mistyped tool name is not a broken stream");
  assert.deepEqual(calls.map((call) => call.method), ["list_runtimes"]);
});

test("a result too big to frame is reported as such rather than written anyway", async (t) => {
  const { client } = await connectedShim(t, async () => "y".repeat(MAX_FRAME_BYTES + 10));

  const answer = await client.request({ id: 1, method: "list_runtimes", params: {} });

  assert.equal(errorCode(answer), "too_large");
  assert.equal(answer?.id, 1, "the caller still learns which request it was");
});

test("a handler that throws answers that one call and keeps the connection", async (t) => {
  let calls = 0;
  const { client } = await connectedShim(t, async () => {
    calls += 1;
    if (calls === 1) throw new Error(`no runtime is trusted ${"detail ".repeat(200)}`);
    return { ok: true };
  });

  const failed = await client.request({ id: 1, method: "list_runtimes", params: {} });
  const after = await client.request({ id: 2, method: "list_runtimes", params: {} });

  assert.equal(errorCode(failed), "failed");
  const message = (failed?.error as { message?: string }).message ?? "";
  assert.match(message, /no runtime is trusted/);
  assert.ok(message.length <= 500, `a failure message is bounded, got ${message.length}`);
  assert.deepEqual(after?.result, { ok: true });
});

test("requests in flight together are answered by id, whatever order they finish in", async (t) => {
  const release: Array<() => void> = [];
  const { client } = await connectedShim(t, async (call) => {
    await new Promise<void>((resolve) => release.push(resolve));
    return { method: call.method };
  });

  await client.sendRaw(`${JSON.stringify({ id: "first", method: "list_runtimes", params: {} })}\n`);
  await client.sendRaw(
    `${JSON.stringify({ id: "second", method: "cancel_subagent", params: { handle: "h" } })}\n`,
  );
  while (release.length < 2) await new Promise((resolve) => setImmediate(resolve));
  release[1]?.();
  release[0]?.();

  const answers = [await client.readLine(), await client.readLine()].map(
    (line) => JSON.parse(line ?? "{}") as { id?: string; result?: { method?: string } },
  );
  assert.deepEqual(answers, [
    { id: "second", result: { method: "cancel_subagent" } },
    { id: "first", result: { method: "list_runtimes" } },
  ]);
});

test("every exposed method reaches the handler with its arguments validated", async (t) => {
  const calls: OrchestrationCall[] = [];
  const { client } = await connectedShim(t, async (call) => {
    calls.push(call);
    return { done: call.method };
  });

  const requests = [
    { method: "list_runtimes", params: {} },
    {
      method: "spawn_subagent",
      params: { brief: "write the release notes", runtime: "codex", effort: "high", mode: "background" },
    },
    { method: "check_subagent", params: { handle: "child-1" } },
    { method: "subagent_result", params: { handle: "child-1" } },
    { method: "cancel_subagent", params: { handle: "child-1" } },
  ];
  const answers = [];
  for (const [index, request] of requests.entries()) {
    answers.push(await client.request({ id: index, ...request }));
  }

  assert.deepEqual(
    answers.map((answer) => (answer?.result as { done?: string })?.done),
    requests.map((request) => request.method),
  );
  assert.deepEqual(calls.map((call) => call.grant.sessionId), Array(5).fill("parent-session"));
  assert.deepEqual(calls[1]?.params, {
    brief: "write the release notes",
    runtime: "codex",
    effort: "high",
    mode: "background",
  });
});

test("arguments that are the wrong shape are refused before the handler sees them", async (t) => {
  const calls: OrchestrationCall[] = [];
  const { client } = await connectedShim(t, async (call) => {
    calls.push(call);
    return {};
  });

  const refusals = [
    { method: "spawn_subagent", params: {} },
    { method: "spawn_subagent", params: { brief: "" } },
    { method: "spawn_subagent", params: { brief: "x", effort: "ludicrous" } },
    { method: "spawn_subagent", params: { brief: "x", budget_usd: -1 } },
    { method: "spawn_subagent", params: { brief: "x", timeout_ms: 0.5 } },
    { method: "spawn_subagent", params: { brief: "x", files: "one.ts" } },
    { method: "check_subagent", params: {} },
    { method: "cancel_subagent", params: { handle: 7 } },
    { method: "spawn_subagent", params: { brief: "x", files: ["relative/path.ts"] } },
    { method: "spawn_subagent", params: { brief: "x", files: [""] } },
    { method: "list_runtimes", params: { verbose: true } },
  ];
  for (const [index, request] of refusals.entries()) {
    const answer = await client.request({ id: index, ...request });
    assert.equal(errorCode(answer), "invalid_params", JSON.stringify(request));
  }
  assert.deepEqual(calls, []);
});
