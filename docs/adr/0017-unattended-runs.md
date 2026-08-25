# ADR-0017: Unattended runs — schedules, fail-closed permissions, and work at rest

- Status: proposed
- Date: 2026-08-25
- Supersedes / superseded by: —

## Context

ADR-0015 gives the window one Loop and one Work Queue. Two things follow that
nothing in this repository has had to answer before.

**The Loop should survive a window reload.** A queue that loses its work when
somebody reloads the window is a queue nobody will trust with a long job.

**Work should be startable on a schedule.** A nightly review, an hourly scan.

Both break an assumption every existing flow rests on: that somebody is watching.
The Connect wizard bounds its Probe Session with a short deadline precisely
"because somebody is watching it". A permission dialog exists because a person
answers it. Neither is true at three in the morning.

Persistence breaks a second one. A `Persisted Session` is metadata and nothing
else — there is deliberately no field for a prompt, hidden context, a tool payload
or a credential, so the file cannot carry one. A Work Item is *mostly* Brief. A
durable queue therefore stores exactly the class of text the session store refuses
to store.

## Decision

**A Schedule lives in settings.** An Agent may propose one; a human enables it.
The split matches ADR-0016's for Drivers — unprompted where it is harmless, human
where it persists. A cron entry an Agent added that starts paid Sessions on a
timer, indefinitely, is not the harmless case.

**Missed ticks are skipped, never caught up.** A window closed for three days must
not open into seventy-two hourly runs. Each Schedule records when it last fired;
on activation the next due tick runs and the rest are dropped.

**A scheduled run's permissions fail closed.** With nobody watching,
`session/request_permission` has no dialog to open, so anything not automatically
allowed by a Client Operation is *denied*, and the run reports it was denied. The
alternative is a Turn that hangs until the Stall Limit and reports nothing useful
— the same money spent for no answer and no reason.

**A tick starts an Agent through the same gate as everything else.** `spawnGate`
is "the one way this layer starts an Agent"; a Schedule is not a side door.
Window trust and Runtime Trust are re-derived per tick, as they are per Session.

**A Schedule disables itself after a threshold of consecutive failures**, and says
so. A broken Schedule otherwise spends money on a timer with nobody reading the
output — which is the failure this whole ADR is shaped around.

**The Work Queue stores Briefs.** Bounded in both directions, versioned so a file
written by a build that means something else by these fields is not read, and
passed through the same redaction as a log. This is a change in what sits on disk
and it is stated rather than discovered: **`agentConductor.loop.persistQueue`
turns it off**, and the Loop then holds its queue only in memory.

**A queue takes the Hold stamp the session store already uses.** Two windows share
one storage directory. The window holding the queue drains it; a second window on
the same folder shows it read-only rather than dispatching it a second time. A
stamp rather than a flag, because a stamp is re-said while the holder lives and
ages out when it is killed — a flag left behind by a killed window would lock the
queue until somebody deleted it by hand.

## Alternatives considered

- **Catch up on missed ticks.** Rejected: an hourly Schedule and a weekend produce
  a hundred and sixty Sessions at once, against every limit the Orchestrator holds
  and every dollar behind them.
- **Queue a permission request until somebody answers.** Rejected: it converts an
  unattended run into a Session that holds a process open indefinitely. Denying and
  reporting is the answer a person can act on the next morning.
- **Let an Agent enable a Schedule.** Rejected: recurring unattended spend is the
  one thing in this design a person must have said yes to, and it is exactly what
  an Agent cannot be given because nobody is there to notice.
- **Store no Briefs — persist queue structure only.** Rejected: the items are then
  unrunnable and the queue is not durable, which was the requirement.
- **Persist by default with no way off.** Rejected: task text at rest is a real
  change for anyone in a regulated repository, and it must be refusable.
- **A separate scheduler process, or the operating system's cron.** Rejected: it
  would start Agents outside the window's trust, outside `spawnGate`, and with no
  UI to see or cancel them.

## Consequences

Work survives a reload, and the file that makes that possible contains task text —
which is why the setting to refuse it exists and why the redaction and the bounds
are not optional.

An unattended run can fail for a reason no interactive run ever sees: a permission
that would have been granted by a person present. That has to read clearly in the
report, or it will be mistaken for the Agent failing.

A Schedule is spend on a timer. The disabling threshold, the skipped catch-up and
the settings-only enablement all guard that same spend from a different direction.
Remove any one and the other two have to catch what it caught, which they were
not designed to do.

The Hold stamp is now used by two stores. If its meaning ever changes, both move
together.

## References

- ADR-0007 — permission routing is consent and an audit trail
- ADR-0008 — one process per session; Stall Limit and Cancel Grace
- ADR-0015 — one Loop per window, owning one Work Queue
- ADR-0016 — Drivers run confined; the same unprompted/human split
- `ARCHITECTURE.md §Resume`, `§Sessions tree` — the Hold stamp and the bounded, versioned record
- `src/vscode/spawnGate.ts` — the one way this layer starts an Agent
