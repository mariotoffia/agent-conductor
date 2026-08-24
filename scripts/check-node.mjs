// Refuses a Node this extension is not built on, before anything installs.
//   node scripts/check-node.mjs [version]
//
// `engines` in package.json is advice: npm prints a warning and installs anyway,
// so the declaration on its own gates nothing. `make doctor` runs this, and
// `make install` depends on `doctor`, which is what turns the declaration into a
// refusal rather than a line in a log nobody reads.
//
// The range is read from package.json and written down nowhere else. A second
// copy in the Makefile would be one that drifts, and drift here is only ever in
// the direction of the gate being wider than the declaration.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
);
// Both are arguments so that neither can be set from outside a run: a range read
// from the environment would let `SOMETHING=">=0" make install` switch the gate
// off for a whole build, with nothing in the Makefile changed to say so. A test
// pointing this at a range the parser cannot read passes it here instead.
const version = process.argv[2] ?? process.versions.node;
const range = process.argv[3] ?? manifest.engines?.node ?? "";

/**
 * `1.2.3` as numbers. Anything else is not a version.
 *
 * A leading `v` is accepted because `node -v` prints one, and someone checking
 * by hand will paste what they were shown.
 *
 * A pre-release tag is dropped rather than ordered: `20.19.0-rc1` counts as
 * `20.19.0`, though semver puts it *below* that release and outside the range.
 * So this is a shade wider than the declaration, deliberately — every clause is
 * a lower bound on a Node somebody installs to build with, and nobody builds
 * this on a release candidate. Tighten it here if that ever stops being true.
 */
function parts(text) {
  const matched = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  return matched ? matched.slice(1, 4).map(Number) : undefined;
}

/** Lexicographic `[major, minor, patch]` compare: is `have` >= `want`? */
function atLeast(have, want) {
  for (let at = 0; at < want.length; at += 1) {
    if (have[at] !== want[at]) return have[at] > want[at];
  }
  return true;
}

/**
 * Whether one clause admits this version.
 *
 * Only the two forms the declared range uses are understood, and an unreadable
 * clause throws rather than returning `false`. A parser that quietly skipped
 * what it did not recognise would answer "no clause matched" for a range that
 * was rewritten — and a check that cannot fail reports success forever, so the
 * failure has to be about the range rather than about the Node.
 */
function admits(clause, have) {
  const caret = /^\^(\d+\.\d+\.\d+)$/.exec(clause);
  if (caret) {
    const want = parts(caret[1]);
    return have[0] === want[0] && atLeast(have, want);
  }
  const floor = /^>=(\d+)$/.exec(clause);
  if (floor) return have[0] >= Number(floor[1]);
  throw new Error(`cannot read the node range clause "${clause}" in "${range}"`);
}

const have = parts(version);
if (!have) {
  console.error(`cannot read the node version "${version}"`);
  process.exit(1);
}

const clauses = range.split("||").map((clause) => clause.trim()).filter(Boolean);
if (clauses.length === 0) {
  console.error("cannot read the node range: package.json declares no engines.node");
  process.exit(1);
}

let supported;
try {
  // `map`, not `some`: every clause is read, including the ones after one that
  // already matched. A short-circuit would leave an unreadable clause unseen for
  // as long as some earlier clause kept saying yes — which is the range being
  // widened by something nothing ever looked at.
  supported = clauses.map((clause) => admits(clause, have)).includes(true);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

if (!supported) {
  console.error(`node ${range} required (have ${version})`);
  process.exit(1);
}
