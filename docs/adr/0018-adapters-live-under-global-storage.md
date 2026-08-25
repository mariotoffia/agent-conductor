# ADR-0018: Adapters live under global storage, and a CLI can be disconnected

- Status: accepted
- Date: 2026-08-25
- Supersedes / superseded by: —

## Context

A CLI that does not speak ACP is used through an Adapter — a small npm package
that wraps it (ADR-0001). The connection wizard installs one, at the exact
version the catalog pins, in a terminal the user watches. Until now that install
was `npm install --global`, which put this Client's pinned dependency into the
directory every other globally installed program shares.

Three things were wrong with that, and one question kept coming back.

The question first: if the extension needs these packages, why not ship them
inside the extension file, so nobody installs anything? Two of the three
Adapters depend on the vendors' own products — `@agentclientprotocol/codex-acp`
depends on `@openai/codex`, and `claude-agent-acp` on
`@anthropic-ai/claude-agent-sdk`. Bundling them means redistributing another
company's shipped CLI inside a VSIX under this publisher's name, and answering
that licensing question again at every version bump.

Then the three:

- A global prefix needs privileges to write on some machines, and the wizard has
  no way to ask for them.
- A pin in a shared directory is not a pin. Anything else that installs the same
  package changes what a bare name resolves to, and the file the user approved
  through the wizard is replaced by one they never saw.
- Nothing could be taken away again. Connecting wrote a settings entry, a
  Runtime Trust approval and an installed package; disconnecting was a settings
  file the user had to edit by hand and an `npm` invocation they had to work out.
  A CLI could look connected long after it stopped being one.

## Decision

Adapters are installed into a directory this extension owns:
`<globalStorage>/adapters`, with `npm install --prefix`, never `--global`.
`<globalStorage>/adapters/node_modules/.bin` is prepended to the `PATH` the
executable port searches, so a bare name in a launch specification resolves to
our own copy before the machine's.

First, not last: the version there is the catalog's pin and the file the user
approved. A user who wants their own names it outright — an absolute `command`
in settings never reaches a `PATH` search at all.

Nothing about Runtime Trust changes. The bin directory is one more `PATH` entry;
what a name lands on is still resolved through symlinks and fingerprinted before
anything starts (ADR-0007), and a package runner is still refused as a launch
command, wherever it was found.

The directory's name reaches a shell, because the install runs in a terminal the
user can watch. It is quoted, and checked against an allow-list of plain path
characters first: global storage is spaces at worst, and a path with anything
else in it is refused rather than quoted and hoped for.

`Agent Conductor: Disconnect a CLI…` is the reverse of the wizard. It drops the
Runtime Trust approval, removes the settings entry from every scope that holds
it, and offers to uninstall the Adapter — the only thing on the machine this
Client put there. The approval goes first: a half-finished removal has to land
on the side that refuses to start an Agent.

## Alternatives considered

**Bundle the Adapters in the extension file.** Rejected: it redistributes the
vendors' own CLIs and SDKs under this publisher, ties every Adapter patch to an
extension release and a Marketplace review, and ships every Adapter to every
user when nobody has every CLI. It also removes one install step, not two — the
CLI an Adapter wraps is still the user's to install.

**Fetch on demand — `npx @agentclientprotocol/codex-acp@1.4.0` as the launch
command.** Rejected already, and this ADR does not reopen it: a program fetched
when a Session starts has no identity that could have been approved beforehand
(ADR-0007). `isPackageRunner` refuses it, both as typed and after symlink
resolution.

**Keep `--global` and only add Disconnect.** Rejected: it leaves the pin in a
shared directory, so uninstalling would remove a package something else on the
machine may be using, and the approval could still be for a file this Client
never installed.

**Rewrite each entry's `command` to the absolute path instead of extending
`PATH`.** Rejected as more moving parts for the same result: the wizard would
have to write a path into settings, the path would go stale if global storage
moved, and a user reading their settings would see a long generated path where
they had written nothing.

## Consequences

Installing an Adapter needs no privileges and changes nothing outside this
extension's storage. Uninstalling one is a directory this extension can remove.
The version a Session launches is the version the wizard installed.

Adapters already installed globally keep working: our directory is searched
first, and a machine that only has the global copy still finds it on `PATH`.
Nothing migrates anything — a user with a global copy who reconnects gets a
local one, and the global one is theirs to remove.

Disk use moves from one shared directory to one per user profile of VS Code.
Two profiles that connect the same CLI install the Adapter twice.

Windows is unchanged and still limited by the same thing it was before: npm
writes `.cmd` shims for package bins, and `WINDOWS_EXECUTABLE_EXTENSIONS`
deliberately excludes `.cmd` and `.bat`, because Node will not spawn them
without a shell. An Adapter that only ships a shim resolves to nothing there,
exactly as it did when the install was global. Fixing that is its own decision.

## References

- ADR-0001 — ACP as the downstream protocol; a non-ACP CLI is used through an
  Adapter.
- ADR-0007 — Runtime Trust: the identity is the file that will actually run,
  fingerprinted before anything starts, and nothing is fetched at session start.
- `UBIQUITOUS.md` — **Adapter**, **Registry**, **Runtime Trust**.
