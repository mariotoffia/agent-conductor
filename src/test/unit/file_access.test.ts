import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkspaceFs, type OpenDocuments } from "../../vscode/fsProvider.js";
import type { ClientOperation, Consent } from "../../vscode/permissions.js";

/** Editor buffers, dirty or not, keyed exactly as the editor knows them. */
function buffers(open: Record<string, string> = {}): OpenDocuments & {
  readonly applied: [string, string][];
} {
  const applied: [string, string][] = [];
  return {
    get applied() {
      return applied;
    },
    text: (path) => open[path],
    replace: async (path, text) => {
      if (!(path in open)) return false;
      open[path] = text;
      applied.push([path, text]);
      return true;
    },
  };
}

/** Records what consent was asked for; answers with a fixed verdict. */
function consent(verdict: boolean): Consent & { readonly asked: [ClientOperation, string][] } {
  const asked: [ClientOperation, string][] = [];
  return {
    get asked() {
      return asked;
    },
    authorize: async (operation, detail) => {
      asked.push([operation, detail]);
      return verdict;
    },
    permits: () => verdict,
  };
}

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "conductor-fs-"));
}

const read = (path: string, over: Record<string, unknown> = {}) => ({
  sessionId: "s1",
  path,
  ...over,
});

test("an open buffer is served ahead of what is on disk", async () => {
  const root = await workspace();
  const file = join(root, "a.ts");
  await writeFile(file, "on disk\n");
  const documents = buffers({ [file]: "unsaved edit\n" });
  const fs = new WorkspaceFs({ roots: [root], documents, consent: consent(true) });

  const answer = await fs.readTextFile(read(file));

  assert.equal(answer.content, "unsaved edit\n");
});

test("a file nobody has open is read from disk", async () => {
  const root = await workspace();
  await writeFile(join(root, "a.ts"), "on disk\n");
  const fs = new WorkspaceFs({ roots: [root], documents: buffers(), consent: consent(true) });

  assert.equal((await fs.readTextFile(read(join(root, "a.ts")))).content, "on disk\n");
});

test("line and limit window the content the agent gets", async () => {
  const root = await workspace();
  await writeFile(join(root, "a.ts"), "one\ntwo\nthree\nfour\n");
  const fs = new WorkspaceFs({ roots: [root], documents: buffers(), consent: consent(true) });

  const answer = await fs.readTextFile(read(join(root, "a.ts"), { line: 2, limit: 2 }));

  assert.equal(answer.content, "two\nthree");
});

test("a path outside the session roots is refused, not offered for consent", async () => {
  const root = await workspace();
  const outside = await workspace();
  await writeFile(join(outside, "secrets.env"), "TOKEN=1\n");
  const guard = consent(true);
  const fs = new WorkspaceFs({ roots: [root], documents: buffers(), consent: guard });

  await assert.rejects(fs.readTextFile(read(join(outside, "secrets.env"))), /outside this session/);
  assert.deepEqual(guard.asked, [], "a path outside the roots is not a question for the user");
});

test("a symlink pointing out of the roots does not smuggle a path back in", async () => {
  const root = await workspace();
  const outside = await workspace();
  await writeFile(join(outside, "secrets.env"), "TOKEN=1\n");
  await symlink(join(outside, "secrets.env"), join(root, "innocent.txt"));
  const fs = new WorkspaceFs({ roots: [root], documents: buffers(), consent: consent(true) });

  await assert.rejects(fs.readTextFile(read(join(root, "innocent.txt"))), /outside this session/);
});

test("a relative path is refused: ACP paths are absolute", async () => {
  const root = await workspace();
  const fs = new WorkspaceFs({ roots: [root], documents: buffers(), consent: consent(true) });

  await assert.rejects(fs.readTextFile(read("a.ts")), /absolute/);
});

test("a refused operation reads nothing", async () => {
  const root = await workspace();
  await writeFile(join(root, "a.ts"), "on disk\n");
  const fs = new WorkspaceFs({ roots: [root], documents: buffers(), consent: consent(false) });

  await assert.rejects(fs.readTextFile(read(join(root, "a.ts"))), /refused/);
});

test("writing an open file goes through the editor, not around it", async () => {
  const root = await workspace();
  const file = join(root, "a.ts");
  await writeFile(file, "on disk\n");
  const documents = buffers({ [file]: "unsaved edit\n" });
  const fs = new WorkspaceFs({ roots: [root], documents, consent: consent(true) });

  await fs.writeTextFile({ sessionId: "s1", path: file, content: "from the agent\n" });

  assert.deepEqual(documents.applied, [[file, "from the agent\n"]]);
  assert.equal(await readFile(file, "utf8"), "on disk\n", "the editor owns the pending change");
});

test("writing a closed file creates it, and its directory, on disk", async () => {
  const root = await workspace();
  const file = join(root, "new", "nested", "a.ts");
  const fs = new WorkspaceFs({ roots: [root], documents: buffers(), consent: consent(true) });

  await fs.writeTextFile({ sessionId: "s1", path: file, content: "created\n" });

  assert.equal(await readFile(file, "utf8"), "created\n");
});

test("a write outside the roots never reaches the disk", async () => {
  const root = await workspace();
  const outside = await workspace();
  const fs = new WorkspaceFs({ roots: [root], documents: buffers(), consent: consent(true) });

  await assert.rejects(
    fs.writeTextFile({ sessionId: "s1", path: join(outside, "a.ts"), content: "x" }),
    /outside this session/,
  );
  await assert.rejects(readFile(join(outside, "a.ts"), "utf8"));
});

test("an additional root is a root too", async () => {
  const root = await workspace();
  const extra = await workspace();
  await mkdir(join(extra, "sub"), { recursive: true });
  await writeFile(join(extra, "sub", "a.ts"), "shared\n");
  const fs = new WorkspaceFs({ roots: [root, extra], documents: buffers(), consent: consent(true) });

  assert.equal((await fs.readTextFile(read(join(extra, "sub", "a.ts")))).content, "shared\n");
});

test("a buffer the editor knows under an uncanonical path is still served first", async () => {
  const root = await workspace();
  const file = join(root, "a.ts");
  await writeFile(file, "on disk\n");
  // What the editor reports for a workspace reached through a symlink.
  const linkedRoot = join(await workspace(), "link");
  await symlink(root, linkedRoot);
  const documents = buffers({ [join(linkedRoot, "a.ts")]: "unsaved edit\n" });
  const fs = new WorkspaceFs({ roots: [root], documents, consent: consent(true) });

  const answer = await fs.readTextFile(read(join(linkedRoot, "a.ts")));

  assert.equal(answer.content, "unsaved edit\n");
});

test("consent is asked for under the operation the acp method authorizes", async () => {
  const root = await workspace();
  await writeFile(join(root, "a.ts"), "on disk\n");
  const guard = consent(true);
  const fs = new WorkspaceFs({ roots: [root], documents: buffers(), consent: guard });

  await fs.readTextFile(read(join(root, "a.ts")));
  await fs.writeTextFile({ sessionId: "s1", path: join(root, "a.ts"), content: "x" });

  assert.deepEqual(
    guard.asked.map(([operation]) => operation),
    ["fs.read", "fs.write"],
  );
});
