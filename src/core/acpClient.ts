import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  AgentExit,
  AgentProcess,
  ClockPort,
  LaunchSpec,
  ProcessPort,
  SessionPorts,
  SpawnRequest,
} from "./types.js";

/** Name we report in `clientInfo`; Agents log it. */
export const CLIENT_NAME = "agent-conductor";
/** Diagnostics kept from the Agent's stderr, used in failure messages. */
const STDERR_TAIL_CHARS = 8 * 1024;
/** Grace a terminated process gets before it is killed outright. */
const SIGTERM_ESCALATION_MS = 2_000;
/** How long a Runtime may take to answer a session-setup request. */
export const DEFAULT_SETUP_TIMEOUT_MS = 60_000;

/** Real timers, unreferenced so a pending grace period never holds Node open. */
export const systemClock: ClockPort = {
  after(ms, run) {
    const timer = setTimeout(run, ms);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

/**
 * Node implementation of `ProcessPort`.
 *
 * `shell` is never enabled: argv reaches the child verbatim, so a runtime
 * argument from settings cannot become a shell command. The environment is
 * passed through exactly as built by `buildSpawnRequest` — the port adds nothing.
 */
export const nodeProcessPort: ProcessPort = {
  spawn(request: SpawnRequest): AgentProcess {
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new Error(`${request.command}: stdio pipes unavailable`);
    }
    const stderr = child.stderr;
    stderr.setEncoding("utf8");
    const exited = new Promise<AgentExit>((settle) => {
      child.once("error", (error) => settle({ code: null, signal: null, error }));
      child.once("exit", (code, signal) => settle({ code, signal }));
    });

    return {
      pid: child.pid,
      stdin: Writable.toWeb(child.stdin),
      stdout: Readable.toWeb(child.stdout),
      onStderr: (handler) => {
        stderr.on("data", (chunk: string) => handler(chunk));
      },
      exited,
      kill: (signal) => {
        child.kill(signal);
      },
    };
  },
};

export interface AgentLaunchOptions {
  runtimeId: string;
  launch: LaunchSpec;
  /** Absolute session working directory; also the child's cwd. */
  cwd: string;
  /** Secret values resolved from SecretStorage by the UI adapter. Never logged. */
  secretEnvironment?: Record<string, string>;
}

/**
 * Validates the launch identity and builds the child environment: the host
 * environment inherited as-is, then catalog policy values, then values resolved
 * from SecretStorage. Conductor itself puts no secret into the inherited layer;
 * an Agent runs with the user's own privileges either way (ADR-0007).
 * Throws before anything is spawned when a required path is not absolute.
 */
export function buildSpawnRequest(options: AgentLaunchOptions): SpawnRequest {
  const { command, args, env } = options.launch;
  if (!command || !isAbsolute(command)) {
    throw new Error(
      `runtime ${options.runtimeId}: launch command must be an absolute path, got "${command}"`,
    );
  }
  if (!isAbsolute(options.cwd)) {
    throw new Error(`runtime ${options.runtimeId}: session cwd must be absolute, got "${options.cwd}"`);
  }
  const inherited: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) inherited[name] = value;
  }
  return {
    command,
    args: [...args],
    cwd: options.cwd,
    env: { ...inherited, ...env, ...options.secretEnvironment },
  };
}

export interface AgentConnectionOptions extends AgentLaunchOptions {
  ports: SessionPorts;
  /** Live from the first byte: `session/load` replays history as updates. */
  onSessionUpdate: (notification: acp.SessionNotification) => void;
  /** True while a cancelled turn is in flight; ACP requires a cancelled answer. */
  turnCancelled?: () => boolean;
  /** Deadline for the handshake; a Runtime that goes silent must not pend. */
  setupTimeoutMs?: number;
  /**
   * Called when the Agent starts waiting on the Client; the returned callback
   * marks that one answer delivered. Time the Client owes the Agent is not the
   * Agent stalling, and pairing the two ends keeps the two attributable.
   */
  onAgentServing?: () => () => void;
  clientVersion?: string;
}

/**
 * One Agent subprocess plus its ACP connection. A Session owns exactly one of
 * these, so terminating it can never affect another Session (ADR-0008).
 */
