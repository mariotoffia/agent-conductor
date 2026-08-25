import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  MAX_CAPABILITY_CONNECTIONS,
  MAX_CONNECTIONS,
  MAX_IN_FLIGHT_CALLS,
  startOrchestrationServer,
} from "../../core/index.js";
import { connectedShim, ipcServer, rawClient, SHIM_CAPABILITY } from "../ipc-fixtures.js";

test("a Shim cannot make the host run its whole backlog at once", async (t) => {
  let live = 0;
  let peak = 0;
  const release: Array<() => void> = [];
  const { client } = await connectedShim(t, async () => {
    live += 1;
    peak = Math.max(peak, live);
    await new Promise<void>((resolve) => release.push(resolve));
    live -= 1;
    return { ok: true };
  });

  // One write, one read event, hundreds of frames — none of them oversized, so
  // the frame limit says nothing about any of this.
  const backlog = 400;
  const frames = Array.from({ length: backlog }, (_, id) =>
    JSON.stringify({ id, method: "list_runtimes", params: {} }),
  ).join("\n");
  await client.sendRaw(`${frames}\n`);
  while (release.length === 0) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.ok(
    peak <= MAX_IN_FLIGHT_CALLS,
    `at most ${MAX_IN_FLIGHT_CALLS} calls may be in flight for one Shim, saw ${peak}`,
  );
  // Against a number as well as against the constant: measured only against
  // itself, the cap could be raised to a thousand and this would stay green.
  assert.ok(MAX_IN_FLIGHT_CALLS <= 64, "a cap this high is not a cap");

  // Held back, not dropped: the backlog still finishes once the work does.
  const answered = new Set<number>();
  for (let turn = 0; turn < backlog * 4 && answered.size < backlog; turn += 1) {
    for (const resume of release.splice(0)) resume();
    const line = await client.readLine();
    if (line) answered.add((JSON.parse(line) as { id: number }).id);
  }
  assert.equal(answered.size, backlog, "throttling must not lose a frame");
});

test("a Shim gets a few connections, not as many as it likes", async (t) => {
  const server = await ipcServer(t, { handler: async () => ({ ok: true }), now: () => 0 });
  const capability = server.issue(SHIM_CAPABILITY);

  const held = [];
  for (let n = 0; n < MAX_CAPABILITY_CONNECTIONS; n += 1) {
    const client = rawClient(t, server.address);
    await client.send(capability.secret);
    assert.deepEqual((await client.request({ id: 1, method: "list_runtimes" }))?.result, { ok: true });
    held.push(client);
  }

  const excess = rawClient(t, server.address);
  await excess.send(capability.secret);
  assert.match((await excess.readLine()) ?? "", /unauthorized/, "the cap is what bounds a flood");
});

test("a connection the server gave up on stops counting against the Shim", async (t) => {
  const server = await ipcServer(t, {
    handler: async () => ({ ok: true }),
    now: () => 0,
    abortGraceMs: 20,
  });
  const capability = server.issue(SHIM_CAPABILITY);

  // Peers that ignore the goodbye, which is what makes this worth testing: a
  // socket that is ended but never reaped holds one of the capability's few
  // slots, and enough of them lock the Shim out of its own capability.
  for (let n = 0; n < MAX_CAPABILITY_CONNECTIONS; n += 1) {
    const doomed = rawClient(t, server.address, { allowHalfOpen: true });
    await doomed.send(capability.secret);
    await doomed.sendRaw("{not json\n").catch(() => {});
    assert.match((await doomed.readLine()) ?? "", /invalid_frame/, "and it still learns why");
  }
  await new Promise((resolve) => setTimeout(resolve, 120));

  const shim = rawClient(t, server.address);
  await shim.send(capability.secret);
  assert.deepEqual((await shim.request({ id: 1, method: "list_runtimes" }))?.result, { ok: true });
});

test("the socket stops accepting long before it runs out of descriptors", async (t) => {
  const server = await ipcServer(t, { handler: async () => ({ ok: true }), now: () => 0 });

  // Silent connections: they have proved nothing, and until the handshake
  // deadline collects them they are descriptors all the same.
  const silent = [];
  for (let n = 0; n < MAX_CONNECTIONS; n += 1) silent.push(rawClient(t, server.address));
  await Promise.all(silent.map((client) => client.ready));

  const excess = rawClient(t, server.address);

  assert.equal(await excess.closed(), true, "the one over the line is not accepted at all");
});

