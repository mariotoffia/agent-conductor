import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import type * as acp from "@agentclientprotocol/sdk";
import { methods } from "@agentclientprotocol/sdk";
import type { TerminalPort } from "../core/index.js";
import { rootGuard, type RootGuard } from "./fsProvider.js";
import {
  clampForDisplay,
  clientOperation,
  commandDetail,
  commandLineOf,
  INHERITS_ENVIRONMENT,
  MAX_COMMAND_CHARS,
  MAX_CWD_CHARS,
  MAX_DETAIL_CHARS,
  type ClientOperation,
  type Consent,
} from "./permissions.js";

/**
 * The Client's `terminal/*` handlers.
 *
 * Commands arrive structured — a command and its arguments — and are spawned
 * that way, with no shell anywhere in the path: an argument from an Agent is an
 * argument, never a fragment of something a shell will parse. Output is kept in a
 * ring buffer bounded by this Client, not by the Agent, so a command that prints
 * forever costs a fixed amount of memory rather than the extension host.
 *
 * Consent is asked for once, when a command starts. Waiting for it, killing it,
 * and releasing it are follow-ups to that decision and only consult policy — but
 * an operation the user rejected outright stays rejected (ADR-0007).
 */

/** The most output this Client retains per terminal, unless configured lower. */
export const DEFAULT_OUTPUT_BYTE_LIMIT = 1024 * 1024;
/** Grace a terminated command gets before it is killed outright. */
const SIGTERM_ESCALATION_MS = 2_000;
/**
 * How long a finished command's pipes may still be delivering. A process ends
 * before the last of its output has been read, and one whose own children
 * inherited its pipes may never close them — so the wait ends on whichever comes
 * first, complete output or this.
 */
const PIPE_DRAIN_MS = 250;
export const DEFAULT_ENV_CHARS = 900;

/**
 * The most any configured budget can be. What a dialog does not show, a person
 * does not read, so a budget larger than the space left in the dialog would put
 * the overflow back where the Agent chooses it — which is the whole reason the
 * environment is shown or refused rather than trimmed.
 */
export const MAX_ENV_CHARS =
  MAX_DETAIL_CHARS - MAX_COMMAND_CHARS - MAX_CWD_CHARS - INHERITS_ENVIRONMENT.length - 60;
/** Process groups are a POSIX notion; Windows has no equivalent through Node. */
const POSIX = process.platform !== "win32";
/**
 * How often a command's process group is checked for having ended, once the
 * command itself is gone but something it started is not. See `probeGroup`.
 */
const GROUP_POLL_MS = 2_000;

/** Signals a process group, or asks after one with signal `0`. */
export type GroupSignal = (pgid: number, signal: NodeJS.Signals | 0) => void;

const posixGroupSignal: GroupSignal = (pgid, signal) => {
  process.kill(-pgid, signal);
};

export interface TerminalServiceOptions {
  /** Absolute Session roots; a command's `cwd` must land inside one. */
  roots: readonly string[];
  consent: Consent;
  /** Ceiling on retained output, whatever the Agent asks for. */
  outputByteLimit?: number;
  /** Base environment for spawned commands; the extension host's by default. */
  env?: Record<string, string>;
  /** How process groups are signalled and asked after; the OS by default. */
  signalGroup?: GroupSignal;
  /** How often to check whether an outlived process group has ended. */
  groupPollMs?: number;
  /** Characters of environment the approval dialog will show before refusing
   *  the command; never more than `MAX_ENV_CHARS`. */
  maxEnvironmentChars?: number;
}

interface Terminal {
  /** The Session that created it; another Session's id is not a handle to it. */
  sessionId: string;
  child: ChildProcess;
  chunks: Buffer[];
  bytes: number;
  limit: number;
  truncated: boolean;
  exit?: acp.TerminalExitStatus;
  exited: Promise<acp.TerminalExitStatus>;
  /** Already told to stop; a second ask must not arm a second escalation. */
  signalled?: boolean;
  signalGroup: GroupSignal;
  groupPollMs: number;
  /**
   * There is no process group left to signal: it has ended, or this platform
   * never had one. Latched, never cleared — a group id that has ended once is
   * not this command's again, whoever holds it next.
   */
  groupGone?: boolean;
  /** Stops the watch that latches `groupGone`. */
  stopWatching?: () => void;
}

