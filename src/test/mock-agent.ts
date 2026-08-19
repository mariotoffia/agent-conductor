#!/usr/bin/env node

import { Readable, Writable } from "node:stream";
import { resolve } from "node:path";
import * as acp from "@agentclientprotocol/sdk";

const configOptions: acp.SessionConfigOption[] = [
  {
    type: "select",
    id: "model",
    name: "Model",
    category: "model",
    currentValue: "mock-model",
    options: [{ value: "mock-model", name: "Mock Model" }],
  },
  {
    type: "select",
    id: "effort",
    name: "Effort",
    category: "thought_level",
    currentValue: "medium",
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
    ],
  },
];

/** Config Options after a change: a different model and fewer effort values. */
const refreshedConfigOptions: acp.SessionConfigOption[] = [
  {
    type: "select",
    id: "model",
    name: "Model",
    category: "model",
    currentValue: "mock-model-fast",
    options: [
      { value: "mock-model", name: "Mock Model" },
      { value: "mock-model-fast", name: "Mock Model Fast" },
    ],
  },
  {
    type: "select",
    id: "effort",
    name: "Effort",
    category: "thought_level",
    currentValue: "low",
    options: [{ value: "low", name: "Low" }],
  },
];

const promptCounts = new Map<string, number>();
let nextSession = 1;
const sessions = new Map<string, acp.NewSessionRequest>();
const pendingCancellations = new Map<string, () => void>();
const mode = process.argv.find((argument) => argument.startsWith("--mode="))?.slice(7) ?? "normal";

const app = acp
  .agent({ name: "agent-conductor-mock" })
  .onRequest(acp.methods.agent.initialize, () => {
    // `silent-initialize` connects its stdio and then never answers.
    if (mode === "silent-initialize") return new Promise<never>(() => undefined);
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
    if (mode === "crash-on-session-new") {
      setImmediate(() => process.exit(42));
      return new Promise<never>(() => undefined);
    }
    const sessionId = `mock-session-${nextSession++}`;
    sessions.set(sessionId, context.params);
    return {
      sessionId,
      configOptions,
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
      await context.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Waiting without responding" },
        },
      });
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
      const cancelled = new Promise<void>((resolveCancellation) => {
        pendingCancellations.set(sessionId, resolveCancellation);
      });
      await context.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Will ask for permission after cancellation" },
        },
      });
      await cancelled;
      pendingCancellations.delete(sessionId);
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
      await context.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Then silence" } },
      });
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

    if (mode === "prompt-error") {
      // Rejects this turn while staying connected and usable.
      throw new Error("mock agent refuses this turn");
    }

    if (mode === "cancel") {
      const cancelled = new Promise<void>((resolveCancellation) => {
        pendingCancellations.set(sessionId, resolveCancellation);
      });
      await context.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Waiting for cancellation" },
        },
      });
      await cancelled;
      pendingCancellations.delete(sessionId);
      return { stopReason: "cancelled" };
    }

    await context.client.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Mock response" },
      },
    });
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
    return { stopReason: "end_turn" };
  })
  .onNotification(acp.methods.agent.session.cancel, (context) => {
    pendingCancellations.get(context.params.sessionId)?.();
  });

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);
if (mode === "stderr") {
  process.stderr.write("mock-agent stderr\n");
}
if (process.argv.includes("--ignore-sigterm")) {
  // Survives SIGTERM so clients have to escalate to end it.
  process.on("SIGTERM", () => undefined);
}
if (process.argv.includes("--graceful-sigterm")) {
  // Shuts down cooperatively, so the exit carries a code and no signal at all.
  process.on("SIGTERM", () => process.exit(0));
}
if (mode === "malformed") {
  process.stdout.end("{malformed\n", () => process.exit(2));
} else if (mode === "exit") {
  setImmediate(() => process.exit(23));
} else {
  app.connect(stream);
}