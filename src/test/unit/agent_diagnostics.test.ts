import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { ConductorSession, type AgentExit, type AgentProcess, type ProcessPort } from "../../core/index.js";
import { harness, launchMockAgent } from "../acp-harness.js";

/**
 * An Agent is started with resolved secrets in its environment, and its own
 * diagnostics are its own text. Nothing that comes back out of them carries a
 * credential — not into the tail that reaches the chat transcript, and not into
 * the log records somebody will paste into a bug report (ADR-0010).
 */

const acpTest = (name: string, fn: (t: TestContext) => Promise<void>) =>
  test(name, { timeout: 10_000 }, fn);

/** Long enough that redaction does not skip it, and distinctive on sight. */
const LEAKED_SECRET = "sk-live-not-a-real-credential-0123456789";

/** What a log reader's eye skips past to read the agent's own output. */
const STDERR_MARK = "stderr: ";

acpTest("a credential split across two reads is not reassembled by the tail", async (t) => {
  const h = harness(t);

  // Redacting a chunk at a time finds nothing in either half; joining them puts
  // the value back. The tail is what reaches the chat transcript (ADR-0010).
  await assert.rejects(
    h.open({
      launch: launchMockAgent("leak-secret-split"),
      secretEnvironment: { MOCK_SECRET: LEAKED_SECRET },
      setupTimeoutMs: 5_000,
    }),
    (error: Error) => {
      assert.doesNotMatch(error.message, new RegExp(LEAKED_SECRET));
      return true;
    },
  );

  // Per record is not the test: two adjacent records in one log file are one
  // multiline match away from the value, and people paste output channels into
  // bug reports. What is written has to be free of it as written.
  const written = h.logs
    .filter((record) => record.includes("stderr:"))
    .map((record) => record.slice(record.indexOf(STDERR_MARK) + STDERR_MARK.length))
    .join("");
  assert.equal(written.includes(LEAKED_SECRET), false, "the log records reassemble the secret");
});

acpTest("a credential with newlines of its own is not split across records", async (t) => {
  const h = harness(t);
  const pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw\n-----END PRIVATE KEY-----";
  // The agent splits its output at the midpoint of the value, and the split has
  // to land after a newline inside it — otherwise the first half has no line to
  // flush and this passes whether or not the guard exists.
  assert.ok(
    pem.slice(0, Math.floor(pem.length / 2)).includes("\n"),
    "edit the key and this test stops testing the guard",
  );

  await assert.rejects(
    h.open({
      launch: launchMockAgent("leak-secret-split"),
      secretEnvironment: { MOCK_SECRET: pem },
      setupTimeoutMs: 5_000,
    }),
    (error: Error) => {
      assert.equal(error.message.includes(pem), false);
      return true;
    },
  );

  // Read as the lines they are in the log file — no stripping needed here.
  const written = h.logs
    .filter((record) => record.includes(STDERR_MARK))
    .map((record) => record.slice(record.indexOf(STDERR_MARK) + STDERR_MARK.length))
    .join("\n");
  assert.equal(written.includes(pem), false, "the log records reassemble the credential");
});

acpTest("a runtime that prints its own credentials leaks none of them", async (t) => {
  const h = harness(t);
  const secret = LEAKED_SECRET;

  // The agent writes the value it was started with to its own diagnostics and
  // dies, which puts it in the stderr tail carried by the setup failure — the
  // same text that reaches the log and the chat transcript (ADR-0010).
  await assert.rejects(
    h.open({
      launch: launchMockAgent("leak-secret"),
      secretEnvironment: { MOCK_SECRET: secret },
    }),
    (error: Error) => {
      assert.doesNotMatch(error.message, new RegExp(secret));
      assert.match(error.message, /MOCK_SECRET=\[redacted\]/);
      return true;
    },
  );

  assert.equal(
    h.logs.some((record) => record.includes(secret)),
    false,
    "no log record may carry a resolved secret",
  );
  assert.ok(
    h.logs.some((record) => record.includes("[redacted]")),
    "the stderr record should still be there, with the value removed",
  );
});

/**
 * A Runtime whose diagnostics are delivered by hand, so the order the pipes
 * would otherwise choose can be stated rather than hoped for.
 */
