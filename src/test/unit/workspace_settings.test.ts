import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyWorkspaceSuppression,
  mergeSettings,
  revertSettings,
  revertWorkspaceSuppression,
  suppressionPlan,
  type StoragePort,
  type SuppressionPlan,
} from "../../core/index.js";
import { policy } from "../runtime-fixtures.js";

const SETTINGS = "/work/repo/.gemini/settings.json";

/** Path-keyed storage that records every write, so a test can see whether a file
 *  was written at all and whether it took exactly one atomic replacement. */
function files(initial: Record<string, string> = {}): StoragePort & { readonly writes: [string, string][] } {
  const content = { ...initial };
  const writes: [string, string][] = [];
  return {
    get writes() { return writes; },
    async read(key: string) { return content[key]; },
    async writeAtomic(key: string, value: string) {
      writes.push([key, value]);
      content[key] = value;
    },
  };
}

// ---------------------------------------------------------------------------
// The workspace settings channel: merge, write, revert.
// ---------------------------------------------------------------------------

const geminiPlan = (): SuppressionPlan => suppressionPlan("gemini", policy) as SuppressionPlan;

test("merging into workspace settings keeps every key the plan does not name", async () => {
  const before = {
    theme: "dark",
    tools: { exclude: ["run_shell_command"], core: ["read_file"] },
    experimental: { somethingElse: true },
  };
  const storage = files({ [SETTINGS]: JSON.stringify(before, null, 2) });

  await applyWorkspaceSuppression(storage, SETTINGS, geminiPlan(), { consent: true });

  assert.equal(storage.writes.length, 1, "the file must be replaced once, whole");
  const [[path, text]] = storage.writes;
  assert.equal(path, SETTINGS);
  assert.deepEqual(JSON.parse(text), {
    theme: "dark",
    tools: { exclude: ["run_shell_command", "invoke_agent"], core: ["read_file"] },
    experimental: { somethingElse: true, enableAgents: false },
  });
});

test("suppression never writes into the workspace without recorded consent", async () => {
  const storage = files();

  await assert.rejects(
    applyWorkspaceSuppression(storage, SETTINGS, geminiPlan(), { consent: false }),
    /recorded consent/,
  );
  assert.deepEqual(storage.writes, [], "a refused write must not have happened first");
});

test("a settings file that cannot be parsed is refused, not overwritten", async () => {
  const storage = files({ [SETTINGS]: '{ "tools": { /* a comment */ } }' });

  await assert.rejects(
    applyWorkspaceSuppression(storage, SETTINGS, geminiPlan(), { consent: true }),
    /not valid JSON/,
  );
  assert.deepEqual(storage.writes, []);
});

test("settings paths are absolute like every other path the client handles", async () => {
  await assert.rejects(
    applyWorkspaceSuppression(files(), ".gemini/settings.json", geminiPlan(), { consent: true }),
    /must be absolute/,
  );
});

test("applying the plan twice writes once: the second time nothing changed", async () => {
  const storage = files();

  const first = await applyWorkspaceSuppression(storage, SETTINGS, geminiPlan(), { consent: true });
  const second = await applyWorkspaceSuppression(storage, SETTINGS, geminiPlan(), { consent: true });

  assert.equal(storage.writes.length, 1);
  assert.ok((first ?? []).length > 0);
  assert.deepEqual(second, []);
});

test("reverting restores the file and leaves later edits of the user's own alone", async () => {
  const storage = files({
    [SETTINGS]: JSON.stringify({ tools: { exclude: ["run_shell_command"] }, theme: "dark" }),
  });
  const revert = await applyWorkspaceSuppression(storage, SETTINGS, geminiPlan(), { consent: true });

  // The user edits the same file before changing their mind about suppression.
  await storage.writeAtomic(
    SETTINGS,
    JSON.stringify({
      ...(JSON.parse(storage.writes[0][1]) as Record<string, unknown>),
      tools: { exclude: ["run_shell_command", "invoke_agent", "web_fetch"] },
      theme: "light",
    }),
  );

  await revertWorkspaceSuppression(storage, SETTINGS, revert ?? []);

  assert.deepEqual(JSON.parse(storage.writes[storage.writes.length - 1][1]), {
    tools: { exclude: ["run_shell_command", "web_fetch"] },
    theme: "light",
  });
});

test("a plan that created its own keys removes them again on revert", async () => {
  const storage = files({ [SETTINGS]: "{}" });
  const revert = await applyWorkspaceSuppression(storage, SETTINGS, geminiPlan(), { consent: true });

  await revertWorkspaceSuppression(storage, SETTINGS, revert ?? []);

  assert.deepEqual(JSON.parse(storage.writes[storage.writes.length - 1][1]), {});
});


