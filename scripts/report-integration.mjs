// Turns one extension-host run into the few lines worth reading.
//   node scripts/report-integration.mjs <log> <exit-status>
//
// A VS Code that starts, loads an extension, logs its own diagnostics and shuts
// down writes about a hundred lines around the six that say what ran. All of it
// stays in the log; the terminal gets the count, the duration, and the failure
// when there is one.
//
// It also refuses. A gate reports two things — what ran, and that anything ran
// at all — and a run that exits zero having printed no count proved nothing
// while looking exactly like a passing branch. VS Code that could not be
// downloaded, a harness that threw before Mocha started and a suite whose output
// went nowhere all land here.
import { readFileSync } from "node:fs";

const [path, status] = process.argv.slice(2);
if (!path) {
  console.error("usage: report-integration.mjs <log> <exit-status>");
  process.exit(1);
}
const failed = Number(status ?? 1) !== 0;

let log;
try {
  log = readFileSync(path, "utf8");
} catch (error) {
  console.error(`cannot read ${path}: ${error.message}`);
  process.exit(1);
}

/**
 * Mocha colours its own output, and the counts are read rather than shown.
 *
 * The escape is written out rather than typed: an invisible `ESC` in a source
 * file is one a patch or an editor can drop without anything looking different,
 * and this regex silently stops matching if it does — leaving the colour in
 * place, the count unreadable, and every run refused for the wrong reason.
 */
const plain = log.replace(/\u001b\[[0-9;]*m/g, "");
const lines = plain.split("\n");

const passing = /^\s*(\d+) passing\s*(\([^)]*\))?/m.exec(plain);
const failing = /^\s*(\d+) failing/m.exec(plain);

// Zero counts as none. The suite has a guard of its own for a run that
// registered nothing, and this is the second of two independent refusals — so
// neither being wrong on its own is enough to make an empty run green.
const ran = Number(passing?.[1] ?? 0) + Number(failing?.[1] ?? 0);
if (ran === 0) {
  // Whatever went wrong happened before Mocha said anything, so the last words
  // in the log are the closest thing to a reason there is.
  const tail = lines.filter((line) => line.trim()).slice(-8);
  console.error(`no extension-host test count in ${path} — the harness proved nothing`);
  for (const line of tail) console.error(`  ${line}`);
  process.exit(1);
}

const counts = [
  passing ? `${passing[1]} passing` : undefined,
  failing ? `${failing[1]} failing` : undefined,
].filter(Boolean).join(", ");
const duration = passing?.[2] ?? "";
console.log(`extension-host tests: ${counts} ${duration}`.trimEnd());

if (!failed && !failing) process.exit(0);

// Everything Mocha wrote from the failure list onwards: the numbered failures,
// their assertions and their stacks. The rest of the transcript stays in the log.
const at = lines.findIndex((line) => /^\s*\d+ failing/.test(line));
for (const line of at === -1 ? lines.slice(-12) : lines.slice(at + 1)) console.error(line);
console.error(`\nfull log: ${path}`);
process.exit(1);
