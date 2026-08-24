import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * The size rule this repository is held to: a code file stays under 500 lines
 * and a document under 600, split by responsibility once it grows past that.
 *
 * The rule predates this file; what was missing was anything that measured it.
 * The one breach found so far was found by a review, in a file the claim "every
 * file is inside the cap" had been made about — the claim had been checked
 * against two directories rather than the repository. A confirmation that is
 * not executable is a confirmation about the day it was typed.
 */

const root = fileURLToPath(new URL("../../..", import.meta.url));

/** Lines as `wc -l` counts them: one per line ending, so the caps mean the same
 * thing here and in a shell. */
function lineCount(text: string): number {
  let lines = 0;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) lines += 1;
  return lines;
}

interface MeasuredFile {
  path: string;
  lines: number;
}

/** The files over a cap, named so the failure says what to split. */
function overLimit(files: MeasuredFile[], cap: number): string[] {
  return files.filter((file) => file.lines > cap).map((file) => `${file.path}: ${file.lines} > ${cap}`);
}

/**
 * Every file the repository is made of, asked of git rather than listed here —
 * a directory list is how the one known breach stayed out of sight. Git also
 * settles what is not covered for free: `node_modules`, `dist` and `reports`
 * are ignored, so they are never measured.
 */
function trackedFiles(endings: string[]): MeasuredFile[] {
  const listed = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
  assert.equal(listed.status, 0, `git ls-files failed: ${listed.stderr}`);
  const paths = listed.stdout
    .split("\0")
    .filter((path) => endings.some((ending) => path.endsWith(ending)))
    // The index lists a file whose deletion is not yet staged; what is measured
    // is what would ship, which is what is on disk.
    .filter((path) => existsSync(join(root, path)));
  assert.ok(paths.length > 0, "the sweep found nothing, which is a sweep that measures nothing");
  return paths.map((path) => ({ path, lines: lineCount(readFileSync(join(root, path), "utf8")) }));
}

test("every tracked code file is at most 500 lines", () => {
  assert.deepEqual(overLimit(trackedFiles([".ts", ".mjs", ".cjs"]), 500), []);
});

test("every tracked document is at most 600 lines", () => {
  assert.deepEqual(overLimit(trackedFiles([".md"]), 600), []);
});

test("the sweep can fail, and reads the repository rather than a list of it", () => {
  // The check's own self-test: a file over the cap is named, one at the cap is
  // not. Both matter — a checker that cannot fail confirms nothing, and one
  // that fails at the cap would make the cap unreachable instead of a ceiling.
  assert.deepEqual(overLimit([{ path: "fixture.ts", lines: 501 }], 500), ["fixture.ts: 501 > 500"]);
  assert.deepEqual(overLimit([{ path: "fixture.ts", lines: 500 }], 500), []);
  // Counted the way `wc -l` counts, so the shell confirmation and this one
  // cannot disagree about a file that ends without a newline.
  assert.equal(lineCount("one\ntwo\nthree"), 2);
  assert.equal(lineCount("one\ntwo\n"), 2);
  assert.equal(lineCount(""), 0);
  // And the sweep is the repository: the seams most likely to grow are being
  // read, not named in a list that would go stale beside them.
  const swept = trackedFiles([".ts", ".mjs", ".cjs", ".md"]).map((file) => file.path);
  for (const expected of [
    "src/core/session.ts",
    "src/vscode/participant.ts",
    "src/test/mock-agent.ts",
    "scripts/run-unit-tests.mjs",
    "README.md",
    "ARCHITECTURE.md",
  ]) {
    assert.ok(swept.includes(expected), `${expected} is not being measured`);
  }
});
