import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { exitError, stageError } from "./failures.js";
import { redactionGuard, redactSecrets } from "./redaction.js";
import type {
  StderrEnd,
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
export const STDERR_TAIL_CHARS = 8 * 1024;
/** Grace a terminated process gets before it is killed outright. */
const SIGTERM_ESCALATION_MS = 2_000;
/**
 * How long the diagnostics pipe may go on delivering after the process is gone.
 * Bounded for the same reason `TerminalService` bounds it: something the Agent
 * started can hold the pipe open long after the Agent itself has ended, and
 * nothing may wait on that indefinitely.
 */
const STDERR_DRAIN_MS = 250;
/** How long a Runtime may take to answer a session-setup request. */
export const DEFAULT_SETUP_TIMEOUT_MS = 60_000;
/** Process groups are a POSIX notion; Windows has no equivalent through Node. */
const POSIX = process.platform !== "win32";

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
 *
 * The Agent gets its own process group, because every CLI in the catalog starts
 * helpers of its own — MCP servers, tool runners — and a Session that stopped
 * only the process it spawned would leave those holding ports and file handles
 * behind it (ADR-0008: a Session owns its process for its whole life).
 */
export const nodeProcessPort: ProcessPort = {
  spawn(request: SpawnRequest): AgentProcess {
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      detached: POSIX,
    });
    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new Error(`${request.command}: stdio pipes unavailable`);
    }
    const stderr = child.stderr;
    stderr.setEncoding("utf8");
    // A broken diagnostics pipe is not a Session failure, but an `error` event
    // with no listener is an uncaught exception in the extension host.
    stderr.on("error", () => undefined);
    const exited = new Promise<AgentExit>((settle) => {
      child.once("error", (error) => settle({ code: null, signal: null, error }));
      child.once("exit", (code, signal) => settle({ code, signal }));
    });
    // A process group id outlives the group, and a Session whose Agent died may
    // not be torn down for hours — long enough for the system to give that id to
    // somebody else. So the question is asked once, while the answer still means
    // what it says, and remembered.
    let groupEnded = false;
    void exited.then(() => {
      groupEnded = child.pid === undefined || !groupExists(child.pid);
    });
    // The process ending is not the output ending. `end` on the pipe is what
    // says the diagnostics are complete; the timer is there because a grandchild
    // holding the pipe would otherwise keep this pending for as long as it runs.
    const stderrEnded = new Promise<StderrEnd>((settle) => {
      stderr.once("end", () => settle("closed"));
      stderr.once("close", () => settle("closed"));
      void exited.then(() => {
        const drain = setTimeout(() => settle("drained"), STDERR_DRAIN_MS);
        drain.unref();
      });
    });

    return {
      pid: child.pid,
      stdin: Writable.toWeb(child.stdin),
      stdout: Readable.toWeb(child.stdout),
      onStderr: (handler) => {
        stderr.on("data", (chunk: string) => handler(chunk));
      },
      exited,
      stderrEnded,
      kill: (signal) => killGroup(child, signal, groupEnded),
    };
  },
};

/**
 * Signals the Agent's whole process group, so what the Agent started stops with
 * it — but never a group already seen to end, because that id is free for the
 * system to give to somebody else and a later question cannot tell the two
 * apart. No timer watches for the group ending after that: unlike a terminal,
 * whose id a Session holds while the Agent keeps working, this is asked at the
 * one moment the Agent's own process is known to be gone.
 */
