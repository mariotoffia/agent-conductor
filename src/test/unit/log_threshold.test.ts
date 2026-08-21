import assert from "node:assert/strict";
import { test } from "node:test";
import { logsAt, LOG_SEVERITY, type LogLevel } from "../../core/index.js";

/**
 * `agentConductor.logging.level` names a cut-off, and a user who asks for a
 * quiet channel gets one. The ordering below is the whole rule, which is why it
 * lives where a test can reach it rather than in the composition root.
 */

test("the configured level is included, and everything more verbose is not", () => {
  assert.deepEqual(
    LOG_SEVERITY.filter((severity) => logsAt("info", severity)),
    ["error", "info"],
  );
  assert.deepEqual(LOG_SEVERITY.filter((severity) => logsAt("error", severity)), ["error"]);
  assert.deepEqual(LOG_SEVERITY.filter((severity) => logsAt("trace", severity)), [...LOG_SEVERITY]);
});

test("errors are written at every level a port exists at", () => {
  // `off` never reaches here: it drops the record before the threshold applies.
  for (const level of LOG_SEVERITY) {
    assert.equal(logsAt(level, "error"), true, `errors are lost at "${level}"`);
  }
});

test("a level this build does not recognise is verbose, never silent", () => {
  // Silence is the one failure nobody notices, and an unknown level can only be
  // one added after this build.
  for (const severity of LOG_SEVERITY) {
    assert.equal(logsAt("added-in-a-later-release", severity), true);
  }
});

test("the ordering runs from least to most verbose", () => {
  // Sorting this array any other way would silently invert the setting.
  assert.deepEqual([...LOG_SEVERITY], ["error", "info", "debug", "trace"] satisfies LogLevel[]);
});