function scriptedStderr(): {
  port: ProcessPort;
  write(chunk: string): void;
  endProcess(): void;
  endPipe(how?: "closed" | "drained"): void;
} {
  let deliver: (chunk: string) => void = () => undefined;
  let processEnded: (exit: AgentExit) => void = () => undefined;
  let pipeEnded: (how: "closed" | "drained") => void = () => undefined;
  const exited = new Promise<AgentExit>((settle) => {
    processEnded = settle;
  });
  const stderrEnded = new Promise<"closed" | "drained">((settle) => {
    pipeEnded = settle;
  });
  const port: ProcessPort = {
    spawn: (): AgentProcess => ({
      stdin: new WritableStream<Uint8Array>(),
      stdout: new ReadableStream<Uint8Array>(), // never speaks ACP
      onStderr: (handler) => {
        deliver = handler;
      },
      exited,
      stderrEnded,
      kill: () => undefined,
    }),
  };
  return {
    port,
    write: (chunk) => deliver(chunk),
    endProcess: () => processEnded({ code: 9, signal: null }),
    /** How the pipe stopped: `drained` means something may still write. */
    endPipe: (how: "closed" | "drained" = "closed") => pipeEnded(how),
  };
}

acpTest("output delivered after the process ends still reaches the log", async (t) => {
  const logs: string[] = [];
  const scripted = scriptedStderr();
  const session = ConductorSession.open(
    {
      runtimeId: "scripted",
      launch: { command: process.execPath, args: [], env: {} },
      cwd: process.cwd(),
      // A secret makes the guard non-zero, which is what holds a trailing line
      // back until something says the diagnostics are complete.
      secretEnvironment: { MOCK_SECRET: LEAKED_SECRET },
      setupTimeoutMs: 2_000,
    },
    { process: scripted.port, log: { log: (level, text) => logs.push(`${level} ${text}`) } },
  );
  // Attached now, not at the assertion: the process ends below and the failure
  // would otherwise be an unhandled rejection before anything is waiting on it.
  const failed = session.then(() => undefined, (error: Error) => error);
  t.after(() => void session.then((live) => live.dispose(), () => undefined));

  const stderr = ["first line\n", "the last thing it said\n"];
  // The guard has to exceed everything the runtime says, or `writeLines` would
  // flush on its own and the flush below would not be what is under test.
  assert.ok(
    LEAKED_SECRET.length > stderr.join("").length,
    "shorten the secret and this test stops distinguishing the two events",
  );

  scripted.write(stderr[0]);
  scripted.endProcess();
  // Node documents `exit` as firing before stdio closes, so this is ordinary:
  // the process is gone and its last diagnostic has not arrived yet. The gap is
  // a real one so that anything hanging off the exit has certainly run.
  await new Promise((resolve) => setTimeout(resolve, 20));
  scripted.write(stderr[1]);
  scripted.endPipe();
  assert.ok(await failed, "the scripted runtime should have failed its handshake");

  const written = logs.filter((record) => record.includes(STDERR_MARK)).join("\n");
  assert.match(written, /first line/);
  // A finished process is not finished output (ARCHITECTURE.md §Client services).
  assert.match(written, /the last thing it said/);
});

test("an agent's own error text cannot carry a resolved secret into a failure", { timeout: 20_000 }, async (t: TestContext) => {
  const secret = "sk-live-not-a-real-credential-0123456789";
  const h = harness(t);
  const session = await h.open({
    launch: launchMockAgent("leak-in-error"),
    secretEnvironment: { MOCK_SECRET: secret },
  });

  // The Agent was started with the credential in its environment, and it puts
  // that environment into a protocol error. What it says reaches a failure
  // message, the log and the transcript (ADR-0010).
  await assert.rejects(session.prompt("go"), (error: Error) => {
    assert.equal(error.message.includes(secret), false, error.message);
    assert.match(error.message, /upstream rejected/);
    return true;
  });
  assert.equal(h.logs.some((line) => line.includes(secret)), false, "the log kept it");
});

test("a refused handshake cannot carry a resolved secret either", { timeout: 20_000 }, async (t: TestContext) => {
  const secret = "sk-live-not-a-real-credential-0123456789";
  const h = harness(t);

  // The Agent rejects `initialize` in its own words, and it was started with
  // the credential in its environment. This failure reaches the transcript and
  // `errorDetails`, which VS Code keeps in chat history (ADR-0010).
  await assert.rejects(
    h.open({
      launch: launchMockAgent("leak-in-handshake"),
      secretEnvironment: { MOCK_SECRET: secret },
    }),
    (error: Error) => {
      assert.equal(error.message.includes(secret), false, error.message);
      assert.match(error.message, /handshake/i);
      return true;
    },
  );
});

test("a secret that collides with a policy variable is reported, not dropped in silence", { timeout: 20_000 }, async (t: TestContext) => {
  const h = harness(t);

  // Codex suppresses through CODEX_CONFIG, so a stored secret pointed at that
  // name never reaches the agent — and a runtime that then fails to
  // authenticate is exactly the obscure failure ADR-0010 refuses to allow.
  const session = await h.open({
    launch: { ...launchMockAgent(), env: { CODEX_CONFIG: "{}" } },
    secretEnvironment: { CODEX_CONFIG: "would-have-been-a-credential" },
  });

  assert.ok(
    h.logs.some((line) => line.includes("CODEX_CONFIG") && /not applied/.test(line)),
    h.logs.join("\n"),
  );
  assert.equal(session.state, "idle");
});

