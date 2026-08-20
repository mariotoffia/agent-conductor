import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * The suite's own gate: a test file that leaves the process running must fail,
 * not hang. A guard that cannot fail reports success forever, so both halves are
 * proved here — that a leak is caught, and that clean-up is not mistaken for one.
 */
const guard = fileURLToPath(new URL("../leak-guard.ts", import.meta.url));

function runFixture(name: string): Promise<{ code: number | null; output: string }> {
  const fixture = fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--import", guard, "--test", fixture],
    {
      // `NODE_TEST_CONTEXT` marks this process as a test run, and node refuses to
      // start a nested one; the fixture has to be run as its own suite.
      // A short grace keeps this fast; the guard's behaviour does not depend on it.
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, TEST_LEAK_GRACE_MS: "250" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  return new Promise((done) => {
    child.once("exit", (code) => done({ code, output }));
  });
}

test("a file whose tests pass but whose process lives on fails the run", { timeout: 30_000 }, async () => {
  const { code, output } = await runFixture("leaks-a-handle.ts");

  // The test itself passes: this is exactly the shape that used to read as
  // success while the run hung.
  assert.match(output, /^ok 1 - passes, and leaves a process running behind it$/m);
  assert.equal(code, 1, "a leaked process was reported as a passing file");
  assert.match(output, /leak-guard/);
  assert.match(output, /ProcessWrap/, "the diagnostic must say what is still held");
});

test("a file that stops what it started is not accused of leaking", { timeout: 30_000 }, async () => {
  const { code, output } = await runFixture("cleans-up.ts");

  assert.equal(code, 0, output);
  assert.equal(output.includes("leak-guard"), false, "clean-up was mistaken for a leak");
});
