# ADR-0015: The Kernel, its Drivers, and the Applications above it

- Status: proposed
- Date: 2026-08-25
- Supersedes / superseded by: —

## Context

Until now one prompt meant one Session on one Runtime. The product's premise is
larger than that: an overarching prompt should be split, and each part handed to
the CLI, model and effort that suits it — repository scanning to something cheap
or local, architecture to a flagship, a review to an adversarial second opinion.

Asking for that surfaces a list with no end: repository scan, architect, design,
task creation, task implementation, QA gate, judge, TDD, and whatever anyone
thinks of next. A layer with a case per entry would never be finished.

The list is endless because every entry is the same shape — *run this text on
that model*. What sits underneath is not endless. Work gets split, a target gets
chosen, the work runs, the result gets judged, results get combined. Five things.

Two more forces push on the design. A running Agent needs a way to ask for work
it cannot do well itself — an architect that wants four hundred files scanned
should not be spawning subagents one at a time, choosing their models, and
batching by hand. And the extension already owns machinery for all of this:
`Orchestrator` holds the spawn tree, the Depth Cap, the semaphore, the aggregate
count per parent, timeouts, worktrees and the cancellation cascade.

Nothing was named. `orchestrator.ts`, `ipc.ts` and `policy.ts` are collectively
"the orchestration layer" with no word for the layer, no word for what extends
it, and no word for what sits above it asking for work.

## Decision

**The Conductor is described as a Kernel, its Drivers, and the Applications
above it.** `Conductor` keeps its meaning — our orchestration layer as a whole.
These are named parts of it, and no existing term changes.

```
Applications   chat participant · cron Schedules · ACP Facade · a Subagent's
               own request, arriving over the Shim
                     │  submit work
────────────────────  ▼  ──────────────────────────────────  syscall (`ctx`)
Kernel         Work Queue · Stages · Capabilities
  (ext host)   Orchestrator — spawn tree · limits · worktrees · cancellation
               Policy · Runtime Trust · SecretStorage
                     │  ctx.ask(preset, prompt)      ▲ returns Work Items
────────────────────  ▼  ──────────────────────────  │  ── process boundary
Drivers        analyse · route · gate · reduce       │
               built-in · installed · agent-authored
──────────────────────────────────────────────────────────────────────────
Devices        Runtimes — the Agent processes, over ACP
```

**`Orchestrator` is Kernel, not an Application.** It enforces the Depth Cap, the
semaphore, the per-parent aggregate count and the cancellation cascade, and it
mints and withdraws the Session Capability. Placing it above the Kernel would
put privilege enforcement in an Application, and every other Application — and
every Driver reaching the spawn path — would then sit outside it. Its definition
in `UBIQUITOUS.md` is unchanged; it gains a layer to live in.

**There is one Loop per window**, owning one Work Queue. A prompt, a cron tick
and a Subagent's request all enter it the same way, because the alternative is
three code paths that must each be taught every limit.

**A Work Item is a `spawn_subagent` request plus provenance and state.** That
type is already written and already validated (`src/core/ipcProtocol.ts`), so a
`route` Driver's output is something the Orchestrator already accepts.

**Five Stages, four of them Drivers:**

| Stage | Owner | Contract |
|---|---|---|
| `analyse` | Driver | one Work Item in, N out. May call a model. |
| `route` | Driver | choose the Preset for one Work Item |
| `dispatch` | **Kernel** | hand to `Orchestrator` |
| `gate` | Driver | judge a finished result: accept, reject, or enqueue follow-ups |
| `reduce` | Driver | combine sibling results into one answer |

**Drivers never spawn.** A Driver returns Work Items and the Kernel dispatches
them; a Driver that needs a model calls `ctx.ask(preset, prompt)`, which the
Kernel turns into a spawn through the Orchestrator. This is what keeps the
Orchestrator the single enforcement point rather than one of several.

**A Driver implements only the Stages it has.** Four small interfaces, not one
wide one, so a twenty-line batching Driver declares one method.

**Every Driver declares the interface version it was built against**, and a
mismatch refuses to load. Agent-authored Drivers are written by something that
will not be back to fix them, so an unversioned interface breaks them silently.

**With nothing configured, behaviour is unchanged.** The Loop ships with
`passthrough` (analyse) and `preset-route` (route) enabled — one prompt, one
Session, one answer, no model call the user did not ask for. Everything else is
off. A feature that alters the product before it is switched on cannot be
released behind a switch.

**New terms for `UBIQUITOUS.md`**, landing with the first implementation:
Kernel, Driver, Application, Work Item, Stage, Loop, Driver Host, Driver Trust,
Driver Capability.

## Alternatives considered

- **A case per role — an "architect step", a "QA step", a "judge step".** Rejected:
  the list has no end, and each entry would be a code change for what is really a
  prompt and a Preset.
- **Declarative steps only — a plugin is data, never code.** Rejected by the
  product owner: pre- and post-processing, batching heuristics and result parsing
  are code, and a schema expressive enough to express them is a language nobody
  asked for.
- **`Orchestrator` as an Application on top of the Kernel.** Rejected: it holds
  the limits and the Session Capability. An Application that enforces privilege
  is a privilege boundary any other Application can walk around.
- **A Loop per prompt rather than per window.** Rejected: a cron Schedule has
  nothing to attach to, a Subagent's re-entrant request has no queue to enter,
  and two prompts cannot share anything.
- **Drivers may spawn directly.** Rejected: two places enforcing the Depth Cap is
  the defect `ARCHITECTURE.md §Spawn` already describes — a limit read before an
  await and written after is not a limit.

## Consequences

The endless list becomes configuration: a Preset and a prompt, not a code change.
What stays code is the five Stages, and they are finite.

`Orchestrator` gains callers it did not have, so its limits are now load-bearing
for a second path. `submit_work` must charge N children against the parent's
aggregate count rather than one, or the per-parent limit is bypassable by an
Agent that asks for a batch instead of a spawn.

Four Driver interfaces are a published surface, versioned from the first release.
Widening one is a new version, not an edit.

The Kernel names a layer, not a security boundary hardware enforces. What the
boundary actually is, and what it is not, is ADR-0016's to state.

## References

- ADR-0008 — one process per session; what the Shim may do; capability scope
- ADR-0014 — native subagents allowed; the Shim injected on opt-in and trust
- ADR-0016 — Drivers run confined, at two privilege levels
- ADR-0017 — unattended runs
- `ARCHITECTURE.md §Spawn`, `§The orchestration socket`
- `src/core/ipcProtocol.ts` — the Work Item's payload type, already validated
