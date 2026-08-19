import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import * as acp from "@agentclientprotocol/sdk";

const mockAgentPath = fileURLToPath(new URL("../mock-agent.ts", import.meta.url));
const childStartTimeoutMs = 5_000;
const testTimeoutMs = 10_000;

function mockTest(name: string, fn: (context: TestContext) => Promise<void>) {
  test(name, { timeout: testTimeoutMs }, fn);
}

function startMockAgent(t: TestContext, args: string[] = []) {
  const child = spawn(process.execPath, ["--import", "tsx", mockAgentPath, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
    child.once("exit", (code, signal) => resolve([code, signal]));
  });
  let stderr = "";
  let resolveStderr: ((value: string) => void) | undefined;
  const firstStderr = new Promise<string>((resolve) => {
    resolveStderr = resolve;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    resolveStderr?.(stderr);
    resolveStderr = undefined;
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
    await exited;
  });

  return {
    child,
    exited,
    firstStderr,
    stream: acp.ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout),
    ),
  };
}

function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out after ${milliseconds}ms`)), milliseconds);
    timeout.unref();
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

mockTest("mock agent initializes ACP v1 and creates a deterministic session", async (t) => {
  const mock = startMockAgent(t);

  const result = await acp.client({ name: "mock-agent-test" }).connectWith(mock.stream, async (context) => {
    const initialized = await context.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const authenticated = await context.request(acp.methods.agent.authenticate, {
      methodId: "mock-auth",
    });
    const session = await context.request(acp.methods.agent.session.new, {
      cwd: process.cwd(),
      mcpServers: [],
    });
    return { authenticated, initialized, session };
  });

  assert.deepEqual(result.authenticated, {});
  assert.equal(result.initialized.protocolVersion, acp.PROTOCOL_VERSION);
  assert.equal(result.initialized.agentCapabilities?.loadSession, true);
  assert.deepEqual(result.initialized.authMethods, [{
    id: "mock-auth",
    name: "Mock authentication",
    description: "Deterministic authentication for tests",
    type: "agent",
  }]);
  assert.equal(result.session.sessionId, "mock-session-1");
  assert.equal(result.session.configOptions?.length, 2);
});

mockTest("mock agent echoes Session setup inputs for client contract assertions", async (t) => {
  const mock = startMockAgent(t);
  const request: acp.NewSessionRequest = {
    cwd: process.cwd(),
    additionalDirectories: [resolve(process.cwd(), "additional")],
    mcpServers: [
      { name: "zeta", command: process.execPath, args: [], env: [] },
      { name: "alpha", command: process.execPath, args: [], env: [] },
    ],
  };

  const result = await acp.client({ name: "mock-agent-test" }).connectWith(mock.stream, async (context) => {
    const initialized = await context.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const session = await context.request(acp.methods.agent.session.new, request);
    return { initialized, session };
  });

  assert.deepEqual(
    result.initialized.agentCapabilities?.sessionCapabilities?.additionalDirectories,
    {},
  );
  assert.deepEqual(result.session._meta, { receivedRequest: request });
});

mockTest("mock agent streams every supported turn fixture and requests permission", async (t) => {
  const mock = startMockAgent(t);
  const updates: acp.SessionUpdate[] = [];
  let permissionRequest: acp.RequestPermissionRequest | undefined;
  const client = acp
    .client({ name: "mock-agent-test" })
    .onRequest(acp.methods.client.session.requestPermission, (context) => {
      permissionRequest = context.params;
      return { outcome: { outcome: "selected", optionId: "allow" } };
    })
    .onNotification(acp.methods.client.session.update, (context) => {
      updates.push(context.params.update);
    });

  const response = await client.connectWith(mock.stream, async (context) => {
    await context.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const session = await context.request(acp.methods.agent.session.new, {
      cwd: process.cwd(),
      mcpServers: [],
    });
    return context.request(acp.methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "script the turn" }],
    });
  });

  assert.equal(response.stopReason, "end_turn");
  const path = resolve(process.cwd(), "mock.txt");
  assert.deepEqual(permissionRequest, {
    sessionId: "mock-session-1",
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
  assert.deepEqual(updates, [
    {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Mock response" },
    },
    {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Mock thought" },
    },
    {
      sessionUpdate: "tool_call",
      toolCallId: "mock-tool",
      title: "Edit mock file",
      kind: "edit",
      status: "pending",
      locations: [{ path }],
    },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "mock-tool",
      status: "completed",
      content: [{ type: "diff", path, oldText: "before\n", newText: "after\n" }],
    },
    {
      sessionUpdate: "plan",
      entries: [{ content: "Exercise ACP client", priority: "high", status: "completed" }],
    },
    {
      sessionUpdate: "usage_update",
      used: 100,
      size: 1_000,
      cost: { amount: 0.01, currency: "USD" },
    },
  ]);
});

mockTest("mock agent keeps a turn active until session cancellation", async (t) => {
  const mock = startMockAgent(t, ["--mode=cancel"]);
  let turnStartedResolve: (() => void) | undefined;
  const turnStarted = new Promise<void>((resolve) => {
    turnStartedResolve = resolve;
  });
  const client = acp
    .client({ name: "mock-agent-test" })
    .onRequest(acp.methods.client.session.requestPermission, () => ({
      outcome: { outcome: "selected", optionId: "allow" },
    }))
    .onNotification(acp.methods.client.session.update, () => {
      turnStartedResolve?.();
    });

  const response = await client.connectWith(mock.stream, async (context) => {
    await context.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const session = await context.request(acp.methods.agent.session.new, {
      cwd: process.cwd(),
      mcpServers: [],
    });
    const prompt = context.request(acp.methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "wait" }],
    });
    await within(turnStarted, childStartTimeoutMs);
    await context.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId });
    return prompt;
  });

  assert.equal(response.stopReason, "cancelled");
});

mockTest("mock agent loads a session with the current Config Options", async (t) => {
  const mock = startMockAgent(t);
  const request: acp.LoadSessionRequest = {
    sessionId: "saved-session",
    cwd: process.cwd(),
    mcpServers: [],
    additionalDirectories: [],
  };

  const loaded = await acp.client({ name: "mock-agent-test" }).connectWith(mock.stream, async (context) => {
    await context.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    return context.request(acp.methods.agent.session.load, request);
  });

  assert.deepEqual(loaded._meta, { receivedRequest: request });
  assert.deepEqual(loaded.configOptions, [
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
  ]);
});

mockTest("mock agent can emit malformed stdout", async (t) => {
  const mock = startMockAgent(t, ["--mode=malformed"]);
  const originalConsoleError = console.error;
  let diagnostic = "";
  console.error = (...values: unknown[]) => {
    diagnostic += values.map(String).join(" ");
  };

  try {
    await assert.rejects(
      acp.client({ name: "mock-agent-test" }).connectWith(mock.stream, (context) =>
        context.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        })),
    );
  } finally {
    console.error = originalConsoleError;
  }
  assert.match(diagnostic, /Failed to parse JSON message/);
});

mockTest("mock agent can emit stderr without corrupting ACP stdout", async (t) => {
  const mock = startMockAgent(t, ["--mode=stderr"]);

  const initialized = await acp.client({ name: "mock-agent-test" }).connectWith(mock.stream, (context) =>
    context.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    }));
  const stderr = await within(mock.firstStderr, childStartTimeoutMs);

  assert.equal(initialized.protocolVersion, acp.PROTOCOL_VERSION);
  assert.equal(stderr, "mock-agent stderr\n");
});

mockTest("mock agent can exit before the ACP handshake", async (t) => {
  const mock = startMockAgent(t, ["--mode=exit"]);

  const [code, signal] = await within(mock.exited, childStartTimeoutMs);

  assert.equal(code, 23);
  assert.equal(signal, null);
});

mockTest("mock agent can keep a prompt pending after cancellation", async (t) => {
  const mock = startMockAgent(t, ["--mode=timeout"]);
  let turnStartedResolve: (() => void) | undefined;
  const turnStarted = new Promise<void>((resolve) => {
    turnStartedResolve = resolve;
  });
  const client = acp
    .client({ name: "mock-agent-test" })
    .onRequest(acp.methods.client.session.requestPermission, () => ({
      outcome: { outcome: "selected", optionId: "allow" },
    }))
    .onNotification(acp.methods.client.session.update, () => {
      turnStartedResolve?.();
    });

  const outcome = await client.connectWith(mock.stream, async (context) => {
    await context.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const session = await context.request(acp.methods.agent.session.new, {
      cwd: process.cwd(),
      mcpServers: [],
    });
    const prompt = context.request(acp.methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "never finish" }],
    });
    const settled = prompt.then(() => "settled" as const, () => "settled" as const);
    await within(turnStarted, childStartTimeoutMs);
    await context.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId });
    return Promise.race([
      settled,
      new Promise<"pending">((resolve) => {
        const timeout = setTimeout(() => resolve("pending"), 100);
        timeout.unref();
      }),
    ]);
  });

  assert.equal(outcome, "pending");
});