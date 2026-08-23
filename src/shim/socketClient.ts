/**
 * The Shim's end of the orchestration socket.
 *
 * Deliberately its own small NDJSON client rather than anything shared with the
 * extension: this file is bundled into `dist/mcp-shim.cjs` and runs in a process
 * an Agent's harness started, so it imports neither the core nor VS Code
 * (ARCHITECTURE.md §Layering rules). What the two ends agree on is the frame —
 * one JSON object per line — and the extension re-validates every field of it,
 * because nothing here is in a position to be trusted.
 */
import net from "node:net";

/**
 * Matches the server's own bound. A longer line means a peer we cannot follow.
 *
 * A copy rather than an import, because this file is bundled apart from the
 * core and may not reach into it — so a test is what holds the two together.
 */
export const MAX_FRAME_BYTES = 1_000_000;

export interface OrchestratorLink {
  /** Sends one call and waits for its answer. Rejects with what went wrong. */
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

interface Waiting {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export function connectOrchestrator(address: string, secret: string): OrchestratorLink {
  const waiting = new Map<number, Waiting>();
  let link: Promise<net.Socket> | undefined;
  let nextId = 1;
  let closed = false;

  /** Fails everything outstanding — a socket that ended answers nothing more. */
  function abandon(reason: string): void {
    const error = new Error(reason);
    for (const [id, pending] of waiting) {
      waiting.delete(id);
      pending.reject(error);
    }
  }

  function deliver(line: string): void {
    let frame: { id?: unknown; result?: unknown; error?: { code?: string; message?: string } };
    try {
      frame = JSON.parse(line) as typeof frame;
    } catch {
      abandon(`orchestrator sent a frame that is not JSON: ${line.slice(0, 200)}`);
      return;
    }
    const described = frame.error
      ? `${frame.error.code ?? "failed"}${frame.error.message ? `: ${frame.error.message}` : ""}`
      : undefined;
    // A failure with no id is the connection's, not one call's — a refused
    // handshake arrives this way, and every waiting call is already lost.
    if (typeof frame.id !== "number") {
      abandon(described ?? "orchestrator sent an answer to nothing");
      return;
    }
    const pending = waiting.get(frame.id);
    if (!pending) return;
    waiting.delete(frame.id);
    if (described) pending.reject(new Error(described));
    else pending.resolve(frame.result);
  }

  function open(): Promise<net.Socket> {
    if (link) return link;
    link = new Promise<net.Socket>((resolve, reject) => {
      const socket = net.connect(address);
      let pending: Buffer = Buffer.alloc(0);
      socket.once("error", reject);
      socket.on("connect", () => {
        socket.off("error", reject);
        // The capability first, on its own line: nothing else is read until it
        // has been accepted.
        socket.write(`${secret}\n`);
        resolve(socket);
      });
      socket.on("data", (chunk: Buffer) => {
        pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
        for (;;) {
          const cut = pending.indexOf(0x0a);
          if (cut < 0) {
            if (pending.length > MAX_FRAME_BYTES) {
              abandon("orchestrator sent a frame beyond the size limit");
              socket.destroy();
            }
            return;
          }
          if (cut > MAX_FRAME_BYTES) {
            // Both ways a frame can be too long, as the server checks both: one
            // that never ends, and one whose ending arrives past the limit.
            abandon("orchestrator sent a frame beyond the size limit");
            socket.destroy();
            return;
          }
          const line = pending.subarray(0, cut).toString("utf8");
          pending = pending.subarray(cut + 1);
          if (line.trim()) deliver(line);
        }
      });
      socket.on("error", (error: Error) => abandon(`orchestrator socket failed: ${error.message}`));
      socket.on("close", () => {
        // Forgotten rather than remembered as broken: an Agent's harness may
        // restart nothing, and a Session whose socket blipped should be able to
        // ask again rather than be told no for the rest of its life.
        if (link) link = undefined;
        abandon("orchestrator socket closed");
      });
    });
    return link;
  }

  return {
    async call(method, params) {
      if (closed) throw new Error("orchestrator link is closed");
      const socket = await open();
      const id = nextId++;
      return new Promise<unknown>((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        socket.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
          if (!error) return;
          waiting.delete(id);
          reject(new Error(`orchestrator socket failed: ${error.message}`));
        });
      });
    },
    close() {
      closed = true;
      const open = link;
      link = undefined;
      void open?.then((socket) => socket.destroy()).catch(() => {});
      abandon("orchestrator link is closed");
    },
  };
}