test("a refused config option cannot carry a resolved secret to the caller", { timeout: 20_000 }, async (t: TestContext) => {
  const secret = "sk-live-not-a-real-credential-0123456789";
  const h = harness(t);
  const session = await h.open({
    launch: launchMockAgent("leak-in-set"),
    secretEnvironment: { MOCK_SECRET: secret },
  });

  // `/model` and `/effort` render this straight into the transcript and into
  // `errorDetails`, which VS Code keeps in chat history (ADR-0010).
  await assert.rejects(session.setConfigOption("model", "mock-model-fast"), (error: Error) => {
    assert.equal(error.message.includes(secret), false, error.message);
    assert.match(error.message, /set refused/);
    return true;
  });
});

acpTest("a pipe that only drained keeps holding back what a value could straddle", async (t) => {
  const logs: string[] = [];
  const scripted = scriptedStderr();
  const session = ConductorSession.open(
    {
      runtimeId: "scripted",
      launch: { command: process.execPath, args: [], env: {} },
      cwd: process.cwd(),
      secretEnvironment: { MOCK_SECRET: LEAKED_SECRET },
      setupTimeoutMs: 2_000,
    },
    { process: scripted.port, log: { log: (level, text) => logs.push(`${level} ${text}`) } },
  );
  const failed = session.then(() => undefined, (error: Error) => error);
  t.after(() => void session.then((live) => live.dispose(), () => undefined));

  // Half a credential, then the process is gone but something it started still
  // holds the descriptor — which is what `drained` means. Writing this record
  // now and the rest of the value later puts the two halves in one log file,
  // adjacent, which is the join redaction exists to stop (ADR-0010).
  scripted.write(`MOCK_SECRET=${LEAKED_SECRET.slice(0, 12)}`);
  scripted.endProcess();
  scripted.endPipe("drained");
  await failed;

  assert.equal(
    logs.some((line) => line.includes(LEAKED_SECRET.slice(0, 12))),
    false,
    `half a credential was written on a drain: ${logs.join("\n")}`,
  );

  // What was held back also has to stay in the buffer, so that the rest of the
  // value is redacted against the whole of it when it arrives. The test below
  // is the one that asks for that.
});

acpTest("what a drain held back is joined to the rest of the value, not dropped", async (t) => {
  const logs: string[] = [];
  const scripted = scriptedStderr();
  const session = ConductorSession.open(
    {
      runtimeId: "scripted",
      launch: { command: process.execPath, args: [], env: {} },
      cwd: process.cwd(),
      secretEnvironment: { MOCK_SECRET: LEAKED_SECRET },
      setupTimeoutMs: 2_000,
    },
    { process: scripted.port, log: { log: (level, text) => logs.push(`${level} ${text}`) } },
  );
  const failed = session.then(() => undefined, (error: Error) => error);
  t.after(() => void session.then((live) => live.dispose(), () => undefined));

  const guard = LEAKED_SECRET.length;
  // Long enough that the drain writes a record and still holds a guard's worth
  // back, and with no line ending in it, so nothing flushes before the drain.
  const said = `${"-".repeat(guard + 4)}MOCK_SECRET=${LEAKED_SECRET.slice(0, 12)}`;
  assert.equal(said.includes("\n"), false, "a line ending here would flush before the drain");
  assert.ok(said.length > guard, "shorter than the guard and the drain writes nothing at all");

  scripted.write(said);
  scripted.endProcess();
  scripted.endPipe("drained");
  await failed;

  // The rest of the value arrives from whatever still holds the descriptor. It
  // is one value only because the head is still in the buffer to be redacted
  // with it — and the newline has to fall inside the guard's window, or the
  // joined line is held back rather than written.
  scripted.write(`${LEAKED_SECRET.slice(12)}\n${"y".repeat(guard + 20)}`);

  const written = logs
    .filter((record) => record.includes(STDERR_MARK))
    .map((record) => record.slice(record.indexOf(STDERR_MARK) + STDERR_MARK.length))
    .join("\n");
  assert.ok(
    written.includes("MOCK_SECRET=[redacted]"),
    `the held-back head was dropped rather than rejoined: ${written}`,
  );
  assert.equal(
    logs.some((record) => record.includes(LEAKED_SECRET.slice(12))),
    false,
    `the rest of a credential reached the log unredacted: ${logs.join("\n")}`,
  );
});