export class TerminalService implements TerminalPort {
  readonly #options: TerminalServiceOptions;
  readonly #confine: RootGuard;
  readonly #terminals = new Map<string, Terminal>();
  #issued = 0;

  constructor(options: TerminalServiceOptions) {
    this.#options = options;
    this.#confine = rootGuard(options.roots);
  }

  async createTerminal(request: acp.CreateTerminalRequest): Promise<acp.CreateTerminalResponse> {
    const args = request.args ?? [];
    const spawning = operationOf(methods.client.terminal.create);
    const cwd = await this.#confine(request.cwd ?? this.#options.roots[0] ?? "", spawning);
    const commandLine = commandLineOf(request.command, args);
    const described = commandDetail(cwd, request.env, commandLine, this.#environmentBudget());
    if (!(await this.#options.consent.authorize(spawning, described))) {
      throw new Error(`terminal.spawn: refused for "${clampForDisplay(commandLine, MAX_COMMAND_CHARS)}"`);
    }

    // `shell: false` is the whole point: argv reaches the child verbatim, so a
    // metacharacter in an argument is a character, not a command.
    const child = spawn(request.command, args, {
      cwd,
      env: { ...inherited(this.#options.env), ...environment(request.env) },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      // Its own process group, so stopping a command stops what it started:
      // a test runner's workers and a dev server's children go with it.
      detached: POSIX,
    });

    const terminal: Terminal = {
      sessionId: request.sessionId,
      child,
      chunks: [],
      bytes: 0,
      limit: retainedBytes(request.outputByteLimit, this.#options.outputByteLimit),
      truncated: false,
      exited: Promise.resolve({}),
      signalGroup: this.#options.signalGroup ?? posixGroupSignal,
      groupPollMs: this.#options.groupPollMs ?? GROUP_POLL_MS,
    };
    terminal.exited = new Promise<acp.TerminalExitStatus>((settle) => {
      let status: acp.TerminalExitStatus = { exitCode: null, signal: null };
      let drain: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        if (terminal.exit) return;
        clearTimeout(drain);
        terminal.exit = status;
        settle(status);
      };
      // A command that could not start has no exit status to report; what went
      // wrong is the only useful thing there is, so it goes in the output.
      child.once("error", (error: Error) => {
        append(terminal, Buffer.from(`${error.message}\n`, "utf8"));
        terminal.groupGone = true; // nothing was ever started to signal
        finish();
      });
      // The process ending is not the output ending — the pipes get a bounded
      // moment to deliver the rest, and `close` is what says they are done.
      child.once("exit", (code, signal) => {
        status = { exitCode: code, signal };
        // From here the command is no longer holding its own group open, so how
        // long that group outlives it is worth watching.
        watchGroup(terminal);
        drain = setTimeout(finish, PIPE_DRAIN_MS);
        drain.unref();
      });
      child.once("close", finish);
    });
    for (const stream of [child.stdout, child.stderr]) {
      collectPipe(stream, (chunk) => append(terminal, chunk));
    }

    this.#issued += 1;
    const terminalId = `term-${this.#issued}`;
    this.#terminals.set(terminalId, terminal);
    return { terminalId };
  }

  async terminalOutput(request: acp.TerminalOutputRequest): Promise<acp.TerminalOutputResponse> {
    const terminal = this.#require(request);
    return {
      output: Buffer.concat(terminal.chunks).toString("utf8"),
      truncated: terminal.truncated,
      ...(terminal.exit ? { exitStatus: terminal.exit } : {}),
    };
  }

  async waitForTerminalExit(
    request: acp.WaitForTerminalExitRequest,
  ): Promise<acp.WaitForTerminalExitResponse> {
    const terminal = this.#require(request);
    this.#requirePolicy(methods.client.terminal.waitForExit);
    return terminal.exited;
  }

  /** Terminates the command; its output stays readable until it is released. */
  async killTerminal(request: acp.KillTerminalRequest): Promise<void> {
    const terminal = this.#require(request);
    this.#requirePolicy(methods.client.terminal.kill);
    kill(terminal);
  }

  async releaseTerminal(request: acp.ReleaseTerminalRequest): Promise<void> {
    const terminal = this.#require(request);
    this.#requirePolicy(methods.client.terminal.release);
    kill(terminal);
    terminal.stopWatching?.();
    this.#terminals.delete(request.terminalId);
  }

  /** Terminates everything still running. The Session owns these processes. */
  dispose(): void {
    for (const terminal of this.#terminals.values()) {
      kill(terminal);
      terminal.stopWatching?.();
    }
    this.#terminals.clear();
  }

  /** Never more than the dialog can show, whatever the setting says. */
  #environmentBudget(): number {
    const configured = this.#options.maxEnvironmentChars;
    // Not a number is not a budget: every comparison against `NaN` is false, so
    // taking one would leave nothing to exceed and refuse nothing.
    if (typeof configured !== "number" || !Number.isFinite(configured)) return DEFAULT_ENV_CHARS;
    return Math.max(0, Math.min(configured, MAX_ENV_CHARS));
  }

  /** The operation an ACP method authorizes under must still be permitted. */
  #requirePolicy(method: string): void {
    const operation = operationOf(method);
    if (!this.#options.consent.permits(operation)) {
      throw new Error(`${operation}: rejected by policy`);
    }
  }

  /**
   * The terminal behind an id, for the Session that created it. A handle issued
   * to one Session is not an argument another Session can present.
   */
  #require(request: { sessionId: acp.SessionId; terminalId: acp.TerminalId }): Terminal {
    const terminal = this.#terminals.get(request.terminalId);
    if (!terminal || terminal.sessionId !== request.sessionId) {
      throw new Error(`unknown terminal "${request.terminalId}"`);
    }
    return terminal;
  }
}

/**
 * Collects one of a command's pipes.
 *
 * The `error` listener is not bookkeeping. A stream that fails with nothing
 * listening does not report false from `emit` — it throws, out of Node's own
 * read path and into whichever process is doing the reading, over a broken pipe
 * that is no reason to take an extension host down. So a pipe that failed says
 * so where the command's own words go, exactly as a command that could not start
 * does, and the exit status still reports what became of the process.
 *
 * Exported because that is the only way to hold it: the pipes belong to a child
 * this service spawns itself, and a test cannot reach them from outside.
 */
export function collectPipe(stream: Readable | null, onChunk: (chunk: Buffer) => void): void {
  if (!stream) return;
  stream.on("data", onChunk);
  stream.on("error", (error: Error) => onChunk(Buffer.from(`${error.message}\n`, "utf8")));
}

/** The Client Operation a method authorizes under; every method here has one. */
function operationOf(method: string): ClientOperation {
  const operation = clientOperation(method);
  if (!operation) throw new Error(`${method}: no client operation to authorize under`);
  return operation;
}

/**
 * Stops a command and whatever it started. Deliberately not skipped for a
 * command that has already exited: a wrapper that starts a worker and returns
 * leaves the worker in the group, and that is the shape of every `npm run`.
 *
 * Signalling a group by an id outlives the group itself, so the id is only used
 * while it has never been seen to end — see `signal` and `watchGroup`.
 */
function kill(terminal: Terminal): void {
  if (terminal.signalled) return;
  terminal.signalled = true;
  signal(terminal, "SIGTERM");
  // Teardown must not depend on the command's cooperation: one that ignores
  // SIGTERM would otherwise leave a `wait` pending for as long as it likes.
  const escalation = setTimeout(() => signal(terminal, "SIGKILL"), SIGTERM_ESCALATION_MS);
  escalation.unref();
  void terminal.exited.then(() => clearTimeout(escalation));
}

/**
 * Signals the command's whole process group where there is one. Signalling only
 * the command leaves whatever it spawned running — holding its ports, and its
 * pipes, after the Session that asked for it is gone.
 *
 * A group is only ever signalled while this Client has not seen it end. That is
 * what keeps the group id meaningful: a system does not recycle one while the
 * group still has members, so a group that has never been observed empty can
 * only hold processes this command started. One that *has* ended is left alone,
 * because its id is free for the system to give to somebody else.
 */
function signal(terminal: Terminal, sig: "SIGTERM" | "SIGKILL"): void {
  const pid = terminal.child.pid;
  if (pid === undefined) return;
  probeGroup(terminal);
  if (!terminal.groupGone) {
    try {
      terminal.signalGroup(pid, sig);
      return;
    } catch {
      // It may have ended between the question and the answer; the command
      // itself is what has to stop, so that is tried before giving up.
    }
  }
  // `ChildProcess.kill` sends nothing once the child has been reaped, so this
  // cannot reach a process that merely inherited its pid.
  try {
    terminal.child.kill(sig);
  } catch {
    // Already gone, or never started: nothing left to stop.
  }
}

/**
 * Asks whether the command's process group is still there, and remembers when
 * it is not. Signal `0` delivers nothing — it is the POSIX way to ask.
 */
function probeGroup(terminal: Terminal): void {
  const pid = terminal.child.pid;
  if (!POSIX || pid === undefined) {
    terminal.groupGone = true; // no groups on this platform, or nothing started
    return;
  }
  if (terminal.groupGone) return;
  try {
    terminal.signalGroup(pid, 0);
  } catch (error) {
    // Only "no such group" means ended. No permission to ask is not an answer.
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") return;
    terminal.groupGone = true;
    terminal.stopWatching?.();
  }
}

/**
 * Watches for the moment a command's group ends, so that moment is noticed
 * while the id still means what it meant. Without it, a group that emptied an
 * hour ago would be signalled on the strength of an id the system may since have
 * handed to a stranger. Stops at the first answer, and never holds Node open.
 */
function watchGroup(terminal: Terminal): void {
  probeGroup(terminal);
  if (terminal.groupGone || terminal.stopWatching) return;
  const watch = setInterval(() => probeGroup(terminal), terminal.groupPollMs);
  watch.unref();
  terminal.stopWatching = () => {
    clearInterval(watch);
    terminal.stopWatching = undefined;
  };
}


/**
 * How much output to retain: what the Agent asked for, never more than this
 * Client holds. A limit the Agent sets alone would make the bound its choice.
 */
function retainedBytes(requested: number | null | undefined, configured?: number): number {
  const ceiling = configured ?? DEFAULT_OUTPUT_BYTE_LIMIT;
  return typeof requested === "number" && Number.isFinite(requested) && requested >= 0
    ? Math.min(requested, ceiling)
    : ceiling;
}

/** Appends to the ring buffer, dropping the oldest bytes past the limit. */
function append(terminal: Terminal, chunk: Buffer): void {
  terminal.chunks.push(chunk);
  terminal.bytes += chunk.byteLength;
  let dropped = false;
  while (terminal.bytes > terminal.limit) {
    const head = terminal.chunks[0];
    if (!head) break;
    terminal.truncated = true;
    dropped = true;
    const excess = terminal.bytes - terminal.limit;
    if (head.byteLength <= excess) {
      terminal.chunks.shift();
      terminal.bytes -= head.byteLength;
    } else {
      terminal.chunks[0] = head.subarray(excess);
      terminal.bytes -= excess;
    }
  }
  if (dropped) trimToCharacterBoundary(terminal);
}

/**
 * Drops the tail of a character the cut landed inside. ACP requires truncation
 * on a character boundary, and a buffer that starts mid-character decodes to a
 * replacement character the command never printed. At most three bytes go.
 */
function trimToCharacterBoundary(terminal: Terminal): void {
  // Three bytes is the most a character can be missing, however many chunks
  // those bytes are spread over — so the budget counts bytes, not turns.
  for (let dropped = 0; dropped < 3; ) {
    const head = terminal.chunks[0];
    if (!head) return;
    if (head.byteLength === 0) {
      terminal.chunks.shift();
      continue;
    }
    // 10xxxxxx is a UTF-8 continuation byte: the middle of a character.
    if (((head[0] ?? 0) & 0xc0) !== 0x80) return;
    terminal.chunks[0] = head.subarray(1);
    terminal.bytes -= 1;
    dropped += 1;
  }
}

function inherited(base?: Record<string, string>): Record<string, string> {
  if (base) return { ...base };
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function environment(variables: acp.EnvVariable[] = []): Record<string, string> {
  return Object.fromEntries(variables.map((variable) => [variable.name, variable.value]));
}
