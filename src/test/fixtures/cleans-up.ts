import { spawn } from "node:child_process";
import { test } from "node:test";

/**
 * The other half of the guard's self-test: a file that starts a process and
 * stops it must not be accused of leaking, or the guard would fail everything.
 */
test("passes, and stops what it started", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5_000)"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((done) => {
    child.once("exit", () => done());
    child.kill("SIGKILL");
  });
});
