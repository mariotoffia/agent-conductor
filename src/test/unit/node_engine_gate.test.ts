import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * The Node the toolchain will actually run on, checked before anything installs.
 *
 * npm reports `engines` as a warning and installs anyway, so the declaration
 * alone gates nothing. `make doctor` runs this script, and `make install`
 * depends on `doctor` — so an unsupported Node stops the build rather than
 * producing a dependency tree that cannot run.
 *
 * The range lives in `package.json` and nowhere else. A second copy in the
 * Makefile would be a copy that drifts, and the drift would only ever show as
 * the gate being wider than the declaration.
 */

const root = fileURLToPath(new URL("../../..", import.meta.url));
const script = fileURLToPath(new URL("../../../scripts/check-node.mjs", import.meta.url));

function check(version: string, range?: string): { status: number; said: string } {
  const run = spawnSync(process.execPath, [script, version, ...(range ? [range] : [])], {
    encoding: "utf8",
    cwd: root,
  });
  return { status: run.status ?? 1, said: `${run.stdout}${run.stderr}` };
}

function declaredRange(): string {
  const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
    engines?: Record<string, string>;
  };
  return manifest.engines?.node ?? "";
}

test("the manifest declares which Node versions this extension is built on", () => {
  assert.equal(declaredRange(), "^20.19.0 || ^22.13.0 || >=24");
});

test("a Node inside the declared range is accepted", () => {
  for (const version of ["20.19.0", "20.19.5", "20.20.1", "22.13.0", "22.14.2", "24.0.0", "25.3.1"]) {
    assert.equal(check(version).status, 0, `${version} should be supported`);
  }
});

test("a Node the declared range excludes is refused, and says what it wanted", () => {
  // The three that matter: below every clause, and the two versions inside a
  // supported major but before the minor the range starts at — the ones a
  // major-only check would wave through.
  for (const version of ["18.20.4", "20.18.3", "22.12.0", "21.7.3", "23.11.0"]) {
    const outcome = check(version);
    assert.equal(outcome.status, 1, `${version} should be refused`);
    assert.match(outcome.said, /node \^20\.19\.0 \|\| \^22\.13\.0 \|\| >=24 required/);
    assert.match(outcome.said, new RegExp(`have ${version.replace(/\./g, "\\.")}`));
  }
});

test("a version written the way `node -v` prints it is read, not refused", () => {
  // What somebody checking by hand will paste.
  assert.equal(check("v24.1.0").status, 0);
  assert.equal(check("v20.18.3").status, 1);
});

test("something that is not a version at all is refused as one", () => {
  for (const junk of ["", "latest", "20", "20.x"]) {
    const outcome = check(junk);
    assert.equal(outcome.status, 1, `"${junk}" is not a version`);
    assert.match(outcome.said, /cannot read the node version/i);
  }
});

test("the running Node is what the check reads when nothing is given", () => {
  const implied = spawnSync(process.execPath, [script], { encoding: "utf8", cwd: root });
  const spelled = check(process.versions.node);
  // The same verdict either way, whichever Node this happens to be running on.
  // Asserting that the running one is supported would measure the machine
  // rather than the defaulting this is about, and say nothing when it failed.
  assert.equal(implied.status ?? 1, spelled.status, `${implied.stdout}${implied.stderr}`);
});

test("an unreadable clause is refused even when an earlier one already matched", () => {
  // The hole a short-circuit leaves: the first clause admits this Node, so a
  // check that stopped there would never look at the second — and the range
  // would have been widened by something nothing ever read.
  const outcome = check("20.19.0", "^20.19.0 || 22.x");

  assert.equal(outcome.status, 1);
  assert.match(outcome.said, /cannot read the node range/i);
  assert.match(outcome.said, /22\.x/);
});

test("a range clause the check cannot read is refused rather than skipped", () => {
  // The failure this exists to prevent: a range rewritten into a form the parser
  // does not understand, silently matching nothing and passing everything. So an
  // unreadable clause is an error about the range, not a verdict about the Node.
  const outcome = check("24.0.0", "20.x || ~22.13");

  assert.equal(outcome.status, 1);
  assert.match(outcome.said, /cannot read the node range/i);
  assert.match(outcome.said, /20\.x/);
});

test("the range cannot be set from the environment", () => {
  // A gate that reads an ambient variable is one a whole build can switch off
  // without anything in the Makefile changing to say so.
  const run = spawnSync(process.execPath, [script, "18.0.0"], {
    encoding: "utf8",
    cwd: root,
    env: { ...process.env, AGENT_CONDUCTOR_NODE_RANGE: ">=0" },
  });

  assert.equal(run.status, 1, "an environment variable widened the declared range");
  assert.match(`${run.stdout}${run.stderr}`, /required \(have 18\.0\.0\)/);
});
