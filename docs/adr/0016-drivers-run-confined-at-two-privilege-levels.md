# ADR-0016: Drivers run confined in a host process, at two privilege levels

- Status: proposed
- Date: 2026-08-25
- Supersedes / superseded by: —

## Context

ADR-0015 makes a Driver a unit of code that extends the Kernel. The product owner
decided that Drivers are real code, that a user may install one, and that a
running Agent may add one at runtime — an Agent writing a batching heuristic or a
result parser for a job it is in the middle of.

Code an Agent wrote is code nobody reviewed. Code a user installed is code that
may have been edited since they read it. Neither may sit in the extension host,
which holds `SecretStorage`, the VS Code API, every live Agent process, and the
Orchestrator's own limits.

Node offers nothing in-process that helps. `vm` is documented as not a security
mechanism, and `worker_threads` shares the process's authority. The only boundary
available is a separate operating-system process holding only what we hand it.

This repository has built that boundary once already. The Shim is a separate
process, framed one JSON object per line, authorised by a capability that lists
the methods it may call, bounded as bytes arrive rather than once a frame is
whole, and revoked by withdrawal rather than by re-checking.

One difference decides the transport. The Shim *dials in* — an Agent starts it,
so the socket must ask who is calling. We start the Driver Host ourselves.

## Decision

**Drivers run in a Driver Host: a process this extension spawns, never in the
extension host.**

**stdio, one JSON object per line, JSON-RPC in both directions.** Not a socket.
Almost all of `src/core/ipc.ts` exists because its peer dials in — a `0700`
directory, a named-pipe branch for Windows, a handshake, per-connection limits.
None of it applies to a process we started and hold the handle to. `readFrame`
and `MAX_FRAME_BYTES` are reused as they are.

**The Host is spawned with Node's permission model on**, as
`execPath --permission --allow-fs-read=<granted roots> host.cjs`, with
`ELECTRON_RUN_AS_NODE=1` so the extension host's Electron behaves as Node.

**The Host's first line is its confinement report**, before anything else —
mirroring the Shim, whose first line is its capability and nothing else. If
`process.permission` is inactive the Kernel loads built-in Drivers only, and says
why. Unlike a Suppression Capability this evidence is a boolean the Host can
actually produce, so it may gate; ADR-0014's lesson is about proof that cannot be
gathered, not about proof that can.

**Two Hosts, one per privilege level.** The same binary, spawned twice:

| Host | Drivers | `--allow-fs-read` |
|---|---|---|
| trusted | built-in and human-approved | the granted roots |
| ephemeral | agent-authored, unprompted | nothing |

A shared heap is the one leak in a single Host: agent-authored code beside a
Driver that was granted roots. Splitting by privilege closes it with one extra
spawn and no second code path. Split further only when a real Driver needs a root
another approved Driver must not see.

**`ctx` is the whole syscall surface.** Four calls:

| Call | Capability | Note |
|---|---|---|
| `ctx.ask(preset, prompt)` | `ask` | the Kernel spawns through the Orchestrator; every limit applies. A Driver never holds a Session. |
| `ctx.read(path)` | `fs.read` | inside granted roots — checked here *and* by Node, so neither is the only thing standing there |
| `ctx.log(message)` | — | the output channel, through the existing redaction |
| `ctx.abort` | — | an `AbortSignal`; cancelling a parent cancels its Drivers |

There is no `enqueue`: `analyse` returns Work Items, and the return value is the
enqueue. There is no durable per-Driver state until a Driver needs one.

**An agent-authored Driver runs unprompted only while it is pure and ephemeral** —
no capability, no granted root, discarded when its Work Item ends. Nothing is
fingerprinted, approved or written down, because nothing outlives the item.
Persisting one, or granting it any capability, is a human approval, unless the
user has switched auto-approval on.

**Driver Trust mirrors Runtime Trust**: the realpath after symlinks and a digest
of the source, re-derived at every load and never read back from a record. Editing
an approved Driver refuses it at the next load.

**The approval dialog shows what cannot be trimmed and opens the source beside
it.** Runtime Trust's rule that nothing in the dialog is trimmed cannot hold for a
Driver, whose source is unbounded. The dialog carries the id, the Stages, the
fingerprint, the exact capabilities and roots, and the path; the source opens
read-only in the editor. That serves the rule's purpose — approving what you
cannot see is what it exists to prevent — better than a truncated modal.

