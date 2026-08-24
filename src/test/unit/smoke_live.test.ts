import assert from "node:assert/strict";
import test from "node:test";
import { smokeLive } from "../smoke-live.js";
import { executable, mockRuntime } from "../participant-fixtures.js";

/**
 * The live smoke driver behind `make smoke-live`: probe whichever agent CLIs are
 * actually installed, with the same Probe Session and Smoke Test the connection
 * wizard runs, and say per CLI whether it answered.
 *
 * CI never has a real CLI (PERSONAS.md: live smoke stays optional and manual),
 * so what is protected here is the driver itself, against the one agent CI does
 * have — the mock, as a real subprocess. The driver must not care which.
 */

const liveTest = (name: string, fn: () => Promise<void>) => test(name, { timeout: 20_000 }, fn);

liveTest("an installed runtime is probed live and reports ok with its read-back", async () => {
  const result = await smokeLive([mockRuntime()], { executable });
  assert.equal(result.probed, 1);
  assert.equal(result.failed, 0);
  const outcome = result.outcomes[0];
  assert.equal(outcome?.id, "mock");
  assert.equal(outcome?.outcome, "ok");
  assert.match(outcome?.detail ?? "", /model /, "the read-back belongs in the report");
});

liveTest("a runtime that is not installed is skipped with the reason, not failed", async () => {
  const spec = { ...mockRuntime(), id: "absent", launch: { command: "no-such-agent-cli", args: [], env: {} } };
  const result = await smokeLive([spec], { executable });
  assert.equal(result.probed, 0);
  assert.equal(result.failed, 0);
  const outcome = result.outcomes[0];
  assert.equal(outcome?.outcome, "skipped");
  assert.match(outcome?.detail ?? "", /not found/);
});

liveTest("a row that means something else says so, and says it first", async () => {
  // `dsh OK` and `copilot OK` are the same three characters for two different
  // claims — one probed against the user's own provider, the other against a
  // fixture. A table read on its own must carry the difference.
  const lines: string[] = [];
  const result = await smokeLive([mockRuntime()], {
    executable,
    notes: { mock: "via the bundled mock provider" },
    log: (line) => lines.push(line),
  });

  assert.match(result.outcomes[0]?.detail ?? "", /^via the bundled mock provider · /);
  assert.match(lines.join("\n"), /via the bundled mock provider/);
});

liveTest("a runtime that answers the smoke test wrongly fails the run", async () => {
  const result = await smokeLive([mockRuntime("chatty")], { executable });
  assert.equal(result.probed, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.outcomes[0]?.outcome, "failed");
});

liveTest("a secret the agent echoes never reaches the report", async () => {
  // The probe inherits this shell's environment so the CLI can authenticate,
  // which is exactly the configuration where an echoed credential would land in
  // the report — so the report is scrubbed against those values. The chatty
  // mock's reply stands in for the echo: name it as a secret, and the failure
  // line that quotes the reply must not contain it.
  const lines: string[] = [];
  const result = await smokeLive([mockRuntime("chatty")], {
    executable,
    secrets: ["Mock response"],
    log: (line) => lines.push(line),
  });
  const report = [result.outcomes[0]?.detail ?? "", ...lines].join("\n");
  assert.ok(!report.includes("Mock response"), `the echoed value survived: ${report}`);
  assert.match(report, /\[redacted\]/);
});
