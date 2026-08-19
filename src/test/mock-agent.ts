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

let nextSession = 1;
const sessions = new Map<string, acp.NewSessionRequest>();
const pendingCancellations = new Map<string, () => void>();
const mode = process.argv.find((argument) => argument.startsWith("--mode="))?.slice(7) ?? "normal";

const app = acp
  .agent({ name: "agent-conductor-mock" })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { additionalDirectories: {} },
    },
    authMethods: [{
      id: "mock-auth",
      name: "Mock authentication",
      description: "Deterministic authentication for tests",
      type: "agent",
    }],
  }))
  .onRequest(acp.methods.agent.authenticate, () => ({}))
  .onRequest(acp.methods.agent.session.new, (context) => {
    const sessionId = `mock-session-${nextSession++}`;
    sessions.set(sessionId, context.params);
    return {
      sessionId,
      configOptions,
      _meta: { receivedRequest: context.params },
    };
  })
  .onRequest(acp.methods.agent.session.load, (context) => {
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
if (mode === "malformed") {
  process.stdout.end("{malformed\n", () => process.exit(2));
} else if (mode === "exit") {
  setImmediate(() => process.exit(23));
} else {
  app.connect(stream);
}