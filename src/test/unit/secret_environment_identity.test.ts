import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSpawnRequest, builtinRuntimes, resolveRuntime } from "../../core/index.js";
import { installed, policy } from "../runtime-fixtures.js";

/**
 * A Runtime's `secretEnvironment` is part of what the user approves.
 *
 * It names variables and the SecretStorage keys behind them, and both come from
 * settings a workspace can write. Two things follow: the names have to be in the
 * fingerprint, or a repository can add one to an approved Runtime and keep the
 * approval; and a credential must never displace the catalog's own policy
 * environment, which is where a Suppression Plan lives (ADR-0004, ADR-0007).
 */

const codex = () => builtinRuntimes(policy).find((entry) => entry.id === "codex");

test("adding a secret reference changes the identity the user approved", async () => {
  const plain = await resolveRuntime(codex()!, { executable: installed });
  const withSecret = await resolveRuntime(
    { ...codex()!, secretEnvironment: { CODEX_CONFIG: "some-stored-key" } },
    { executable: installed },
  );

  assert.notEqual(
    plain.fingerprint,
    withSecret.fingerprint,
    "a variable a repository added would otherwise ride an existing approval",
  );
});

test("pointing a reference at a different secret changes it too", async () => {
  const one = await resolveRuntime(
    { ...codex()!, secretEnvironment: { ANTHROPIC_API_KEY: "work-key" } },
    { executable: installed },
  );
  const other = await resolveRuntime(
    { ...codex()!, secretEnvironment: { ANTHROPIC_API_KEY: "someone-elses-key" } },
    { executable: installed },
  );

  assert.notEqual(one.fingerprint, other.fingerprint);
});

test("a secret reference cannot displace the policy environment it was approved with", async () => {
  const runtime = await resolveRuntime(codex()!, { executable: installed });
  assert.ok(runtime.launch.env.CODEX_CONFIG, "codex suppresses through this variable");

  const request = buildSpawnRequest({
    runtimeId: "codex",
    launch: runtime.launch,
    cwd: process.cwd(),
    // The name is settings-supplied, so it can name the one variable the
    // Suppression Plan travels in.
    secretEnvironment: { CODEX_CONFIG: '{"agents":{"enabled":true}}' },
  });

  assert.equal(
    request.env.CODEX_CONFIG,
    runtime.launch.env.CODEX_CONFIG,
    "the plan the fingerprint covers is what the process gets",
  );
});

test("a secret still reaches the process where it collides with nothing", async () => {
  const request = buildSpawnRequest({
    runtimeId: "codex",
    launch: (await resolveRuntime(codex()!, { executable: installed })).launch,
    cwd: process.cwd(),
    secretEnvironment: { OPENAI_API_KEY: "sk-value" },
  });

  assert.equal(request.env.OPENAI_API_KEY, "sk-value");
});
