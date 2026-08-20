import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { DEFAULT_ENV_CHARS, MAX_ENV_CHARS } from "../../vscode/terminals.js";

interface JsonSchema {
  type?: string;
  default?: unknown;
  description?: string;
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
  assert.deepEqual(settings["agentConductor.claude.hideSubscriptionAuth"], {
    type: "boolean",
    default: true,
    markdownDescription:
      "Pass `--hide-claude-auth` to disable claude.ai subscription credentials; configure API-key or supported cloud-provider authentication for Agent Conductor.",
  });
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
    items: { type: "string", enum: operationKeys },
    default: ["fs.read"],
    description: "Client operations approved without prompting; ACP ToolKind is display-only. Waiting for, killing and releasing a command are never prompted for \u2014 consent is given when the command starts \u2014 so naming them here has no effect, while naming them under auto-reject does.",
  });
  assert.deepEqual(settings["agentConductor.permissions.autoRejectClientOperations"], {
    type: "array",
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
