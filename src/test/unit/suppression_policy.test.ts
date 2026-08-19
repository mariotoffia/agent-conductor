import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  builtinRuntimes,
  knownDelegationTools,
  parseSuppressionPlan,
  resolveRuntime,
  runtimeCatalog,
  suppressionPlan,
  verifySuppression,
  type RuntimeSpec,
  type SessionPolicy,
  type SuppliedSuppression,
  type SuppressionPlan,
} from "../../core/index.js";
import { cleared, executables, installed, policy } from "../runtime-fixtures.js";

/** What the golden files pin: every channel a plan reaches its Agent through. */
function catalogShape(sessionPolicy: SessionPolicy): Record<string, unknown> {
  return Object.fromEntries(
    builtinRuntimes(sessionPolicy).map((runtime) => [
      runtime.id,
      { launch: runtime.launch, suppression: runtime.suppression ?? null },
    ]),
  );
}

function golden(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/suppression/${name}.json`, import.meta.url), "utf8"));
}

// ---------------------------------------------------------------------------
// Golden plans: the exact argv, environment and `_meta` of every built-in.
// ---------------------------------------------------------------------------

test("every built-in launches exactly as the golden suppressed catalog says", () => {
  assert.deepEqual(catalogShape({ suppressBuiltInSubagents: true }), golden("enabled"));
});

test("suppression off leaves no plan and no trace of one in any launch", () => {
  const shape = catalogShape({ suppressBuiltInSubagents: false });
  assert.deepEqual(shape, golden("disabled"));

  for (const runtime of builtinRuntimes({ suppressBuiltInSubagents: false })) {
    assert.equal(runtime.suppression, undefined, `${runtime.id} kept a plan`);
    assert.deepEqual(runtime.launch.env, {}, `${runtime.id} kept a policy environment`);
  }
});

test("claude disables the tool that still exists, not the one that was renamed", () => {
  const plan = suppressionPlan("claude", policy) as SuppressionPlan;
  const disallowed = ((plan.sessionMeta as { claudeCode: { options: { disallowedTools: string[] } } })
    .claudeCode.options.disallowedTools);

  // The old name silently no-ops, so naming it would suppress nothing (ADR-0004).
  assert.ok(disallowed.includes("Agent"));
  assert.ok(!disallowed.includes("Task"));
  assert.deepEqual((plan.sessionMeta as { claudeCode: { options: { agents: unknown } } }).claudeCode.options.agents, {});
});

test("codex sets both switches, because the feature flag is read first", () => {
  const plan = suppressionPlan("codex", policy) as SuppressionPlan;
  const config = JSON.parse(plan.env.CODEX_CONFIG) as {
    agents: { enabled: boolean };
    features: { multi_agent_v2: boolean; collab: boolean };
  };

  assert.equal(config.agents.enabled, false);
  assert.equal(config.features.multi_agent_v2, false);
  assert.equal(config.features.collab, false);
});

test("copilot's exclusions are appended to its launch, never replacing it", () => {
  const [copilot] = builtinRuntimes(policy).filter((runtime) => runtime.id === "copilot");

  assert.deepEqual(copilot.launch.args, ["--acp", "--stdio", "--excluded-tools", "task,read_agent"]);
});

test("built-in ids are unique and every entry names something launchable", () => {
  const runtimes = builtinRuntimes(policy);
  const ids = runtimes.map((runtime) => runtime.id);

  assert.equal(new Set(ids).size, ids.length);
  for (const runtime of runtimes) {
    assert.ok(runtime.launch.command.length > 0, `${runtime.id}: empty command`);
    assert.ok(runtime.detection.binaries.length > 0, `${runtime.id}: no detection binaries`);
    assert.ok((runtime.suppression?.delegationTools.length ?? 0) > 0, `${runtime.id}: nothing to verify`);
  }
});

// ---------------------------------------------------------------------------
// Verification: the live tool list decides, and everything unknown fails closed.
// ---------------------------------------------------------------------------

test("a tool list that could not be read is never taken for a clean one", () => {
  const plan = suppressionPlan("copilot", policy) as SuppressionPlan;

  const unread = verifySuppression(plan, {});
  assert.equal(unread.verified, false);
  assert.match(unread.reason as string, /tool list/);

  assert.equal(verifySuppression(plan, { tools: ["shell", "str_replace"] }).verified, true);
});

test("a delegation tool still on the list refuses the capability, however it is spelled", () => {
  const plan = suppressionPlan("copilot", policy) as SuppressionPlan;

  for (const live of ["task", "Task", "READ_AGENT"]) {
    const verdict = verifySuppression(plan, { tools: ["shell", live] });
    assert.equal(verdict.verified, false, `"${live}" passed as suppressed`);
    assert.match(verdict.reason as string, /delegation tools still available/);
  }
});

test("gemini stays unverified until the workspace write was consented to", () => {
  const plan = suppressionPlan("gemini", policy) as SuppressionPlan;

  const withoutConsent = verifySuppression(plan, { tools: ["read_file"] });
  assert.equal(withoutConsent.verified, false);
  assert.match(withoutConsent.reason as string, /\.gemini\/settings\.json/);

  assert.equal(verifySuppression(plan, { tools: ["read_file"], workspaceSettingsConsent: true }).verified, true);
});

test("a runtime with no plan cannot be verified by any evidence", () => {
  const verdict = verifySuppression(undefined, { tools: [], workspaceSettingsConsent: true });

  assert.equal(verdict.verified, false);
  assert.match(verdict.reason as string, /no suppression plan/);
});

// ---------------------------------------------------------------------------
// Eligibility: no plan, no Shim — and a supplied plan is a new identity.
// ---------------------------------------------------------------------------

const myAcp = executables({ "my-acp": "/opt/bin/my-acp" });

const suppliedPlan: SuppliedSuppression = {
  args: ["--no-subagents"],
  env: { MY_ACP_AGENTS: "off" },
  sessionMeta: { myAcp: { agents: false } },
  delegationTools: ["delegate"],
};

function custom(suppression?: SuppliedSuppression): RuntimeSpec {
  const [spec] = runtimeCatalog({
    policy,
    overrides: { "my-acp": { command: "my-acp", ...(suppression ? { suppression } : {}) } },
  }).filter((runtime) => runtime.id === "my-acp");
  return spec;
}

test("a custom Runtime with no plan stays ineligible even when evidence was recorded", async () => {
  const spec = custom();
  const { fingerprint } = await resolveRuntime(spec, { executable: myAcp });

  const resolved = await resolveRuntime(spec, { executable: myAcp, trust: { fingerprint, suppression: cleared() } });

  assert.equal(resolved.trusted, true);
  // ADR-0008: injection needs a Suppression Plan, not merely a record saying one
  // was verified. There is nothing here that could have been verified.
  assert.equal(resolved.capabilities.suppression, false);
});

test("a supplied plan reaches the launch, the metadata, and the identity", async () => {
  const spec = custom(suppliedPlan);
  const { fingerprint } = await resolveRuntime(spec, { executable: myAcp });
  const resolved = await resolveRuntime(spec, { executable: myAcp, trust: { fingerprint, suppression: cleared() } });

  assert.deepEqual(resolved.launch.args, ["--no-subagents"]);
  assert.deepEqual(resolved.launch.env, { MY_ACP_AGENTS: "off" });
  assert.deepEqual(resolved.sessionMeta, { myAcp: { agents: false } });
  assert.equal(resolved.capabilities.suppression, true);

  const plainly = await resolveRuntime(custom(), { executable: myAcp });
  assert.notEqual(plainly.fingerprint, fingerprint, "supplying a plan must need fresh approval");
});

test("editing a supplied plan's metadata invalidates the approval it was given", async () => {
  const approved = await resolveRuntime(custom(suppliedPlan), { executable: myAcp });
  const edited = await resolveRuntime(
    custom({ ...suppliedPlan, sessionMeta: { myAcp: { agents: true } } }),
    { executable: myAcp, trust: { fingerprint: approved.fingerprint, suppression: cleared() } },
  );

  assert.equal(edited.trusted, false);
  assert.equal(edited.capabilities.suppression, false);
});

test("a supplied plan naming no delegation tool is refused as unfalsifiable", () => {
  const spec = custom({ args: ["--no-subagents"] } as SuppliedSuppression);

  assert.equal(spec.suppression, undefined);
  assert.match(spec.unavailable as string, /delegation tools/);
});

test("a malformed supplied plan disables its Runtime instead of half-applying", () => {
  const malformed: [SuppliedSuppression, RegExp][] = [
    [{ args: [1] } as unknown as SuppliedSuppression, /arguments/],
    [{ env: { A: 2 } } as unknown as SuppliedSuppression, /environment/],
    [{ sessionMeta: [] } as unknown as SuppliedSuppression, /session metadata/],
    [{ workspaceSettings: { file: 1 } } as unknown as SuppliedSuppression, /workspace settings/],
  ];

  for (const [supplied, reason] of malformed) {
    const spec = custom({ delegationTools: ["delegate"], ...supplied });
    assert.equal(spec.suppression, undefined, `${JSON.stringify(supplied)} was applied anyway`);
    assert.match(spec.unavailable as string, reason);
  }
  assert.equal(parseSuppressionPlan(undefined).plan, undefined);
});

test("replacing a built-in's launch leaves it with no plan to be eligible under", async () => {
  const replaced = runtimeCatalog({
    policy,
    overrides: { claude: { command: "codex-acp", suppressBuiltInSubagents: true } },
  }).find((runtime) => runtime.id === "claude") as RuntimeSpec;
  const { fingerprint } = await resolveRuntime(replaced, { executable: installed });

  const resolved = await resolveRuntime(replaced, {
    executable: installed,
    trust: { fingerprint, suppression: cleared() },
  });

  assert.equal(replaced.suppression, undefined, "the built-in recipe went with the launch it described");
  assert.equal(resolved.sessionMeta, undefined);
  assert.equal(resolved.capabilities.suppression, false);
});

test("a supplied plan cannot stand in for a recipe the catalog already has", async () => {
  const [claude] = runtimeCatalog({
    policy,
    overrides: { claude: { suppression: { delegationTools: ["nothing_by_this_name"] } } },
  }).filter((runtime) => runtime.id === "claude");

  // Otherwise a workspace settings file could swap Claude's real `_meta` recipe
  // for one that names a tool Claude does not have, and pass verification while
  // `Agent` stayed live (ADR-0008).
  assert.match(claude.unavailable as string, /built-in/);
  await assert.rejects(resolveRuntime(claude, { executable: installed }), /built-in/);
});

test("a plan that disables nothing is not a plan", () => {
  const spec = custom({ delegationTools: ["delegate"] });

  assert.equal(spec.suppression, undefined);
  assert.match(spec.unavailable as string, /disables nothing/);
});

test("a workspace-scoped plan is only verified for the workspace it was written in", async () => {
  const [gemini] = runtimeCatalog({ policy }).filter((runtime) => runtime.id === "gemini");
  const { fingerprint } = await resolveRuntime(gemini, { executable: installed, workspace: "/work/a" });
  const trust = { fingerprint, suppression: cleared({ workspace: "/work/a" }) };

  const here = await resolveRuntime(gemini, { executable: installed, trust, workspace: "/work/a" });
  const elsewhere = await resolveRuntime(gemini, { executable: installed, trust, workspace: "/work/b" });

  assert.equal(here.capabilities.suppression, true);
  // The plan lives in the other workspace's settings file; this one never got it.
  assert.equal(elsewhere.capabilities.suppression, false);
});

test("an empty tool list is silence, not proof", () => {
  const verdict = verifySuppression(suppressionPlan("copilot", policy), { tools: [] });

  assert.equal(verdict.verified, false);
  assert.match(verdict.reason as string, /tool list/);
});

test("a settings file the plan should never write to is refused", () => {
  for (const file of ["", "/etc/hosts", "../../../etc/hosts", ".gemini/../../out.json"]) {
    const spec = custom({ ...suppliedPlan, workspaceSettings: { file, merge: { a: 1 } } });
    assert.equal(spec.suppression, undefined, `"${file}" was accepted`);
    assert.match(spec.unavailable as string, /workspace/);
  }
});

test("one unusable override entry does not empty the catalog", () => {
  const catalog = runtimeCatalog({
    policy,
    overrides: { "my-acp": null as unknown as { command: string }, claude: { enabled: true } },
  });

  assert.equal(catalog.length, builtinRuntimes(policy).length);
  assert.ok(catalog.every((runtime) => runtime.id !== "my-acp"));
});

test("an override that replaces nothing does not open the door to a decoy plan", async () => {
  // `args: []` is what Claude already launches with, so this entry is the built-in
  // in every way the user can see — command, argv and environment are identical.
  const decoy = { sessionMeta: {}, delegationTools: ["nothing_by_this_name"] };
  const [claude] = runtimeCatalog({
    policy,
    overrides: { claude: { args: [], suppression: decoy } },
  }).filter((runtime) => runtime.id === "claude");

  assert.match(claude.unavailable as string, /built-in/);
  await assert.rejects(resolveRuntime(claude, { executable: installed }), /built-in/);
});

test("a plan is measured against every delegation tool known, not the ones it names", () => {
  // Otherwise a plan is self-certifying: name a tool nobody has, and an Agent with
  // its delegation fully live passes (ADR-0008).
  const decoy: SuppressionPlan = {
    args: ["--quiet"],
    env: {},
    delegationTools: ["nothing_by_this_name"],
  };

  const verdict = verifySuppression(decoy, { tools: ["Agent", "Read", "Bash"] });
  assert.equal(verdict.verified, false);
  assert.match(verdict.reason as string, /Agent/);

  assert.equal(verifySuppression(decoy, { tools: ["Read", "Bash"] }).verified, true);
});

test("a custom id aimed at a catalog binary cannot certify its own decoy", async () => {
  const [impostor] = runtimeCatalog({
    policy,
    overrides: {
      Claude: {
        command: "claude-agent-acp",
        suppression: { args: ["--quiet"], delegationTools: ["nothing_by_this_name"] },
      },
    },
  }).filter((runtime) => runtime.id === "Claude");
  const { fingerprint } = await resolveRuntime(impostor, { executable: installed });
  const resolved = await resolveRuntime(impostor, {
    executable: installed,
    trust: { fingerprint, suppression: cleared() },
  });

  // The entry may exist and be trusted; what it may not do is call itself verified
  // while Claude's own delegation tools are still there to be found.
  assert.equal(resolved.capabilities.suppression, true);
  assert.equal(verifySuppression(impostor.suppression, { tools: ["Agent"] }).verified, false);
});

test("an empty metadata payload is not a channel and cannot carry a plan", () => {
  const spec = custom({ sessionMeta: {}, delegationTools: ["delegate"] });

  assert.match(spec.unavailable as string, /disables nothing/);
});

test("every built-in's delegation tools are among the names verification looks for", () => {
  const known = new Set(knownDelegationTools().map((tool) => tool.toLowerCase()));

  // A Runtime added to the catalog without its tools reaching the union would be
  // verified against someone else's names — the way suppression recipes rot.
  for (const runtime of builtinRuntimes(policy)) {
    for (const tool of runtime.suppression?.delegationTools ?? []) {
      assert.ok(known.has(tool.toLowerCase()), `${runtime.id}: ${tool} is not checked for`);
    }
  }
});

test("eligibility is derived from the evidence, never asserted alongside it", async () => {
  const [claude] = runtimeCatalog({ policy }).filter((runtime) => runtime.id === "claude");
  const { fingerprint } = await resolveRuntime(claude, { executable: installed });
  const eligible = async (tools: string[]): Promise<boolean> =>
    (await resolveRuntime(claude, { executable: installed, trust: { fingerprint, suppression: { tools } } }))
      .capabilities.suppression;

  // A record says what a Probe Session saw. Whether that clears the plan is
  // re-decided here, every time, so no stored claim can outlive the check.
  assert.equal(await eligible(["Read", "Bash"]), true);
  assert.equal(await eligible(["Read", "Agent"]), false);
  assert.equal(await eligible([]), false);
});

test("evidence gathered against an older plan is re-judged against the current one", async () => {
  // The catalog learns of a delegation tool after the evidence was recorded; the
  // stored tool list still shows it, so the capability lapses on its own.
  const spec = custom({ ...suppliedPlan, delegationTools: ["delegate", "handoff"] });
  const { fingerprint } = await resolveRuntime(spec, { executable: myAcp });
  const resolved = await resolveRuntime(spec, {
    executable: myAcp,
    trust: { fingerprint, suppression: { tools: ["read", "handoff"] } },
  });

  assert.equal(resolved.capabilities.suppression, false);
});
