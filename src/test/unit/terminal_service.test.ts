import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { PassThrough } from "node:stream";
import { collectPipe, TerminalService } from "../../vscode/terminals.js";
import { consent, run, script, workspace } from "../terminal-fixtures.js";

test("a command runs and both of its output streams are captured", async (t: TestContext) => {
  const root = await workspace(t);
  const service = new TerminalService({ roots: [root], consent: consent() });

  const { terminalId, exit } = await run(service, {
    ...script("process.stdout.write('out'); process.stderr.write('err')"),
    cwd: root,
  });
  const output = await service.terminalOutput({ sessionId: "s1", terminalId });

  assert.equal(exit.exitCode, 0);
  assert.match(output.output, /out/);
  assert.match(output.output, /err/);
  assert.equal(output.truncated, false);
  assert.deepEqual(output.exitStatus, { exitCode: 0, signal: null });
});

test("an argument is an argument: nothing is handed to a shell", async (t: TestContext) => {
  const root = await workspace(t);
  const service = new TerminalService({ roots: [root], consent: consent() });

  const { terminalId } = await run(service, {
    ...script("process.stdout.write(process.argv[1] ?? '')", "$(echo pwned); rm -rf /"),
    cwd: root,
  });
  const output = await service.terminalOutput({ sessionId: "s1", terminalId });

  assert.equal(output.output, "$(echo pwned); rm -rf /");
});

test("output past the byte limit is dropped from the front and flagged", async (t: TestContext) => {
  const root = await workspace(t);
  const service = new TerminalService({ roots: [root], consent: consent() });

  const { terminalId } = await run(service, {
    ...script("for (let i = 0; i < 100; i++) process.stdout.write(String(i % 10))"),
    cwd: root,
    outputByteLimit: 10,
  });
  const output = await service.terminalOutput({ sessionId: "s1", terminalId });

  assert.equal(output.output.length, 10);
  assert.equal(output.output, "0123456789", "the newest output is what is kept");
  assert.equal(output.truncated, true);
});

test("a killed command reports its signal and keeps its output readable", async (t: TestContext) => {
  const root = await workspace(t);
  const service = new TerminalService({ roots: [root], consent: consent() });
  const { terminalId } = await service.createTerminal({
    sessionId: "s1",
    ...script("process.stdout.write('started'); setInterval(() => {}, 1000)"),
    cwd: root,
  });
  // Waited for, not slept through: the suite runs every file at once, so a fixed
  // delay is a guess about how loaded the machine is, and the test it makes is
  // one that fails for a reason that has nothing to do with what it protects.
  for (let left = 200; left > 0; left -= 1) {
    const so_far = await service.terminalOutput({ sessionId: "s1", terminalId });
    if (so_far.output === "started") break;
    await new Promise((wake) => setTimeout(wake, 25));
  }

  await service.killTerminal({ sessionId: "s1", terminalId });
  const exit = await service.waitForTerminalExit({ sessionId: "s1", terminalId });
  const output = await service.terminalOutput({ sessionId: "s1", terminalId });

  assert.equal(exit.signal, "SIGTERM");
  assert.equal(output.output, "started", "the buffer outlives the process, until release");
});

test("a released terminal is no longer a handle to anything", async (t: TestContext) => {
  const root = await workspace(t);
  const service = new TerminalService({ roots: [root], consent: consent() });
  const { terminalId } = await run(service, { ...script("process.stdout.write('x')"), cwd: root });

  await service.releaseTerminal({ sessionId: "s1", terminalId });

  await assert.rejects(service.terminalOutput({ sessionId: "s1", terminalId }), /unknown terminal/);
});

test("an id nobody was issued is not a terminal", async (t: TestContext) => {
  const root = await workspace(t);
  const service = new TerminalService({ roots: [root], consent: consent() });

  await assert.rejects(
    service.terminalOutput({ sessionId: "s1", terminalId: "term-1" }),
    /unknown terminal/,
  );
});

test("another session's terminal id is not a handle either", async (t: TestContext) => {
  const root = await workspace(t);
  const service = new TerminalService({ roots: [root], consent: consent() });
  const { terminalId } = await run(service, { ...script("process.stdout.write('x')"), cwd: root });

  await assert.rejects(
    service.terminalOutput({ sessionId: "s2", terminalId }),
    /unknown terminal/,
  );
});

test("a command that cannot start says so instead of hanging", async (t: TestContext) => {
  const root = await workspace(t);
  const service = new TerminalService({ roots: [root], consent: consent() });

  const { terminalId, exit } = await run(service, {
    command: join(root, "no-such-command"),
    args: [],
    cwd: root,
  });
  const output = await service.terminalOutput({ sessionId: "s1", terminalId });

  assert.equal(exit.exitCode, null);
  assert.match(output.output, /ENOENT/);
});

