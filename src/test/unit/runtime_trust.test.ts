import assert from "node:assert/strict";
import { test } from "node:test";
import {
  launchFingerprint,
  resolveRuntime,
  runtimeCatalog,
  trustedLaunch,
  type ExecutablePort,
  type RuntimeSpec,
} from "../../core/index.js";
import { executables, installed, policy, spec } from "../runtime-fixtures.js";

// Runtime Trust: what the user approved, what changes it, and what lapses with it.

test("trust holds for the identity the user approved and lapses when it changes", async () => {
  const runtimeSpec = spec({ launch: { command: "agent", args: ["--acp"], env: { POLICY: "on" } } });
  const executable = executables({ agent: "/opt/bin/agent" });

  const approved = await resolveRuntime(runtimeSpec, { executable });
  const trust = { fingerprint: approved.fingerprint };

  const again = await resolveRuntime(runtimeSpec, { executable, trust });
  assert.equal(again.trusted, true);
  assert.deepEqual(trustedLaunch(again).args, ["--acp"]);

  const rearmed = { ...runtimeSpec, launch: { ...runtimeSpec.launch, args: ["--acp", "--dangerously"] } };
  const changed = await resolveRuntime(rearmed, { executable, trust });
  assert.equal(changed.trusted, false);
  assert.throws(() => trustedLaunch(changed), /is not trusted/);
});

test("a replaced artifact at the same path lapses trust when the host digests it", async () => {
  const runtimeSpec = spec({ launch: { command: "agent", args: [], env: {} } });
  const before: ExecutablePort = { async resolve() { return { path: "/opt/bin/agent", digest: "sha256:aaa" }; } };
  const after: ExecutablePort = { async resolve() { return { path: "/opt/bin/agent", digest: "sha256:bbb" }; } };

  const trust = { fingerprint: (await resolveRuntime(runtimeSpec, { executable: before })).fingerprint };

  assert.equal((await resolveRuntime(runtimeSpec, { executable: before, trust })).trusted, true);
  assert.equal((await resolveRuntime(runtimeSpec, { executable: after, trust })).trusted, false);
});

test("the launch identity covers catalog policy environment and nothing a secret rides in", async () => {
  const identity = { runtimeId: "claude", launch: { command: "/opt/bin/agent", args: [], env: {} }, policy };

  // Everything that changes what runs is part of the identity.
  assert.notEqual(launchFingerprint(identity), launchFingerprint({ ...identity, runtimeId: "codex" }));
  assert.notEqual(
    launchFingerprint(identity),
    launchFingerprint({ ...identity, launch: { ...identity.launch, env: { CODEX_CONFIG: "{}" } } }),
  );
  assert.notEqual(
    launchFingerprint(identity),
    launchFingerprint({ ...identity, launch: { ...identity.launch, args: ["--acp"] } }),
  );
  // Key order in the catalog environment is not an identity change.
  assert.equal(
    launchFingerprint({ ...identity, launch: { ...identity.launch, env: { A: "1", B: "2" } } }),
    launchFingerprint({ ...identity, launch: { ...identity.launch, env: { B: "2", A: "1" } } }),
  );

  // Resolution carries the catalog environment only: SecretStorage values reach a
  // Session separately and must never end up in a fingerprint anyone can persist.
  const resolved = await resolveRuntime(
    spec({ launch: { command: "agent", args: [], env: { CODEX_CONFIG: "{}" } } }),
    { executable: executables({ agent: "/opt/bin/agent" }) },
  );
  assert.deepEqual(resolved.launch.env, { CODEX_CONFIG: "{}" });
});

test("suppression and budget need current trust plus evidence; read-back is a Runtime trait", async () => {
  const runtimeSpec = spec({ launch: { command: "agent", args: [], env: {} } });
  const executable = executables({ agent: "/opt/bin/agent" });
  const { fingerprint } = await resolveRuntime(runtimeSpec, { executable });

  const verified = await resolveRuntime(runtimeSpec, {
    executable,
    trust: { fingerprint, suppression: true, budget: true },
  });
  assert.deepEqual(verified.capabilities, { readback: true, suppression: true, budget: true });

  // Evidence recorded against another identity grants nothing.
  const lapsed = await resolveRuntime(runtimeSpec, {
    executable,
    trust: { fingerprint: "sha256:stale", suppression: true, budget: true },
  });
  assert.deepEqual(lapsed.capabilities, { readback: true, suppression: false, budget: false });

  const noReadback = await resolveRuntime(
    { ...runtimeSpec, quirks: { ...runtimeSpec.quirks, effortReadback: false } },
    { executable, trust: { fingerprint } },
  );
  assert.deepEqual(noReadback.capabilities, { readback: false, suppression: false, budget: false });
});

test("switching suppression off changes the launch identity of every built-in", async () => {
  const suppressed = runtimeCatalog({ policy: { suppressBuiltInSubagents: true } });
  const unsuppressed = runtimeCatalog({ policy: { suppressBuiltInSubagents: false } });

  for (const spec of suppressed) {
    const approved = await resolveRuntime(spec, { executable: installed });
    const flipped = await resolveRuntime(
      unsuppressed.find((entry) => entry.id === spec.id) as RuntimeSpec,
      { executable: installed, trust: { fingerprint: approved.fingerprint, suppression: true, budget: true } },
    );

    assert.equal(flipped.trusted, false, `${spec.id} kept its trust with suppression switched off`);
    assert.deepEqual(flipped.capabilities, {
      readback: spec.quirks.effortReadback,
      suppression: false,
      budget: false,
    });
  }
});