export interface AgentConnection {
  readonly agent: acp.ClientContext;
  readonly handshake: acp.InitializeResponse;
  readonly pid?: number;
  readonly exited: Promise<AgentExit>;
  /** Aborts when the ACP connection closes, whether or not the process lives. */
  readonly closed: AbortSignal;
  /** Recent Agent stderr, for diagnostics in failure messages. */
  stderrTail(): string;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
  /** Closes the connection, terminates the process, resolves once it is gone. */
  close(): Promise<AgentExit>;
}

/** Spawns a Runtime and completes the ACP v1 handshake. */
export async function connectAgent(options: AgentConnectionOptions): Promise<AgentConnection> {
  const { runtimeId, ports } = options;
  const log = ports.log;
  const request = buildSpawnRequest(options);
  const secretNames = Object.keys(options.secretEnvironment ?? {});
  // Environment values can be secrets: log names only (ADR-0010).
  log?.log(
    "info",
    `runtime ${runtimeId}: spawning ${request.command} (${request.args.length} args)` +
      ` env+=[${[...Object.keys(options.launch.env), ...secretNames].join(", ")}]`,
  );

  const child = (ports.process ?? nodeProcessPort).spawn(request);
  let stderrTail = "";
  child.onStderr((chunk) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    log?.log("debug", `runtime ${runtimeId} stderr: ${chunk.trimEnd()}`);
  });

  const clock = ports.clock ?? systemClock;
  const connection = clientApp(options).connect(acp.ndJsonStream(child.stdin, child.stdout));
  const close = async (): Promise<AgentExit> => {
    connection.close();
    child.kill("SIGTERM");
    // Teardown must not depend on the Agent's cooperation: a custom Runtime that
    // ignores SIGTERM would otherwise hang dispose — and with it the handshake
    // failure path, which awaits this too.
    const cancelEscalation = clock.after(SIGTERM_ESCALATION_MS, () => child.kill("SIGKILL"));
    try {
      return await child.exited;
    } finally {
      cancelEscalation();
    }
  };
  // A process that ends before the handshake completes is the failure, not the
  // pending request it strands. Note that ACP transports skip unparseable lines
  // rather than failing, so stream corruption surfaces as a stranded request.
  let exitFailure: Error | undefined;
  const exitFirst = child.exited.then((exit) => {
    exitFailure = exitError(runtimeId, exit, stderrTail);
    throw exitFailure;
  });

  const setupMs = options.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS;
  let handshake: acp.InitializeResponse;
  try {
    handshake = await withDeadline(
      Promise.race([
        connection.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: clientCapabilities(ports),
          clientInfo: { name: CLIENT_NAME, version: options.clientVersion ?? "0.0.0" },
        }),
        exitFirst,
      ]),
      setupMs,
      clock,
      () => new Error(`agent did not answer initialize within ${setupMs}ms`),
    );
    if (handshake.protocolVersion !== acp.PROTOCOL_VERSION) {
      throw new Error(
        `unsupported ACP protocol version ${handshake.protocolVersion}` +
          ` (this client speaks v${acp.PROTOCOL_VERSION} only)`,
      );
    }
  } catch (error) {
    const exit = await close();
    // Which of the two ended the other cannot be inferred after the fact: a
    // Runtime that handles SIGTERM exits with a code, exactly like one that died
    // on its own. So report both facts rather than guessing between them — the
    // process death only speaks for itself when it was the failure we caught.
    throw error === exitFailure
      ? error
      : stageError(runtimeId, "ACP handshake", error, exit, stderrTail);
  }
  log?.log(
    "info",
    `runtime ${runtimeId}: ACP v${handshake.protocolVersion} ready (${handshake.agentInfo?.name ?? "agent"})`,
  );
  return {
    agent: connection.agent,
    handshake,
    pid: child.pid,
    exited: child.exited,
    closed: connection.signal,
    stderrTail: () => stderrTail,
    kill: (signal) => child.kill(signal),
    close,
  };
}

/** Only capabilities we can actually serve: a port is the proof of support. */
function clientCapabilities(ports: SessionPorts): acp.ClientCapabilities {
  return {
    fs: { readTextFile: Boolean(ports.fs), writeTextFile: Boolean(ports.fs) },
    terminal: Boolean(ports.terminal),
    ...(ports.elicitation ? { elicitation: { form: {} } } : {}),
    // Without this, an Agent that still delegates internally reports nested
    // subagent work as an opaque tool result instead of taggable transcript.
    _meta: { "subagent-transcript": true },
  };
}

