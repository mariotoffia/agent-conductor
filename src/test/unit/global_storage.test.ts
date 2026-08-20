import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileStorage } from "../../vscode/config.js";

const directory = (): Promise<string> => mkdtemp(join(tmpdir(), "conductor-store-"));

test("a value written under a name is read back", async () => {
  const home = await directory();
  const storage = fileStorage(join(home, "globalStorage"));

  await storage.writeAtomic("acp-registry.json", '{"version":"1"}');

  assert.equal(await storage.read("acp-registry.json"), '{"version":"1"}');
});

test("a name nothing was written under reads as absent, not as a failure", async () => {
  const storage = fileStorage(await directory());

  assert.equal(await storage.read("acp-registry.json"), undefined);
});

test("a replacement leaves the whole new value and nothing half-written", async () => {
  const home = await directory();
  const storage = fileStorage(home);

  await storage.writeAtomic("acp-registry.json", "first");
  await storage.writeAtomic("acp-registry.json", "second");

  assert.equal(await storage.read("acp-registry.json"), "second");
  assert.deepEqual(await readdir(home), ["acp-registry.json"], "a torn write must not survive");
});

test("an absolute key is the file it names: the workspace settings channel writes those", async () => {
  const home = await directory();
  const elsewhere = join(await directory(), "settings.json");
  const storage = fileStorage(home);

  await storage.writeAtomic(elsewhere, "{}");

  assert.equal(await readFile(elsewhere, "utf8"), "{}");
});

test("a relative key cannot climb out of the storage directory", async () => {
  const home = await directory();
  const outside = join(home, "..", "escaped.json");
  await writeFile(outside, "untouched");
  const storage = fileStorage(join(home, "globalStorage"));

  await assert.rejects(storage.writeAtomic("../../escaped.json", "overwritten"), /outside/);

  assert.equal(await readFile(outside, "utf8"), "untouched");
});

test("two writes to one name in flight together do not trip over each other", async () => {
  const home = await directory();
  const storage = fileStorage(home);

  await Promise.all([
    storage.writeAtomic("acp-registry.json", "first"),
    storage.writeAtomic("acp-registry.json", "second"),
  ]);

  // Either value may win; neither write may fail, and no scratch file may remain.
  assert.ok(["first", "second"].includes((await storage.read("acp-registry.json")) ?? ""));
  assert.deepEqual(await readdir(home), ["acp-registry.json"]);
});
