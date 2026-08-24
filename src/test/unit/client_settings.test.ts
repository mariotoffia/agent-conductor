import assert from "node:assert/strict";
import type { RuntimeSetting } from "../../vscode/config.js";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  readSettings,
  resolveSecretEnvironment,
  type SecretsSource,
  type SettingsSource,
} from "../../vscode/config.js";

/** Settings as VS Code hands them over: one effective value per dotted key. */
function source(values: Record<string, unknown>): SettingsSource {
  return { get: (key) => values[key] };
}

test("an operation listed as both auto-allow and auto-reject never auto-allows", () => {
  const { settings, problems } = readSettings(
    source({
      "permissions.autoAllowClientOperations": ["fs.read", "terminal.spawn"],
      "permissions.autoRejectClientOperations": ["terminal.spawn"],
    }),
  );

  assert.deepEqual(settings["permissions.autoAllowClientOperations"], ["fs.read"]);
  assert.deepEqual(settings["permissions.autoRejectClientOperations"], ["terminal.spawn"]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /terminal\.spawn/);
});

test("unset settings fall back to exactly the defaults the manifest declares", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
  ) as { contributes: { configuration: { properties: Record<string, { default?: unknown }> } } };
  const declared = manifest.contributes.configuration.properties;

  const { settings, problems } = readSettings(source({}));

  assert.deepEqual(problems, []);
  for (const [key, value] of Object.entries(settings)) {
    // VS Code applies the manifest default when a key is unset; a schema that
    // disagreed would validate against a value the user never sees.
    assert.deepEqual(value, declared[`agentConductor.${key}`]?.default, key);
  }
});

test("a setting that does not validate falls back to its default and says so", () => {
  const { settings, problems } = readSettings(
    source({ "orchestration.maxConcurrentSubagents": 99, "ui.showThinking": "yes" }),
  );

  assert.equal(settings["orchestration.maxConcurrentSubagents"], 3);
  assert.equal(settings["ui.showThinking"], true);
  assert.equal(problems.length, 2);
  assert.match(problems.join("\n"), /maxConcurrentSubagents/);
  assert.match(problems.join("\n"), /showThinking/);
});

test("one malformed runtime entry does not take the other runtimes with it", () => {
  const { settings, problems } = readSettings(
    source({
      runtimes: {
        claude: { enabled: true, command: "/usr/local/bin/claude-agent-acp" },
        broken: { enabled: true, unknownKey: 1 },
      },
    }),
  );

  assert.deepEqual(Object.keys(settings.runtimes), ["claude"]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^runtime "broken"/);
});

test("a suppression plan supplied in settings must name the tools it disables", () => {
  const { settings, problems } = readSettings(
    source({
      runtimes: {
        mine: { suppression: { args: ["--no-agents"], delegationTools: [] } },
      },
    }),
  );

  assert.deepEqual(settings.runtimes, {});
  assert.match(problems[0], /suppression/);
});

test("a secret pasted into settings is refused without ever being echoed back", () => {
  const literal = "sk-ant-api03-NOTAREALKEYbutshapedlikeone0123456789";
  const { settings, problems } = readSettings(
    source({ runtimes: { claude: { secretEnvironment: { ANTHROPIC_API_KEY: literal } } } }),
  );

  assert.deepEqual(settings.runtimes, {}, "a runtime carrying a literal secret is not usable");
  assert.equal(problems.length, 1);
  assert.match(problems[0], /secretEnvironment/);
  assert.equal(problems[0].includes(literal), false, "the value must never reach a message");
});

test("a secret storage key reference is accepted", () => {
  const { settings, problems } = readSettings(
    source({
      runtimes: { claude: { secretEnvironment: { ANTHROPIC_API_KEY: "claude.apiKey" } } },
    }),
  );

  assert.deepEqual(problems, []);
  assert.deepEqual(settings.runtimes.claude?.secretEnvironment, { ANTHROPIC_API_KEY: "claude.apiKey" });
});

// ---------------------------------------------------------------------------
// Secret resolution: settings hold references, the child environment holds
// values, and no value is ever allowed into a message (ADR-0010).
// ---------------------------------------------------------------------------

