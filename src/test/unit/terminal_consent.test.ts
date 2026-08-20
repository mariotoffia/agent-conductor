import assert from "node:assert/strict";
import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { TerminalService } from "../../vscode/terminals.js";
import { consent, script, shownDetail, workspace } from "../terminal-fixtures.js";

test("a working directory outside the session roots is refused", async () => {
  const root = await workspace();
  const outside = await workspace();
  const guard = consent();
  const service = new TerminalService({ roots: [root], consent: guard });

  await assert.rejects(
    service.createTerminal({ sessionId: "s1", ...script("process.exit(0)"), cwd: outside }),
    /outside this session/,
  );
  assert.deepEqual(guard.asked, [], "a cwd outside the roots is not a question for the user");
});

test("a refused command never starts", async () => {
  const root = await workspace();
  const marker = join(root, "ran.txt");
  const service = new TerminalService({
    roots: [root],
    consent: consent({ authorize: async () => false }),
  });

  await assert.rejects(
    service.createTerminal({
      sessionId: "s1",
      ...script("require('node:fs').writeFileSync(process.argv[1], 'x')", marker),
      cwd: root,
    }),
    /refused/,
  );
  await assert.rejects(stat(marker), "the command must not have run");
});

test("a policy rejection stops a kill without stopping the command", async () => {
  const root = await workspace();
  const service = new TerminalService({
    roots: [root],
    consent: consent({ permits: (operation) => operation !== "terminal.kill" }),
  });
  const { terminalId } = await service.createTerminal({
    sessionId: "s1",
    ...script("setTimeout(() => {}, 300)"),
    cwd: root,
  });

  await assert.rejects(
    service.killTerminal({ sessionId: "s1", terminalId }),
    /rejected by policy/,
  );
  const exit = await service.waitForTerminalExit({ sessionId: "s1", terminalId });
  assert.equal(exit.exitCode, 0, "the command ran to completion");
});

test("the consent detail names the environment the command would run with", async () => {
  const root = await workspace();
  const dialog = shownDetail();
  const service = new TerminalService({ roots: [root], consent: dialog });

  // `node -v` runs whatever this variable points at. A dialog that shows only
  // the command line asks the user to approve something other than what runs.
  await assert.rejects(
    service.createTerminal({
      sessionId: "s1",
      command: process.execPath,
      args: ["-v"],
      env: [{ name: "NODE_OPTIONS", value: "--require /tmp/whatever.js" }],
      cwd: root,
    }),
    /refused/,
  );

  assert.match(dialog.details[0] ?? "", /NODE_OPTIONS/);
});

test("an environment the dialog does show never pushes the command out of it", async () => {
  const root = await workspace();
  const dialog = shownDetail();
  const service = new TerminalService({ roots: [root], consent: dialog });

  // As much environment as the dialog accepts at all: the command being approved
  // must still be in it, and the whole thing must still fit the modal.
  await assert.rejects(
    service.createTerminal({
      sessionId: "s1",
      command: "/bin/rm",
      args: ["-rf", join(root, "everything")],
      env: Array.from({ length: 8 }, (_unused, index) => ({
        name: `PAD${index}${"N".repeat(60)}`,
        value: "A".repeat(60),
      })),
      cwd: root,
    }),
    /refused/,
  );

  const detail = dialog.details[0] ?? "";
  assert.match(detail, /\/bin\/rm -rf/, "the command being approved must be in the dialog");
  assert.match(detail, /everything/);
  assert.ok(detail.length < 2_000, `the dialog is unbounded: ${detail.length}`);
});

test("an argument cannot forge a line the client writes", async () => {
  const root = await workspace();
  const dialog = shownDetail();
  const service = new TerminalService({ roots: [root], consent: dialog });

  await assert.rejects(
    service.createTerminal({
      sessionId: "s1",
      command: "/bin/rm",
      args: ["-rf", "/", "\nDirectory: /somewhere/harmless"],
      cwd: root,
    }),
    /refused/,
  );

  const lines = (dialog.details[0] ?? "").split("\n").filter((line) => line.startsWith("Directory:"));
  assert.deepEqual(lines, [`Directory: ${await realpath(root)}`]);
});

