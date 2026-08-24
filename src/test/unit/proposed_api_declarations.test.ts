import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * What the extension file may claim about itself.
 *
 * VS Code enables a proposed API because the manifest asks for it, and asking
 * costs nothing: a build that declares `chatSessionsProvider` with no provider
 * behind it produces an extension indistinguishable from the stable one except
 * in what it says, and the Marketplace refuses it besides. This extension
 * implements no proposal, so its manifest names none (ADR-0011).
 *
 * The committed manifest is half of it. A build step that rewrites the manifest
 * on its way to `vsce` declares just as effectively and leaves the committed
 * file looking innocent — which is how an unfinished proposed-API build came to
 * be a second release artifact with no provider in it. So no build input may
 * write that field either.
 *
 * Both halves are exact rather than heuristic. Nothing here tries to judge
 * whether some provider is real: reviving a proposed-API build channel takes a
 * new ADR, and this check changes with it.
 */

const root = fileURLToPath(new URL("../../..", import.meta.url));
const FIELD = "enabledApiProposals";

interface BuildInput {
  where: string;
  text: string;
}

/**
 * Every file the repository is made of, asked of git rather than listed here.
 *
 * A list written down is a list that goes stale: a build step added somewhere it
 * did not name would be one this check cannot see, and a gate blind to the next
 * file is open by default. Git also settles what is not an input for free —
 * `node_modules`, `dist` and `reports` are ignored, so they are never walked.
 *
 * A file git does not track is not part of anyone else's build either, so it is
 * outside what this can promise.
 */
function repositoryFiles(): string[] {
  const listed = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
  assert.equal(listed.status, 0, `git ls-files failed: ${listed.stderr}`);
  return listed.stdout.split("\0").filter((path) => path !== "");
}

/**
 * Everything that runs on the way to an extension file, and could therefore put
 * the field in the manifest without the manifest showing it.
 *
 * Three things are not build inputs. `package.json` is the one file allowed to
 * carry the field — though the commands it defines are inputs like any other, so
 * those come back as one. Markdown describes the field; this ADR and the glossary
 * both name it. And a test says what a declaration looks like, which is what the
 * self-test below is made of.
 */
function buildInputs(): BuildInput[] {
  const manifest = readManifest<{ scripts?: Record<string, string> }>();
  const testDirectory = `src/test/`;
  return [
    { where: "package.json scripts", text: JSON.stringify(manifest.scripts ?? {}) },
    ...repositoryFiles()
      .filter((path) => path !== "package.json" && !path.endsWith(".md") && !path.startsWith(testDirectory))
      .map((path) => ({ where: path, text: readFileSync(join(root, path), "utf8") })),
  ];
}

/** Read as text, so a mention counts however the declaration is written. */
function writingProposals(inputs: BuildInput[]): string[] {
  return inputs.filter((input) => input.text.includes(FIELD)).map((input) => input.where);
}

function declaredProposals(manifest: { enabledApiProposals?: string[] }): string[] {
  return manifest.enabledApiProposals ?? [];
}

function readManifest<T>(): T {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as T;
}

test("the manifest asks VS Code for no API proposal", () => {
  assert.deepEqual(declaredProposals(readManifest()), []);
});

test("no build step writes an API proposal into the manifest on its way to the package", () => {
  assert.deepEqual(writingProposals(buildInputs()), []);
});

test("both halves see a declaration when one is there", () => {
  // The gate's own self-test. Read against a repository that declares nothing,
  // either half passes whether or not it can see a declaration at all — which is
  // how the first version of this file came to be blind to a declaration written
  // across two lines.
  assert.deepEqual(declaredProposals({ enabledApiProposals: ["chatSessionsProvider"] }), ["chatSessionsProvider"]);
  assert.deepEqual(
    writingProposals([{ where: "fixture", text: `pkg.${FIELD} = [\n  "chatSessionsProvider",\n];` }]),
    ["fixture"],
  );
  assert.deepEqual(writingProposals([{ where: "fixture", text: `pkg.name = "agent-conductor";` }]), []);
  // And what is read is the repository, not a list of it. Naming the files that
  // happen to build today would pass just as well against a check that had gone
  // blind to the next one added, so what is asserted is the breadth: the build
  // front door, the bundler, a script, and configuration that names neither.
  const inputs = buildInputs().map((input) => input.where);
  for (const expected of [
    "Makefile",
    "esbuild.mjs",
    "scripts/run-unit-tests.mjs",
    "package.json scripts",
    "tsconfig.json",
    "eslint.config.mjs",
  ]) {
    assert.ok(inputs.includes(expected), `${expected} is not being read; inputs: ${inputs.length}`);
  }
  // Documentation names the field to explain it, and is not a build input.
  assert.ok(!inputs.some((where) => where.endsWith(".md")), "markdown is being read as a build input");
});
