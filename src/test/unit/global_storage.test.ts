import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileStorage } from "../../vscode/config.js";

/** A directory for one test, removed with it. */
const directory = async (t: TestContext): Promise<string> => {
  const made = await mkdtemp(join(tmpdir(), "conductor-store-"));
  t.after(() => rm(made, { recursive: true, force: true }));
  return made;
};

test("a value written under a name is read back", async (t: TestContext) => {
  const home = await directory(t);
  const storage = fileStorage(join(home, "globalStorage"));

  await storage.writeAtomic("acp-registry.json", '{"version":"1"}');

  assert.equal(await storage.read("acp-registry.json"), '{"version":"1"}');
});

test("a name nothing was written under reads as absent, not as a failure", async (t: TestContext) => {
  const storage = fileStorage(await directory(t));

  assert.equal(await storage.read("acp-registry.json"), undefined);
});

test("a replacement leaves the whole new value and nothing half-written", async (t: TestContext) => {
  const home = await directory(t);
  const storage = fileStorage(home);

  await storage.writeAtomic("acp-registry.json", "first");
  await storage.writeAtomic("acp-registry.json", "second");

  assert.equal(await storage.read("acp-registry.json"), "second");
  assert.deepEqual(await readdir(home), ["acp-registry.json"], "a torn write must not survive");
});

test("an absolute key is the file it names: the workspace settings channel writes those", async (t: TestContext) => {
  const home = await directory(t);
  const elsewhere = join(await directory(t), "settings.json");
  const storage = fileStorage(home);

  await storage.writeAtomic(elsewhere, "{}");

  assert.equal(await readFile(elsewhere, "utf8"), "{}");
});

test("a relative key cannot climb out of the storage directory", async (t: TestContext) => {
  const home = await directory(t);
  const outside = join(home, "..", "escaped.json");
  await writeFile(outside, "untouched");
  const storage = fileStorage(join(home, "globalStorage"));

  await assert.rejects(storage.writeAtomic("../../escaped.json", "overwritten"), /outside/);

  assert.equal(await readFile(outside, "utf8"), "untouched");
});

test("two writes to one name in flight together do not trip over each other", async (t: TestContext) => {
  const home = await directory(t);
  const storage = fileStorage(home);

  await Promise.all([
    storage.writeAtomic("acp-registry.json", "first"),
    storage.writeAtomic("acp-registry.json", "second"),
  ]);

  // Either value may win; neither write may fail, and no scratch file may remain.
  assert.ok(["first", "second"].includes((await storage.read("acp-registry.json")) ?? ""));
  assert.deepEqual(await readdir(home), ["acp-registry.json"]);
});

test("a scratch file left by a crash does not accumulate under global storage", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "conductor-storage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storage = fileStorage(directory);
  // What an extension host killed mid-write leaves behind: the rename never
  // happened, so the scratch file is nobody's and nothing ever reads it. Dated
  // back, because a file in flight looks the same and only age tells them apart.
  const abandoned = join(directory, "acp-registry.json.abandoned.tmp");
  await writeFile(abandoned, "half a document", "utf8");
  const week = Date.now() - 7 * 24 * 60 * 60 * 1000;
  await utimes(abandoned, new Date(week), new Date(week));

  await storage.writeAtomic("acp-registry.json", "{}");

  const left = (await readdir(directory)).filter((entry) => entry.endsWith(".tmp"));
  assert.deepEqual(left, [], `scratch files were left behind: ${left.join(", ")}`);
});

test("a scratch file another writer is using now is not swept away", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "conductor-storage-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const inFlight = join(home, "acp-registry.json.another-writer.tmp");
  const abandoned = join(home, "acp-registry.json.long-gone.tmp");
  await writeFile(inFlight, "half of somebody else's write", "utf8");
  await writeFile(abandoned, "half of a write from last week", "utf8");
  const week = Date.now() - 7 * 24 * 60 * 60 * 1000;
  await utimes(abandoned, new Date(week), new Date(week));

  await fileStorage(home).writeAtomic("acp-registry.json", "{}");

  // Sweeping by name alone undoes the unique-per-write name that exists so a
  // second writer cannot report a failure that never happened — and two windows
  // can share one storage directory, so "mine" is not something age can tell.
  assert.equal(existsSync(inFlight), true, "a live scratch file was deleted");
  assert.equal(existsSync(abandoned), false, "an abandoned one was kept");
});
