import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { executablePort, WINDOWS_EXECUTABLE_EXTENSIONS } from "../../core/executables.js";

/**
 * What a launch command really lands on, and what that file contains — the two
 * things Runtime Trust is bound to (ADR-0007). Nothing here executes anything.
 */

const dir = (): Promise<string> => mkdtemp(join(tmpdir(), "conductor-exe-"));

async function program(home: string, name: string, body = "#!/bin/sh\nexit 0\n"): Promise<string> {
  const target = join(home, name);
  await writeFile(target, body);
  await chmod(target, 0o755);
  return target;
}

test("an absolute path to a real executable resolves, with a digest of its contents", async () => {
  const home = await dir();
  const target = await program(home, "agent");

  const found = await executablePort().resolve(target);

  assert.equal(found?.path, await realpath(target));
  assert.match(found?.digest ?? "", /^[0-9a-f]{64}$/);
});

test("two files with the same contents share a digest; one changed byte does not", async () => {
  const home = await dir();
  const same = await executablePort().resolve(await program(home, "a"));
  const also = await executablePort().resolve(await program(home, "b"));
  const other = await executablePort().resolve(await program(home, "c", "#!/bin/sh\nexit 1\n"));

  assert.equal(same?.digest, also?.digest);
  assert.notEqual(same?.digest, other?.digest);
});

test("a bare name is looked up on the supplied PATH, in order", async () => {
  const first = await dir();
  const second = await dir();
  await program(first, "agent", "#!/bin/sh\necho first\n");
  await program(second, "agent", "#!/bin/sh\necho second\n");

  const found = await executablePort({ path: [first, second].join(delimiter) }).resolve("agent");

  assert.equal(found?.path, await realpath(join(first, "agent")));
});

test("a symlink resolves to the file that would actually run", async () => {
  const home = await dir();
  const real = await program(home, "real-agent");
  const link = join(home, "agent");
  await symlink(real, link);

  const found = await executablePort({ path: home }).resolve("agent");

  assert.equal(found?.path, await realpath(real));
});

test("a name nothing on PATH provides resolves to nothing", async () => {
  assert.equal(await executablePort({ path: await dir() }).resolve("agent"), undefined);
});

test("an empty command resolves to nothing rather than to the search path itself", async () => {
  assert.equal(await executablePort({ path: await dir() }).resolve("   "), undefined);
});

test("a directory is not an executable, whatever its name is", async () => {
  const home = await dir();
  await mkdir(join(home, "agent"));

  assert.equal(await executablePort({ path: home }).resolve("agent"), undefined);
});

test("a file without the execute bit is not a launch command", { skip: process.platform === "win32" }, async () => {
  const home = await dir();
  await writeFile(join(home, "agent"), "#!/bin/sh\n");

  assert.equal(await executablePort({ path: home }).resolve("agent"), undefined);
});

test("an artifact too large to hash still resolves, bound to its path alone", async () => {
  const home = await dir();
  const target = await program(home, "agent", "x".repeat(4_096));

  const found = await executablePort({ maxDigestBytes: 16 }).resolve(target);

  // Not a failure: `ResolvedRuntime.artifactVerified` reports the narrower bind.
  assert.equal(found?.path, await realpath(target));
  assert.equal(found?.digest, undefined);
});

test("no shell wrapper is offered as a launch command on Windows", () => {
  // Node refuses to spawn these without a shell, and argv from settings must
  // never reach one.
  assert.deepEqual(
    WINDOWS_EXECUTABLE_EXTENSIONS.filter((extension) => [".cmd", ".bat"].includes(extension)),
    [],
  );
});