test("disposing the service stops what it started", async (t: TestContext) => {
  const root = await workspace(t);
  const service = new TerminalService({ roots: [root], consent: consent() });
  const { terminalId } = await service.createTerminal({
    sessionId: "s1",
    ...script("setInterval(() => {}, 1000)"),
    cwd: root,
  });
  const running = service.waitForTerminalExit({ sessionId: "s1", terminalId });

  service.dispose();

  assert.equal((await running).signal, "SIGTERM");
});

test("truncation cuts on a character boundary, not through one", async (t: TestContext) => {
  const root = await workspace(t);
  const service = new TerminalService({ roots: [root], consent: consent() });

  // Five two-byte characters; a limit of nine bytes must drop a whole one.
  const { terminalId } = await run(service, {
    ...script("process.stdout.write('ααααα')"),
    cwd: root,
    outputByteLimit: 9,
  });
  const output = await service.terminalOutput({ sessionId: "s1", terminalId });

  assert.equal(output.truncated, true);
  assert.equal(output.output, "αααα");
  assert.equal(output.output.includes("�"), false, "a character was cut in half");
});

test("the agent cannot raise the amount of output this client will hold", async (t: TestContext) => {
  const root = await workspace(t);
  const service = new TerminalService({ roots: [root], consent: consent(), outputByteLimit: 32 });

  const { terminalId } = await run(service, {
    ...script("for (let i = 0; i < 500; i++) process.stdout.write('x')"),
    cwd: root,
    outputByteLimit: 10_000_000,
  });
  const output = await service.terminalOutput({ sessionId: "s1", terminalId });

  assert.equal(output.output.length, 32);
  assert.equal(output.truncated, true);
});

test("output written as the command ends is all there when the wait returns", async (t: TestContext) => {
  const root = await workspace(t);
  const service = new TerminalService({ roots: [root], consent: consent() });

  // A command whose own child inherits its output and writes after it exits:
  // the process is gone long before the last of its output has been read.
  const { terminalId } = await run(service, {
    ...script(
      "require('node:child_process').spawn(process.execPath," +
        " ['-e', \"setTimeout(() => process.stdout.write('LATE'), 50)\"], { stdio: 'inherit' });" +
        " process.stdout.write('EARLY')",
    ),
    cwd: root,
  });
  const output = await service.terminalOutput({ sessionId: "s1", terminalId });

  assert.equal(output.output, "EARLYLATE");
});

test("killing a command stops what the command started", { skip: process.platform === "win32" }, async (t: TestContext) => {
  const root = await workspace(t);
  const service = new TerminalService({ roots: [root], consent: consent() });
  const { terminalId } = await service.createTerminal({
    sessionId: "s1",
    ...script(
      "require('node:child_process').spawn(process.execPath," +
        " ['-e', \"setInterval(() => process.stdout.write('tick'), 25)\"], { stdio: 'inherit' });" +
        " setInterval(() => {}, 1000)",
    ),
    cwd: root,
  });
  // Waited for rather than slept through: starting node and its grandchild takes
  // as long as the machine takes, and a fixed delay makes this a test of the
  // machine's load instead of the kill.
  const output = async (): Promise<number> =>
    (await service.terminalOutput({ sessionId: "s1", terminalId })).output.length;
  const deadline = Date.now() + 15_000;
  while ((await output()) === 0 && Date.now() < deadline) {
    await new Promise((wake) => setTimeout(wake, 25));
  }
  assert.ok((await output()) > 0, "the command's child did run");

  await service.killTerminal({ sessionId: "s1", terminalId });
  await new Promise((wake) => setTimeout(wake, 200));
  const settled = await output();
  await new Promise((wake) => setTimeout(wake, 300));

  assert.equal(await output(), settled, "the command's child outlived the kill");
});

test("releasing a terminal stops the children a finished command left behind", { skip: process.platform === "win32" }, async (t: TestContext) => {
  const root = await workspace(t);
  const marker = join(root, "worker.log");
  const service = new TerminalService({ roots: [root], consent: consent() });

  // The wrapper shape: a command that starts a worker and exits straight away.
  const { terminalId } = await run(service, {
    ...script(
      "const worker = require('node:child_process').spawn(process.execPath, ['-e'," +
        " \"setInterval(() => require('node:fs').appendFileSync(process.argv[1], 'x'), 25)\"," +
        " process.argv[1]], { stdio: 'ignore' }); worker.unref();",
      marker,
    ),
    cwd: root,
  });
  await new Promise((wake) => setTimeout(wake, 250));

  await service.releaseTerminal({ sessionId: "s1", terminalId });
  await new Promise((wake) => setTimeout(wake, 250));
  const settled = (await readFile(marker, "utf8")).length;
  await new Promise((wake) => setTimeout(wake, 300));

  assert.ok(settled > 0, "the worker did run");
  assert.equal((await readFile(marker, "utf8")).length, settled, "the worker outlived its terminal");
});