test("suppression is decided per Runtime, not once for the window", () => {
  const catalog = runtimeCatalog({
    policy: { suppressBuiltInSubagents: true },
    overrides: { codex: { suppressBuiltInSubagents: false } },
  });
  const codex = catalog.find((runtime) => runtime.id === "codex");
  const claude = catalog.find((runtime) => runtime.id === "claude");

  assert.equal(codex?.policy.suppressBuiltInSubagents, false);
  assert.equal(codex?.launch.env.CODEX_CONFIG, undefined);
  assert.equal(claude?.policy.suppressBuiltInSubagents, true);
  assert.ok(claude?.sessionMeta?.(claude.policy), "claude keeps its suppression _meta");
});

test("a launch that re-enters a package runner through argv cannot inherit trust", async () => {
  const executable = executables({ node: "/usr/local/bin/node" });
  const approved = await resolveRuntime(
    spec({ launch: { command: "node", args: ["/opt/agent.js"], env: {} } }),
    { executable },
  );

  const sneaky = await resolveRuntime(
    spec({ launch: { command: "node", args: ["/usr/lib/npm/bin/npx-cli.js", "-y", "@attacker/acp"], env: {} } }),
    { executable, trust: { fingerprint: approved.fingerprint, suppression: true } },
  );

  assert.equal(sneaky.trusted, false);
  assert.throws(() => trustedLaunch(sneaky), /is not trusted/);
});

test("a caller can tell whether trust covers the artifact or only its path", async () => {
  const runtimeSpec = spec({ launch: { command: "agent", args: [], env: {} } });
  const digesting: ExecutablePort = { async resolve() { return { path: "/opt/bin/agent", digest: "sha256:aaa" }; } };

  assert.equal(
    (await resolveRuntime(runtimeSpec, { executable: executables({ agent: "/opt/bin/agent" }) })).artifactVerified,
    false,
  );
  assert.equal((await resolveRuntime(runtimeSpec, { executable: digesting })).artifactVerified, true);
});

test("the suppression the user approved travels with the Runtime, already applied", async () => {
  const [claude] = runtimeCatalog({
    policy: { suppressBuiltInSubagents: false },
    overrides: { claude: { suppressBuiltInSubagents: true } },
  });
  const resolved = await resolveRuntime(claude, { executable: installed });

  // The window says "do not suppress"; this Runtime says otherwise and was
  // fingerprinted saying so, so nothing downstream may re-decide it.
  assert.equal(resolved.policy.suppressBuiltInSubagents, true);
  assert.deepEqual(
    resolved.sessionMeta,
    { claudeCode: { options: { disallowedTools: ["Agent", "SendMessage", "ListAgents"], agents: {} } } },
  );
});

test("the whole per-session policy is part of the identity, not one named field", () => {
  const identity = { runtimeId: "claude", launch: { command: "/opt/bin/agent", args: [], env: {} }, policy };
  // A policy that grows a field must grow the identity with it, or a capability
  // verified under the old policy would survive the new one (ADR-0008).
  const widened = { ...identity, policy: { ...policy, futureSetting: true } as typeof policy };

  assert.notEqual(launchFingerprint(identity), launchFingerprint(widened));
});

test("a digest that says nothing is not artifact verification", async () => {
  const runtimeSpec = spec({ launch: { command: "agent", args: [], env: {} } });
  const blank: ExecutablePort = { async resolve() { return { path: "/opt/bin/agent", digest: "  " }; } };
  const none: ExecutablePort = { async resolve() { return { path: "/opt/bin/agent" }; } };

  const resolved = await resolveRuntime(runtimeSpec, { executable: blank });
  assert.equal(resolved.artifactVerified, false);
  assert.equal(resolved.fingerprint, (await resolveRuntime(runtimeSpec, { executable: none })).fingerprint);
});

test("asking for suppression cannot revive a plan the replaced launch carried away", async () => {
  // Each built-in keeps its plan somewhere the override destroys: claude in the
  // `_meta` builder, codex in the environment, copilot in argv.
  const replaced = runtimeCatalog({
    policy,
    overrides: {
      claude: { command: "/opt/mine/claude-agent-acp", suppressBuiltInSubagents: true },
      codex: { command: "/opt/mine/codex-acp", suppressBuiltInSubagents: true },
      copilot: { args: ["--acp", "--stdio"], suppressBuiltInSubagents: true },
    },
  });
  const executable = executables({
    "/opt/mine/claude-agent-acp": "/opt/mine/claude-agent-acp",
    "/opt/mine/codex-acp": "/opt/mine/codex-acp",
    copilot: "/opt/bin/copilot",
  });

  for (const id of ["claude", "codex", "copilot"]) {
    const resolved = await resolveRuntime(replaced.find((entry) => entry.id === id) as RuntimeSpec, { executable });

    assert.equal(resolved.policy.suppressBuiltInSubagents, false, `${id} still claims suppression`);
    assert.equal(resolved.sessionMeta, undefined, `${id} sent a _meta plan`);
    assert.deepEqual(resolved.launch.env, {}, `${id} carried a policy environment to another binary`);
  }
});
