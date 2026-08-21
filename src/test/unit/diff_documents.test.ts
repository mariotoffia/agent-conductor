import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DiffDocuments,
  MAX_DIFF_CHARS,
  MAX_DIFFS_PER_SESSION,
} from "../../vscode/diffDocs.js";

/**
 * What the diff editor is shown is what the Agent reported, and no more of it
 * than this Client chose to keep.
 */

const diff = (path: string) => ({ path, oldText: "before\n", newText: "after\n" });

test("a recorded diff serves both sides back", () => {
  const docs = new DiffDocuments();

  const handle = docs.record("s1", diff("/w/mock.txt"));

  assert.equal(docs.content(`${handle.id}:old`), "before\n");
  assert.equal(docs.content(`${handle.id}:new`), "after\n");
  assert.equal(handle.path, "/w/mock.txt");
  assert.match(handle.title, /mock\.txt/);
});

test("the provider reads the side out of the uri it is asked for", () => {
  const docs = new DiffDocuments();
  const handle = docs.record("s1", diff("/w/mock.txt"));

  assert.equal(docs.provideTextDocumentContent({ query: `${handle.id}:old` }), "before\n");
  assert.equal(docs.provideTextDocumentContent({ query: `${handle.id}:new` }), "after\n");
});

test("each side is bounded, so one enormous file cannot be retained whole", () => {
  const docs = new DiffDocuments();

  const handle = docs.record("s1", {
    path: "/w/big.txt",
    oldText: "o".repeat(MAX_DIFF_CHARS * 2),
    newText: "n".repeat(MAX_DIFF_CHARS * 2),
  });

  for (const side of ["old", "new"]) {
    const kept = docs.content(`${handle.id}:${side}`);
    assert.ok(kept.length < MAX_DIFF_CHARS * 2, `${side} side was retained whole`);
    assert.match(kept, /truncated by Agent Conductor/);
  }
});

test("a session keeps only its most recent diffs", () => {
  const docs = new DiffDocuments();

  const handles = Array.from({ length: MAX_DIFFS_PER_SESSION + 5 }, (_unused, at) =>
    docs.record("s1", diff(`/w/file-${at}.txt`)));

  assert.equal(docs.size, MAX_DIFFS_PER_SESSION);
  assert.equal(docs.entry(handles[0].id), undefined, "the oldest diff should have been dropped");
  assert.ok(docs.entry(handles[handles.length - 1].id), "the newest diff must still be there");
});

test("a dropped diff says so rather than rendering as an empty file", () => {
  const docs = new DiffDocuments();
  const handle = docs.record("s1", diff("/w/mock.txt"));

  docs.closeSession("s1");

  // An empty document would read as "the whole file was added".
  assert.match(docs.content(`${handle.id}:old`), /no longer available/);
  assert.match(docs.content("nonsense"), /no longer available/);
});

test("a side that is neither old nor new is not served as one", () => {
  const docs = new DiffDocuments();
  const handle = docs.record("s1", diff("/w/mock.txt"));

  // Only the two sides this client composes are answerable; anything else is
  // not a request for a document that exists.
  assert.match(docs.content(`${handle.id}:`), /no longer available/);
  assert.match(docs.content(`${handle.id}:bogus`), /no longer available/);
  assert.match(docs.content(`${handle.id}:old:new`), /no longer available/);
  assert.equal(docs.content(`${handle.id}:new`), "after\n");
});

test("closing one session leaves another session's diffs alone", () => {
  const docs = new DiffDocuments();
  const mine = docs.record("s1", diff("/w/mine.txt"));
  const theirs = docs.record("s2", diff("/w/theirs.txt"));

  docs.closeSession("s1");

  assert.equal(docs.entry(mine.id), undefined);
  assert.deepEqual(docs.entry(theirs.id)?.path, "/w/theirs.txt");
  assert.equal(docs.size, 1);
});
