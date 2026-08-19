import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cacheRegistry,
  isNewerVersion,
  parseRegistry,
  readCachedRegistry,
  registryAdapterVersion,
  type StoragePort,
} from "../../core/index.js";
import { registryText, storage } from "../runtime-fixtures.js";

test("a registry document is accepted with its unknown fields intact", () => {
  const document = parseRegistry(registryText);

  assert.equal(document.agents.length, 2);
  assert.equal(document.agents[0]?.distribution.npx?.package, "@agentclientprotocol/claude-agent-acp@0.71.0");
  assert.equal((document.agents[0] as { description?: string }).description, "ACP adapter for Claude Code");
});

test("anything that is not a registry document is rejected before it is cached", async () => {
  assert.throws(() => parseRegistry("not json"), SyntaxError);
  assert.throws(() => parseRegistry("{}"), /agents/);
  assert.throws(() => parseRegistry(JSON.stringify({ version: "1.0.0", agents: [{ id: "x" }] })), /name/);

  const store = storage();
  await assert.rejects(cacheRegistry(store, "{}", 1_000));
  assert.deepEqual(store.writes, [], "a rejected document must leave the offline copy alone");
});

test("a cached document survives a restart and goes stale after its lifetime", async () => {
  const store = storage();
  const fresh = await cacheRegistry(store, registryText, 1_000);
  assert.equal(fresh.stale, false);
  assert.equal(store.writes.length, 1);

  const reread = await readCachedRegistry(store, 1_000 + 60_000, 3_600_000);
  assert.equal(reread?.stale, false);
  assert.equal(reread?.document.agents.length, 2);

  const expired = await readCachedRegistry(store, 1_000 + 3_600_001, 3_600_000);
  assert.equal(expired?.stale, true, "a stale document stays usable — it is the offline copy");
});

test("a cache stamped in the future is stale rather than fresh forever", async () => {
  const store = storage();
  await cacheRegistry(store, registryText, 4_000_000_000_000);

  assert.equal((await readCachedRegistry(store, 1_000))?.stale, true);
});

test("an unreadable cache reads as absent rather than failing the extension", async () => {
  assert.equal(await readCachedRegistry(storage(), 1_000), undefined);
  assert.equal(await readCachedRegistry(storage("}}not json"), 1_000), undefined);
  assert.equal(await readCachedRegistry(storage(JSON.stringify({ fetchedAt: 1, document: {} })), 1_000), undefined);

  const unreadable: StoragePort = {
    async read() { throw new Error("global storage is gone"); },
    async writeAtomic() {},
  };
  assert.equal(await readCachedRegistry(unreadable, 1_000), undefined);
});

test("an oversized document is refused on the way in and on the way back out", async () => {
  const oversized = "x".repeat(5_000_000);
  assert.throws(() => parseRegistry(oversized), /too large/);

  // The same bound applies at startup: a cache written out of band is still input.
  const stuffed = storage(JSON.stringify({ fetchedAt: 1_000, document: { version: oversized, agents: [] } }));
  assert.equal(await readCachedRegistry(stuffed, 1_000), undefined);
});

test("a registry entry names an exact version of the package the catalog expects", async () => {
  const snapshot = await cacheRegistry(storage(), registryText, 1_000);
  const pkg = "@agentclientprotocol/claude-agent-acp";

  assert.equal(registryAdapterVersion(snapshot, "claude-acp", pkg), "0.71.0");
  assert.equal(registryAdapterVersion(snapshot, "claude-acp", "@attacker/claude-agent-acp"), undefined);
  assert.equal(registryAdapterVersion(snapshot, "amp-acp", pkg), undefined, "no npx distribution");
  assert.equal(registryAdapterVersion(undefined, "claude-acp", pkg), undefined, "offline");
});

test("version comparison answers no rather than guessing when a version is malformed", () => {
  assert.equal(isNewerVersion("0.71.0", "0.70.0"), true);
  assert.equal(isNewerVersion("1.0.0", "0.70.0"), true);
  assert.equal(isNewerVersion("0.0.1", "0.70.0"), false);
  assert.equal(isNewerVersion("0.70.0", "0.70.0"), false);
  assert.equal(isNewerVersion("0.70.0-beta", "0.70.0"), false, "a prerelease is not a later release");
  assert.equal(isNewerVersion("0.71.0-rc.1", "0.70.0"), true);

  // Anything it cannot read is not evidence of being newer, whichever part is bad.
  for (const malformed of ["1.2.x", "x.2.3", "1.2", "", "latest", "9999999999999999999999.0.0-"]) {
    assert.equal(isNewerVersion(malformed, "0.70.0"), false, `"${malformed}" must not count as newer`);
  }
});