function store(secrets: Record<string, string>): SecretsSource {
  return { get: async (key) => secrets[key] };
}

test("references resolve into the environment the agent process is spawned with", async () => {
  const environment = await resolveSecretEnvironment(
    store({ "claude.apiKey": "s3cret-value-9999" }),
    "claude",
    { ANTHROPIC_API_KEY: "claude.apiKey" },
  );

  assert.deepEqual(environment, { ANTHROPIC_API_KEY: "s3cret-value-9999" });
});

test("a reference with nothing stored behind it stops the launch", async () => {
  // A reference that is really a mis-pasted credential cannot always be told
  // apart from a key name, so nothing read out of `secretEnvironment` is printed.
  const unrecognisedShape = "gsk0Xk8fJ2mQpL9vRt3wYz5NbH7cD1aE4gS6";

  await assert.rejects(
    resolveSecretEnvironment(store({}), "claude", { ANTHROPIC_API_KEY: unrecognisedShape }),
    (error: Error) => {
      assert.match(error.message, /ANTHROPIC_API_KEY/);
      assert.equal(error.message.includes(unrecognisedShape), false, "the reference leaked");
      return true;
    },
  );
});

test("a literal secret handed to resolution is refused without being printed", async () => {
  const literal = "ghp_NOTAREALTOKENbutshapedlikeone0123456789";

  await assert.rejects(
    resolveSecretEnvironment(store({}), "claude", { GITHUB_TOKEN: literal }),
    (error: Error) => {
      assert.equal(error.message.includes(literal), false);
      assert.match(error.message, /GITHUB_TOKEN/);
      return true;
    },
  );
});

test("a failing secret store cannot leak an already-resolved value through its error", async () => {
  const value = "s3cret-value-9999";
  const failing: SecretsSource = {
    get: async (key) => {
      if (key === "claude.apiKey") return value;
      throw new Error(`keychain rejected the read (last value was ${value})`);
    },
  };

  await assert.rejects(
    resolveSecretEnvironment(failing, "claude", {
      ANTHROPIC_API_KEY: "claude.apiKey",
      OTHER_TOKEN: "claude.other",
    }),
    (error: Error) => {
      assert.equal(error.message.includes(value), false, "the resolved value leaked");
      assert.match(error.message, /\[redacted\]/);
      return true;
    },
  );
});

test("a typo in the reject list drops that entry, never the rejections around it", () => {
  const { settings, problems } = readSettings(
    source({
      "permissions.autoAllowClientOperations": ["fs.read", "fs.write"],
      "permissions.autoRejectClientOperations": ["terminal.spawn", "fs.delete"],
    }),
  );

  // Falling back to the manifest default here would be an empty reject list:
  // an operation the user refused outright would run with no prompt at all.
  assert.deepEqual(settings["permissions.autoRejectClientOperations"], ["terminal.spawn"]);
  assert.deepEqual(settings["permissions.autoAllowClientOperations"], ["fs.read", "fs.write"]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /fs\.delete/);
});

test("a typo in the allow list drops that entry too", () => {
  const { settings, problems } = readSettings(
    // Not the default list, so falling back to it cannot pass for a fix.
    source({ "permissions.autoAllowClientOperations": ["fs.write", "everything"] }),
  );

  assert.deepEqual(settings["permissions.autoAllowClientOperations"], ["fs.write"]);
  assert.equal(problems.length, 1);
});

test("a rejection list that is not a list at all grants nothing automatically", () => {
  const { settings, problems } = readSettings(
    source({
      "permissions.autoAllowClientOperations": ["terminal.spawn", "fs.write"],
      // Hand-edited settings.json: a bare string where a list belongs.
      "permissions.autoRejectClientOperations": "terminal.spawn",
    }),
  );

  // Which operations the user meant to refuse is unknowable, so nothing is
  // approved without asking — the one reading that cannot silently grant.
  assert.deepEqual(settings["permissions.autoAllowClientOperations"], []);
  assert.deepEqual(settings["permissions.autoRejectClientOperations"], []);
  assert.match(problems.join("\n"), /autoRejectClientOperations/);
});