**A Driver that misses its deadline faults its Host.** The Kernel restarts that
Host, fails the calls in flight, and disables the offending Driver after a
threshold. One hung Driver stalls its Host, so the remedy is the one ADR-0008
already takes with an Agent that stops responding — and it reaches one privilege
level, never both.

## What the boundary is, and what it is not

Measured on 2026-08-25 against `Visual Studio Code.app` 1.134.0 (Electron, Node
v24.18.1) and Node v26.7.0, with `--permission --allow-fs-read=<path>`:

| A Driver attempts | Result | A boundary? |
|---|---|---|
| read or write outside its granted roots | `ERR_ACCESS_DENIED` | **yes** |
| `child_process.spawn` — shell out | `ERR_ACCESS_DENIED` | **yes** |
| `worker_threads`, native addons | `ERR_ACCESS_DENIED` | **yes** |
| `require("vscode")`, reach `SecretStorage` | absent from the process | **yes** |
| spawn an Agent past the Depth Cap | it can only return Work Items | **yes** |
| `fetch`, `net.connect`, `dns.lookup` | **allowed** | **no** |
| consume CPU or memory | allowed | no |

**Node's permission model does not cover the network, and this is not a sandbox.**
The same plainness ADR-0007 applies to permission routing applies here.

The ephemeral Host stubs `net`, `dns`, `http`, `https` and `fetch` before loading
any Driver. That is defence in depth and a speed bump, not a boundary; it is worth
the ten lines because with `child_process`, `worker_threads` and addons all denied
there is no straightforward way back to a socket. What makes the gap tolerable is
the capability model rather than the stub: a Driver that runs unprompted is granted
no root at all, so the only thing it can send anywhere is the Work Item — which the
Agent that wrote it already had.

## Alternatives considered

- **Load Drivers into the extension host.** Rejected: a Driver could read
  `SecretStorage`, spawn Agents outside the Orchestrator's limits, and act as the
  extension. Driver Trust would be the only control, and an approved file edited
  afterwards runs before any fingerprint is re-checked.
- **`vm` or `worker_threads` as the boundary.** Rejected: Node documents `vm` as
  not a security mechanism, and a worker carries the process's authority.
- **A socket, reusing `ipc.ts` whole.** Rejected: its complexity is the price of a
  peer that dials in. We hold this process's handle.
- **One Host per Driver.** Rejected for now: a process, a lifecycle and a restart
  policy per enabled Driver, to separate Drivers the same user approved. Two Hosts
  buy the isolation that matters.
- **One shared Host for every Driver.** Rejected: it puts agent-authored code in
  the same heap as a Driver holding granted roots.
- **Require approval for every agent-authored Driver.** Rejected by the product
  owner: it makes unattended and scheduled runs unusable, which ADR-0017 depends on.
- **Gate the network by policy and claim it holds.** Rejected: we cannot enforce
  it, and a limit nobody can enforce is worse than a gap that is written down.

## Consequences

Agent-authored code becomes something whose reach can be stated precisely rather
than argued about: no secrets, no VS Code, no shelling out, no filesystem, and no
spawn that the Orchestrator did not make.

The network gap is real and belongs in the approval dialog and in the settings
description, not only here. A Driver granted `fs.read` over a repository can send
that repository somewhere, and only a human approval stands in front of that.

Two Host processes appear in the process tree per window with Drivers enabled, and
each is a lifecycle to start, restart and tear down. The leak-guard check in
`make test` will catch a Host that outlives its tests.

The confinement report has to be re-measured when VS Code's bundled Node changes,
because the flag is the whole boundary. `docs/CHANGELOG.md` is where that
verification is recorded, dated, per release.

## References

- ADR-0007 — agent trust and client permissions; "consent and an audit trail, not a sandbox"
- ADR-0008 — capability scope, revocation by withdrawal, terminating a process that stopped responding
- ADR-0014 — evidence that cannot be gathered must not gate for ever
- ADR-0015 — the Kernel, its Drivers, and the Applications above it
- Node permission model — `--permission`, `--allow-fs-read`, `process.permission`
- `ARCHITECTURE.md §The orchestration socket` — the framing and bounding this reuses
