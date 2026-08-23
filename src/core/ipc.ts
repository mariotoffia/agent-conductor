/**
 * The socket the Shim talks to, and the Session Capability that authorises it
 * (ADR-0008).
 *
 * Two things live here and nothing else: the transport, and the authority.
 * What a call then *does* belongs to the Orchestrator, which supplies the
 * handler — so the rule that a caller can never widen its own authority is
 * enforced in one place rather than in five method bodies.
 *
 * The authority is bound on this side alone. A capability names the Session it
 * acts for, that Session's parent, its depth, its roots, when it lapses and
 * which methods it may call; the Shim presents a secret and nothing else. Every
 * request schema is `strict`, so a frame that even mentions a lineage field is
 * refused rather than having it quietly ignored — the difference matters, because
 * a field that is ignored today is a field somebody merges tomorrow.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  MAX_ERROR_CHARS,
  MAX_FRAME_BYTES,
  MAX_SECRET_LINE_BYTES,
  ORCHESTRATION_METHODS,
  PARAMS,
  readFrame,
  type SessionCapability,
  type Failure,
  type OrchestrationCall,
  type OrchestrationHandler,
  type RequestFrame,
} from "./ipcProtocol.js";
import type { LogPort } from "./types.js";

/** How long a connection may stay unauthenticated before it is dropped. */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Calls one Shim may have outstanding before we stop reading from it.
 *
 * Without this, one read of a Shim's own making — several hundred small frames
 * in a single write, none of them near the frame limit — starts a handler for
 * every one of them at once, inside the extension host. The peer is a process
 * an Agent controls, so the backlog is held in the socket, where the operating
 * system already knows how to push back, rather than in this process's heap.
 */
export const MAX_IN_FLIGHT_CALLS = 32;

/**
 * Connections one capability may hold at once.
 *
 * A Shim needs exactly one; the rest is slack for a reconnect after its socket
 * dropped. Not one, because a Shim locked out by its own dead socket loses
 * delegation for the whole of its Session.
 */
export const MAX_CAPABILITY_CONNECTIONS = 4;

/** Connections the socket accepts at all, before anything has proved anything. */
export const MAX_CONNECTIONS = 64;

/**
 * How long a connection we have given up on may take to read why.
 *
 * Ending the socket alone leaves it half-closed, which a peer that never
 * finishes holds for as long as it likes — one of that capability's few
 * connections with it. Cutting it immediately loses the frame that says what
 * went wrong, because a reset discards what the peer has not read yet. So it is
 * ended, and reaped shortly after.
 */
const DEFAULT_ABORT_GRACE_MS = 1_000;

export interface IssuedCapability {
  /**
   * The secret the Shim presents. It travels in the Shim's environment, never
   * in its arguments: `/proc/<pid>/cmdline` and `ps` are readable by any local
   * process, and a secret anyone can read authenticates anyone.
   */
  readonly secret: string;
  /** Withdraws it: further calls are refused and any open connection is dropped. */
  revoke(): void;
}

export interface OrchestrationServerOptions {
  handler: OrchestrationHandler;
  /** Injectable so expiry is testable without waiting for a clock. */
  now?: () => number;
  maxFrameBytes?: number;
  handshakeTimeoutMs?: number;
  /** How long an aborted connection has to read why before it is reaped. */
  abortGraceMs?: number;
  /** Calls one connection may have outstanding before we stop reading from it. */
  maxInFlightCalls?: number;
  log?: LogPort;
}

export interface OrchestrationServer {
  /** Absolute socket path, or the named pipe on Windows. */
  readonly address: string;
  /** Mints a capability for one Session. Refuses a grant it could not enforce. */
  issue(grant: SessionCapability): IssuedCapability;
  close(): Promise<void>;
}

interface Registration {
  /** The secret's digest. The secret itself is handed out and never kept: a
   *  credential nothing reads is a credential nothing needs to hold. */
  digest: Buffer;
  grant: SessionCapability;
  /** Connections currently authenticated by it, so revoking can drop them. */
  holders: Set<net.Socket>;
}

