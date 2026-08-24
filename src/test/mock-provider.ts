import { createServer, type Server } from "node:http";

/**
 * A model endpoint for tests: OpenAI-compatible, canned answers, no network.
 *
 * Not every agent CLI brings its own model. DeepSeek Harness talks to a provider
 * the user hosts, so a live run of it would otherwise prove only whether that
 * machine happened to be up — and fail, loudly and uninterestingly, whenever it
 * was not. Pointed here instead, the run proves what it is actually for: that
 * this Client can drive that CLI through a whole Turn.
 *
 * It answers what a harness asks of a provider and nothing more: one model, and
 * one completion. There is no authentication — a key of any value is accepted,
 * because what a CLI insists on holding is its own business and none of it is
 * real here.
 */

/** What the mock says when asked to complete anything. The Smoke Test's answer,
 *  since proving a Turn arrives is the whole reason this exists. */
export const MOCK_COMPLETION = "OK";

export interface MockProvider {
  /** Base URL a provider config points at, `/v1` included. */
  url: string;
  /** Completions asked for so far; a Turn that never reached the model is a
   *  different failure from one the model answered badly. */
  completions: number;
  close(): Promise<void>;
}

/** Starts one on a port the operating system chooses, bound to loopback: a test
 *  fixture that listens on every interface is a service nobody meant to run. */
export async function startMockProvider(reply: string = MOCK_COMPLETION): Promise<MockProvider> {
  const state = { completions: 0 };
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      const send = (status: number, payload: unknown): void => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      if (request.url?.endsWith("/models")) {
        send(200, { object: "list", data: [{ id: MOCK_MODEL, object: "model" }] });
        return;
      }
      state.completions += 1;
      // Both shapes, because harnesses differ and one of them asked: the same
      // answer delivered as events, ending with the sentinel a client waits for.
      if (wantsStream(body)) {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const event = (delta: unknown, finish: string | null): string =>
          `data: ${JSON.stringify({
            id: "chatcmpl-mock",
            object: "chat.completion.chunk",
            created: 0,
            model: MOCK_MODEL,
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`;
        response.write(event({ role: "assistant", content: "" }, null));
        response.write(event({ content: reply }, null));
        response.write(event({}, "stop"));
        response.end("data: [DONE]\n\n");
        return;
      }
      send(200, {
        id: "chatcmpl-mock",
        object: "chat.completion",
        created: 0,
        model: MOCK_MODEL,
        choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the mock provider did not report a port to point a runtime at");
  }
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    get completions() {
      return state.completions;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // Whatever a CLI left open goes with it: a fixture that waits for a
        // peer to hang up is a suite that hangs.
        server.closeAllConnections();
      }),
  };
}

/**
 * Whether the caller asked for events rather than one body.
 *
 * Read out of the parsed request, not matched in its text: a message that
 * merely mentions the field would otherwise choose the shape of the answer.
 * A body that is not JSON is not a request for a stream — the completion path
 * answers it and the client sees an ordinary reply.
 */
function wantsStream(body: string): boolean {
  try {
    return (JSON.parse(body) as { stream?: unknown }).stream === true;
  } catch {
    return false;
  }
}

/** The only model it serves. A provider config naming another gets it anyway,
 *  which is the honest behaviour for a fixture: nothing here is a real choice. */
export const MOCK_MODEL = "mock-model";
