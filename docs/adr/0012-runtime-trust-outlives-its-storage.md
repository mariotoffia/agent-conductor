# ADR-0012: Runtime Trust outlives the storage that holds it

- Status: accepted
- Date: 2026-08-24
- Supersedes / superseded by: —

## Context

Runtime Trust is what the user approved for one launch identity, and it decides
whether an Agent process is started at all (ADR-0007). It lives in VS Code's
`ExtensionContext.globalState`, which is the right home: another window reads it,
and so does the next one.

`globalState` turned out not to keep a value for as long as the window that wrote
it runs. Instrumentation inside a running extension host recorded, in one
activation, one `ExtensionContext` and one `globalStorageUri`:

```
write runtimeTrust.shimdelegate               t
wrote runtimeTrust.shimdelegate readback=yes  t+2ms
read  runtimeTrust.shimdelegate found         t+6ms    keys = wizardmock, mock, shimdelegate
read  runtimeTrust.shimdelegate MISSING       t+192ms  keys = wizardmock, mock
```

The value was written, confirmed readable, read once, and then gone from
`keys()`. The two approvals written seconds earlier were untouched, so it is the
newest key that disappears — the signature of a flush that began before the last
write landing after it. Nothing in this extension deletes trust; there is one
writer and, before this, one reader.

What that cost was not a stale display. Trust is re-derived from storage on every
spawn, so a Runtime approved a moment earlier was refused as one nobody had taken
through the wizard — advice to do the thing the user had just done. It surfaced
as an extension-host test failing about one run in three to eight, always with
that message.

## Decision

The trust store keeps what this window granted, in memory, beside what storage
holds — `src/vscode/runtimeTrust.ts`, one small module with the single writer and
the readers behind it.

**Storage is authoritative. Memory answers only where storage has nothing.**
That order is the decision, not an implementation detail: a Runtime re-approved
in another window must be read as that window left it, and this window's memory
is then the older answer. In the other order, a stale approval here would quietly
outrank a newer one made elsewhere.

Memory is committed only after storage has accepted the write. A write that
failed is one the wizard tells the user did not save, and a window that went on
treating the Runtime as approved would contradict the refusal it had just shown
them.

Memory can therefore keep an approval the user made. It can never invent one:
nothing writes to it but `record`, which is reached by the connection wizard and,
under `ExtensionMode.Test`, by the stand-in an extension-host test uses in place
of driving that wizard's dialogs.

## Alternatives considered

**Re-read, or retry, on a miss.** A miss is indistinguishable from a Runtime that
was genuinely never approved, which is the common case and must stay fast and
must stay a refusal. Retrying every one of those to catch a rare loss makes the
ordinary answer slow and the rare one still uncertain.

**Write trust somewhere of our own.** A second on-disk store to be kept in step
with the first, for a value that is already persisted correctly almost always.
The in-memory copy needs no reconciliation because it never outlives its window.

**Treat a miss as "cannot be determined" and fail differently.** It is still a
refusal — correctly, since starting an Agent on unverified trust is the one thing
this must not do. It would only change the wording, and the wording is right for
the case that actually dominates.

## Consequences

Removing that map reintroduces the failure, and it looks removable: a store that
consults memory only when storage is empty reads as a redundant cache. This ADR
is what says otherwise.

The mechanism is inferred from its signature, not proven from VS Code's own
source. The fix would mask several causes of a lost key equally well, which is
worth being plain about. One variant it does **not** cover: storage returning an
older value for the same key rather than nothing. Under "storage is
authoritative" that would still produce a spurious refusal — a narrower window
than the one measured, and left alone rather than guessed at, because preferring
memory over a value storage actually holds is the one change that could let a
window ignore what another window approved.

Nothing about the security posture moves. The authorization gate is unchanged:
the launch identity is fingerprinted and compared on every spawn, so a record
read from either place is only ever *a* trust, never a decision.

## References

ADR-0007 (Runtime Trust and client permissions) · ADR-0008 (evidence re-derived,
never recorded as a verdict) · `src/vscode/runtimeTrust.ts` ·
`src/test/unit/runtime_trust_store.test.ts`