function digestOf(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

/**
 * Compares two secrets without letting how long it took say how much matched.
 *
 * Hashed first so both sides are the same length: `timingSafeEqual` throws on a
 * length mismatch, and answering "wrong length" quickly is itself an answer.
 *
 * No test holds this. A timing property is not one a unit test can observe, so
 * what keeps it is reading — swapping this for `===` passes every test in the
 * suite, which is exactly why it is written down here.
 */
function sameSecret(digest: Buffer, presented: string): boolean {
  return timingSafeEqual(digest, digestOf(presented));
}

function validateGrant(grant: SessionCapability, now: number): void {
  if (!grant.sessionId) throw new Error("session capability: sessionId is required");
  if (!Number.isInteger(grant.depth) || grant.depth < 0) {
    throw new Error(`session capability: depth must be a non-negative integer, got ${grant.depth}`);
  }
  // A capability naming no workspace is one no call can be checked against, and
  // a check nothing can fail is not one — so it is refused at the mint.
  if (grant.roots.length === 0) throw new Error("session capability: at least one root is required");
  for (const root of grant.roots) {
    if (!isAbsolute(root)) throw new Error(`session capability: root must be absolute, got "${root}"`);
  }
  if (grant.methods.length === 0) throw new Error("session capability: at least one method is required");
  for (const method of grant.methods) {
    if (!ORCHESTRATION_METHODS.includes(method)) {
      throw new Error(`session capability: unknown method "${method}"`);
    }
  }
  if (!(grant.expiresAtMs > now)) throw new Error("session capability: expiry is already past");
}

/**
 * The address the Shim is given, and the permissions around it.
 *
 * A directory of our own, created 0700, rather than a socket loose in the
 * temporary directory: Linux honours the socket file's own mode and macOS
 * historically does not, but both honour the directory's — so the containing
 * directory is what the guarantee rests on. Windows named pipes carry no
 * filesystem mode at all, which is why the nonce is the whole of the secrecy
 * there and the capability is what actually authorises.
 */
async function bind(server: net.Server): Promise<{ address: string; cleanup: () => Promise<void> }> {
  const nonce = randomBytes(12).toString("hex");
  if (process.platform === "win32") {
    const address = `\\\\.\\pipe\\agent-conductor-${nonce}`;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(address, () => {
        server.off("error", reject);
        resolve();
      });
    });
    return { address, cleanup: async () => {} };
  }
  const directory = await mkdtemp(join(tmpdir(), "agent-conductor-"));
  const address = join(directory, "ipc.sock");
  const cleanup = (): Promise<void> => rm(directory, { recursive: true, force: true });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(address, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await chmod(address, 0o600);
  } catch (error) {
    // The directory exists from the line above whether or not the socket does,
    // so a failure here leaves one behind unless it is taken back.
    await cleanup();
    throw error;
  }
  return { address, cleanup };
}

