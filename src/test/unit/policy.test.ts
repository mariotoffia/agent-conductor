import assert from "node:assert/strict";
import { test } from "node:test";
import { builtinRuntimes, claudeSessionMeta, codexEnv, geminiWorkspaceSettings } from "../../core/index.js";

test("claude suppression meta disables Agent/SendMessage/ListAgents and empties the agent registry", () => {
  const meta = claudeSessionMeta({ suppressBuiltInSubagents: true });
  assert.deepEqual(meta, {
    claudeCode: {
      options: {
        disallowedTools: ["Agent", "SendMessage", "ListAgents"],
        agents: {},
      },
    },
  });
  assert.equal(claudeSessionMeta({ suppressBuiltInSubagents: false }), undefined);
});

test("codex suppression sets BOTH features.multi_agent_v2 and agents.enabled", () => {
  const env = codexEnv({ suppressBuiltInSubagents: true });
  const cfg = JSON.parse(env.CODEX_CONFIG) as {
    agents: { enabled: boolean };
    features: { multi_agent_v2: boolean; collab: boolean };
  };
  assert.equal(cfg.agents.enabled, false);
  assert.equal(cfg.features.multi_agent_v2, false);
  assert.equal(cfg.features.collab, false);
  assert.deepEqual(codexEnv({ suppressBuiltInSubagents: false }), {});
});

test("gemini suppression merges enableAgents=false and excludes invoke_agent", () => {
  assert.deepEqual(geminiWorkspaceSettings({ suppressBuiltInSubagents: true }), {
    experimental: { enableAgents: false },
    tools: { exclude: ["invoke_agent"] },
  });
});

test("builtin runtime ids are unique and launch specs are non-empty", () => {
  const runtimes = builtinRuntimes({ suppressBuiltInSubagents: true });
  const ids = runtimes.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const r of runtimes) {
    assert.ok(r.launch.command.length > 0, `${r.id}: empty command`);
    assert.ok(r.detection.binaries.length > 0, `${r.id}: no detection binaries`);
  }
});
