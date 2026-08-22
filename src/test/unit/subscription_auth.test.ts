import assert from "node:assert/strict";
import { test } from "node:test";
import { builtinRuntimes, resolveRuntime, runtimeCatalog, type SessionPolicy } from "../../core/index.js";
import { identityDetail } from "../../vscode/wizardTrust.js";
import { executables, installed } from "../runtime-fixtures.js";

/**
 * Claude runs on an API key, not on somebody's claude.ai subscription (ADR-0010).
 *
 * The adapter is told so on its command line, which makes it part of the launch
 * identity: a Runtime approved with subscription authentication hidden is not
 * the same Runtime as one approved without it, and a settings change that turns
 * it off has to be approved again.
 */

const policyWith = (overrides: Partial<SessionPolicy> = {}): SessionPolicy => ({
  suppressBuiltInSubagents: false,
  hideSubscriptionAuth: true,
  ...overrides,
});

const runtimeOf = (id: string, policy: SessionPolicy) =>
  builtinRuntimes(policy).find((entry) => entry.id === id);

test("claude is launched with subscription authentication hidden by default", () => {
  const claude = runtimeOf("claude", policyWith());

  assert.deepEqual(claude?.launch.args, ["--hide-claude-auth"]);
});

test("turning the default off launches claude without the flag", () => {
  const claude = runtimeOf("claude", policyWith({ hideSubscriptionAuth: false }));

  assert.deepEqual(claude?.launch.args, []);
});

test("no other runtime is given an argument it never asked for", () => {
  const runtimes = builtinRuntimes(policyWith());

  assert.deepEqual(runtimeOf("codex", policyWith())?.launch.args, []);
  assert.deepEqual(runtimeOf("gemini", policyWith())?.launch.args, ["--acp"]);
  assert.deepEqual(runtimeOf("copilot", policyWith())?.launch.args, ["--acp", "--stdio"]);
  for (const runtime of runtimes) {
    assert.equal(
      runtime.launch.args.includes("--hide-claude-auth"),
      runtime.id === "claude",
      `${runtime.id} was given claude's authentication flag`,
    );
  }
});

test("hiding subscription authentication is part of what the user approved", async () => {
  const hidden = await resolveRuntime(runtimeOf("claude", policyWith())!, { executable: installed });
  const shown = await resolveRuntime(
    runtimeOf("claude", policyWith({ hideSubscriptionAuth: false }))!,
    { executable: installed },
  );

  // Otherwise a settings change would silently move a session onto subscription
  // credentials under an approval given for something else (ADR-0007).
  assert.notEqual(hidden.fingerprint, shown.fingerprint);
});

test("a runtime with no recipe for it is unaffected by the setting", async () => {
  const on = await resolveRuntime(runtimeOf("gemini", policyWith())!, { executable: installed });
  const off = await resolveRuntime(
    runtimeOf("gemini", policyWith({ hideSubscriptionAuth: false }))!,
    { executable: installed },
  );

  // A setting that named no runtime of theirs must not lapse their trust.
  assert.equal(on.fingerprint, off.fingerprint);
});

test("naming the same command settings already describe changes nothing", () => {
  // An override that repeats the catalog's own command replaces nothing, so it
  // must not quietly drop the flag the catalog put there (ADR-0010).
  const [claude] = runtimeCatalog({
    policy: policyWith(),
    overrides: { claude: { command: "claude-agent-acp" } },
  });

  assert.deepEqual(claude?.launch.args, ["--hide-claude-auth"]);
  assert.equal(claude?.policy.hideSubscriptionAuth, true);
});

test("the same adapter named absolutely is warned about, not denied", async () => {
  // The ordinary wizard route when the adapter is not on PATH: the prompt asks
  // for "an absolute path, or a name on PATH". Whatever we can or cannot apply
  // to it, the user must not be told the switch does not exist.
  const [claude] = runtimeCatalog({
    policy: policyWith(),
    overrides: { claude: { command: "/opt/homebrew/bin/claude-agent-acp" } },
  });
  const runtime = await resolveRuntime(claude!, {
    executable: executables({ "/opt/homebrew/bin/claude-agent-acp": "/opt/homebrew/bin/claude-agent-acp" }),
  });

  const detail = identityDetail(runtime);
  assert.equal(detail.includes("no switch for it"), false, detail);
  assert.match(detail, /left on|personal plan/i, "the risk is stated, not denied");
});

test("a runtime that never had the switch says so", async () => {
  const runtime = await resolveRuntime(runtimeOf("gemini", policyWith())!, { executable: installed });

  assert.match(identityDetail(runtime), /no switch for it/);
});

test("a launch the user replaced says plainly that the flag no longer applies", async () => {
  const [replaced] = runtimeCatalog({
    policy: policyWith(),
    overrides: { claude: { command: "/opt/bin/my-own-adapter" } },
  });
  const runtime = await resolveRuntime(replaced!, {
    executable: executables({ "/opt/bin/my-own-adapter": "/opt/bin/my-own-adapter" }),
  });

  // The catalog cannot know how somebody else's program is told to avoid
  // subscription credentials, and the approval must not leave that unsaid.
  assert.equal(runtime.launch.args.includes("--hide-claude-auth"), false);
  assert.match(identityDetail(runtime), /left on|personal plan/i);
});

test("an approved claude launch says the flag is there", async () => {
  const runtime = await resolveRuntime(runtimeOf("claude", policyWith())!, { executable: installed });

  // Named on its own line, not merely present in the command line above it.
  assert.match(identityDetail(runtime), /Subscription authentication: off, via --hide-claude-auth/);
});

test("the disclosure never contradicts the command line above it", async () => {
  // Every combination the wizard and settings can produce: a dialog that says
  // one thing while the argv one line above says another is a dialog people
  // stop reading (ADR-0007).
  const overrides = [
    undefined,
    { command: "claude-agent-acp" },
    { args: [] },
    { command: "claude-agent-acp", args: ["--hide-claude-auth"] },
    { command: "/opt/bin/claude-agent-acp" },
    { command: "/opt/bin/claude-agent-acp", args: ["--hide-claude-auth"] },
    { command: "/opt/bin/other-agent" },
  ];
  const paths = {
    "claude-agent-acp": "/opt/bin/claude-agent-acp",
    "/opt/bin/claude-agent-acp": "/opt/bin/claude-agent-acp",
    "/opt/bin/other-agent": "/opt/bin/other-agent",
  };

  for (const hideSubscriptionAuth of [true, false]) {
    for (const override of overrides) {
      const [claude] = runtimeCatalog({
        policy: { suppressBuiltInSubagents: false, hideSubscriptionAuth },
        ...(override ? { overrides: { claude: override } } : {}),
      });
      const runtime = await resolveRuntime(claude!, { executable: executables(paths) });
      const detail = identityDetail(runtime);
      const applied = runtime.launch.args.includes("--hide-claude-auth");

      assert.equal(
        /Subscription authentication: off/.test(detail),
        applied,
        `argv ${JSON.stringify(runtime.launch.args)} but said: ${detail.split("\n").find((line) => line.startsWith("Subscription"))}`,
      );
    }
  }
});