test("a name that is not an environment variable name never reaches a child process", async () => {
  await assert.rejects(
    resolveSecretEnvironment(store({ "claude.apiKey": "s3cret-value-9999" }), "claude", {
      "PATH=/tmp/evil:": "claude.apiKey",
    }),
    /environment variable name/,
  );
});

test("an environment budget beyond what a prompt can show is reported, not silently ignored", () => {
  const { settings, problems } = readSettings(source({ "permissions.maxEnvironmentChars": 50_000 }));

  assert.equal(settings["permissions.maxEnvironmentChars"], 900);
  assert.match(problems.join("\n"), /maxEnvironmentChars/);
});

test("a runtime named after an Object member is still just a runtime", () => {
  const { settings } = readSettings(
    source({ runtimes: { toString: { command: "/opt/bin/agent" }, claude: {} } }),
  );

  // Ids are settings keys, so one can be spelled like a member of every object.
  // What matters is that it validates as an entry and reaches the catalog as
  // one — `runtime_registry.test.ts` pins that it cannot take the catalog down.
  // Read the way every consumer reads it — by id, from the record's own keys.
  const entry: RuntimeSetting | undefined = Object.entries(settings.runtimes).find(
    ([id]) => id === "toString",
  )?.[1];
  assert.equal(entry?.command, "/opt/bin/agent");
  assert.deepEqual(Object.keys(settings.runtimes).sort(), ["claude", "toString"]);
});

test("a credential pasted into a suppression plan's environment is refused", () => {
  const { settings, problems } = readSettings(
    source({
      runtimes: {
        codex: {
          suppression: {
            env: { OPENAI_API_KEY: "sk-live-pasted-into-settings" },
            delegationTools: ["spawn_agent"],
          },
        },
      },
    }),
  );

  // `secretEnvironment` catches this shape; a suppression plan's environment is
  // the same settings file and the same hazard — synced, and often committed.
  assert.deepEqual(settings.runtimes, {});
  assert.ok(problems.some((problem) => /codex/.test(problem)), problems.join("\n"));
  assert.equal(problems.join("\n").includes("sk-live-pasted-into-settings"), false, "and never echoed");
});

test("every setting the manifest declares is one the client reads", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
  ) as { contributes: { configuration: { properties: Record<string, unknown> } } };
  const declared = Object.keys(manifest.contributes.configuration.properties);
  const { settings } = readSettings(source({}));
  const known = new Set(Object.keys(settings));

  // The other direction from the schema test above. A key added to the manifest
  // and to nothing else is a setting that silently does nothing — which is how
  // `claude.hideSubscriptionAuth` sat inert while its description promised a
  // security property.
  const unread = declared
    .map((key) => key.replace(/^agentConductor\./, ""))
    .filter((key) => !known.has(key));
  assert.deepEqual(unread, [], `declared but never parsed: ${unread.join(", ")}`);
});

/**
 * Settings the client parses but nothing acts on yet, and why.
 *
 * Parsing a setting is not reading it: `readSettings` validates all of these,
 * and a user who sets one gets no error and no effect. Naming them here is the
 * honest version of that — and the test below fails both ways, so a setting
 * that gains a consumer has to be taken off the list.
 */
const NOT_ACTED_ON: Record<string, string> = {
  "gemini.writeWorkspaceSettings": "the workspace suppression channel is not wired end to end",
};

test("a setting nothing acts on is one this client admits to", async () => {
  const { settings } = readSettings(source({}));
  const directories = ["../../core", "../../vscode"].map((at) => new URL(`${at}/`, import.meta.url));
  const sources = (
    await Promise.all(
      directories.map(async (directory) =>
        Promise.all(
          (await readdir(directory))
            .filter((name) => name.endsWith(".ts") && name !== "config.ts")
            .map((name) => readFile(new URL(name, directory), "utf8")),
        ),
      ),
    )
  )
    .flat()
    .join("\n");

  // Consumers name a setting by its key: `settings()["registry.url"]`.
  const acted = Object.keys(settings).filter((key) => sources.includes(`"${key}"`));
  assert.deepEqual(
    Object.keys(settings).filter((key) => !acted.includes(key)).sort(),
    Object.keys(NOT_ACTED_ON).sort(),
    "a setting gained or lost a consumer without this list being updated",
  );
});
