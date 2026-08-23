import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { MAX_FRAME_BYTES as CORE_FRAME_LIMIT } from "../../core/index.js";
import { connectOrchestrator, MAX_FRAME_BYTES } from "../../shim/socketClient.js";

test("the Shim bounds its frames where the extension does", () => {
  assert.equal(
    MAX_FRAME_BYTES,
    CORE_FRAME_LIMIT,
    "the Shim cannot import the core, so nothing but this holds the two limits together",
  );
});

/**
 * An orchestrator that answers exactly as told, badly if that is what is asked.
 *
 * The real server cannot produce a truncated frame or a response split inside a
 * character, so it cannot show what the Shim does when it receives one — and
 * what the Shim does then decides whether an Agent's turn ends or hangs.
 */
async function fakeOrchestrator(
  t: TestContext,
  onLine: (line: string, socket: net.Socket) => void,
): Promise<{ address: string; sockets: net.Socket[] }> {
  const directory = await mkdtemp(join(tmpdir(), "conductor-shim-test-"));
  const address = join(directory, "ipc.sock");
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    let pending = "";
    socket.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      let cut = pending.indexOf("\n");
      while (cut >= 0) {
        onLine(pending.slice(0, cut), socket);
        pending = pending.slice(cut + 1);
        cut = pending.indexOf("\n");
      }
    });
    socket.on("error", () => socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(address, resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  return { address, sockets };
}

/** The capability line, then every request line. */
function afterHandshake(reply: (request: { id: number; method: string }, socket: net.Socket) => void) {
  const seen = new Map<net.Socket, boolean>();
  return (line: string, socket: net.Socket): void => {
    if (!seen.get(socket)) {
      seen.set(socket, true);
      return;
    }
    reply(JSON.parse(line) as { id: number; method: string }, socket);
  };
}

test("an answer split inside a character arrives as the character", async (t) => {
  const text = "the child said — “done” 🛠";
  const { address } = await fakeOrchestrator(
    t,
    afterHandshake((request, socket) => {
      const frame = Buffer.from(`${JSON.stringify({ id: request.id, result: { text } })}\n`);
      const cut = frame.indexOf(Buffer.from("🛠")) + 2;
      socket.write(frame.subarray(0, cut));
      setTimeout(() => socket.write(frame.subarray(cut)), 20);
    }),
  );
  const link = connectOrchestrator(address, "secret");
  t.after(() => link.close());

  assert.deepEqual(await link.call("list_runtimes", {}), { text });
});

test("two calls in flight each get their own answer", async (t) => {
  const held: Array<{ id: number; handle: string; socket: net.Socket }> = [];
  const { address } = await fakeOrchestrator(t, (line, socket) => {
    if (!line.startsWith("{")) return; // the capability line
    const frame = JSON.parse(line) as { id?: number; params?: { handle: string } };
    if (frame.id === undefined) return;
    held.push({ id: frame.id, handle: frame.params?.handle ?? "", socket });
    if (held.length < 2) return;
    // Answered in the order they did not arrive in, which is the only order that
    // can tell a client matching on ids from one matching on turns.
    for (const call of held.reverse()) {
      call.socket.write(`${JSON.stringify({ id: call.id, result: { handle: call.handle } })}\n`);
    }
  });
  const link = connectOrchestrator(address, "secret");
  t.after(() => link.close());

  const [first, second] = await Promise.all([
    link.call("check_subagent", { handle: "child-a" }),
    link.call("check_subagent", { handle: "child-b" }),
  ]);

  assert.deepEqual(first, { handle: "child-a" });
  assert.deepEqual(second, { handle: "child-b" });
});

test("a call whose orchestrator goes away is told so rather than left waiting", async (t) => {
  const { address } = await fakeOrchestrator(
    t,
    afterHandshake((_request, socket) => socket.destroy()),
  );
  const link = connectOrchestrator(address, "secret");
  t.after(() => link.close());

  await assert.rejects(link.call("spawn_subagent", { brief: "x" }), /closed|failed/);
});

test("a refusal carrying no id fails the call it stranded", async (t) => {
  const { address } = await fakeOrchestrator(t, (_line, socket) => {
    socket.write(`${JSON.stringify({ id: null, error: { code: "unauthorized", message: "no such capability" } })}\n`);
    socket.end();
  });
  const link = connectOrchestrator(address, "stale-secret");
  t.after(() => link.close());

  await assert.rejects(link.call("list_runtimes", {}), /unauthorized: no such capability/);
});

test("an answer beyond the frame limit is refused rather than accumulated", async (t) => {
  const { address } = await fakeOrchestrator(
    t,
    afterHandshake((_request, socket) => {
      socket.write("x".repeat(MAX_FRAME_BYTES + 1));
    }),
  );
  const link = connectOrchestrator(address, "secret");
  t.after(() => link.close());

  await assert.rejects(link.call("list_runtimes", {}), /size limit/);
});

test("an answer whose ending arrives past the limit is refused too", async (t) => {
  const { address } = await fakeOrchestrator(
    t,
    afterHandshake((_request, socket) => {
      // Just inside the limit, then the rest with its newline: the frame is
      // over-long, but the reader finds an ending rather than running out of
      // room without one — the other way round from the flood above, and the
      // one a peer would use if the two checks were not both there.
      socket.write("x".repeat(MAX_FRAME_BYTES - 100), () => {
        setTimeout(() => socket.write(`${"y".repeat(200)}\n`), 30);
      });
    }),
  );
  const link = connectOrchestrator(address, "secret");
  t.after(() => link.close());

  await assert.rejects(link.call("list_runtimes", {}), /size limit/);
});

test("a link whose socket dropped can be used again", async (t) => {
  let drop = true;
  const { address } = await fakeOrchestrator(
    t,
    afterHandshake((request, socket) => {
      if (drop) {
        drop = false;
        socket.destroy();
        return;
      }
      socket.write(`${JSON.stringify({ id: request.id, result: { ok: true } })}\n`);
    }),
  );
  const link = connectOrchestrator(address, "secret");
  t.after(() => link.close());

  await assert.rejects(link.call("list_runtimes", {}));
  assert.deepEqual(await link.call("list_runtimes", {}), { ok: true }, "a blip must not end delegation");
});

test("a closed link answers at once instead of opening a socket", async (t) => {
  const { address, sockets } = await fakeOrchestrator(t, () => {});
  const link = connectOrchestrator(address, "secret");

  link.close();

  await assert.rejects(link.call("list_runtimes", {}), /closed/);
  assert.deepEqual(sockets, [], "a closed link connects to nothing");
});
