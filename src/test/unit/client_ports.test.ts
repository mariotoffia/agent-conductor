import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { readSettings } from "../../vscode/config.js";
import { liveLogPort, sessionPorts } from "../../vscode/clientPorts.js";
import type { LogLevel } from "../../core/index.js";

/**
 * What one Session's ports are built from.
 *
 * The services below these have tests of their own; what nobody else checks is
 * that they are handed *this window's* folders and *these* settings. That wiring
 * is the kind that fails silently — a filesystem port built with the wrong roots
 * refuses nothing, and every service under it goes on passing.
 */

/** Settings as `getConfiguration("agentConductor")` serves them: unprefixed. */
const settings = (over: Record<string, unknown> = {}) =>
  readSettings({ get: (key: string) => over[key] }).settings;

/**
 * Ports whose consent is already given.
 *
 * Deliberately: with the dialog left to refuse, every one of these rejects for
 * that reason and the roots could be anything at all. What is under test is the
 * barrier that is left when the user has said yes.
 */
const ports = (roots: string[]) =>
  sessionPorts({
    settings: settings({
      "permissions.autoAllowClientOperations": ["fs.read", "fs.write", "terminal.spawn"],
    }),
    roots,
    agentLabel: "Mock Agent",
    log: { log: () => undefined },
    consent: { ask: () => Promise.reject(new Error("nothing may be asked here")) },
    documents: { text: () => undefined, replace: async () => false },
    forms: { input: async () => undefined, pick: async () => undefined, pickMany: async () => undefined },
  });

/** Two real directories: one the Session was opened over, one it was not. */
const folders = async (t: TestContext): Promise<{ inside: string; outside: string }> => {
  const made = await Promise.all([
    mkdtemp(join(tmpdir(), "conductor-inside-")),
    mkdtemp(join(tmpdir(), "conductor-outside-")),
  ]);
  t.after(() => Promise.all(made.map((at) => rm(at, { recursive: true, force: true }))));
  // Real paths, and real files in them: a path that does not exist is refused by
  // the canonicalizer, which would make every one of these pass for the wrong
  // reason whatever the roots were.
  const [inside, outside] = made.map((at) => realpathSync(at));
  await Promise.all([
    writeFile(join(inside, "ours.txt"), "ours", "utf8"),
    writeFile(join(outside, "theirs.txt"), "theirs", "utf8"),
  ]);
  return { inside, outside };
};

test("a session may only read inside the folders this window has open", async (t) => {
  const { inside, outside } = await folders(t);
  const built = ports([inside]);

  // Proof the path itself is fine: the same call inside the roots succeeds.
  assert.equal(
    (await built.fs?.readTextFile({ sessionId: "s", path: join(inside, "ours.txt") }))?.content,
    "ours",
  );

  await assert.rejects(
    () => built.fs?.readTextFile({ sessionId: "s", path: join(outside, "theirs.txt") }) ?? Promise.resolve(),
    /outside/i,
  );
});

test("a session may only run a command inside those folders", async (t) => {
  const { inside, outside } = await folders(t);
  const built = ports([inside]);
  const terminal = built.terminal;
  assert.ok(terminal);

  // Both halves, because only the pair pins the wiring: a port handed the wrong
  // folders refuses everything, which the failing half alone cannot tell apart.
  const started = await terminal.createTerminal({
    sessionId: "s",
    command: "/bin/echo",
    args: ["hello"],
    cwd: inside,
  });
  await terminal.releaseTerminal({ sessionId: "s", terminalId: started.terminalId });

  await assert.rejects(
    () =>
      terminal.createTerminal({ sessionId: "s", command: "/bin/echo", args: ["hello"], cwd: outside }),
    /outside/i,
  );
});

