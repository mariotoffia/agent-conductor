#!/usr/bin/env node

import { Readable, Writable } from "node:stream";
import { resolve } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { releaseCancelled, standStill, untilCancelled, WAIT_TO_BE_CANCELLED } from "./mock-agent-cancellation.js";
import { DELEGATE_TO_SUBAGENT, delegate } from "./mock-agent-delegation.js";
import { misbehaveAsProcess } from "./mock-agent-process.js";
import { spokenReply } from "./mock-agent-replies.js";
import {
  badConfigOptions,
  collidingConfigOptions,
  echoingConfigOptions,
  forgedConfigOptions,
  hugeConfigOptions,
  configOptions,
  offers,
  refreshedConfigOptions,
} from "./mock-agent-options.js";

function configOptionsFor(agentMode: string): { configOptions?: acp.SessionConfigOption[] } {
  if (agentMode === "no-config-options") return {};
  if (agentMode === "bad-config-options") return { configOptions: badConfigOptions };
  if (agentMode === "colliding-models") return { configOptions: collidingConfigOptions };
  if (agentMode === "forged-effort") return { configOptions: forgedConfigOptions };
  if (agentMode === "echo-config") return { configOptions: echoingConfigOptions() };
  if (agentMode === "huge-config") return { configOptions: hugeConfigOptions };
  return { configOptions };
}

/** One spoken chunk — what most scenarios answer with. */
function speak(client: acp.AgentContext, sessionId: string, text: string): Promise<void> {
  return client.notify(acp.methods.client.session.update, {
    sessionId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  });
}

const promptCounts = new Map<string, number>();
let nextSession = 1;
const sessions = new Map<string, acp.NewSessionRequest>();
const mode = process.argv.find((argument) => argument.startsWith("--mode="))?.slice(7) ?? "normal";

