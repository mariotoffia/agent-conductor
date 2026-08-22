import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test, type TestContext } from "node:test";
import { executablePort, WINDOWS_EXECUTABLE_EXTENSIONS } from "../../core/executables.js";

/**
 * What a launch command really lands on, and what that file contains — the two
 * things Runtime Trust is bound to (ADR-0007). Nothing here executes anything.
 */

/** A directory for one test, removed with it: these run on every `make test`,
 *  and one left per test is thousands in the temp directory by the weekend. */
const dir = async (t: TestContext): Promise<string> => {
  const made = await mkdtemp(join(tmpdir(), "conductor-exe-"));
  t.after(() => rm(made, { recursive: true, force: true }));
  return made;
};

async function program(home: string, name: string, body = "#!/bin/sh\nexit 0\n"): Promise<string> {
  const target = join(home, name);
  await writeFile(target, body);
  await chmod(target, 0o755);
  return target;
}

test("an absolute path to a real executable resolves, with a digest of its contents", async (t: TestContext) => {
  const home = await dir(t);
  const target = await program(home, "agent");

  const found = await executablePort().resolve(target);

  assert.equal(found?.path, await realpath(target));
  assert.match(found?.digest ?? "", /^[0-9a-f]{64}$/);
});

test("two files with the same contents share a digest; one changed byte does not", async (t: TestContext) => {
  const home = await dir(t);
  const same = await executablePort().resolve(await program(home, "a"));
  const also = await executablePort().resolve(await program(home, "b"));
  const other = await executablePort().resolve(await program(home, "c", "#!/bin/sh\nexit 1\n"));

  assert.equal(same?.digest, also?.digest);
  assert.notEqual(same?.digest, other?.digest);
});

test("a bare name is looked up on the supplied PATH, in order", async (t: TestContext) => {
  const first = await dir(t);
  const second = await dir(t);
  await program(first, "agent", "#!/bin/sh\necho first\n");
  await program(second, "agent", "#!/bin/sh\necho second\n");

  const found = await executablePort({ path: [first, second].join(delimiter) }).resolve("agent");

  assert.equal(found?.path, await realpath(join(first, "agent")));
});

test("a symlink resolves to the file that would actually run", async (t: TestContext) => {
  const home = await dir(t);
  const real = await program(home, "real-agent");
  const link = join(home, "agent");
  await symlink(real, link);

  const found = await executablePort({ path: home }).resolve("agent");

  assert.equal(found?.path, await realpath(real));
});

test("a name nothing on PATH provides resolves to nothing", async (t: TestContext) => {
  assert.equal(await executablePort({ path: await dir(t) }).resolve("agent"), undefined);
});

test("an empty command resolves to nothing rather than to the search path itself", async (t: TestContext) => {
  assert.equal(await executablePort({ path: await dir(t) }).resolve("   "), undefined);
});

test("a directory is not an executable, whatever its name is", async (t: TestContext) => {
  const home = await dir(t);
  await mkdir(join(home, "agent"));

  assert.equal(await executablePort({ path: home }).resolve("agent"), undefined);
});

test("a file without the execute bit is not a launch command", { skip: process.platform === "win32" }, async (t: TestContext) => {
  const home = await dir(t);
  await writeFile(join(home, "agent"), "#!/bin/sh\n");

  assert.equal(await executablePort({ path: home }).resolve("agent"), undefined);
});

test("an artifact too large to hash still resolves, bound to its path alone", async (t: TestContext) => {
  const home = await dir(t);
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

/**
 * The real port, over the real filesystem. Everything above it is tested with a
 * fake, and the fake cannot tell you whether a symlink is followed, whether a
 * directory passes for a program, or what a digest is taken over.
 */

test("the real port resolves a name on PATH to the file it would run", async (t) => {
  const home = await dir(t);
  const real = join(home, "real-agent");
  await writeFile(real, "#!/bin/sh\necho hi\n", { mode: 0o755 });
  await symlink(real, join(home, "linked-agent"));
  await mkdir(join(home, "a-directory"));

  const port = executablePort({ path: home });

  const found = await port.resolve("linked-agent");
  assert.equal(found?.path, await realpath(real), "a symlink resolves to what actually runs");
  assert.match(found?.digest ?? "", /^[0-9a-f]{64}$/, "and the digest is over that file");
  assert.equal(await port.resolve("a-directory"), undefined, "a directory is not a program");
  assert.equal(await port.resolve("not-here-at-all"), undefined);
});

test("the real port gives up the digest rather than reading something huge", async (t) => {
  const home = await dir(t);
  const big = join(home, "big-agent");
  await writeFile(big, "x".repeat(4_096), { mode: 0o755 });

  const port = executablePort({ path: home, maxDigestBytes: 1_024 });

  const found = await port.resolve("big-agent");
  // Trust then covers the path only, which `ResolvedRuntime.artifactVerified`
  // reports — better than reading an arbitrary file into the extension host.
  assert.equal(found?.path, await realpath(big));
  assert.equal(found?.digest, undefined);
});
