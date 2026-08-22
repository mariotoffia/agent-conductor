// Runs the unit suite, and refuses to run nothing.
//   node scripts/run-unit-tests.mjs [directory]
//
// `node --test "glob"` reports success when its glob matches nothing: zero
// tests, exit 0. That is the one failure a test gate cannot survive, because it
// looks exactly like a passing branch — so the files are found here, by name,
// and a run that found none exits non-zero instead of green. `make gate-selftest`
// points this at an empty directory and expects it to fail.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

// Anything beginning with `-` is for the test runner, so `npm test --
// --test-name-pattern=x` still works; the first plain word, if there is one, is
// the directory to look in — which is how the self-test points this at an empty
// one.
const given = process.argv.slice(2);
const root = given.find((argument) => !argument.startsWith("-")) ?? "src/test/unit";
const flags = given.filter((argument) => argument.startsWith("-"));

function testFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

let files = [];
try {
  files = testFiles(root).sort();
} catch (error) {
  console.error(`unit tests: cannot read ${root}: ${error.message}`);
  process.exit(1);
}

if (files.length === 0) {
  console.error(`unit tests: no *.test.ts under ${root} — the gate matched nothing`);
  process.exit(1);
}

const { status, error } = spawnSync(
  process.execPath,
  ["--import", "tsx", "--import", "./src/test/leak-guard.ts", "--test", ...flags, ...files],
  { stdio: "inherit" },
);
if (error) {
  console.error(`unit tests: ${error.message}`);
  process.exit(1);
}
process.exit(status ?? 1);