test("an environment too large to show is refused, not shown in part", async () => {
  const root = await workspace();
  const dialog = shownDetail();
  const service = new TerminalService({ roots: [root], consent: dialog });

  // Filler ahead of the variable that matters: a dialog that shows the first few
  // and counts the rest lets the agent choose which one the user does not read.
  await assert.rejects(
    service.createTerminal({
      sessionId: "s1",
      command: process.execPath,
      args: ["-v"],
      env: [
        ...Array.from({ length: 20 }, (_unused, index) => ({
          name: `FILLER_${index}_${"N".repeat(60)}`,
          value: "en_US.UTF-8",
        })),
        { name: "NODE_OPTIONS", value: "--require /tmp/evil.js" },
      ],
      cwd: root,
    }),
    /environment/,
  );
  assert.deepEqual(dialog.details, [], "nothing partially described was put up for approval");
});

test("an environment that fits is shown whole", async () => {
  const root = await workspace();
  const dialog = shownDetail();
  const service = new TerminalService({ roots: [root], consent: dialog });

  const variables = Array.from({ length: 20 }, (_unused, index) => ({
    name: `VAR${index}`,
    value: String(index),
  }));
  await assert.rejects(
    service.createTerminal({
      sessionId: "s1",
      command: process.execPath,
      args: ["-v"],
      env: variables,
      cwd: root,
    }),
    /refused/,
  );

  for (const variable of variables) {
    assert.match(dialog.details[0] ?? "", new RegExp(`${variable.name}=${variable.value}\\b`));
  }
});

test("the dialog keeps argument boundaries the shell would have needed quotes for", async () => {
  const root = await workspace();
  const dialog = shownDetail();
  const service = new TerminalService({ roots: [root], consent: dialog });

  for (const args of [["a b"], ["a", "b"], ["", "x"]]) {
    await assert.rejects(
      service.createTerminal({ sessionId: "s1", command: "/bin/echo", args, cwd: root }),
      /refused/,
    );
  }

  assert.notEqual(dialog.details[0], dialog.details[1], "one argument and two must not read alike");
  assert.match(dialog.details[2] ?? "", /"" x/, "an empty argument is still an argument");
});

test("the environment a dialog will show is configurable, and refusal follows it", async () => {
  const root = await workspace();
  const dialog = shownDetail();
  // A stricter budget than the default: this environment fits the default and
  // must not fit here.
  const service = new TerminalService({
    roots: [root],
    consent: dialog,
    maxEnvironmentChars: 20,
  });

  await assert.rejects(
    service.createTerminal({
      sessionId: "s1",
      command: process.execPath,
      args: ["-v"],
      env: [{ name: "SERVICE_ENDPOINT", value: "https://svc.internal.example.com" }],
      cwd: root,
    }),
    /environment/,
  );
  assert.deepEqual(dialog.details, []);
});

test("a budget beyond what the dialog can show is brought back to what it can", async () => {
  const root = await workspace();
  const dialog = shownDetail();
  // Raising the budget past the dialog's own limit would put the overflow back
  // where the agent chooses it: past the clamp, unread.
  const service = new TerminalService({
    roots: [root],
    consent: dialog,
    maxEnvironmentChars: 1_000_000,
  });

  await assert.rejects(
    service.createTerminal({
      sessionId: "s1",
      command: process.execPath,
      args: ["-v"],
      env: Array.from({ length: 200 }, (_unused, index) => ({
        name: `VAR${index}`,
        value: "x".repeat(40),
      })),
      cwd: root,
    }),
    /environment/,
  );
  assert.deepEqual(dialog.details, []);
});

test("a budget that is not a number falls back to one, rather than to no rule at all", async () => {
  const root = await workspace();
  const dialog = shownDetail();
  const service = new TerminalService({
    roots: [root],
    consent: dialog,
    maxEnvironmentChars: Number.NaN,
  });

  // Every comparison against NaN is false, so a budget of NaN would refuse
  // nothing — the shown-or-refused rule would quietly stop existing.
  await assert.rejects(
    service.createTerminal({
      sessionId: "s1",
      command: process.execPath,
      args: ["-v"],
      env: Array.from({ length: 200 }, (_unused, index) => ({
        name: `VAR${index}`,
        value: "x".repeat(40),
      })),
      cwd: root,
    }),
    /environment/,
  );
  assert.deepEqual(dialog.details, []);
});
