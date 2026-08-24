import assert from "node:assert/strict";
import test from "node:test";
import {
  openProbeSession,
  resolveRuntime,
  smokeVerdict,
  type ResolvedRuntime,
} from "../../core/index.js";
import { executable, mockRuntime } from "../participant-fixtures.js";

/**
 * The Smoke Test tolerates the quirks a real CLI wraps its answer in
 * (UBIQUITOUS: Smoke Test). Copilot answers "OK" — after printing an
 * informational banner, as a chunk of its own, fused with no line ending —
 * and a rule that refuses that refuses a healthy connection.
 *
 * What still counts as the answer is a segment of its own: a line, or a chunk
 * of the Agent's stream. Words fused onto the answer inside one segment are a
 * reply that did not follow the instruction, and stay refused.
 */

const quirkTest = (name: string, fn: () => Promise<void>) => test(name, { timeout: 20_000 }, fn);

async function approved(mode: string): Promise<ResolvedRuntime> {
  const spec = mockRuntime(mode);
  const untrusted = await resolveRuntime(spec, { executable });
  return resolveRuntime(spec, { executable, trust: { fingerprint: untrusted.fingerprint } });
}

async function smokeOf(mode: string): Promise<{ ok: boolean; reply: string }> {
  const probe = await openProbeSession({ runtime: await approved(mode) });
  try {
    return await probe.smoke();
  } finally {
    await probe.close();
  }
}

quirkTest("a banner fused before the answer chunk is a quirk, not a failure", async () => {
  const smoke = await smokeOf("banner-then-ok");
  assert.equal(smoke.ok, true, `refused: "${smoke.reply}"`);
  assert.match(smoke.reply, /Disabled tools/, "the report still shows everything that was said");
});

quirkTest("a banner above the answer on its own line is a quirk too", async () => {
  const smoke = await smokeOf("banner-line-ok");
  assert.equal(smoke.ok, true, `refused: "${smoke.reply}"`);
});

quirkTest("an answer split across chunks is still the answer", async () => {
  const smoke = await smokeOf("split-ok");
  assert.equal(smoke.ok, true, `refused: "${smoke.reply}"`);
});

quirkTest("prose instead of the answer is still refused", async () => {
  const smoke = await smokeOf("chatty");
  assert.equal(smoke.ok, false);
});

quirkTest("the verdict accepts only a segment that is the answer and nothing else", async () => {
  // The segment rule directly, so each boundary is pinned falsifiably: a chunk
  // boundary isolates the answer, a line ending isolates it, and words fused
  // onto it inside one segment do not.
  assert.equal(smokeVerdict("banner OK", ["banner OK"]), false, "fused words are not the answer");
  assert.equal(smokeVerdict("bannerOK", ["banner", "OK"]), true, "its own chunk is");
  assert.equal(smokeVerdict("banner\nOK", ["banner\nOK"]), true, "its own line is");
  assert.equal(smokeVerdict("OKjunk", ["OK", "junk"]), false, "junk fused after the answer is not");
  assert.equal(smokeVerdict("OK\nlater banner", ["OK\nlater banner"]), true, "a trailing line is noise");
  assert.equal(smokeVerdict("OK", ["O", "K"]), true, "chunking cannot cut the answer apart");
  assert.equal(smokeVerdict("", []), false, "silence is not the answer");
});