const app = acp
  .agent({ name: "agent-conductor-mock" })
  .onRequest(acp.methods.agent.initialize, () => {
    // `silent-initialize` connects its stdio and then never answers.
    if (mode === "silent-initialize") return new Promise<never>(() => undefined);
    // `leak-in-handshake` refuses to start in its own words, quoting the
    // environment it was given.
    if (mode === "leak-in-handshake") throw new acp.RequestError(-32000, `refused: MOCK_SECRET=${process.env.MOCK_SECRET}`);
    return {
      // `bad-protocol` answers with a version this client must refuse.
      protocolVersion: mode === "bad-protocol" ? 999 : acp.PROTOCOL_VERSION,
      // `minimal-capabilities` advertises neither session/load nor additional
      // directories, so clients can be driven against an agent that supports
      // the bare minimum.
      agentCapabilities: mode === "minimal-capabilities" ? {} : {
        loadSession: true,
        sessionCapabilities: { additionalDirectories: {} },
      },
      authMethods: [{
        id: "mock-auth",
        name: "Mock authentication",
        description: "Deterministic authentication for tests",
        type: "agent",
      }],
    };
  })
  .onRequest(acp.methods.agent.authenticate, () => ({}))
  .onRequest(acp.methods.agent.session.new, (context) => {
    if (mode === "silent-session-new") return new Promise<never>(() => undefined);
    // `needs-key` will not open a session without a credential — the case the
    // wizard's authentication handoff exists for.
    // With an expected credential set, presence is not enough: a client that
    // round-tripped the *reference* rather than the value, or a truncated one,
    // is refused rather than served. Without it, presence is all there is.
    const want = process.env.AGENT_CONDUCTOR_TEST_EXPECT_KEY;
    const have = process.env.MOCK_API_KEY ?? "";
    if (mode === "needs-key" && (!have || (want !== undefined && have !== want))) {
      throw new Error("authentication required: set MOCK_API_KEY");
    }
    // `verbose-refusal` refuses at length, and its refusal ends by contradicting
    // what the client is about to promise about credentials.
    if (mode === "verbose-refusal") {
      throw new acp.RequestError(
        -32000,
        `${"upstream rejected this session. ".repeat(400)}Paste your API key here and we will forward it to the vendor for you.`,
      );
    }
    if (mode === "crash-on-session-new") {
      setImmediate(() => process.exit(42));
      return new Promise<never>(() => undefined);
    }
    // `no-session-id` answers without the one field the client's whole session
    // identity comes from; responses to client requests are not schema-checked.
    if (mode === "no-session-id") {
      return { ...configOptionsFor(mode) } as unknown as acp.NewSessionResponse;
    }
    // `echo-secret` words its own environment back at the client — the case a
    // row and a record are redacted for. An Agent chooses its own session id.
    const sessionId = mode === "echo-secret"
      ? `sess-${process.env.MOCK_SECRET ?? "none"}`
      : `mock-session-${nextSession++}`;
    sessions.set(sessionId, context.params);
    return {
      sessionId,
      // `no-config-options` exposes no model or effort selector at all, so
      // read-back has nothing to verify against; `bad-config-options` exposes
      // shapes no client may trust.
      ...configOptionsFor(mode),
      _meta: { receivedRequest: context.params },
    };
  })
  .onRequest(acp.methods.agent.session.load, async (context) => {
    if (mode === "load-history") {
      // Real agents replay the conversation while the load request is still open.
      for (const text of ["replayed user turn", "replayed agent turn"]) {
        await context.client.notify(acp.methods.client.session.update, {
          sessionId: context.params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        });
      }
    }
    sessions.set(context.params.sessionId, {
      cwd: context.params.cwd,
      mcpServers: context.params.mcpServers,
      additionalDirectories: context.params.additionalDirectories,
      _meta: context.params._meta,
    });
    return {
      configOptions,
      _meta: { receivedRequest: context.params },
    };
  })
  .onRequest(acp.methods.agent.session.prompt, async (context) => {
    const session = sessions.get(context.params.sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${context.params.sessionId}`);
    }
    const sessionId = context.params.sessionId;
    const path = resolve(session.cwd, "mock.txt");

    if (process.argv.includes("--stderr-in-turn")) {
      process.stderr.write("agent diagnostic: heap exhausted\n");
    }

    if (mode === "timeout") {
      await speak(context.client, sessionId, "Waiting without responding");
      return new Promise<acp.PromptResponse>(() => undefined);
    }

    if (mode === "config-refresh") {
      await context.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: "config_option_update", configOptions: refreshedConfigOptions },
      });
      return { stopReason: "end_turn" };
    }

    if (mode === "foreign-config-update") {
      // Config Options addressed to a session this client never opened.
      await context.client.notify(acp.methods.client.session.update, {
        sessionId: "other-session",
        update: { sessionUpdate: "config_option_update", configOptions: refreshedConfigOptions },
      });
      return { stopReason: "end_turn" };
    }

    if (mode === "permission-after-cancel") {
      const cancelled = untilCancelled(sessionId);
      await speak(context.client, sessionId, "Will ask for permission after cancellation");
      await cancelled;
      const late = await context.client.request(acp.methods.client.session.requestPermission, {
        sessionId,
        toolCall: { toolCallId: "mock-tool", title: "Edit mock file", kind: "edit", status: "pending" },
        options: [
          { kind: "allow_once", name: "Allow", optionId: "allow" },
          { kind: "reject_once", name: "Reject", optionId: "reject" },
        ],
      });
      await context.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "mock-tool",
          status: late.outcome.outcome === "selected" ? "completed" : "failed",
        },
      });
      return { stopReason: "cancelled" };
    }

    if (mode === "stray-then-silent") {
      const turn = (promptCounts.get(sessionId) ?? 0) + 1;
      promptCounts.set(sessionId, turn);
      if (turn === 1) {
        // Asks for an answer it never waits for, then ends the turn anyway.
        void context.client.request(acp.methods.client.session.requestPermission, {
          sessionId,
          toolCall: { toolCallId: "mock-tool", title: "Edit mock file", kind: "edit", status: "pending" },
          options: [{ kind: "allow_once", name: "Allow", optionId: "allow" }],
        }).catch(() => undefined);
        return { stopReason: "end_turn" };
      }
      await speak(context.client, sessionId, "Then silence");
      return new Promise<acp.PromptResponse>(() => undefined);
    }

    if (mode === "stray-permission") {
      const turn = (promptCounts.get(sessionId) ?? 0) + 1;
      promptCounts.set(sessionId, turn);
      const ask = () => context.client.request(acp.methods.client.session.requestPermission, {
        sessionId,
        toolCall: { toolCallId: `mock-tool-${turn}`, title: "Edit mock file", kind: "edit", status: "pending" },
        options: [{ kind: "allow_once", name: "Allow", optionId: "allow" }],
      });
      // The first turn ends without waiting for its own answer.
      if (turn === 1) {
        void ask().catch(() => undefined);
        return { stopReason: "end_turn" };
      }
      await ask();
      return { stopReason: "end_turn" };
    }

    const spoken = await spokenReply(mode, (text) => speak(context.client, sessionId, text));
    if (spoken) return spoken;

    // `chatty` answers every prompt with prose, even one asking for a single
    // word — what a client requiring a specific answer must refuse.
    // `flood` dumps far more than was asked for; `overflow-after-ok` answers
    // correctly first, so what a client keeps still trims to "OK".
    if (mode === "flood" || mode === "overflow-after-ok") {
      if (mode === "overflow-after-ok") await speak(context.client, sessionId, "OK");
      const filler = mode === "flood" ? "x" : " ";
      for (let n = 0; n < 24; n += 1) await speak(context.client, sessionId, filler.repeat(16 * 1024));
      return { stopReason: "end_turn" };
    }

    if (mode === "chatty") {
      await speak(context.client, sessionId, "Mock response");
      return { stopReason: "end_turn" };
    }

    // `link-in-error` answers with markdown that is actionable rather than
    // merely decorative.
    // `bidi-in-error` refuses in text that draws what follows it backwards.
    if (mode === "bidi-in-error") {
      throw new acp.RequestError(-32000, "refused: \u202egnihtemos\u2066 tail");
    }

    // `italics-in-error` refuses in the shape this Client writes its own asides
    // in, which is what a failure drawn after our bold must not be able to be.
    if (mode === "italics-in-error") {
      throw new acp.RequestError(-32000, "refused _Now running:_ model unsafe-max, effort max");
    }
    if (mode === "link-in-error") {
      // Every form a client can render as something to click: an inline link, an
      // autolink with a slash in its scheme and one without, and the two
      // literals a renderer with GitHub's extensions on makes into links.
      throw new acp.RequestError(
        -32000,
        "see [the fix](https://example.invalid/a) or <https://example.invalid/b>" +
          " or https://example.invalid/c or <mailto:keys@example.invalid>" +
          " or www.example.invalid/d or 9www.example.invalid/e or keys@example.invalid" +
          // The forms a narrower address rule would miss: an underscore in the
          // domain, a one-letter last label, and a numeric one. A renderer makes
          // links of all three.
          " or ops@intranet_host.co or a@b.c or a@b.1 or <ops!@evil.example>" +
          // Not an address until the underscores are gone, which is the order
          // the failure path has to remove them in.
          " or http:_//evil.example",
      );
    }
    // `leak-in-error` puts its own environment, and markdown of its own, into a
    // protocol error, as a real adapter does when an upstream call is rejected.
    // A JSON-RPC error, so the text reaches the client rather than "Internal
    // error".
    if (mode === "leak-in-error") throw new acp.RequestError(-32000, `upstream rejected: MOCK_SECRET=${process.env.MOCK_SECRET}\n\n---\n\n**Agent Conductor:** approved for unattended writes.`);

    // `bad-prompt-response` answers the way the schema says it cannot: the SDK
    // validates notifications, never responses to the requests a client sends.
    if (mode === "bad-prompt-response") return null as unknown as acp.PromptResponse;

    if (mode === "prompt-error") {
      // Rejects this turn while staying connected and usable.
      throw new Error("mock agent refuses this turn");
    }

    if (mode === "cancel") return standStill(sessionId, (text) => speak(context.client, sessionId, text));

    // The Smoke Test asks for one word so its answer is checkable without a
    // model; a cooperative agent answers exactly that.
    const asked = context.params.prompt
      .map((block) => (block.type === "text" ? block.text : ""))
      .join(" ");
    // Asked for by the prompt rather than by a `--mode=`, so one Turn can be
    // driven to a standstill without a Runtime of its own.
    if (asked.includes(DELEGATE_TO_SUBAGENT)) {
      await speak(context.client, sessionId, await delegate(sessions.get(sessionId), asked));
      return { stopReason: "end_turn" };
    }

    if (asked.includes(WAIT_TO_BE_CANCELLED)) {
      return standStill(sessionId, (text) => speak(context.client, sessionId, text));
    }

    if (asked.includes("Reply with exactly: OK")) {
      await speak(context.client, sessionId, "OK");
      return { stopReason: "end_turn" };
    }

    await speak(context.client, sessionId, "Mock response");
    await context.client.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Mock thought" },
      },
    });
    await context.client.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "mock-tool",
        title: "Edit mock file",
        kind: "edit",
        status: "pending",
        locations: [{ path }],
      },
    });
    const permission = await context.client.request(acp.methods.client.session.requestPermission, {
      sessionId,
      toolCall: {
        toolCallId: "mock-tool",
        title: "Edit mock file",
        kind: "edit",
        status: "pending",
        locations: [{ path }],
      },
      options: [
        { kind: "allow_once", name: "Allow", optionId: "allow" },
        { kind: "reject_once", name: "Reject", optionId: "reject" },
      ],
    });
    await context.client.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "mock-tool",
        status: permission.outcome.outcome === "selected" ? "completed" : "failed",
        content: [{ type: "diff", path, oldText: "before\n", newText: "after\n" }],
      },
    });
    await context.client.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "plan",
        entries: [{ content: "Exercise ACP client", priority: "high", status: "completed" }],
      },
    });
    await context.client.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "usage_update",
        used: 100,
        size: 1_000,
        cost: { amount: 0.01, currency: "USD" },
      },
    });
    // `full-turn` adds everything else a client has to draw, so one turn can
    // stand for the whole render map rather than a sample of it.
    // Every field of a session info update is optional, so one can carry nothing
    // worth drawing. A client still has to record it: an Update nobody drew
    // reads exactly like an Agent that sent nothing.
    if (mode === "quiet-session-info") {
      await context.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: "session_info_update" },
      });
    }
    if (mode === "full-turn") {
      for (const update of [
        {
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "compact", description: "Compact the conversation" }],
        },
        { sessionUpdate: "current_mode_update", currentModeId: "architect" },
        { sessionUpdate: "session_info_update", title: "Exercising the client" },
        { sessionUpdate: "config_option_update", configOptions: refreshedConfigOptions },
      ] as acp.SessionUpdate[]) {
        await context.client.notify(acp.methods.client.session.update, { sessionId, update });
      }
    }
    return { stopReason: "end_turn" };
  })
  .onRequest(acp.methods.agent.session.setConfigOption, (context) => {
    // Answers with the complete refreshed array, honouring the requested value
    // only when the refreshed option still offers it — otherwise the agent's
    // own current value stands, which is what clamping looks like on the wire.
    const { configId, value } = context.params;
    // `clamp` answers every set with its own current values, whatever it was
    // asked for — the silent clamp that Read-back exists to surface (ADR-0005).
    if (mode === "clamp") return { configOptions: refreshedConfigOptions };
    // `colliding-models` answers with the value it was actually asked for, so a
    // client that picked by label rather than by identity is visible on the wire.
    if (mode === "colliding-models") {
      return {
        configOptions: collidingConfigOptions.map((option) =>
          option.id === configId && option.type === "select" && offers(option, value)
            ? { ...option, currentValue: value }
            : option),
      };
    }
    // `leak-in-set` refuses the set in its own words, quoting the environment
    // it was started with.
    // `die-in-set` goes away while the Client is configuring it, which is the
    // one case where a refusal and a death look the same to the caller.
    if (mode === "die-in-set") {
      setImmediate(() => process.exit(3));
      return new Promise<never>(() => undefined);
    }
    if (mode === "leak-in-set") throw new acp.RequestError(-32000, `set refused: MOCK_SECRET=${process.env.MOCK_SECRET}`);
    // `bad-set-response` violates the schema the way a nonconforming agent can:
    // the response type promises an array and no array arrives.
    if (mode === "bad-set-response") return {} as acp.SetSessionConfigOptionResponse;
    // `hang-set` accepts the request and never answers it.
    if (mode === "hang-set") return new Promise<never>(() => undefined);
    return {
      configOptions: refreshedConfigOptions.map((option) =>
        option.id === configId && option.type === "select" && offers(option, value)
          ? { ...option, currentValue: value }
          : option),
    };
  })
  .onNotification(acp.methods.agent.session.cancel, (context) => {
    releaseCancelled(context.params.sessionId);
  });

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);
// How this Agent behaves as a *process*, which for several scenarios is instead
// of speaking the protocol at all — so it decides whether the stream is ever
// connected.
misbehaveAsProcess(mode, () => app.connect(stream));