function killGroup(child: ChildProcess, signal: "SIGTERM" | "SIGKILL", ended: boolean): void {
  const pid = child.pid;
  if (POSIX && !ended && pid !== undefined && groupExists(pid)) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // It may have ended between the question and the answer.
    }
  }
  // Sends nothing once the child has been reaped, so this cannot reach a
  // process that merely inherited its pid.
  try {
    child.kill(signal);
  } catch {
    // Already gone, or never started: nothing left to stop.
  }
}

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0); // signal 0 delivers nothing; it only asks
    return true;
  } catch (error) {
    // Only "no such group" is an answer. No permission to ask is not.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

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
 * environment inherited as-is, then values resolved from SecretStorage, then
 * catalog policy values — which win, because a Suppression Plan travels in them
 * and the variable a credential fills is named by settings a workspace writes. Conductor itself puts no secret into the inherited layer;
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
    // Catalog policy last. A Suppression Plan travels in this environment, and
    // the variable a secret fills is named by settings a workspace can write —
    // so a credential must not be able to displace the plan the fingerprint
    // covers (ADR-0004, ADR-0007).
    env: { ...inherited, ...options.secretEnvironment, ...env },
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

  // Named, not silent: the credential does not reach the Agent, and a Runtime
  // failing to authenticate is the obscure failure that would follow.
  for (const name of Object.keys(options.secretEnvironment ?? {})) {
    if (Object.hasOwn(options.launch.env, name)) {
      log?.log(
        "error",
        `runtime ${runtimeId}: ${name} is set by this runtime's own policy, so the stored secret` +
          " for it was not applied — rename the variable or drop the reference",
      );
    }
  }

  const child = (ports.process ?? nodeProcessPort).spawn(request);
  let stderrTail = "";
  // An Agent's diagnostics are its own text, and it was started with resolved
  // secrets in its environment — a crash that prints that environment, or a
  // verbose flag, puts a credential here. None of it reaches the log, the turn
  // failure or the chat transcript with a secret still in it (ADR-0010).
  //
  // Both buffers are redacted after joining, never chunk by chunk. A value split
  // across two reads matches neither half, and would be whole again the moment
  // they were put back together — which is what the tail does, and what two
  // adjacent records in a log file do to anyone reading them. So the log is
  // written a whole line at a time out of its own redacted buffer, bounded the
  // same way, rather than a read at a time.
  const secretValues = Object.values(options.secretEnvironment ?? {});
  // The end of the buffer is held back by this much before a line is written,
  // so that no flush can ever cut a secret in half.
  const guard = redactionGuard(secretValues);
  let pendingLine = "";
  /** Writes whole lines, holding back anything a secret could still straddle. */
  const writeLines = (upTo: number): void => {
    const lastBreak = pendingLine.slice(0, upTo).lastIndexOf("\n");
    if (lastBreak < 0) return;
    log?.log("debug", `runtime ${runtimeId} stderr: ${pendingLine.slice(0, lastBreak)}`);
    pendingLine = pendingLine.slice(lastBreak + 1);
  };
  child.onStderr((chunk) => {
    stderrTail = appendRedacted(stderrTail, chunk, secretValues, STDERR_TAIL_CHARS);
    if (!log) return;
    pendingLine = appendRedacted(pendingLine, chunk, secretValues, STDERR_TAIL_CHARS);
    writeLines(Math.max(0, pendingLine.length - guard));
  });
  // A process that died mid-line still said something, and an Agent that writes
  // one short diagnostic and exits would otherwise never reach the log at all.
  // Once it is gone its last text is complete, so the guard is no longer needed
  // and the remainder — redacted as it was appended — is written whole.
  //
  // Waits for the pipe rather than the exit: a chunk delivered after the process
  // is gone is ordinary, and flushing at the exit would hold that last line back
  // behind the guard for a flush that never came.
  void child.stderrEnded.then((how) => {
    if (!log || !pendingLine.trim()) return;
    // Unguarded only where the pipe itself ended, because only then is what was
    // said complete. Where the wait merely drained, something the Agent started
    // still holds the descriptor and may write the rest of a value this record
    // would have cut in half — so that much stays held back (ADR-0010).
    const keep = how === "closed" ? 0 : redactionGuard(secretValues);
    const upTo = pendingLine.length - keep;
    if (upTo <= 0) return;
    log.log("debug", `runtime ${runtimeId} stderr: ${pendingLine.slice(0, upTo).trimEnd()}`);
    pendingLine = "";
  });

  const clock = ports.clock ?? systemClock;
  const connection = clientApp(options).connect(acp.ndJsonStream(child.stdin, child.stdout));
  const close = async (): Promise<AgentExit> => {
    // Both halves happen, in this order, whatever either of them does: the
    // process first because teardown must not depend on the connection, and the
    // connection regardless because a process that refused to be signalled is
    // no reason to keep talking to it.
    try {
      child.kill("SIGTERM");
    } finally {
      connection.close();
    }
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
    // The handshake is what failed; a teardown that fails on the way out must
    // not replace the diagnosis with its own.
    const exit = await close().catch(() => undefined);
    // Which of the two ended the other cannot be inferred after the fact: a
    // Runtime that handles SIGTERM exits with a code, exactly like one that died
    // on its own. So report both facts rather than guessing between them — the
    // process death only speaks for itself when it was the failure we caught.
    throw error === exitFailure
      ? error
      : stageError(runtimeId, "ACP handshake", error, exit, stderrTail, secretValues);
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

/**
 * Adds a chunk to a bounded buffer of Agent diagnostics.
 *
 * Redacted before it is cut, never after. A cut applied first can take the head
 * of a secret away and leave a tail that matches nothing on every later pass —
 * so the value stays in the buffer and is printed by every failure message that
 * quotes it (ADR-0010). What is already in the buffer was redacted on its way
 * in, so redacting again only ever finds a value that straddles the join.
 */
export function appendRedacted(
  existing: string,
  chunk: string,
  secrets: string[],
  limit: number,
): string {
  return redactSecrets(existing + chunk, secrets).slice(-limit);
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

