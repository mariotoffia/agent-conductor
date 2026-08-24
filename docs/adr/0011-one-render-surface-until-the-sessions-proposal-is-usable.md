# ADR-0011: One render surface, until the sessions proposal can be built and tested here

- Status: accepted
- Date: 2026-08-24
- Supersedes: the second-build-channel part of ADR-0002

## Context

ADR-0002 settled two things. The Marketplace build renders through a stable chat
participant, and one surface-neutral render map feeds every surface. Both hold.

It also promised a second build channel: a sideloaded extension file, from a
generated manifest, turning on `chatSessionsProvider` and
`chatParticipantAdditions` for a better session UI. That half was never built.
What existed was a script that copied `package.json`, added
`enabledApiProposals: ["chatSessionsProvider", "chatParticipantAdditions"]`,
packaged, and put the original back. No provider was registered, and the manifest
carried none of the `chatSessions` contribution the proposal requires. The second
artifact `make release` produced was therefore the first one with two extra words
in its manifest, and `make release` shipped it as though it were a product.

Three things have to exist before that half can be finished, and none of them do:

- **Declarations to compile against.** `@types/vscode` ships the stable API only.
  A proposed API needs its `vscode.proposed.*.d.ts` fetched for the exact VS Code
  version being targeted, and nothing in this toolchain fetches one. TypeScript
  `strict` is on, so a provider cannot be written at all without them.
- **A host that would run it.** The extension-host gate launches stable VS Code
  without `--enable-proposed-api`. A provider registered behind a proposal would
  be unreachable there, so "render parity for every Update variant" would be a
  claim no gate could check.
- **A proposal that stays still.** These declarations are versioned and change
  without notice between VS Code releases; the version pin ADR-0002 accepted as
  the price is a pin that has to be chased.

## Decision

The extension has one render surface: the stable chat participant and the
sessions tree. The render map stays surface-neutral, because that is what makes a
second sink a later addition rather than a rewrite — but there is one sink today,
and the code says so.

**A manifest may only ask VS Code for an API proposal this extension implements.**
It implements none, so `make test` holds that exactly, in two halves: the
committed manifest declares no proposal, and nothing else in the repository
writes that field either. The second half is not redundant — a build step that
rewrites the manifest on its way to `vsce` declares just as effectively and
leaves the committed file looking innocent — and it reads what git says the
repository is made of rather than a list of the files that build it today.
A list would be a gate blind to the next file added, which is open by default.
Documentation is not a build input, which is what lets this ADR name the field.

Neither half is a heuristic, and neither tries to judge whether some provider is
real. Reviving a proposed-API build channel takes a new ADR, and this check
changes with it — which is the point at which someone has to say what counts as
a provider being there.

There is no `package-rich` target and no manifest generator. `make release` builds
one extension file.

## Alternatives considered

**Finish the rich build now.** It needs a per-version proposed-declaration fetch,
a second VS Code in the gate started with proposals enabled, and a provider whose
parity tests only ever run there. That is a build channel's worth of work for a UI
improvement, and it was not what this task was scoped to buy.

**Keep the target, drop it from `release`.** The generator would survive as a
thing that can be run, still producing a manifest that lies. A target nobody runs
rots into a target somebody runs.

**Keep shipping the second artifact.** It is an extension file whose only claim is
false, and `vsce publish` refuses proposals anyway — so the one channel it could
reach is the one where a user sideloads it expecting the better UI.

## Consequences

Tool-call and diff rendering stay as good as a stable chat stream can draw them,
for everyone, with no better build to point at. That was already true; it is now
also what the repository says.

Reviving the second channel means a new ADR, and its first task is the fetch step
for the proposed declarations — because until those exist, nothing about the
provider can be typechecked, and the gate above will refuse the manifest.

`ARCHITECTURE.md` no longer lists a proposed-API provider in the UI layer.

## References

ADR-0002 · ADR-0003 (TypeScript `strict`, the core seam) ·
`ARCHITECTURE.md §System` · code.visualstudio.com/api/advanced-topics/using-proposed-api