test("a peer the server gave up on cannot go on filling its memory", async (t) => {
  const server = await ipcServer(t, {
    handler: async () => ({ ok: true }),
    now: () => 0,
    // Long enough that the flood below happens entirely inside the goodbye.
    abortGraceMs: 5_000,
  });
  const capability = server.issue(SHIM_CAPABILITY);
  const client = rawClient(t, server.address, { allowHalfOpen: true });
  await client.send(capability.secret);
  await client.sendRaw("{not json\n").catch(() => {});
  assert.match((await client.readLine()) ?? "", /invalid_frame/);

  // Everything after the refusal is bytes nothing will ever parse. They must
  // stop at the socket, where the operating system pushes back, rather than
  // being read into a buffer this process keeps growing.
  const block = Buffer.alloc(64 * 1_024, 0x78);
  for (let n = 0; n < 128; n += 1) void client.sendRaw(block).catch(() => {});

  // Watched rather than sampled once, because a server that is merely slow also
  // leaves bytes with the peer for a moment. One that stopped reading leaves
  // them there for good: this same flood drains in about a quarter-second when
  // nothing pauses the socket.
  for (let waited = 0; waited < 1_500; waited += 100) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(
      client.unread() > 2_000_000,
      `the server went on reading a peer it refused: only ${client.unread()} bytes left with it after ${waited + 100}ms`,
    );
  }
});

test("a peer that dribbles bytes still runs out of handshake", async (t) => {
  const server = await ipcServer(t, {
    handler: async () => ({ ok: true }),
    now: () => 0,
    handshakeTimeoutMs: 150,
  });
  server.issue(SHIM_CAPABILITY);
  const trickler = rawClient(t, server.address);

  // One byte at a time, faster than the deadline: an idle timer would be reset
  // by every one of them and never fire, which is a connection held for as long
  // as the peer cares to hold it — and there are only so many.
  const dribble = setInterval(() => void trickler.sendRaw("x").catch(() => {}), 40);
  t.after(() => clearInterval(dribble));

  assert.equal(await trickler.closed(3_000), true, "the deadline is on the handshake, not on silence");
});

test("a Shim that vanishes mid-call takes nothing else down with it", async (t) => {
  let started: (() => void) | undefined;
  const reached = new Promise<void>((resolve) => (started = resolve));
  const server = await ipcServer(t, {
    handler: async () => {
      started?.();
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { ok: true };
    },
    now: () => 0,
  });
  const capability = server.issue(SHIM_CAPABILITY);
  const first = rawClient(t, server.address);
  await first.send(capability.secret);
  await first.sendRaw(`${JSON.stringify({ id: 1, method: "list_runtimes", params: {} })}\n`);
  await reached;
  await first.destroy();

  const second = rawClient(t, server.address);
  await second.send(capability.secret);
  const answer = await second.request({ id: 1, method: "list_runtimes", params: {} });

  assert.deepEqual(answer?.result, { ok: true }, "the server survives a peer that disappears");
});

test("a connection that never authenticates is dropped rather than held", async (t) => {
  const server = await ipcServer(t, {
    handler: async () => ({ ok: true }),
    now: () => 0,
    handshakeTimeoutMs: 50,
  });
  const capability = server.issue(SHIM_CAPABILITY);

  const silent = rawClient(t, server.address);
  assert.equal(await silent.closed(5_000), true, "an unauthenticated connection must not linger");

  const speaking = rawClient(t, server.address);
  await speaking.send(capability.secret);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const answer = await speaking.request({ id: 1, method: "list_runtimes", params: {} });

  assert.deepEqual(answer?.result, { ok: true }, "the deadline is the handshake's, not the connection's");
});

test("the socket sits where only its owner can reach it", { skip: process.platform === "win32" }, async (t) => {
  const { server } = await connectedShim(t, async () => ({}));

  const directory = await stat(dirname(server.address));
  const socket = await stat(server.address);

  assert.equal(directory.mode & 0o777, 0o700, "the containing directory is what macOS enforces");
  assert.equal(socket.mode & 0o777, 0o600, "and the mode is what Linux enforces");
});

