import { spawn } from "node:child_process";
import { test } from "node:test";

/**
 * Deliberately leaks, so `leak_guard.test.ts` can prove the guard still bites.
 * Not under `src/test/unit/`, so the suite never runs it directly.
 *
 * The shape of a real incident: the test passes, and the process it started
 * outlives it. The child ends on its own so a run of this fixture cannot leave
 * anything behind for long.
 */
test("passes, and leaves a process running behind it", () => {
  spawn(process.execPath, ["-e", "setTimeout(() => {}, 5_000)"], { stdio: ["ignore", "pipe", "pipe"] });
});
