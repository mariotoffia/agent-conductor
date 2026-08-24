import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";

/**
 * What the extension-host run says on a terminal, and when it refuses to call
 * itself passed.
 *
 * The whole transcript of a VS Code that started, logged its own diagnostics and
 * shut down is a hundred lines of noise around six that matter, so it is kept in
 * `reports/integration.log` and the terminal gets the count, the duration and —
 * only when there is one — the failure.
 *
 * The refusal is the point of it, though. A gate reports two things: what ran,
 * and that anything ran at all. A run that exits zero having printed no count is
 * a harness that proved nothing, and it looks exactly like a passing branch.
 */

const script = fileURLToPath(new URL("../../../scripts/report-integration.mjs", import.meta.url));

function summarise(t: TestContext, log: string, status: number): { code: number; said: string } {
  const directory = mkdtempSync(join(tmpdir(), "conductor-summary-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "integration.log");
  writeFileSync(path, log);
  const run = spawnSync(process.execPath, [script, path, String(status)], { encoding: "utf8" });
  return { code: run.status ?? 1, said: `${run.stdout}${run.stderr}` };
}

/**
 * Mocha's own output, with the ANSI colour it really carries.
 *
 * Written as escapes rather than the bytes themselves: an invisible `ESC` in a
 * fixture is one an editor or a patch can drop without anything looking
 * different, and a colourless fixture would exercise a code path the real run
 * never takes — the reporter would refuse for having found no count at all,
 * which is a different refusal from the one under test.
 */
const green = (text: string): string => `\u001b[32m${text}\u001b[0m`;
const dim = (text: string): string => `\u001b[90m${text}\u001b[0m`;
const bright = (text: string): string => `\u001b[92m${text}\u001b[0m`;

const PASSING = [
  "[main] Extension host with pid 1 starting",
  `  ${green("  ✔")}${dim(" a turn is refused until the runtime is approved")}`,
  `${bright(" ")}${green(" 6 passing")}${dim(" (467ms)")}`,
  "Exit code:   0",
].join("\n");

const FAILING = [
  `${bright(" ")}${green(" 4 passing")}${dim(" (512ms)")}`,
  `\u001b[31m  2 failing\u001b[0m`,
  "",
  "  1) the sessions tree in the extension host",
  "       a live session is a row the host can draw:",
  "     AssertionError [ERR_ASSERTION]: the row's icon is not a ThemeIcon",
  "      at Context.<anonymous> (dist/test/suite/index.cjs:120:12)",
].join("\n");

test("a passing run says how many ran and how long it took, and nothing else", (t) => {
  const outcome = summarise(t, PASSING, 0);

  assert.equal(outcome.code, 0);
  assert.match(outcome.said, /6 passing/);
  assert.match(outcome.said, /467ms/);
  // The transcript stays in the file. A terminal that gets the extension host's
  // own diagnostics back is the thing this replaces.
  assert.doesNotMatch(outcome.said, /Extension host with pid/);
  assert.doesNotMatch(outcome.said, /a turn is refused/);
});

test("a failing run says which test failed and where the rest of it is", (t) => {
  const outcome = summarise(t, FAILING, 1);

  assert.equal(outcome.code, 1);
  assert.match(outcome.said, /4 passing/);
  assert.match(outcome.said, /2 failing/);
  assert.match(outcome.said, /a live session is a row the host can draw/);
  assert.match(outcome.said, /the row's icon is not a ThemeIcon/);
  // Where to read the rest, since the terminal no longer carries it.
  assert.match(outcome.said, /integration\.log/);
});

test("a run that exits zero having printed no count is refused", (t) => {
  // The failure this exists to catch: VS Code that never started, a suite whose
  // output went nowhere, a harness rewritten into silence. Exit zero with no
  // evidence is indistinguishable from a passing branch, so it is not one.
  const outcome = summarise(t, "[main] Extension host exited with code: 0\nExit code:   0", 0);

  assert.equal(outcome.code, 1);
  assert.match(outcome.said, /no extension-host test count/i);
});

test("a run that says zero tests passed is refused, whatever its exit status", (t) => {
  // The suite has a guard of its own for a run that registered nothing, and this
  // is the backstop for it: two independent refusals, so neither being wrong is
  // enough on its own to make an empty run green.
  //
  // Both statuses, because the title says both. Zero is the one that matters —
  // a nonzero run is refused anyway — but a reporter that only refused the empty
  // *and failing* case would satisfy a test that never asked.
  for (const status of [0, 1]) {
    const outcome = summarise(t, `${bright(" ")}${green(" 0 passing")}${dim(" (1ms)")}`, status);

    assert.equal(outcome.code, 1, `zero tests at exit ${status}`);
    // The refusal, not the count line: `0 passing` is what the reporter prints
    // when it is *not* refusing, so matching it would be satisfied by the bug.
    assert.match(outcome.said, /the harness proved nothing/);
  }
});

test("a harness that failed before any test ran is refused, and says so", (t) => {
  const outcome = summarise(t, "Error: Failed to download VS Code: 404\n    at download", 1);

  assert.equal(outcome.code, 1);
  assert.match(outcome.said, /Failed to download VS Code/);
});

test("a log that cannot be read is refused rather than treated as empty", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "conductor-summary-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const run = spawnSync(process.execPath, [script, join(directory, "absent.log"), "0"], {
    encoding: "utf8",
  });

  assert.equal(run.status, 1);
  assert.match(`${run.stdout}${run.stderr}`, /cannot read/i);
});
