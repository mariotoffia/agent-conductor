import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { TerminalService } from "../../vscode/terminals.js";
import { consent, run, script, workspace } from "../terminal-fixtures.js";

test("a command runs and both of its output streams are captured", async () => {
  const root = await workspace();
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

test("an argument is an argument: nothing is handed to a shell", async () => {
  const root = await workspace();
  const service = new TerminalService({ roots: [root], consent: consent() });

  const { terminalId } = await run(service, {
    ...script("process.stdout.write(process.argv[1] ?? '')", "$(echo pwned); rm -rf /"),
    cwd: root,
  });
  const output = await service.terminalOutput({ sessionId: "s1", terminalId });

  assert.equal(output.output, "$(echo pwned); rm -rf /");
});

test("output past the byte limit is dropped from the front and flagged", async () => {
  const root = await workspace();
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

test("a killed command reports its signal and keeps its output readable", async () => {
  const root = await workspace();
  const service = new TerminalService({ roots: [root], consent: consent() });
  const { terminalId } = await service.createTerminal({
    sessionId: "s1",
    ...script("process.stdout.write('started'); setInterval(() => {}, 1000)"),
    cwd: root,
  });
  // Let it print before it is stopped.
  await new Promise((wake) => setTimeout(wake, 200));

  await service.killTerminal({ sessionId: "s1", terminalId });
  const exit = await service.waitForTerminalExit({ sessionId: "s1", terminalId });
  const output = await service.terminalOutput({ sessionId: "s1", terminalId });

  assert.equal(exit.signal, "SIGTERM");
  assert.equal(output.output, "started", "the buffer outlives the process, until release");
});

test("a released terminal is no longer a handle to anything", async () => {
  const root = await workspace();
  const service = new TerminalService({ roots: [root], consent: consent() });
  const { terminalId } = await run(service, { ...script("process.stdout.write('x')"), cwd: root });

  await service.releaseTerminal({ sessionId: "s1", terminalId });

  await assert.rejects(service.terminalOutput({ sessionId: "s1", terminalId }), /unknown terminal/);
});

test("an id nobody was issued is not a terminal", async () => {
  const root = await workspace();
  const service = new TerminalService({ roots: [root], consent: consent() });

  await assert.rejects(
    service.terminalOutput({ sessionId: "s1", terminalId: "term-1" }),
    /unknown terminal/,
  );
});

test("another session's terminal id is not a handle either", async () => {
  const root = await workspace();
  const service = new TerminalService({ roots: [root], consent: consent() });
  const { terminalId } = await run(service, { ...script("process.stdout.write('x')"), cwd: root });

  await assert.rejects(
    service.terminalOutput({ sessionId: "s2", terminalId }),
    /unknown terminal/,
  );
});

test("a command that cannot start says so instead of hanging", async () => {
  const root = await workspace();
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

test("disposing the service stops what it started", async () => {
  const root = await workspace();
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

test("truncation cuts on a character boundary, not through one", async () => {
  const root = await workspace();
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

test("the agent cannot raise the amount of output this client will hold", async () => {
  const root = await workspace();
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

test("output written as the command ends is all there when the wait returns", async () => {
  const root = await workspace();
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

test("killing a command stops what the command started", { skip: process.platform === "win32" }, async () => {
  const root = await workspace();
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
  await new Promise((wake) => setTimeout(wake, 200));

  await service.killTerminal({ sessionId: "s1", terminalId });
  await new Promise((wake) => setTimeout(wake, 200));
  const settled = (await service.terminalOutput({ sessionId: "s1", terminalId })).output.length;
  await new Promise((wake) => setTimeout(wake, 300));
  const later = (await service.terminalOutput({ sessionId: "s1", terminalId })).output.length;

  assert.ok(settled > 0, "the command's child did run");
  assert.equal(later, settled, "the command's child outlived the kill");
});

test("releasing a terminal stops the children a finished command left behind", { skip: process.platform === "win32" }, async () => {
  const root = await workspace();
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

test("a character split across chunks is not left half-decoded", async () => {
  const root = await workspace();
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

test("a process group this client has seen end is never signalled again", async () => {
  const root = await workspace();
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

test("a recycled group id is not signalled on the strength of an id that has moved on", async () => {
  const root = await workspace();
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
