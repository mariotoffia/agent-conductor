import assert from "node:assert/strict";
import test from "node:test";
import { builtinRuntimes } from "../../core/index.js";
import { connectCli, ourWays } from "../../vscode/wizard.js";
import { clampForDisplay, MAX_DETAIL_CHARS, WAYS_CHARS } from "../../vscode/permissions.js";
import { policy } from "../runtime-fixtures.js";
import { mockEntry, wizardHarness } from "../wizard-fixtures.js";

/**
 * How a Runtime that cannot run says what would make it run.
 *
 * This Client installs a pinned Adapter and nothing else (ADR-0007): a CLI is
 * the user's to install, and "not found" on its own leaves them to search for
 * the command. So a catalog entry may carry the ways its vendor documents,
 * shown where the answer is needed — the dialog that says it cannot launch, and
 * the one that says a session would not open, which is where a CLI that is
 * installed but not yet set up ends up.
 */

const hintTest = (name: string, fn: () => Promise<void>) => test(name, { timeout: 30_000 }, fn);
const runtime = (id: string) => builtinRuntimes(policy).find((entry) => entry.id === id);

test("a CLI this client cannot install carries the ways its vendor documents", () => {
  // Verified against each vendor's own installation page, and dated in
  // `docs/CHANGELOG.md` — a command invented here would be one the user pastes.
  assert.deepEqual(runtime("gemini")?.install, [
    "brew install gemini-cli",
    "npm install -g @google/gemini-cli",
  ]);
  assert.deepEqual(runtime("copilot")?.install, [
    "brew install --cask copilot-cli",
    "npm install -g @github/copilot",
  ]);
});

test("a CLI that is not launchable once installed says what else it needs", () => {
  // dsh installs from npm like any Adapter and is still not launchable: its ACP
  // lives in a profile the user makes. The installer offer alone is a dead end.
  const setup = runtime("dsh")?.setup ?? [];

  assert.equal(setup.length, 3, `dsh's setup is two commands and a note: ${setup.join(" · ")}`);
  assert.match(setup[0] ?? "", /^dsh plugin --profile acp add @deepseek-ai\/dsh-acp@/);
  assert.match(setup[1] ?? "", /cordis\.patch\.yml/);
  // The plugin does not read dsh's own default model, and a patch without both
  // gives a runtime that connects and then fails every turn — so what is shown
  // has to carry them, and has to say they are the user's to fill in.
  assert.match(setup[1] ?? "", /provider: PROVIDER, model: MODEL/);
  assert.match(setup.join("\n"), /dsh web/);
  // Pasted as a block, the line that is not a command must not become one.
  assert.match(setup[2] ?? "", /^#/);
  // Installing it is the Adapter offer's job, which names the same package.
  assert.equal(runtime("dsh")?.install, undefined);
});

test("a runtime with nothing to add carries neither", () => {
  // The Adapter offer already says what to do, so a line here would repeat it.
  for (const id of ["claude", "codex"]) {
    assert.equal(runtime(id)?.install, undefined, `${id} repeats the adapter offer`);
    assert.equal(runtime(id)?.setup, undefined, `${id} claims a setup step it does not have`);
  }
});

test("what the catalog offers to say fits the share of a dialog it is given", () => {
  // The reachable half of the bound: a Runtime added with more advice than a
  // modal can hold would push out the reason it could not launch, which is the
  // half this Client did not write.
  for (const spec of builtinRuntimes(policy)) {
    const ways = ourWays(spec);
    assert.ok(ways.length <= WAYS_CHARS, `${spec.id} would crowd out the reason: ${ways.length} characters`);
  }
  // And the bound is one, rather than a hope about how short the catalog is.
  const huge = ourWays({ install: ["x".repeat(WAYS_CHARS * 2)] });
  assert.ok(huge.length > WAYS_CHARS, "the fixture must exceed the share to prove anything");
  assert.equal(clampForDisplay(huge, WAYS_CHARS).length, WAYS_CHARS);
});

hintTest("the dialog that says a CLI cannot launch shows how to install it", async () => {
  // Gemini is not installed in this harness, so the wizard offers what it can.
  const harness = wizardHarness({
    saved: { gemini: {} },
    consent: () => undefined,
  });

  await connectCli(harness.ports);

  const dialog = harness.asked.find((text) => text.includes("cannot be launched"));
  assert.ok(dialog, `no such dialog; asked: ${harness.asked.join(" | ")}`);
  assert.match(dialog, /brew install gemini-cli/);
  assert.match(dialog, /npm install -g @google\/gemini-cli/);
});

hintTest("the dialog for a session that would not open shows them too", async () => {
  // Where a CLI that is installed but not set up arrives: dsh with no profile
  // fails here, not at detection, so this is the dialog that has to say it.
  const harness = wizardHarness({
    saved: { dsh: mockEntry("verbose-refusal") },
    consent: (message, choices) => (message.includes("could not open a session") ? undefined : choices[0]),
  });

  await connectCli(harness.ports);

  const dialog = harness.asked.find((text) => text.includes("could not open a session"));
  assert.ok(dialog, `no such dialog; asked: ${harness.asked.join(" | ")}`);
  assert.match(dialog, /dsh plugin --profile acp add/);
  // Paid for out of the same budget as everything else in that modal: a sentence
  // added without being paid for is how the parts stop adding up.
  const detail = dialog.slice(dialog.indexOf("\n") + 1);
  assert.ok(detail.length <= MAX_DETAIL_CHARS, `the modal's detail is ${detail.length} characters`);
});
