import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { test } from "node:test";
import {
  cacheRegistry,
  describeRefresh,
  isNewerVersion,
  MAX_REGISTRY_TEXT,
  parseRegistry,
  readCachedRegistry,
  refreshRegistry,
  registryAdapterVersion,
  type StoragePort,
} from "../../core/index.js";
import { linkish } from "../link-forms.js";
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

/**
 * Refreshing: a validated document replaces the cache, and anything that goes
 * wrong falls back visibly rather than silently. The built-in catalog always
 * works offline, so a failed refresh is a message, never a broken extension.
 */

test("a refreshed registry replaces the cached copy", async () => {
  const store = storage();

  const refreshed = await refreshRegistry(store, "https://example.test/registry.json", 5_000, {
    fetchText: async () => registryText,
  });

  assert.equal(refreshed.problem, undefined);
  assert.equal(refreshed.snapshot?.stale, false);
  assert.equal(refreshed.snapshot?.document.agents.length, 2);
  assert.equal(store.writes.length, 1);
});

test("a registry that cannot be reached falls back to the copy on disk", async () => {
  const store = storage(JSON.stringify({ fetchedAt: 1_000, document: JSON.parse(registryText) }));

  const refreshed = await refreshRegistry(store, "https://example.test/registry.json", 5_000, {
    fetchText: async () => {
      throw new Error("getaddrinfo ENOTFOUND example.test");
    },
  });

  assert.match(refreshed.problem ?? "", /ENOTFOUND/);
  assert.equal(refreshed.snapshot?.document.agents.length, 2, "the offline copy still serves");
  assert.deepEqual(store.writes, [], "a failed refresh must not touch the cache");
});

test("with no cached copy the built-in catalog is what is left", async () => {
  const store = storage();

  const refreshed = await refreshRegistry(store, "https://example.test/registry.json", 5_000, {
    fetchText: async () => {
      throw new Error("offline");
    },
  });

  assert.equal(refreshed.snapshot, undefined, "nothing may be invented to stand in for it");
  assert.match(refreshed.problem ?? "", /offline/);
});

test("a document that does not validate leaves the cached copy in place", async () => {
  const store = storage(JSON.stringify({ fetchedAt: 1_000, document: JSON.parse(registryText) }));

  const refreshed = await refreshRegistry(store, "https://example.test/registry.json", 5_000, {
    fetchText: async () => JSON.stringify({ version: "1.0.0", agents: [{ id: "x" }] }),
  });

  assert.ok(refreshed.problem, "a malformed document is a problem, not a refresh");
  assert.deepEqual(store.writes, []);
  assert.equal(refreshed.snapshot?.document.agents.length, 2);
});

test("a registry response larger than the cap is refused", async () => {
  const store = storage();

  const refreshed = await refreshRegistry(store, "https://example.test/registry.json", 5_000, {
    fetchText: async () => " ".repeat(MAX_REGISTRY_TEXT + 1),
  });

  assert.match(refreshed.problem ?? "", /too large/);
  assert.deepEqual(store.writes, []);
});

/**
 * The fetch itself, over a real socket. Everything above injects `fetchText`,
 * which is where the decisions live — but the bounded read, the size headers and
 * the status check are hand-written code on a network trust boundary, and code
 * with no test is code that has never run.
 */

async function servedBy(handler: (response: ServerResponse) => void): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = createServer((_request, response) => handler(response));
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/registry.json`,
    close: () =>
      new Promise<void>((closed) => {
        // A body the client stopped reading is still a live socket, and
        // `close` waits for those: this test would otherwise hang the file.
        server.closeAllConnections();
        server.close(() => closed());
      }),
  };
}

test("a registry served over http is validated and cached", async () => {
  const store = storage();
  const served = await servedBy((response) => {
    response.setHeader("content-type", "application/json");
    response.end(registryText);
  });

  try {
    const refreshed = await refreshRegistry(store, served.url, 5_000);

    assert.equal(refreshed.problem, undefined);
    assert.equal(refreshed.snapshot?.document.agents.length, 2);
  } finally {
    await served.close();
  }
});

test("a registry that answers with an error status is not cached", async () => {
  const store = storage();
  const served = await servedBy((response) => {
    response.statusCode = 503;
    response.end("upstream is down");
  });

  try {
    const refreshed = await refreshRegistry(store, served.url, 5_000);

    assert.match(refreshed.problem ?? "", /503/);
    assert.deepEqual(store.writes, [], "an error page is not a registry document");
  } finally {
    await served.close();
  }
});

test("a body that keeps coming is cut off at the cap", async () => {
  const store = storage();
  // Declares nothing and never ends: the shape that would otherwise be read
  // into the extension host until it ran out of memory.
  const served = await servedBy((response) => {
    const flood = () => {
      if (response.writableEnded || response.destroyed) return;
      response.write("x".repeat(64 * 1024));
      setTimeout(flood, 1).unref();
    };
    flood();
  });

  try {
    const refreshed = await refreshRegistry(store, served.url, 5_000);

    assert.match(refreshed.problem ?? "", /too large/);
    assert.deepEqual(store.writes, []);
  } finally {
    await served.close();
  }
});

test("what a refresh leaves the user with is said in words that name the state", () => {
  const cached = { fetchedAt: Date.parse("2026-08-01T00:00:00Z"), document: JSON.parse(registryText), stale: true };

  assert.match(describeRefresh({ snapshot: { ...cached, stale: false } }), /refreshed/i);
  // Both failure shapes say which one it is: an extension quietly serving a
  // month-old document reads exactly like one that just refreshed.
  const offline = describeRefresh({ snapshot: cached, problem: "getaddrinfo ENOTFOUND" });
  assert.match(offline, /unavailable/i);
  assert.match(offline, /2026-08-01/, "the date it was cached");
  assert.match(offline, /stale/i);
  assert.match(describeRefresh({ problem: "offline" }), /built-in catalog/i);
});

test("what a registry host says about itself cannot be drawn as something to click", async () => {
  // The URL is `machine` scope, so this needs a hostile or compromised host
  // rather than a repository — but what comes back is still its text, and it is
  // put in front of the user in a notification (ADR-0007).
  const said = describeRefresh({
    problem: "registry answered 503 see [the fix](https://evil.invalid/fix) or www.evil.invalid",
  });

  const clickable = linkish(said);
  assert.equal(clickable, undefined, `the refresh reported ${clickable ?? ""}: ${said}`);
});
