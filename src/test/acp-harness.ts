import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import type * as acp from "@agentclientprotocol/sdk";
import {
  ConductorSession,
  nodeProcessPort,
  type AgentProcess,
  type ClockPort,
  type LaunchSpec,
  type ProcessPort,
  type SessionPorts,
  type SessionSpec,
  type SpawnRequest,
} from "../core/index.js";

const mockAgent = fileURLToPath(new URL("./mock-agent.ts", import.meta.url));

/** Mock-agent process launch spec; the command is absolute, as ACP requires. */
export function launchMockAgent(mode?: string, extraArgs: string[] = []): LaunchSpec {
  return {
    command: process.execPath,
    args: ["--import", "tsx", mockAgent, ...(mode ? [`--mode=${mode}`] : []), ...extraArgs],
    env: {},
  };
}

/** One JSON-RPC line the client actually wrote to the Agent's stdin. */
export interface SentLine {
  method?: string;
  params?: Record<string, unknown>;
}

/** Resolves as soon as the Agent sends its first Update of a turn. */
export function turnGate(sink: acp.SessionNotification[]) {
  let started: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    started = resolve;
  });
  return {
    started: promise,
    onUpdate: (notification: acp.SessionNotification) => {
      sink.push(notification);
      started?.();
    },
  };
}

/** ClockPort whose timers only run when the test fires them. */
export function fakeClock() {
  const timers: { ms: number; run: () => void; cancelled: boolean }[] = [];
  const armedWaiters: { threshold: number; resolve: () => void }[] = [];
  const msWaiters: { ms: number; resolve: () => void }[] = [];
  let armedTotal = 0;
  return {
    port: {
      after(ms, run) {
        const timer = { ms, run, cancelled: false };
        timers.push(timer);
        armedTotal += 1;
        for (const waiter of armedWaiters.filter((candidate) => candidate.threshold <= armedTotal)) {
          armedWaiters.splice(armedWaiters.indexOf(waiter), 1);
          waiter.resolve();
        }
        for (const waiter of msWaiters.filter((candidate) => candidate.ms === ms)) {
          msWaiters.splice(msWaiters.indexOf(waiter), 1);
          waiter.resolve();
        }
        return () => {
          timer.cancelled = true;
        };
      },
    } satisfies ClockPort,
    pending: () => timers.filter((timer) => !timer.cancelled),
    /** Resolves once a timer of exactly this duration has been armed. */
    armedMs(ms: number): Promise<void> {
      if (timers.some((timer) => timer.ms === ms)) return Promise.resolve();
      return new Promise<void>((resolve) => msWaiters.push({ ms, resolve }));
    },
    /**
     * Resolves once `count` timers have been armed in total, so a test can wait
     * for one specific timer rather than polling or firing the wrong one.
     */
    armed(count = 1): Promise<void> {
      if (armedTotal >= count) return Promise.resolve();
      return new Promise<void>((resolve) => armedWaiters.push({ threshold: count, resolve }));
    },
    fire() {
      for (const timer of timers.filter((candidate) => !candidate.cancelled)) {
        timer.cancelled = true;
        timer.run();
      }
    },
  };
}

/** Wraps the real process port to record spawn requests and outgoing ACP lines. */
export function recordingProcessPort(
  spawns: SpawnRequest[],
  sent: SentLine[],
  children: AgentProcess[] = [],
): ProcessPort {
  return {
    spawn(request) {
      spawns.push(request);
      const child = nodeProcessPort.spawn(request);
      children.push(child);
      const writer = child.stdin.getWriter();
      const decoder = new TextDecoder();
      let buffered = "";
      const stdin = new WritableStream<Uint8Array>({
        async write(chunk) {
          buffered += decoder.decode(chunk, { stream: true });
          for (;;) {
            const end = buffered.indexOf("\n");
            if (end < 0) break;
            const line = buffered.slice(0, end).trim();
            buffered = buffered.slice(end + 1);
            if (line) sent.push(JSON.parse(line) as SentLine);
          }
          await writer.write(chunk);
        },
        close: () => writer.close(),
        abort: (reason) => writer.abort(reason),
      });
      const recorded = { ...child, stdin } satisfies AgentProcess;
      children[children.length - 1] = recorded;
      return recorded;
    },
  };
}

/**
 * Session under test wired to recording ports: every spawn, outgoing ACP line,
 * update, permission request, and log record is observable.
 */
export function harness(t: TestContext, portOverrides: SessionPorts = {}) {
  const updates: acp.SessionNotification[] = [];
  const logs: string[] = [];
  const permissions: acp.RequestPermissionRequest[] = [];
  const spawns: SpawnRequest[] = [];
  const sent: SentLine[] = [];
  const children: AgentProcess[] = [];
  const clock = fakeClock();
  let permissionOutcome: acp.RequestPermissionResponse = {
    outcome: { outcome: "selected", optionId: "allow" },
  };
  const ports: SessionPorts = {
    process: recordingProcessPort(spawns, sent, children),
    clock: clock.port,
    log: { log: (level, text) => logs.push(`${level} ${text}`) },
    permission: {
      requestPermission: (request) => {
        permissions.push(request);
        return Promise.resolve(permissionOutcome);
      },
    },
    ...portOverrides,
  };

  function spec(overrides: Partial<SessionSpec> = {}): SessionSpec {
    return {
      runtimeId: "mock",
      launch: launchMockAgent(),
      cwd: process.cwd(),
      onUpdate: (notification) => updates.push(notification),
      ...overrides,
    };
  }

  function track(session: ConductorSession) {
    t.after(() => session.dispose());
    return session;
  }

  return {
    children,
    clock,
    logs,
    permissions,
    ports,
    sent,
    spawns,
    spec,
    updates,
    async open(overrides: Partial<SessionSpec> = {}) {
      return track(await ConductorSession.open(spec(overrides), ports));
    },
    async load(sessionId: string, overrides: Partial<SessionSpec> = {}) {
      return track(await ConductorSession.load({ ...spec(overrides), sessionId }, ports));
    },
    /** Params of the first request the client sent for `method`. */
    paramsOf(method: string): Record<string, unknown> {
      const line = sent.find((candidate) => candidate.method === method);
      assert.ok(line, `client never sent ${method}`);
      return line.params ?? {};
    },
    methodsSent: () => sent.map((line) => line.method),
    answerPermission(outcome: acp.RequestPermissionResponse) {
      permissionOutcome = outcome;
    },
  };
}