test("a character split across chunks is not left half-decoded", async (t: TestContext) => {
  const root = await workspace(t);
  const service = new TerminalService({ roots: [root], consent: consent() });

  // One emoji written a byte at a time, then a plain character: the cut lands
  // inside the emoji and its remaining bytes arrive in separate chunks.
  const { terminalId } = await run(service, {
    ...script(
      "const bytes = Buffer.from('😀Z');" +
        " for (const byte of bytes) process.stdout.write(Buffer.from([byte]));",
    ),
    cwd: root,
    outputByteLimit: 4,
  });
  const output = await service.terminalOutput({ sessionId: "s1", terminalId });

  assert.equal(output.output.includes("�"), false, `half a character survived: ${output.output}`);
});

test("a process group this client has seen end is never signalled again", async (t: TestContext) => {
  const root = await workspace(t);
  const signals: [number, NodeJS.Signals | 0][] = [];
  const service = new TerminalService({
    roots: [root],
    consent: consent(),
    signalGroup: (pgid, signal) => {
      signals.push([pgid, signal]);
      process.kill(-pgid, signal);
    },
  });

  const { terminalId } = await run(service, { ...script("process.exit(0)"), cwd: root });
  const afterExit = signals.length;

  await service.releaseTerminal({ sessionId: "s1", terminalId });

  // Proves the client asks whether the group is still there at all — without
  // that question it cannot know the difference between an empty group and one
  // the system has since handed to a stranger.
  assert.ok(
    signals.some(([, signal]) => signal === 0),
    "the client never looked to see whether the group had ended",
  );
  // The command is over and its group is empty, so its id is free for the
  // system to hand to something else. Signalling it now could reach a stranger.
  assert.deepEqual(
    signals.slice(afterExit).filter(([, signal]) => signal !== 0),
    [],
    "an ended process group must never be signalled",
  );
});

test("a recycled group id is not signalled on the strength of an id that has moved on", async (t: TestContext) => {
  const root = await workspace(t);
  const signals: [number, NodeJS.Signals | 0][] = [];
  let groupExists = true;
  const service = new TerminalService({
    roots: [root],
    consent: consent(),
    groupPollMs: 25,
    // Stands in for the system's answers; nothing here signals anything real.
    signalGroup: (pgid, signal) => {
      signals.push([pgid, signal]);
      if (groupExists) return;
      const gone: NodeJS.ErrnoException = new Error("no such process group");
      gone.code = "ESRCH";
      throw gone;
    },
  });

  const { terminalId } = await run(service, { ...script("process.exit(0)"), cwd: root });
  // The command's group outlives it — something it started is still running —
  // and then that ends too, with nobody asking about it…
  await new Promise((wake) => setTimeout(wake, 120));
  groupExists = false;
  await new Promise((wake) => setTimeout(wake, 120));
  // …and its id comes back around as somebody else's group.
  groupExists = true;

  await service.releaseTerminal({ sessionId: "s1", terminalId });

  assert.deepEqual(
    signals.filter(([, signal]) => signal !== 0),
    [],
    "a stranger's process group was signalled on a recycled id",
  );
});

/**
 * A command's pipe can fail while the command is still running, and a stream
 * that fails with nothing listening does not report it — `emit("error")` throws,
 * out of Node's own read path and into whichever process is reading. A broken
 * pipe is not a reason to take an extension host down, so it is collected like
 * anything else the command said.
 */
test("a pipe that fails says so in the output rather than throwing at the host", () => {
  const collected: Buffer[] = [];
  const pipe = new PassThrough();
  collectPipe(pipe, (chunk) => collected.push(chunk));

  pipe.emit("data", Buffer.from("started", "utf8"));
  pipe.emit("error", new Error("read EIO"));
  pipe.emit("data", Buffer.from("after", "utf8"));

  const said = Buffer.concat(collected).toString("utf8");
  assert.match(said, /started/);
  assert.match(said, /read EIO/, "output that stops has to carry the reason it stopped");
});

test("a command with no pipe at all is collected without complaint", () => {
  assert.doesNotThrow(() => collectPipe(null, () => undefined));
});
