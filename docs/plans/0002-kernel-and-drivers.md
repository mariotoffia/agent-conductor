# Kernel and Drivers

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Status: draft — plans are temporary; promote durable decisions to ADRs (AGENTS.md).

**Goal:** Split an overarching prompt across CLIs, models and efforts, driven by pluggable code, without a second place that enforces a limit.

**Decisions this implements:** ADR-0015 (the Kernel, its Drivers, the Applications above it), ADR-0016 (Drivers run confined, at two privilege levels), ADR-0017 (unattended runs).

---

## What is being built

TODO: What about...
1. Memory driver?
2. How are a driver different from a mcp or internal tool call
3. Do we support "meta level" tool/MCP calls?
4. If (3) mcp driver?

One Loop per window owning one Work Queue. Everything that wants work done — a
chat prompt, a cron tick, a Subagent asking over the Shim — puts a Work Item on
it. Five Stages drain it; four of them are Drivers.

```
Applications   participant · cron · Facade · Subagent request (Shim)
                     │
Kernel         Queue → analyse → route → dispatch → gate → reduce
                                            │
                                    Orchestrator (existing)
                                    depth · semaphore · count · worktrees
                     │  ctx.ask / ctx.read           ▲ Work Items
Drivers        trusted Host          ephemeral Host  │
```

The endless list — repository scan, architect, design, task creation, task
implementation, QA gate, judge, TDD — is Presets and prompts, not Stages. It
never becomes a code change.

## Prerequisite: headroom

Every file this touches is at or against the 500-line cap. This is the first
task because nothing else fits until it is done.

| File | Lines | Cap |
|---|---|---|
| `src/vscode/participant.ts` | 500 | 500 |
| `src/core/orchestrator.ts` | 496 | 500 |
| `src/core/ipc.ts` | 485 | 500 |
| `src/vscode/composition.ts` | 478 | 500 |

- [ ] Extract the slash-command handlers from `participant.ts` into `src/vscode/participantCommands.ts`. Behaviour unchanged; `make test` passes with no test edited.
- [ ] Extract Loop wiring out of `composition.ts` into `src/vscode/loopWiring.ts` before adding any, so composition keeps its shape.
- [ ] Confirm `make lint` still writes `reports/core-imports.log` clean.

---

## Phase 1 — Kernel, built-in Drivers, in-process

No Driver Host, no code loading, no cron, queue in memory. **Default behaviour
must be byte-identical to today**: the existing tests pass unedited, and that is
the phase's exit criterion.

### Types and queue

- [ ] `src/core/loop/types.ts` — `WorkItem` (the `spawn_subagent` payload from `ipcProtocol.ts` plus `id`, `origin`, `parentItemId`, `state`), `Stage`, `Verdict`, `DriverRef`, `DRIVER_ABI = 1`.
- [ ] `src/core/loop/queue.ts` — admit, next, complete, cancel, and the per-parent counters. Read-and-reserve with nothing awaited in between, and every counter re-read after each await; `ARCHITECTURE.md §Spawn` explains why.
- [ ] `src/test/unit/queue_admission_limits.test.ts` — a limit read before an await and written after does not hold; prove this one does.

### The four Driver interfaces

- [ ] `src/core/loop/drivers.ts` — `AnalyseDriver`, `RouteDriver`, `GateDriver`, `ReduceDriver`, each with one method. A Driver declares its Stages and its ABI; a mismatch refuses to load.
- [ ] `src/core/loop/ctx.ts` — `ask`, `read`, `log`, `abort`. In phase 1 it calls the Orchestrator directly; phase 2 puts the same surface behind the Host protocol unchanged.
- [ ] `src/test/unit/driver_abi_mismatch.test.ts` — a Driver built against ABI 0 does not load.

### The Loop

- [ ] `src/core/loop/loop.ts` — drain the queue through the five Stages. `dispatch` calls `Orchestrator` and nothing else does.
- [ ] A sync single item hands the live `ConductorSession` back to its Application, so the participant streams exactly as it does today. The Loop decides *what Sessions to open*; it does not wrap the streaming.
- [ ] Cancelling a parent cancels its Drivers and its Work Items to the bottom of the tree.
- [ ] `src/test/unit/loop_stage_order.test.ts` — analyse, route, dispatch, gate, reduce, in that order, with a Driver at each.
- [ ] `src/test/unit/loop_default_is_unchanged.test.ts` — with only the two default Drivers, one prompt produces one Session and one answer, and no model call nobody asked for.

### Built-in Drivers

- [ ] `builtin/passthrough.ts` — analyse, **on**. One item in, one out. No model call.
- [ ] `builtin/presetRoute.ts` — route, **on**. The Preset defaults already in `OrchestrationLimits`.
- [ ] `builtin/llmPartition.ts` — analyse, **off**. Calls `ctx.ask` on a Preset, parses a Work Item list against a Zod schema, refuses anything else.
- [ ] `builtin/judge.ts` — gate, **off**. N verdicts on a Preset, majority decides; the worked example of a Stage.
- [ ] `src/test/unit/llm_partition_refuses_bad_output.test.ts` — a model answering prose, or naming a file outside the granted roots, yields no Work Items rather than a bad one.

### Wiring

