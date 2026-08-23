import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { SessionCapability, OrchestrationCall } from "../../core/index.js";
import { ipcServer, rawClient, type RawClient } from "../ipc-fixtures.js";

/** A grant with everything an issuer must decide, so a test can vary one part. */
function grant(overrides: Partial<SessionCapability> = {}): SessionCapability {
  return {
    sessionId: "parent-session",
    depth: 0,
    roots: ["/workspace"],
    expiresAtMs: 60_000,
    methods: ["list_runtimes", "spawn_subagent"],
    ...overrides,
  };
}

/** Records what the Orchestrator would have been asked to do. */
function recorder() {
  const calls: OrchestrationCall[] = [];
  return {
    calls,
    handler: async (call: OrchestrationCall) => {
      calls.push(call);
      return { ok: true };
    },
  };
}

async function connect(t: TestContext, address: string, secret: string): Promise<RawClient> {
  const client = rawClient(t, address);
  await client.send(secret);
  return client;
}

test("a connection presenting the wrong secret never reaches the handler", async (t) => {
  const seen = recorder();
  const server = await ipcServer(t, { handler: seen.handler, now: () => 0 });
  server.issue(grant());

  const client = rawClient(t, server.address);
  await client.send("not-the-secret");
  const answer = await client.readLine();

  assert.match(answer ?? "", /unauthorized/, "the refusal must be said, not merely implied");
  assert.equal(await client.closed(), true, "an unauthenticated connection must be dropped");
  assert.deepEqual(seen.calls, [], "nothing may reach the handler without a capability");
});

test("a request sent instead of a handshake is refused as a handshake", async (t) => {
  const seen = recorder();
  const server = await ipcServer(t, { handler: seen.handler, now: () => 0 });
  server.issue(grant());

  const client = rawClient(t, server.address);
  const answer = await client.request({ id: 1, method: "list_runtimes", params: {} });

  assert.equal((answer?.error as { code?: string })?.code, "unauthorized");
  assert.deepEqual(seen.calls, [], "no frame is a method call until a capability says so");
});

test("a handshake line with no end to it is refused before it is held", async (t) => {
  const seen = recorder();
  const server = await ipcServer(t, { handler: seen.handler, now: () => 0 });
  server.issue(grant());

  const client = rawClient(t, server.address);
  await client.sendRaw("x".repeat(4_096)).catch(() => {});
  const answer = await client.readLine();

  assert.match(answer ?? "", /too_large/);
  assert.equal(await client.closed(), true);
  assert.deepEqual(seen.calls, []);
});

test("a capability past its expiry is refused at the handshake", async (t) => {
  const seen = recorder();
  let clock = 0;
  const server = await ipcServer(t, { handler: seen.handler, now: () => clock });
  const capability = server.issue(grant({ expiresAtMs: 1_000 }));

  clock = 1_001;
  const client = await connect(t, server.address, capability.secret);

  assert.match((await client.readLine()) ?? "", /unauthorized/);
  assert.deepEqual(seen.calls, []);
});

test("a capability that expires under an open connection stops that connection", async (t) => {
  const seen = recorder();
  let clock = 0;
  const server = await ipcServer(t, { handler: seen.handler, now: () => clock });
  const capability = server.issue(grant({ expiresAtMs: 1_000 }));
  const client = await connect(t, server.address, capability.secret);

  const before = await client.request({ id: 1, method: "list_runtimes", params: {} });
  clock = 1_001;
  const after = await client.request({ id: 2, method: "list_runtimes", params: {} });

  assert.deepEqual(before?.result, { ok: true }, "the first call is inside the expiry");
  assert.equal((after?.error as { code?: string })?.code, "unauthorized");
  assert.equal(seen.calls.length, 1, "expiry is re-checked per call, not only at the handshake");
  assert.equal(await client.closed(), true, "a lapsed capability leaves nothing holding a socket");
});

test("a revoked capability drops the connection already holding it", async (t) => {
  const seen = recorder();
  const server = await ipcServer(t, { handler: seen.handler, now: () => 0 });
  const capability = server.issue(grant());
  const client = await connect(t, server.address, capability.secret);
  await client.request({ id: 1, method: "list_runtimes", params: {} });

  capability.revoke();

  assert.equal(await client.closed(), true, "revoking is immediate, not on next use");
  const again = await connect(t, server.address, capability.secret);
  assert.match((await again.readLine()) ?? "", /unauthorized/, "a revoked secret buys nothing back");
  assert.equal(seen.calls.length, 1);
});

test("work a Shim sent before its capability was withdrawn does not reach the Orchestrator", async (t) => {
  const seen: string[] = [];
  let release: (() => void) | undefined;
  const server = await ipcServer(t, {
    now: () => 0,
    // One at a time, so the second frame is still waiting its turn — which is
    // the only way a frame can be read under a capability and dispatched after
    // it is gone.
    maxInFlightCalls: 1,
    handler: async (call) => {
      seen.push(call.method);
      if (seen.length === 1) await new Promise<void>((resolve) => (release = resolve));
      return { ok: true };
    },
  });
  const capability = server.issue(grant());
  const client = await connect(t, server.address, capability.secret);

  const both = [
    JSON.stringify({ id: 1, method: "list_runtimes", params: {} }),
    JSON.stringify({ id: 2, method: "spawn_subagent", params: { brief: "carry on" } }),
  ].join("\n");
  await client.sendRaw(`${both}\n`);
  while (!release) await new Promise((resolve) => setImmediate(resolve));

  capability.revoke();
  release();
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(seen, ["list_runtimes"], "the queued call is refused, not run late");
});