export async function startOrchestrationServer(
  options: OrchestrationServerOptions,
): Promise<OrchestrationServer> {
  const now = options.now ?? Date.now;
  const maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const abortGraceMs = options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS;
  const maxInFlightCalls = options.maxInFlightCalls ?? MAX_IN_FLIGHT_CALLS;
  const registrations = new Set<Registration>();
  const connections = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    serve(socket);
  });
  // A backstop under the per-capability cap: connections that have proved
  // nothing yet are still descriptors, and the handshake deadline is 10 seconds
  // of them.
  server.maxConnections = MAX_CONNECTIONS;

  /**
   * Finishes with one connection: stop reading it, say why, then reap it.
   *
   * All three matter and none of them alone is enough. Reading stops because a
   * peer we have given up on is otherwise free to decide how much of this
   * process's memory to fill while it is being let go. The goodbye is a real
   * `end` rather than a cut, because a reset discards whatever the peer has not
   * read yet — including the frame saying what went wrong. And the reap is what
   * bounds the wait, since a half-closed socket the peer never finishes is a
   * descriptor held for as long as it likes.
   */
  function farewell(socket: net.Socket): void {
    socket.pause();
    socket.end();
    // Unref'd: this is a peer we have finished with, and nothing about it is
    // worth keeping a process alive for.
    const reap = setTimeout(() => socket.destroy(), abortGraceMs);
    reap.unref();
    socket.once("close", () => clearTimeout(reap));
  }

  /**
   * Ends a capability and every connection holding it.
   *
   * `lingering` is the one that has just been told why, and is let go rather
   * than cut so the answer gets out; the rest have nothing owed to them.
   */
  function retire(registration: Registration, lingering?: net.Socket): void {
    registrations.delete(registration);
    for (const holder of registration.holders) {
      if (holder === lingering) farewell(holder);
      else holder.destroy();
    }
  }

  function write(socket: net.Socket, frame: unknown): void {
    if (socket.destroyed) return;
    socket.write(`${JSON.stringify(frame)}\n`);
  }

  /**
   * Answers one call with a refusal.
   *
   * The message is bounded here rather than at each caller, because several of
   * them quote what the caller sent — a method name, a rejected value — and a
   * frame limit that the reply can exceed is not a limit on the conversation.
   */
  function fail(socket: net.Socket, id: unknown, code: Failure, message?: string): void {
    const said = message?.slice(0, MAX_ERROR_CHARS);
    write(socket, { id: id ?? null, error: { code, ...(said ? { message: said } : {}) } });
  }

  /**
   * Finds the capability a presented secret belongs to.
   *
   * Every registration is compared, with no early exit: stopping at the match
   * would make the time taken say where in the table it sat, and the table is
   * one entry per live Session. Like the comparison itself, nothing tests this
   * — a `break` here would pass the suite.
   */
  function lookup(presented: string): Registration | undefined {
    let found: Registration | undefined;
    for (const registration of registrations) {
      if (sameSecret(registration.digest, presented)) found = registration;
    }
    return found;
  }

  function serve(socket: net.Socket): void {
    let authorised: Registration | undefined;
    let pending: Buffer = Buffer.alloc(0);
    let inFlight = 0;

    // The handshake is the only thing on a deadline, and the deadline is a
    // fixed one rather than the socket's own idle timer: an idle timer is reset
    // by activity, so a peer sending one byte at a time would sit here for as
    // long as it liked, holding one of the connections every other Session
    // needs. Once a Shim is authorised its connection is quiet for as long as
    // its Session is, so the deadline is cleared rather than taught who to
    // spare.
    const handshake = setTimeout(() => socket.destroy(), handshakeTimeoutMs);
    handshake.unref();
    socket.once("close", () => clearTimeout(handshake));

    const abort = (code: Failure, message: string): void => {
      fail(socket, null, code, message);
      farewell(socket);
    };

    socket.on("close", () => authorised?.holders.delete(socket));
    // A Shim that dies mid-call takes its socket with it. Nothing here waits on
    // one, so an error is only worth not throwing.
    socket.on("error", () => socket.destroy());
    socket.on("drain", () => pump());

    /**
     * Reads what has arrived, a frame at a time, and stops reading while this
     * connection has more outstanding than we will hold for it.
     *
     * Called again whenever that changes — a call finishing, a write draining —
     * because the bytes already read stay in `pending`, and no further `data`
     * event will arrive to remind us they are there.
     */
    function pump(): void {
      for (;;) {
        // Once we have said goodbye we are done reading, whichever way we got
        // there — a refusal, or a capability that lapsed under an open
        // connection. Asked of the socket rather than kept in a flag beside it,
        // because a flag only one of those paths sets is a pause only one of
        // them keeps; and asked every turn rather than on entry, because the frame
        // this loop just dispatched is one of the things that ends a
        // connection, and the next turn would resume the socket it just paused.
        if (socket.writableEnded) return;
        if (inFlight >= maxInFlightCalls || socket.writableNeedDrain) {
          socket.pause();
          return;
        }
        if (socket.isPaused()) socket.resume();
        // Per line, not per chunk: a Shim that connects and calls in the same
        // breath puts both in one read, and the handshake's own tight limit
        // still being in force behind it would refuse every real brief.
        const limit = authorised ? maxFrameBytes : MAX_SECRET_LINE_BYTES;
        const cut = pending.indexOf(0x0a);
        if (cut < 0) {
          // Bounded as it is read, not once it is whole: a frame that never ends
          // must be refused before it is held, not after.
          if (pending.length > limit) abort("too_large", `frame exceeds ${limit} bytes`);
          return;
        }
        const line = pending.subarray(0, cut);
        pending = pending.subarray(cut + 1);
        if (line.length > limit) {
          abort("too_large", `frame exceeds ${limit} bytes`);
          return;
        }

        if (!authorised) {
          const registration = lookup(line.toString("utf8").trim());
          // Left in the table a lapsed capability would sit there for the life
          // of the window — in a table every handshake reads all of, by design.
          if (registration && registration.grant.expiresAtMs <= now()) retire(registration);
          if (!registration || !registrations.has(registration)) {
            // The same answer either way: which of the two it was is exactly
            // what a caller holding a guess would like to be told.
            abort("unauthorized", "no such capability");
            return;
          }
          if (registration.holders.size >= MAX_CAPABILITY_CONNECTIONS) {
            abort("unauthorized", "too many connections for this capability");
            return;
          }
          registration.holders.add(socket);
          authorised = registration;
          clearTimeout(handshake);
          continue;
        }

        const text = line.toString("utf8");
        if (!text.trim()) continue;
        const frame = readFrame(text);
        if (!frame) {
          abort("invalid_frame", "a request is an object with an id, a method and params");
          return;
        }
        inFlight += 1;
        void dispatch(socket, authorised, frame)
          // Caught here, where every call routes through, rather than trusted
          // not to happen: an unanswered call is the one failure the Shim
          // cannot recover from — it waits on that id for the rest of the
          // Agent's turn — so a throw on the way to an answer must still
          // produce one, whatever the frame did to cause it.
          .catch(() => fail(socket, frame.id, "failed", "orchestration call failed"))
          .finally(() => {
            inFlight -= 1;
            pump();
          });
      }
    }

    socket.on("data", (chunk: Buffer) => {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      pump();
    });
  }

  async function dispatch(
    socket: net.Socket,
    registration: Registration,
    { id, method, params }: RequestFrame,
  ): Promise<void> {
    // Per call, not once at the handshake. A connection outlives the moment it
    // was opened, and so does what it has already sent: a frame read before the
    // capability was withdrawn can still be waiting its turn behind a slow one
    // when it is, and that frame must not reach the Orchestrator.
    if (!registrations.has(registration)) return fail(socket, id, "unauthorized", "capability revoked");
    const { grant } = registration;
    if (grant.expiresAtMs <= now()) {
      fail(socket, id, "unauthorized", "capability expired");
      // Refusing the call is not enough: a lapsed capability that still holds a
      // socket is an authority nothing can take back and a descriptor nothing
      // reaps. It ends the same way a revoked one does.
      return retire(registration, socket);
    }

    const known = ORCHESTRATION_METHODS.find((candidate) => candidate === method);
    if (!known) return fail(socket, id, "unknown_method", `no method "${String(method)}"`);
    if (!grant.methods.includes(known)) {
      return fail(socket, id, "unauthorized", `capability does not allow "${known}"`);
    }

    const parsed = PARAMS[known].safeParse(params ?? {});
    if (!parsed.success) {
      return fail(socket, id, "invalid_params", parsed.error.issues[0]?.message ?? "invalid params");
    }

    try {
      const call = { method: known, params: parsed.data, grant } as OrchestrationCall;
      const result = await options.handler(call);
      const encoded = JSON.stringify({ id, result: result ?? null });
      if (Buffer.byteLength(encoded, "utf8") + 1 > maxFrameBytes) {
        return fail(socket, id, "too_large", "result exceeds the frame limit");
      }
      if (!socket.destroyed) socket.write(`${encoded}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.log?.log("debug", `orchestration call failed: ${message}`);
      fail(socket, id, "failed", message);
    }
  }

  const { address, cleanup } = await bind(server);

  return {
    address,
    issue(grant) {
      validateGrant(grant, now());
      const secret = randomBytes(32).toString("base64url");
      const registration: Registration = {
        digest: digestOf(secret),
        grant: { ...grant, roots: [...grant.roots], methods: [...grant.methods] },
        holders: new Set(),
      };
      registrations.add(registration);
      return {
        secret,
        revoke() {
          retire(registration);
        },
      };
    },
    async close() {
      registrations.clear();
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await cleanup();
    },
  };
}
