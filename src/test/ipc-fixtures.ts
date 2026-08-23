import net from "node:net";
import type { TestContext } from "node:test";
import {
  startOrchestrationServer,
  type OrchestrationCall,
  type OrchestrationServer,
  type OrchestrationServerOptions,
  type SessionCapability,
} from "../core/index.js";

/** What a Session would issue a Shim: everything an issuer has to decide. */
export const SHIM_CAPABILITY: SessionCapability = {
  sessionId: "parent-session",
  depth: 0,
  roots: ["/workspace"],
  expiresAtMs: 60_000,
  methods: ["list_runtimes", "spawn_subagent", "check_subagent", "subagent_result", "cancel_subagent"],
};

/** An orchestration server that closes with the test that started it. */
export async function ipcServer(
  t: TestContext,
  options: OrchestrationServerOptions,
): Promise<OrchestrationServer> {
  const server = await startOrchestrationServer(options);
  t.after(() => server.close());
  return server;
}

/**
 * A deliberately unhelpful client for the orchestration socket.
 *
 * The Shim's own client is the thing under test on the happy path, so it cannot
 * also be what sends the malformed handshake, the oversized frame and the half
 * line — a client that refuses to produce bad input can only ever prove the
 * server is never given any. This one writes exactly the bytes it is told to.
 */
export interface RawClient {
  /** Resolves once the server has this connection, or rejects if it will not. */
  ready: Promise<void>;
  /** Writes one line: the text plus the newline the protocol frames on. */
  send(line: string): Promise<void>;
  /** Writes bytes verbatim — no newline, no framing, no encoding help. */
  sendRaw(bytes: string | Buffer): Promise<void>;
  /** The next line the server sent, or `undefined` once it closed or went quiet. */
  readLine(deadlineMs?: number): Promise<string | undefined>;
  /** Resolves true when the server ends the connection, false on a deadline. */
  closed(deadlineMs?: number): Promise<boolean>;
  /** Sends one frame and reads back the answer to it. */
  request(frame: unknown): Promise<Record<string, unknown> | undefined>;
  /** Disappears the way a Shim whose process died does: no goodbye. */
  destroy(): Promise<void>;
  /** Bytes this client has written that the server has not taken yet. */
  unread(): number;
}

/** A server holding `SHIM_CAPABILITY`, and a client that has already presented it. */
export async function connectedShim(
  t: TestContext,
  handler: (call: OrchestrationCall) => Promise<unknown>,
  options: Partial<OrchestrationServerOptions> = {},
): Promise<{ client: RawClient; server: OrchestrationServer }> {
  const server = await ipcServer(t, { handler, now: () => 0, ...options });
  const capability = server.issue(SHIM_CAPABILITY);
  const client = rawClient(t, server.address);
  await client.send(capability.secret);
  return { client, server };
}

/** The failure code an answer carries, if it carries one. */
export function errorCode(answer: Record<string, unknown> | undefined): string | undefined {
  return (answer?.error as { code?: string } | undefined)?.code;
}

export function rawClient(
  t: TestContext,
  address: string,
  options: { allowHalfOpen?: boolean; readAnswers?: boolean } = {},
): RawClient {
  // `allowHalfOpen` makes a client that ignores the server's goodbye, which is
  // the only kind that can show whether the server reaps what it ended.
  // `readAnswers: false` makes one that never reads them at all, which is the
  // only kind that can fill the server's write buffer.
  const socket = net.connect({ path: address, allowHalfOpen: options.allowHalfOpen ?? false });
  if (options.readAnswers === false) socket.pause();
  socket.setEncoding("utf8");
  t.after(() => {
    socket.destroy();
  });

  const ready = new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  const lines: string[] = [];
  let pending = "";
  let ended = false;
  let wake: (() => void) | undefined;
  const arrived = (): void => {
    wake?.();
    wake = undefined;
  };

  if (options.readAnswers !== false) socket.on("data", (chunk: string) => {
    pending += chunk;
    let cut = pending.indexOf("\n");
    while (cut >= 0) {
      lines.push(pending.slice(0, cut));
      pending = pending.slice(cut + 1);
      cut = pending.indexOf("\n");
    }
    arrived();
  });
  socket.on("close", () => {
    ended = true;
    arrived();
  });
  socket.on("error", () => {
    ended = true;
    arrived();
  });

  const write = (text: string | Buffer): Promise<void> =>
    new Promise((resolve, reject) => {
      socket.write(text, (error) => (error ? reject(error) : resolve()));
    });

  const settle = (): Promise<void> =>
    new Promise((resolve) => {
      wake = resolve;
    });

  const timer = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms).unref();
    });

  return {
    ready,
    async send(line) {
      await write(`${line}\n`);
    },
    async sendRaw(bytes) {
      await write(bytes);
    },
    // On a deadline, because the assertion that follows almost always reads
    // "the refusal must be said": a server that stops answering would otherwise
    // hang the whole file, and a run with no result is worse than a red one.
    async readLine(deadlineMs = 5_000) {
      const expiry = Date.now() + deadlineMs;
      while (lines.length === 0 && !ended && Date.now() < expiry) {
        await Promise.race([settle(), timer(Math.max(0, expiry - Date.now()))]);
      }
      return lines.shift();
    },
    async request(frame) {
      await write(`${JSON.stringify(frame)}\n`);
      const answer = await this.readLine();
      return answer === undefined ? undefined : (JSON.parse(answer) as Record<string, unknown>);
    },
    unread() {
      return socket.writableLength;
    },
    async destroy() {
      socket.destroy();
      while (!ended) await settle();
    },
    async closed(deadlineMs = 2_000) {
      if (ended) return true;
      await Promise.race([settle(), timer(deadlineMs)]);
      return ended;
    },
  };
}