test("a socket that cannot be listened on leaves nothing behind", async (t) => {
  // A temporary directory of this test's own: `os.tmpdir()` is read per call
  // from the environment, and the shared one has this suite's own sockets — and
  // other files' probe directories, which share the prefix — appearing and
  // vanishing in it while this runs.
  const root = await mkdtemp(join(tmpdir(), "conductor-bind-"));
  const names = ["TMPDIR", "TMP", "TEMP"] as const;
  const restore = names.map((name) => [name, process.env[name]] as const);
  for (const name of names) process.env[name] = root;
  t.after(async () => {
    for (const [name, value] of restore) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  const listen = net.Server.prototype.listen;
  // The directory is made before the socket can be, so the only way to see
  // whether it is taken back is to stop the socket from happening.
  net.Server.prototype.listen = function (this: net.Server) {
    setImmediate(() => this.emit("error", new Error("listen refused")));
    return this;
  } as typeof listen;
  t.after(() => {
    net.Server.prototype.listen = listen;
  });

  await assert.rejects(startOrchestrationServer({ handler: async () => ({}) }), /listen refused/);

  assert.deepEqual(await readdir(root), [], "a failed start must not leave a directory of its own behind");
});

test("a capability that lapses stops the connection reading, not just answering", async (t) => {
  let clock = 0;
  const server = await ipcServer(t, {
    handler: async () => ({ ok: true }),
    now: () => clock,
    abortGraceMs: 5_000,
  });
  const capability = server.issue({ ...SHIM_CAPABILITY, expiresAtMs: 1_000 });
  const client = rawClient(t, server.address, { allowHalfOpen: true });
  await client.send(capability.secret);
  // Answered before the clock moves, so what follows is a capability lapsing
  // under a connection the server already has — not one refused at its
  // handshake, which is a different path with a different answer.
  assert.deepEqual((await client.request({ id: 0, method: "list_runtimes" }))?.result, { ok: true });

  clock = 1_001;
  const answer = await client.request({ id: 1, method: "list_runtimes", params: {} });
  assert.match((answer?.error as { message?: string })?.message ?? "", /expired/);

  // The same flood the refusal path is held to. A Session ending under an open
  // connection is the ordinary way a capability goes, so it is the path that
  // must not go on reading a peer nothing will answer.
  const block = Buffer.alloc(64 * 1_024, 0x78);
  for (let n = 0; n < 128; n += 1) void client.sendRaw(block).catch(() => {});
  for (let waited = 0; waited < 1_000; waited += 100) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(
      client.unread() > 2_000_000,
      `a lapsed capability went on reading: only ${client.unread()} bytes left with the peer`,
    );
  }
});

test("a Shim that stops reading its answers stops being read from", async (t) => {
  let handled = 0;
  const server = await ipcServer(t, {
    handler: async () => {
      handled += 1;
      return { padding: "z".repeat(64 * 1_024) };
    },
    now: () => 0,
  });
  const capability = server.issue(SHIM_CAPABILITY);
  const client = rawClient(t, server.address, { readAnswers: false });
  await client.send(capability.secret);

  const asked = 400;
  const frames = Array.from({ length: asked }, (_, id) =>
    JSON.stringify({ id, method: "list_runtimes", params: {} }),
  ).join("\n");
  await client.sendRaw(`${frames}\n`);
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.ok(handled < asked, `a peer that never reads was served all ${asked} of its requests anyway`);
});

/**
 * The socket a Shim is given can still fail after `listen` has answered — an
 * accept that runs out of descriptors is the ordinary way — and an `error` event
 * with no listener is an uncaught exception in the host that raised it. Nothing
 * here can recover an accept, so what has to happen is that it is said rather
 * than thrown.
 *
 * Reached by standing in for `net.createServer`, because the raw server is the
 * one thing this module deliberately never hands out; the fault itself is Node's
 * own, emitted exactly as an accept failure arrives.
 */
test("a socket that fails after it is listening is reported, not thrown at the host", async (t) => {
  const said: string[] = [];
  const made: net.Server[] = [];
  const real = net.createServer;
  net.createServer = ((...args: Parameters<typeof net.createServer>) => {
    const server = real(...args);
    made.push(server);
    return server;
  }) as typeof net.createServer;
  let server;
  try {
    server = await ipcServer(t, {
      handler: async () => ({}),
      log: { log: (_level, text) => said.push(text) },
    });
  } finally {
    net.createServer = real;
  }

  const raw = made[0];
  assert.ok(raw, "the test never got hold of the socket it is about to fault");
  raw.emit("error", new Error("EMFILE: too many open files, accept"));

  assert.match(said.join("\n"), /EMFILE/, "an accept that failed was never reported");
  // And the socket a Shim already holds is still the one it was given: reporting
  // an accept failure is not the same as giving up the address.
  assert.ok(server.address.length > 0);
});