test("reverting a section the plan created keeps what the user put in it since", async () => {
  const storage = files();
  const revert = await applyWorkspaceSuppression(storage, SETTINGS, geminiPlan(), { consent: true });

  // The plan created both sections; the user then made them theirs.
  await storage.writeAtomic(
    SETTINGS,
    JSON.stringify({
      experimental: { enableAgents: false, vlmSwitchMode: "once" },
      tools: { exclude: ["invoke_agent"], core: ["read_file"] },
    }),
  );
  await revertWorkspaceSuppression(storage, SETTINGS, revert ?? []);

  assert.deepEqual(JSON.parse(storage.writes[storage.writes.length - 1][1]), {
    experimental: { vlmSwitchMode: "once" },
    tools: { core: ["read_file"] },
  });
});

test("a settings document can never reach the prototype every object shares", () => {
  const hostile = JSON.parse('{"__proto__": {"polluted": "yes"}}') as Record<string, unknown>;

  const merged = mergeSettings({}, hostile);
  const reverted = revertSettings({}, [{ path: ["__proto__", "polluted"], previous: "yes" }]);

  assert.equal(({} as Record<string, unknown>).polluted, undefined, "Object.prototype was written to");
  assert.equal((merged.settings as Record<string, unknown>).polluted, undefined);
  assert.equal((reverted as Record<string, unknown>).polluted, undefined);
});

test("reverting puts back a value of any type the plan wrote over", async () => {
  const storage = files({ [SETTINGS]: JSON.stringify({ tools: { exclude: "invoke_agent" } }) });

  const revert = await applyWorkspaceSuppression(storage, SETTINGS, geminiPlan(), { consent: true });
  await revertWorkspaceSuppression(storage, SETTINGS, revert ?? []);

  assert.deepEqual(JSON.parse(storage.writes[storage.writes.length - 1][1]), {
    tools: { exclude: "invoke_agent" },
  });
});

test("list entries are compared by value, so a re-applied plan still writes once", () => {
  const patch = { tools: { rules: [{ deny: "invoke_agent" }] } };
  const once = mergeSettings({}, patch);
  const twice = mergeSettings(once.settings, patch);

  assert.deepEqual(twice.revert, [], "an unchanged document must not be rewritten");
  assert.deepEqual(twice.settings, once.settings);
});

test("a list the user turned into something else is theirs, and revert leaves it", async () => {
  const storage = files();
  const revert = await applyWorkspaceSuppression(storage, SETTINGS, geminiPlan(), { consent: true });

  await storage.writeAtomic(
    SETTINGS,
    JSON.stringify({
      experimental: { enableAgents: false },
      tools: { exclude: { deny: ["invoke_agent", "secret_tool"] } },
    }),
  );
  await revertWorkspaceSuppression(storage, SETTINGS, revert ?? []);

  // Removing items from a list that is no longer a list cannot mean deleting it.
  assert.deepEqual(JSON.parse(storage.writes[storage.writes.length - 1][1]), {
    tools: { exclude: { deny: ["invoke_agent", "secret_tool"] } },
  });
});

test("list entries survive a file whose keys were rewritten in another order", () => {
  const patch = { tools: { rules: [{ deny: "invoke_agent", level: "hard" }] } };
  const once = mergeSettings({}, patch);
  const reordered = JSON.parse('{"tools":{"rules":[{"level":"hard","deny":"invoke_agent"}]}}') as Record<string, unknown>;

  assert.deepEqual(mergeSettings(reordered, patch).revert, [], "the same entry was appended twice");
  assert.ok(once.revert.length > 0);
});

test("a value the user changed after the plan wrote it is theirs to keep", async () => {
  const storage = files();
  const revert = await applyWorkspaceSuppression(storage, SETTINGS, geminiPlan(), { consent: true });

  // They turned agents back on themselves; reverting suppression must not silently
  // undo a decision the plan did not make.
  await storage.writeAtomic(
    SETTINGS,
    JSON.stringify({ experimental: { enableAgents: true }, tools: { exclude: ["invoke_agent"] } }),
  );
  await revertWorkspaceSuppression(storage, SETTINGS, revert ?? []);

  assert.deepEqual(JSON.parse(storage.writes[storage.writes.length - 1][1]), {
    experimental: { enableAgents: true },
  });
});

test("emptying a list the plan only added to leaves the list, not a hole", () => {
  const before = { tools: { exclude: ["run_shell_command"] } };
  const { revert } = mergeSettings(before, { tools: { exclude: ["invoke_agent"] } });

  // The user removed their own entry too; the key predates the plan and stays.
  const reverted = revertSettings({ tools: { exclude: ["invoke_agent"] } }, revert);
  assert.deepEqual(reverted, { tools: { exclude: [] } });
});
