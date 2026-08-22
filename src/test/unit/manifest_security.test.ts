import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { DEFAULT_ENV_CHARS, MAX_ENV_CHARS } from "../../vscode/terminals.js";

interface JsonSchema {
  type?: string;
  default?: unknown;
  description?: string;
  markdownDescription?: string;
  scope?: string;
  items?: JsonSchema;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  required?: string[];
}

interface ExtensionManifest {
  contributes: {
    configuration: {
      properties: Record<string, JsonSchema>;
    };
  };
}

const manifest = JSON.parse(
  await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
) as ExtensionManifest;
const settings = manifest.contributes.configuration.properties;

test("cross-runtime orchestration requires explicit opt-in", () => {
  assert.equal(settings["agentConductor.orchestration.enabled"].default, false);
});

test("Claude sessions default to API-key authentication", () => {
  const setting = settings["agentConductor.claude.hideSubscriptionAuth"];

  assert.equal(setting.type, "boolean");
  // Whether a personal plan may be routed through a third-party product is not
  // a repository's to decide, whichever way this one is set (ADR-0010).
  assert.equal(setting.scope, "machine");
  assert.equal(setting.default, true, "ADR-0010's posture is the default");
  // The description names the flag, and `subscription_auth.test.ts` pins that
  // the flag actually reaches the launch. A manifest describing a security
  // property the client does not have is the failure worth guarding against.
  assert.match(setting.markdownDescription ?? "", /--hide-claude-auth/);
});

test("runtime settings reference secrets without accepting plaintext environment values", () => {
  const runtimeEntry = settings["agentConductor.runtimes"].additionalProperties;
  assert.ok(runtimeEntry && typeof runtimeEntry === "object");

  assert.equal(runtimeEntry.additionalProperties, false);
  const properties = runtimeEntry.properties ?? {};
  assert.equal("env" in properties, false);
  assert.deepEqual(properties.secretEnvironment, {
    type: "object",
    additionalProperties: { type: "string" },
    description: "Environment variable name to VS Code SecretStorage key reference.",
  });
});

test("automatic permission policy uses Client-derived operation keys", () => {
  assert.equal("agentConductor.permissions.autoAllow" in settings, false);
  assert.equal("agentConductor.permissions.autoReject" in settings, false);

  const operationKeys = ["fs.read", "fs.write", "terminal.spawn", "terminal.wait", "terminal.kill", "terminal.release"];
  assert.deepEqual(settings["agentConductor.permissions.autoAllowClientOperations"], {
    type: "array",
    scope: "machine",
    items: { type: "string", enum: operationKeys },
    default: ["fs.read"],
    description: "Client operations approved without prompting; ACP ToolKind is display-only. Waiting for, killing and releasing a command are never prompted for \u2014 consent is given when the command starts \u2014 so naming them here has no effect, while naming them under auto-reject does.",
  });
  assert.deepEqual(settings["agentConductor.permissions.autoRejectClientOperations"], {
    type: "array",
    scope: "machine",
    items: { type: "string", enum: operationKeys },
    default: [],
  });
});

test("a runtime entry can carry the suppression plan the settings layer validates", () => {
  const runtimeEntry = settings["agentConductor.runtimes"].additionalProperties;
  assert.ok(runtimeEntry && typeof runtimeEntry === "object");

  // Without this the one channel by which a user-defined Runtime becomes eligible
  // for orchestration is a schema error in the settings editor.
  const plan = runtimeEntry.properties?.suppression;
  assert.ok(plan, "no way to supply a suppression plan");
  assert.equal(plan.additionalProperties, false);
  assert.deepEqual(plan.required, ["delegationTools"]);
  assert.equal(plan.properties?.delegationTools?.type, "array");
});

test("the approval prompt's environment budget cannot be raised past what it shows", () => {
  const budget = settings["agentConductor.permissions.maxEnvironmentChars"];

  // A budget beyond the prompt's own capacity would let the overflow fall off
  // the end of it — which is the hiding the shown-or-refused rule exists to stop.
  assert.equal(budget.maximum, MAX_ENV_CHARS);
  assert.equal(budget.default, DEFAULT_ENV_CHARS);
  assert.equal(budget.minimum, 0);
});

test("settings that govern the window are declared as governing the window", () => {
  // `resource` scope makes VS Code offer a per-folder tab for these, and a
  // folder value would be silently ignored: the participant is one per window,
  // reads settings without a resource, and runs one session at a time. A
  // repository can still supply them through workspace settings, which is the
  // case the approval prompt is built for.
  for (const key of ["agentConductor.runtimes", "agentConductor.presets"]) {
    assert.equal(settings[key]?.scope, "window", `${key} offers a folder tab nothing reads`);
  }
});

test("whether the user is asked at all is not a repository's to decide", () => {
  // A workspace can write window-scoped settings, and these three decide
  // whether a permission is ever put in front of anybody. A cloned repository
  // that could set them would remove the only defence there is (ADR-0007).
  for (const key of [
    "agentConductor.permissions.autoAllowClientOperations",
    "agentConductor.permissions.autoRejectClientOperations",
    "agentConductor.permissions.rememberAlwaysChoices",
  ]) {
    assert.equal(settings[key]?.scope, "machine", `${key} is settable by a workspace`);
  }
});

test("the client's own limits are not a repository's to set", () => {
  // ADR-0008 puts orchestration behind the user turning it on, and ADR-0009
  // makes depth, concurrency and budget the Client's limits. A repository that
  // could write them could also flip the window policy, which changes every
  // Runtime's fingerprint and leaves every approval lapsed.
  for (const key of [
    "agentConductor.orchestration.enabled",
    "agentConductor.orchestration.maxSpawnDepth",
    "agentConductor.orchestration.maxConcurrentSubagents",
    "agentConductor.orchestration.budgetUsdPerSubagent",
    "agentConductor.orchestration.subagentIsolation",
    "agentConductor.orchestration.defaultSubagentPreset",
    "agentConductor.worktrees.root",
    "agentConductor.gemini.writeWorkspaceSettings",
  ]) {
    assert.equal(settings[key]?.scope, "machine", `${key} is settable by a workspace`);
  }
});

test("what to download and which version to install are not a repository's to say", () => {
  // A workspace can write window-scoped settings. These two decide where the
  // extension fetches from and which exact version the wizard offers to install
  // globally, which is not something a repository gets a say in (ADR-0007).
  for (const key of ["agentConductor.registry.url", "agentConductor.registry.pin"]) {
    assert.equal(settings[key]?.scope, "machine", `${key} is settable by a workspace`);
  }
});

test("whether opening a folder starts an agent is not the folder's to decide", () => {
  // Resuming on startup spawns a coding CLI with the user's own permissions
  // because a window opened. A cloned repository that could turn that on would
  // be choosing to run something before anybody had looked at it (ADR-0007).
  assert.equal(settings["agentConductor.sessions.resumeOnStartup"]?.scope, "machine");
});
