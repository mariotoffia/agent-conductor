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
  endPipe(): void;
} {
  let deliver: (chunk: string) => void = () => undefined;
  let processEnded: (exit: AgentExit) => void = () => undefined;
  let pipeEnded: () => void = () => undefined;
  const exited = new Promise<AgentExit>((settle) => {
    processEnded = settle;
  });
  const stderrEnded = new Promise<void>((settle) => {
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
    endPipe: () => pipeEnded(),
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