test("a form the agent asks for is put to the window this session belongs to", async (t) => {
  const { inside } = await folders(t);
  const asked: string[] = [];
  const built = sessionPorts({
    settings: settings(),
    roots: [inside],
    agentLabel: "Mock Agent",
    log: { log: () => undefined },
    consent: { ask: () => Promise.reject(new Error("nothing may be asked here")) },
    documents: { text: () => undefined, replace: async () => false },
    forms: {
      input: async (options) => {
        asked.push(String(options?.prompt ?? options?.title ?? ""));
        return "answered";
      },
      pick: async () => undefined,
      pickMany: async () => undefined,
    },
  });

  const answer = await built.elicitation?.createElicitation({
    mode: "form",
    sessionId: "s",
    message: "What is the ticket number?",
    requestedSchema: { type: "object", properties: { ticket: { type: "string", title: "Ticket" } } },
  });

  // Without this the capability is advertised and every question the Agent asks
  // goes nowhere — which is worse than never offering it.
  assert.equal(asked.length, 1);
  assert.equal(answer?.action, "accept");
});

test("a session with no folder to run in reaches nothing rather than everything", async (t) => {
  // The empty list is the case worth pinning: a port built with no roots that
  // read that as "no restriction" would be the widest possible one.
  const { inside } = await folders(t);
  const built = ports([]);

  await assert.rejects(
    () => built.fs?.readTextFile({ sessionId: "s", path: join(inside, "ours.txt") }) ?? Promise.resolve(),
    /outside/i,
  );
});

test("what is written to the log is decided by the level in settings", () => {
  const written: string[] = [];
  let level = "off";
  const port = liveLogPort(
    {
      error: (text: string) => written.push(`error ${text}`),
      info: (text: string) => written.push(`info ${text}`),
      debug: (text: string) => written.push(`debug ${text}`),
      trace: (text: string) => written.push(`trace ${text}`),
    } as never,
    () => level,
  );
  const all = (): void => {
    for (const severity of ["error", "info", "debug", "trace"] as LogLevel[]) {
      port.log(severity, "said");
    }
  };

  all();
  assert.deepEqual(written, [], "`off` drops the record rather than writing it quietly");

  level = "error";
  all();
  assert.deepEqual(written, ["error said"]);

  // Re-read per record, not once when the window opened: a level changed while
  // it is open takes effect on the next record.
  level = "debug";
  written.length = 0;
  all();
  assert.deepEqual(written, ["error said", "info said", "debug said"]);
});

test("a session is served through every port the protocol may reach for", async (t) => {
  const { inside } = await folders(t);

  const built = ports([inside]);

  // Each of these answers a request an Agent makes. One left off is a capability
  // this Client advertised and then cannot serve.
  for (const [name, port] of Object.entries(built)) {
    assert.ok(port, `no ${name} port was built`);
  }
  assert.deepEqual(Object.keys(built).sort(), [
    "elicitation",
    "fs",
    "log",
    "permission",
    "process",
    "terminal",
  ]);
});

test("the quietest severity is written when the level asks for it", () => {
  const written: string[] = [];
  const port = liveLogPort(
    {
      error: (text: string) => written.push(`error ${text}`),
      info: (text: string) => written.push(`info ${text}`),
      debug: (text: string) => written.push(`debug ${text}`),
      trace: (text: string) => written.push(`trace ${text}`),
    } as never,
    () => "trace",
  );

  port.log("trace", "said");

  // Four severities, four bindings: one wired to the wrong channel method loses
  // exactly the records that were asked for.
  assert.deepEqual(written, ["trace said"]);
});

/**
 * A log record is written from places nothing is waiting on: an Agent process
 * that ended, a pipe that drained, a Turn's `finally`. Every one of them reaches
 * the window twice — the configured level is re-read, then the channel is
 * written — and a window on its way out answers both by throwing.
 *
 * Guarded here rather than at each caller. There are dozens of them, none has
 * anywhere to put the failure, and the one thing a log must never do is end the
 * work that was logging.
 */
test("a window that has gone cannot fail whatever was writing to its log", () => {
  const closed = liveLogPort(
    {
      error: () => {
        throw new Error("Channel has been closed");
      },
      info: () => undefined,
      debug: () => undefined,
      trace: () => undefined,
    } as never,
    () => "trace",
  );
  const unreadable = liveLogPort({ error: () => undefined } as never, () => {
    throw new Error("Extension instance has been disposed");
  });

  assert.doesNotThrow(() => closed.log("error", "an agent process ended"));
  assert.doesNotThrow(() => unreadable.log("error", "an agent process ended"));
});