- [ ] The participant becomes an Application: submit a Work Item, render what comes back.
- [ ] Settings: `agentConductor.loop.enabled`, `.drivers` (id → enabled).
- [ ] `UBIQUITOUS.md` gains Kernel, Driver, Application, Work Item, Stage, Loop, Driver Host, Driver Trust, Driver Capability — the words before the code that uses them.
- [ ] `ARCHITECTURE.md` gains a `§Loop` data flow beside `§Spawn`.
- [ ] `make check` passes with no existing test edited.

---

## Phase 2 — Driver Host and Driver Trust

- [ ] `src/driverhost/main.ts` — loads Drivers, serves the protocol on stdio. Bundled separately, imports nothing from core, like the Shim.
- [ ] `src/core/loop/hostProtocol.ts` — the contract, apart from the machinery, as `ipcProtocol.ts` is. Reuses `readFrame` and `MAX_FRAME_BYTES`.
- [ ] `src/core/loop/host.ts` — spawn with `--permission --allow-fs-read=<roots>` and `ELECTRON_RUN_AS_NODE=1`; read the confinement report as the first line; refuse everything but built-ins if `process.permission` is inactive.
- [ ] Two Hosts: trusted (granted roots) and ephemeral (no roots). Same binary, different flags.
- [ ] `src/core/loop/driverTrust.ts` — realpath after symlinks plus a digest of the source, re-derived at every load, never read back from a record. Reuses what `executables.ts` does for launch commands.
- [ ] Approval dialog: id, Stages, fingerprint, exact capabilities and roots, path — and the source opened read-only beside it.
- [ ] Per-call deadline; a breach restarts that Host, fails the calls in flight, and disables the Driver after a threshold.
- [ ] `src/test/unit/driver_confinement_report.test.ts` — an inactive permission model loads built-ins only, and says why.
- [ ] `src/test/unit/driver_trust_refuses_edited_source.test.ts` — approve, edit one byte, refuse.
- [ ] `src/test/unit/driver_host_fault_restarts_one_level.test.ts` — a hung Driver takes down its own Host and not the other.
- [ ] Record the confinement measurement in `docs/CHANGELOG.md`: what was checked, against which VS Code build and Node version, dated.

---

## Phase 3 — Agent-authored Drivers and `submit_work`

- [ ] `ORCHESTRATION_METHODS` gains `submit_work`, `add_driver`, `list_drivers`, `enable_driver`, `disable_driver`, `remove_driver`, each with a strict schema in `PARAMS`.
- [ ] `submit_work({intent, files, batch, preset, mode})` returns a handle. `check_subagent`, `subagent_result` and `cancel_subagent` accept it unchanged.
- [ ] `preset` is a **hint** the route Drivers may override. An Agent never names a runtime and model for a submission — that is the user's policy.
- [ ] Batching is Kernel-side: batch size follows the target model's context, which the Agent does not know.
- [ ] **`submit_work` charges N against the parent's aggregate count, not 1.**
- [ ] Same admit checks as `spawn_subagent`, in the same place: active parent, current Runtime Trust, granted roots, Depth Cap, count.
- [ ] `add_driver` with no capability and no persistence runs in the ephemeral Host, unprompted, discarded with its Work Item. Anything persistent or capability-bearing needs a human, unless `agentConductor.drivers.autoApprove` is on.
- [ ] `src/test/unit/submit_work_charges_every_child.test.ts` — a submission fanning to eight charges eight, and the ninth is refused when the parent has one left.
- [ ] `src/test/unit/ephemeral_driver_gets_no_roots.test.ts` — an agent-authored Driver reading any path is denied by Node, not only by us.
- [ ] `src/test/unit/ephemeral_driver_dies_with_its_item.test.ts` — nothing is fingerprinted, persisted, or loadable afterwards.

---

## Phase 4 — Durable queue and Schedules

- [ ] `src/core/loop/queueStore.ts` — versioned, bounded both ways, redacted as a log is. Holds Briefs; ADR-0017 says why and `agentConductor.loop.persistQueue` turns it off.
- [ ] The Hold stamp from the session store: the holding window drains, a second window on the same folder shows the queue read-only.
- [ ] `src/core/loop/schedules.ts` — a Schedule reads from settings. An Agent may propose; a human enables.
- [ ] Missed ticks are skipped, never caught up: record `lastFiredAt`, run the next due one, drop the rest.
- [ ] A tick starts an Agent through `spawnGate` like everything else, with window trust and Runtime Trust re-derived.
- [ ] A scheduled run's permissions fail closed: anything not automatically allowed is denied and reported, never left open.
- [ ] A Schedule disables itself after a threshold of consecutive failures, and says so.
- [ ] `src/test/unit/schedule_skips_missed_ticks.test.ts` — a window closed three days opens into one run, not seventy-two.
- [ ] `src/test/unit/unattended_permission_fails_closed.test.ts` — no dialog, a denial, and a reason a person can act on.
- [ ] `src/test/unit/queue_hold_stops_double_dispatch.test.ts` — a second window does not drain a held queue.

---

## How you know it is done

`make lint` and `make test` on the branch, then `make check-all`. Phase 1's own
gate is stricter than that: **no existing test may be edited to make it pass.**

Failures that predate the branch are still the branch's to fix or revert.

## What is deliberately not here

- Per-Driver durable state — no Driver needs it yet.
- A Host per Driver — two privilege levels buy the isolation that matters.
- Network gating for Drivers — it cannot be enforced, so it is written down instead (ADR-0016).
- Enforcing limits on a CLI's own subagents — the CLI does not report them (ADR-0014).