test("one Session's secret carries that Session's lineage and no other's", async (t) => {
  const seen = recorder();
  const server = await ipcServer(t, { handler: seen.handler, now: () => 0 });
  const first = server.issue(grant({ sessionId: "alpha", depth: 0, roots: ["/alpha"] }));
  const second = server.issue(
    grant({ sessionId: "beta", parentSessionId: "alpha", depth: 1, roots: ["/beta"] }),
  );

  await (await connect(t, server.address, first.secret)).request({ id: 1, method: "list_runtimes" });
  await (await connect(t, server.address, second.secret)).request({ id: 1, method: "list_runtimes" });

  assert.deepEqual(
    seen.calls.map((call) => [call.grant.sessionId, call.grant.depth, call.grant.roots]),
    [
      ["alpha", 0, ["/alpha"]],
      ["beta", 1, ["/beta"]],
    ],
  );
  assert.equal(seen.calls[1]?.grant.parentSessionId, "alpha");
});

test("a grant is copied at the mint, so what was issued is what is enforced", async (t) => {
  const seen = recorder();
  const server = await ipcServer(t, { handler: seen.handler, now: () => 0 });
  const issued = grant({ roots: ["/alpha"], methods: ["list_runtimes"] });
  const capability = server.issue(issued);

  (issued.roots as string[]).push("/elsewhere");
  (issued.methods as string[]).push("spawn_subagent");
  issued.depth = 99;

  const client = await connect(t, server.address, capability.secret);
  const widened = await client.request({ id: 1, method: "spawn_subagent", params: { brief: "x" } });
  const allowed = await client.request({ id: 2, method: "list_runtimes", params: {} });

  assert.equal((widened?.error as { code?: string })?.code, "unauthorized");
  assert.deepEqual(allowed?.result, { ok: true });
  assert.deepEqual(seen.calls[0]?.grant.roots, ["/alpha"], "the enforced roots are the issued ones");
  assert.equal(seen.calls[0]?.grant.depth, 0);
});

test("a caller naming its own Session, depth or roots is refused, not merged", async (t) => {
  const seen = recorder();
  const server = await ipcServer(t, { handler: seen.handler, now: () => 0 });
  const capability = server.issue(grant({ sessionId: "alpha", depth: 1, roots: ["/alpha"] }));
  const client = await connect(t, server.address, capability.secret);

  for (const forged of [
    { sessionId: "victim" },
    { parentSessionId: "victim" },
    { depth: 0 },
    { roots: ["/elsewhere"] },
    { methods: ["cancel_subagent"] },
    { expiresAtMs: 1e15 },
  ]) {
    const answer = await client.request({
      id: 1,
      method: "spawn_subagent",
      params: { brief: "do the thing", ...forged },
    });
    assert.equal(
      (answer?.error as { code?: string })?.code,
      "invalid_params",
      `a frame carrying ${Object.keys(forged)[0]} must be refused outright`,
    );
  }
  assert.deepEqual(seen.calls, [], "an attempt to widen a capability reaches nothing");
});

test("a method the capability does not list is refused while the rest still work", async (t) => {
  const seen = recorder();
  const server = await ipcServer(t, { handler: seen.handler, now: () => 0 });
  const capability = server.issue(grant({ methods: ["list_runtimes"] }));
  const client = await connect(t, server.address, capability.secret);

  const refused = await client.request({
    id: 1,
    method: "spawn_subagent",
    params: { brief: "do the thing" },
  });
  const allowed = await client.request({ id: 2, method: "list_runtimes", params: {} });

  assert.equal((refused?.error as { code?: string })?.code, "unauthorized");
  assert.deepEqual(allowed?.result, { ok: true });
  assert.deepEqual(
    seen.calls.map((call) => call.method),
    ["list_runtimes"],
  );
});

test("a grant the server could not enforce is refused at the mint", async (t) => {
  const server = await ipcServer(t, { handler: async () => ({}), now: () => 1_000 });

  const refusals: Array<[string, Partial<SessionCapability>]> = [
    ["a relative root", { roots: ["workspace"] }],
    ["no roots at all", { roots: [] }],
    ["an expiry in the past", { expiresAtMs: 999 }],
    ["no methods", { methods: [] }],
    ["a method nothing serves", { methods: ["read_everything"] as never }],
    ["a negative depth", { depth: -1 }],
    ["a fractional depth", { depth: 0.5 }],
    ["no Session", { sessionId: "" }],
  ];
  for (const [why, overrides] of refusals) {
    assert.throws(() => server.issue(grant({ expiresAtMs: 60_000, ...overrides })), /session capability/, why);
  }
});