function clientApp(options: AgentConnectionOptions): acp.ClientApp {
  const { ports } = options;
  /** Marks the Client as owing the Agent an answer for the whole handler. */
  const serving = async <T>(answer: () => Promise<T> | T): Promise<T> => {
    const delivered = options.onAgentServing?.();
    try {
      return await answer();
    } finally {
      delivered?.();
    }
  };
  const app = acp
    .client({ name: CLIENT_NAME })
    .onNotification(acp.methods.client.session.update, (context) => {
      options.onSessionUpdate(context.params);
    })
    .onRequest(acp.methods.client.session.requestPermission, (context) => serving(() => {
      // ACP requires a cancelled turn to answer `cancelled`, and without a
      // permission port there is no way to obtain consent: both fail closed.
      if (options.turnCancelled?.() || !ports.permission) {
        return { outcome: { outcome: "cancelled" } };
      }
      return ports.permission.requestPermission(context.params);
    }));
  const fs = ports.fs;
  if (fs) {
    app
      .onRequest(acp.methods.client.fs.readTextFile, (context) =>
        serving(() => fs.readTextFile(context.params)))
      .onRequest(acp.methods.client.fs.writeTextFile, (context) =>
        serving(async () => {
          await fs.writeTextFile(context.params);
        }));
  }
  const terminal = ports.terminal;
  if (terminal) {
    app
      .onRequest(acp.methods.client.terminal.create, (context) =>
        serving(() => terminal.createTerminal(context.params)))
      .onRequest(acp.methods.client.terminal.output, (context) =>
        serving(() => terminal.terminalOutput(context.params)))
      .onRequest(acp.methods.client.terminal.waitForExit, (context) =>
        serving(() => terminal.waitForTerminalExit(context.params)))
      .onRequest(acp.methods.client.terminal.kill, (context) =>
        serving(async () => {
          await terminal.killTerminal(context.params);
        }))
      .onRequest(acp.methods.client.terminal.release, (context) =>
        serving(async () => {
          await terminal.releaseTerminal(context.params);
        }));
  }
  const elicitation = ports.elicitation;
  if (elicitation) {
    app
      .onRequest(acp.methods.client.elicitation.create, (context) =>
        serving(() => elicitation.createElicitation(context.params)))
      .onNotification(acp.methods.client.elicitation.complete, (context) => {
        elicitation.completeElicitation(context.params);
      });
  }
  return app;
}

/**
 * Rejects when `work` outlives `ms`. A Runtime that connects its stdio and then
 * goes silent would otherwise leave a caller pending with no way back.
 */
export async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  clock: ClockPort,
  timedOut: () => Error,
): Promise<T> {
  let cancel: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    cancel = clock.after(ms, () => reject(timedOut()));
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    cancel?.();
  }
}

function describeExit(exit: AgentExit): string {
  return exit.error
    ? `could not be started: ${exit.error.message}`
    : `exited with ${exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`}`;
}

/** Failure message for a process that ended when we still needed it. */
export function exitError(runtimeId: string, exit: AgentExit, stderrTail: string): Error {
  return new Error(`runtime ${runtimeId}: agent process ${describeExit(exit)}${tailOf(stderrTail)}`, {
    cause: exit.error,
  });
}

/** Setup failure: which stage failed, why, and how the Agent process ended. */
export function stageError(
  runtimeId: string,
  stage: string,
  error: unknown,
  exit: AgentExit | undefined,
  stderrTail: string,
): Error {
  const ending = exit ? ` (agent process ${describeExit(exit)})` : "";
  return new Error(
    `runtime ${runtimeId}: ${stage} failed: ${message(error)}${ending}${tailOf(stderrTail)}`,
    { cause: error },
  );
}

/** Labels the Agent's own output: the buffer spans the connection, not one Turn. */
export function tailOf(stderrTail: string): string {
  const tail = stderrTail.trim();
  return tail ? `\nrecent agent output:\n${tail}` : "";
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
