# Agent Conductor Implementation Plan — Judged

> **What this document is:** a mirror of `0001-mvp-implementation-plan.md` with an independent judgement per task: overall, completeness, security and maintainability scores (1–100), and an issue register with a per-issue certainty score (1–100). Task 8 is excluded from scoring (in progress at audit time). Analysis is static only — nothing was compiled or tested during this audit; scores reflect what the code, tests, ADRs and manifests **say**, judged against the plan's own requirements and published protocol/vendor norms.
>
> **Audit method:** 9 parallel deep-read audits (one per task or task pair: 1, 2, 3, 4, 5+6, 7, 9, 12+13, 10/11/14–16+infra), each reading the full task files plus their tests, ADRs, and the pinned ACP SDK schema where protocol drift was in scope. Material claims were re-verified against the working tree afterwards (line counts, `views` contribution, `engines`, shim source, `gen-rich-manifest.mjs`).
>
> **Authority order** (same as the plan): ADRs and root docs > current source/tests > plan > README/walkthroughs.
>
> **Score legend:** 95+ exemplary · 85–94 strong · 70–84 acceptable with real debt · 40–69 partial · <40 absent or misleading. Certainty = auditor confidence the finding is correct as written (100 = re-verified against the working tree).

---

## Judged Milestone Status

| Deliverable | Plan status | Judged | Note |
|---|---|---|---|
| Core ACP client and mock Agent | Done | **Done** (94/95) | Genuinely done; leak-guard harness is a model of gate discipline |
| Stable direct Session | Pending | **In progress (Task 8)** | `participant.ts`, `composition.ts`, `diffDocs.ts`, extension-host suite exist and pass per plan notes; not scored here |
| Wizard, settings, multiple Runtimes | Pending | **Done** (88–93) | All four runtimes configurable from live Config Options; trust only after probe answers |
| Orchestrator | Pending | **Not started** (12–14/100) | Only a 42-line shim stub + fail-closed predicate + unconsumed settings exist |
| Real release gate | Pending | **Half built** (55) | Runner is strong (four fail modes, env scrubbing); 7 of 11 host coverage areas missing; `engines.node` absent |
| Rich VSIX build | Pending | **Needs the removal path** (20) | Stub injects proposals with no provider; plan + ADR-0002 both authorize deleting `package-rich` |
| ACP-agent Facade | Deferred | **Deferred correctly** | No code, no drift |

## Global Scoreboard

| Area | Overall | Completeness | Security | Maintainability |
|---|---|---|---|---|
| **Repo overall (all judged work)** | **81** | **66** | **92** | **85** |
| Delivered core (Tasks 2–7, 9) | 91 | 90 | 94 | 88 |
| Governance (Task 1) | 93 | 92 | 95 | 93 |
| Not-yet-built (Tasks 10, 11, 12, 13) | 10–15 | 5–15 | 72–78 (latent) | 70–90 (stubs only) |
| Build/lint/test infrastructure | 85 | 90 | 90 | 90 |

How the overall 81 is computed: delivered work (weight ≈70%) averages ≈91 with security ≈94; unbuilt scope (Tasks 10/11/12/13, weight ≈30%) scores 10–15 on completeness. Security stays high because everything unbuilt is **fail-closed**: orchestration is off by default, the shim exposes no state, no token exists yet, and `verifySuppression` refuses by construction.

---

## Task 1 — Ratify the security and lifecycle model — **judged Done**

**Scores: Overall 93 · Completeness 92 · Security 95 · Maintainability 93**

All four ADRs (0007–0010) exist with `Status: accepted`, full template sections (Context/Decision/Alternatives/Consequences), and are mutually consistent: ADR-0010's supersession of ADR-0006 is marked bidirectionally, and the three security ADRs agree on fingerprint-as-identity, consent-not-sandbox, and worktrees-as-coordination. `UBIQUITOUS.md` defines all five required terms; `ARCHITECTURE.md §Security invariants` encodes the invariants (off-by-default orchestration, per-Session revocable capabilities, no parent repo in `additionalDirectories`, SecretStorage-only secrets). `package.json` has `orchestration.enabled` defaulting to `false`, `secretEnvironment` as name→key references, and `additionalProperties: false` on the runtime schema — no plaintext `env` remains (the suppression-plan `env` is documented policy env, not a credential store).

The ratified model matches industry norm where a norm exists: VS Code extensions keep secrets in SecretStorage and only names in settings; ACP/Claude Code permission requests are user-consent surfaces, not sandboxes (the agent keeps OS privileges — the ADR says exactly this); per-Session random capability tokens bound server-side match the MCP-loopback / per-connection-token / Docker-socket pattern, with the token passed via environment rather than argv to avoid `ps` exposure.

Issues:

| # | Certainty | Finding | Severity |
|---|---|---|---|
| 1 | 85 | `SuppressionCapability`, `BudgetCapability`, `SessionCapability`, `PersistedSession` exist only as glossary words; only `RuntimeTrust` has a code counterpart (`src/core/types.ts:105`). Code identifiers land with Tasks 10/12/13, but Task 1's point was to ratify the shape in advance | low |
| 2 | 80 | "Versioned" Persisted Session is prose in ADR-0008 only; no `{version: N, …}` record shape is pinned in a canonical doc, so the Task 10 migrator has no schema of record (industry norm: version the record in the persistence contract, not in an ADR sentence) | low |
| 3 | 70 | Suppression-plan `env` is an untyped string map in the same settings tree as `secretEnvironment`; the `config.ts` secret-shape tripwire is applied to `secretEnvironment` only. Extend the same check to suppression `env` | low |
| 4 | 95 | `make doctor` still accepts any Node ≥20 while the plan requires `^20.19.0 \|\| ^22.13.0 \|\| >=24` — see global issue G1; the engine range is not declared at all in `package.json` (see G3) | medium |

---

## Task 2 — Build the mock ACP Agent — **judged Done**

**Scores: Overall 94 · Completeness 95 · Security 93 · Maintainability 84**

`src/test/mock-agent.ts` (423 lines, under the 500 rule) uses **only** the pinned `@agentclientprotocol/sdk` (`acp.agent`, `acp.ndJsonStream`, `acp.methods`, `acp.PROTOCOL_VERSION`) — no raw ndjson, no `Date.now`/`Math.random`, per-process deterministic session ids. It scripts ~25 injectable modes (initialize/auth, config options, full update stream, permission requests, cooperative cancel, timeout, malformed stdout, stderr, child-exit, setup reinjection, `load-history`, `spawns-child`, leak modes). `mock_agent.test.ts` spawns it as a **real subprocess** (`spawn(process.execPath, ["--import","tsx", …])`) for all nine required scenarios, with order-pinned `deepEqual` over the entire update stream and a genuine "prompt still pending after cancel" assertion for timeout mode — not a skipped no-op. The `leak-guard` (`--import` on every test process, unref'd grace timer, self-proving fixtures in both directions) is the strongest part of the harness.

Issues:

| # | Certainty | Finding | Severity |
|---|---|---|---|
| 5 | 98 | Scenario is hard-coded `if (mode === …)` branches; the 500-line rule will be breached the moment a mode is added. Industry norm is script-as-data (JSON scenario + runner, as MCP SDK and node:test subprocess fixtures do) | low |
| 6 | 75 | `spawns-child` fixture spawns without `detached`; group-kill is POSIX-guarded, so on Windows the 25 ms worker orphans. Dev/CI is mac/linux today | low |
| 7 | 85 | Malformed-stdout test asserts on the SDK's `console.error` text (`/Failed to parse JSON message/`) — fragile to an SDK point release; the JSON-RPC rejection itself is asserted first, so impact is bounded | low |

---

## Task 3 — One-process-per-Session ACP lifecycle — **judged Done**

**Scores: Overall 94 · Completeness 93 · Security 95 · Maintainability 93**

This is the hardest task in the plan and it is executed well. Every targeted classic bug was checked and is **absent**:

- **No per-chunk `toString` framing bug.** Both directions delegate to the SDK's `ndJsonStream`, whose `LineBuffer` carries partial tails *as bytes* across chunks and decodes only complete lines — UTF-8 split across chunk boundaries is safe.
- **No cross-Session kill.** Each `ConductorSession` owns exactly one process (no pool/registry exists anywhere); escalation kills only `-child.pid` of its own `detached` group, with a PID-reuse guard (`groupExists` while alive, never signal a seen-ended group) and a test that patches `process.kill` to catch a negative-pid signal to a recycled group. SIGTERM→SIGKILL at 2 s is inside the 2–5 s industry norm.
- **Cancelled-turn invariant holds** (`{stopReason:"cancelled"}` / `{"outcome":"cancelled"}`), including the "crash during cancel reports the crash, not a clean cancel" case.
- **Grace timer** is an injected clock, `unref`'d, re-checked inside the callback so a stale fire cannot kill a healthy Session; fake-clock tests assert exact arm/disarm sequences (`session_bounds.test.ts`).
- **Sorted `mcpServers`** (codepoint comparison) at both `session/new` and `session/load`; `session/load` refused without the `loadSession` agent capability; `additionalDirectories` only under the advertised capability — field names match the shipped SDK schema.
- **Secrets:** values come from the UI adapter; logs carry names only; the stderr tail is redacted *before* the bounded cut with a straddle guard whose test sweeps every cut point inside a secret.
- **Leak discipline:** handshake failure reaps the child; every setup test asserts `reaped(exited)`; `dispose()` is memoized and flips state before its first `await`.

Issues:

| # | Certainty | Finding | Severity |
|---|---|---|---|
| 8 | 85 | `cwd` is validated for absoluteness but not existence before spawn; a missing cwd surfaces as a spawn error. LSP/MCP clients pre-`stat` the cwd; costs one `stat` | low |
| 9 | 60 | If the agent dies while the user stares at the consent modal, `host.ask`'s modal Promise is never resolved early — the modal lingers until the user clicks or the window closes. Fail-closed (`undefined` → cancelled), so no security hole, but a dead Session can keep a modal alive. Norm: settle pending requests from the same handler that observes `closed` | low |
| 10 | 90 | Mid-Session corruption of a *response* line (not corrupt-then-die) has no deadline; only the 10-minute stall limit bounds it, and a corrupt line followed by legitimate updates restarts the stall clock. Skip-and-log is the SDK/spec norm, so this is accepted protocol behaviour, but the stall constant should be surfaced in docs | low |
| 11 | 95 | Grace→SIGTERM contract tests live in `session_bounds.test.ts`, not the `acp_client.test.ts` the plan names. The tests are real, not tautological — naming deviation only | info |

---

## Task 4 — Config Option discovery and Read-back — **judged Done**

**Scores: Overall 96 · Completeness 95 · Security 97 · Maintainability 95**

The cleanest task in the audit. The feature is a pure projection over one invariant — *the last complete array the agent sent* — and every path (new, load, set, unsolicited refresh, failed-set wipe) **replaces wholesale** (`session.ts` `#handleUpdate`, set response, `session/new`, `session/load`); there is no append/merge anywhere. `verified` is set **only** when the agent reports a `currentValue` (`discovery.ts:158`); catalog fallbacks feed only the picker and can never leak into `EffectiveSelection.verification` — the exact invariant ADR-0005 exists to protect. Mismatch is by value id; an effective value absent from the option list is preserved, not thrown. Field names read from `configOptions` were checked 1:1 against the pinned SDK's `schema.json` — **no protocol drift**. Notably, `categorySlot` maps only `model` and `thought_level` and deliberately **not** `mode` — correct, because the ACP schema defines `mode` as the session-mode selector, and routing it to the model picker would be the bug (the plan's task text paraphrases this loosely; the code wins). Agent responses are treated as untrusted input: the SDK only schema-checks notifications, so every field a projection reads is narrowed before use, and malformed entries are dropped by `asConfigOptions` (wire-tested via the mock's `bad-config-options` mode). Tests are not circular: unit tests hand-build protocol-shaped fixtures independent of production normalizers; unsolicited refresh goes over a real subprocess pipe.

Issues:

| # | Certainty | Finding | Severity |
|---|---|---|---|
| 12 | 55 | A stale `config_option_update` arriving after a newer one wins (last-write-wins, no protocol versioning) — inherent to ACP v1; no mitigation exists in-protocol | low (inherent) |
| 13 | 80 | A `config_option_update` before `sessionId` is known is adopted then overwritten by `session/new`'s response — only a protocol-violating agent triggers it | low |
| 14 | 75 | No test pins "agent reports a `currentValue` absent from its own options list"; behaviour is correct by construction — a 5-line pin would harden it | low |

---

## Task 5 — Secure, offline-safe Runtime resolution — **judged Done**

**Scores: Overall 93 · Completeness 92 · Security 95 · Maintainability 86**

The offline-safety story is layered and correct: user pin > registry > built-in pin; the registry feed can only move versions **forward** to an exact version of the same package name (`pinnedAdapter` + `isNewerVersion` floor + package-name check); fetch/validation/missing-cache all fall back visibly; the stale cache stays usable; nothing invents data. Zod `.parse` at write-time, `.safeParse` returning `undefined` on read, 4 MiB bounds, future-`fetchedAt` treated stale — directionally correct. The `StoragePort` (`types.ts:262`) with `writeAtomic` is used by the `fileStorage` adapter (`fileStorage` = unique-per-write tmp + same-directory rename, relative-key confinement tested including the `../../escaped.json` escape). Executable resolution does `X_OK` + `isFile` + `realpath` + a ≤64 MiB digest, refuses package runners **as a realpath target** (symlink escape handled), and never returns `.cmd`/`.bat` for the shell-less spawn. No `vscode` import in `src/core/**` (verified by grep). Exact-version pins only: dist-tags, ranges, and leading zeros all rejected; a bad pin disables one Runtime, not the catalog.

Issues:

| # | Certainty | Finding | Severity |
|---|---|---|---|
| 15 | 90 | The plan's split was done without deleting the original: `runtime_registry.test.ts` still exists and overlaps both `runtime_trust.test.ts` and `registry_cache.test.ts`. Pin behaviour now lives in up to three files — violates the repo's own one-test-file-per-behaviour rule | medium |
| 16 | 90 | The registry feed URL is a **user-edited setting** with no signed document behind it. A version pin is not artifact authenticity: a DNS attacker who controls that name can ship a malicious *newer* exact adapter version that the wizard then installs. Norm: npm `dist.integrity`/signatures, marketplace signed VSIXs; here: pin a constant URL and/or add a document hash check | medium |
| 17 | 75 | `claude` launch command is `claude-agent-acp`, but the upstream `@agentclientprotocol/claude-agent-acp` bin is `claude-code-acp` (confirmed against the npm registry; the catalog pin 0.70.0 is current, not stale). If the bin name drifted, resolution fails closed and Claude becomes unlaunchable until the catalog is fixed | low |
| 18 | 70 | Crashed activation orphans `*.tmp` files under global storage forever — no startup sweep. Norm: glob and delete stale tmp at activation | low |
| 19 | 85 | The real `executables.ts` fs port is only exercised through fake ports in fixtures; no real-fs test of X_OK denial or symlink-to-runner canonicalisation | low |

---

## Task 6 — Complete and verify Suppression Plans — **judged Done (with a live dead end)**

**Scores: Overall 78 · Completeness 70 · Security 92 · Maintainability 88**

The core-side machinery is mechanically excellent: exact enabled/disabled argv/env/`_meta` golden fixtures for all four built-ins; `verifySuppression` fails closed on every branch (no plan, unreadable or empty tool list, plan naming nothing, no recorded consent — "presence of evidence is absence", `policy.ts:135–165`); Gemini workspace merge/revert preserves unrelated JSON via atomic tmp+rename writes; custom Runtimes are ineligible until a verified plan exists. But the audit found the single most important operational dead end in the whole implemented surface:

| # | Certainty | Finding | Severity |
|---|---|---|---|
| 20 | 92 | **The Gemini workspace channel is unwired end-to-end.** `applyWorkspaceSuppression`/`revertWorkspaceSuppression` (`policy.ts:445,465`) have **zero production callers** — only tests reference them. No wizard stage records `workspaceSettingsConsent`, no code sets it, and the `gemini.writeWorkspaceSettings` setting (default `false`) has no consumer. Consequence: `verifySuppression` can never return verified for Gemini, so Gemini is **permanently ineligible for Shim injection** — which is the fail-closed direction, but the capability is currently unattainable, and the plan's Task 9 note ("the wizard-side probe lands with the wizard") is not true in the code as delivered. Either finish the consent path in the wizard or document Gemini as orchestration-ineligible in the walkthrough | **high** (capability, not hole) |
| 21 | 70 | Suppression argv/env recipes are pinned against vendor CLIs from memory of flag spellings; the plan itself admits the unverified list lives in the (soon-deletable) guide. Re-verify the four recipes against primary vendor sources and date the verification (Task 16 requires this anyway) | medium |

---

## Task 7 — Typed VS Code configuration and client services — **judged Done**

**Scores: Overall 92 · Completeness 96 · Security 93 · Maintainability 92**

All seven checkboxes are implemented, and the security bar is above what most extensions reach:

- **Path containment is post-realpath with a `sep` boundary on both sides** (`rootGuard`): absolute-only → resolve → component-wise `realpath` to the nearest existing ancestor → `path === root || path.startsWith(root + sep)`. The `/a/b` root does **not** admit `/a/b-evil`, and a symlink inside the root pointing out is pinned by a dedicated test to fail both directions.
- **Secrets provably never reach an error string.** `config.ts` refuses credential-shaped literals (10 prefix heuristics: `sk-`, `ghp_`, `glpat-`, `xox*`, `AKIA`, `AIza`, JWT `eyJ`, npm, `pk_live`, …) before they enter settings; `resolveSecretEnvironment` re-checks at the last gate; every `throw` in `config.ts` was traced for value interpolation; the "failing secret store cannot leak" test makes a fake store leak and asserts `[redacted]`.
- **Terminal kill is process-group-correct with the recycled-pgid protection most implementations miss**: `detached: true` + `process.kill(-pgid)`, 2 s SIGKILL escalation, and the group id is latched unusable once observed empty (signal-0 probe) so a recycled pgid can never signal a stranger's process — specifically pinned by a "recycled group id" test. Ring buffer is a real 1 MiB byte ceiling with character-boundary trim (cross-chunk UTF-8 continuation case pinned). A `$(echo pwned); rm -rf /` argument is pinned to echo back as text with `shell: false`.
- **Permission routing is keyed by method+arguments** (`OPERATION_BY_METHOD`); `toolKind` appears in `permissions.ts` only inside a dialog string marked "(reported by the agent)" and in display mapping. Empty options or dismissed dialog → `{"outcome":"cancelled"}`. Conflicts in allow/reject lists deny; a corrupt reject list refuses to fall back to defaults — the one fail-open trap, closed and tested.
- **Elicitation** dismisses to `{"action":"cancel"}`, validates fields, and deliberately does **not** execute agent-supplied `pattern` regexes (a ReDoS on the UI thread; `^(a+)+$` pinned as the failing case).

Issues:

| # | Certainty | Finding | Severity |
|---|---|---|---|
| 22 | 95 | Containment compares canonical paths **case-sensitively** (documented `ponytail:` ceiling): on a macOS case-insensitive volume, a legitimate session under `/Users/x/Proj` where the agent reports `/users/x/proj` fails every read. Safe direction (refusal), but a legitimate runtime would look broken. Norm: detect volume case-sensitivity once (stat both spellings, compare inodes) | low |
| 23 | 90 | `openDocuments` buffer lookup is exact-string `document.uri.fsPath === path`; a document whose `fsPath` differs from both the canonical path and the agent's spelling (macOS case difference) silently falls through to disk — agent content written near the user's dirty buffer. Data loss is prevented (editor flags the conflict) but the case is untested | low |
| 24 | 85 | `terminal` spawn inherits the **entire** `process.env`; the consent dialog shows only the agent-supplied `request.env`. This is the norm (VS Code spawns with host env), but the dialog should say inherited env is the editor's | low |
| 25 | 85 | The "unset settings fall back to defaults" test iterates `scalarSchema` keys only — a new `agentConductor.*` manifest key not added to the schema is silently unread and the test still passes. Norm: also assert manifest keys ⊆ schema keys | low |
| 26 | 80 | A rejected secret literal in one `secretEnvironment` entry drops the **entire Runtime entry**, including valid unrelated config. Fail-closed and the error text correctly names nothing; the per-entry philosophy used elsewhere would drop only the variable | low |

---

## Task 8 — Direct Session vertical slice — **excluded (in progress)**

Not scored, per the audit mandate. For the record: the slice's code (`participant.ts` 457 lines, `composition.ts`, `diffDocs.ts`) and one extension-host suite exist; the plan itself defers the wider host coverage (wizard save, resume, tree, Shim child), the `engines.node` range, and console count-only output to Task 14.

---

## Task 9 — Connect-a-CLI wizard — **judged Done**

**Scores: Overall 88 · Completeness 84 · Security 90 · Maintainability 88**

One of the better-executed tasks. Verified: single `Connection` state object (`wizardPorts.ts:115–129`) passed stage to stage; every user-facing `await` funnels through an `ask` that throws `Cancelled` on dismissal, and `finally` kills the probe process and removes the tmp dir even on throw; the probe advertises `fs.read=false, fs.write=false, terminal=false` **on the wire** (pinned), runs in a fresh `mkdtemp` with no `additionalDirectories`, and any permission request is refused; `PROBE_DEADLINE_MS` (20 s) bounds `initialize`, `session/new`, `session/load` and `set_config_option` (not just the session default); save is strictly post-validation (every failure test asserts `writes === []`); the settings write is a read-modify-write of only the `runtimes` key at the chosen scope, preserving hand-written fields, and workspace scope is never promoted to global; trust is recorded **after** the probe answered (AGENTS.md invariant), and a `globalState` write failure leaves `trusted: []`. The three self-note fixes are real and pinned: `hideSubscriptionAuth` → `--hide-claude-auth` folded into the fingerprint with a test that no other Runtime's fingerprint moves; `quirks.processScopedConfig` is now read at `participant.ts:348` (reconnect message vs "exposes no model"); the deferred settings are genuinely unread. The fingerprint (id, absolute command, args, env, policy, suppression, **artifact digest**, secret **names** — values excluded) is the correct consent pattern: replace the binary and re-approval is required (git `safe.directory` / macOS keychain norm).

Issues:

| # | Certainty | Finding | Severity |
|---|---|---|---|
| 27 | 85 | Dismissing the fan-out modal counts as **decline-and-continue**, contradicting the wizard's own rule that dismissing any question ends the run having written nothing. Safe direction (no fan-out without consent), but intent is ambiguous; norm: a real three-way dialog | low |
| 28 | 70 | Storing an API key mid-probe adds a `secretEnvironment` reference to the state entry **after** the approval dialog — secret names are fingerprinted, so the approved identity silently changed. `launchesAsApproved` then fires but blames "settings scopes", the wrong cause. Fail-closed overall (re-refused at launch), but the error message misdiagnoses. Norm: re-run approval whenever the pending entry changes post-approval | medium-low |
| 29 | 75 | `recordTrust` sits outside the try/catch around the settings write; a `globalState` failure reports "could not connect" for a CLI that demonstrably worked. Misdiagnosis, not a security issue | low |
| 30 | 95 | `wizardTerminal`/`registered` module globals in `wizardHost.ts:129–136` are the one place the "single state object" claim bends; documented and single-window-scoped | low |
| 31 | 90 | `describeRefresh` (offline-fallback wording) lives in `composition.ts` with no test at any level — extract into core as the codebase does elsewhere | low |

---

## Task 10 — Metadata-only Session persistence — **judged Absent**

**Scores: Overall 15 · Completeness 15 · Security 90 · Maintainability 85**

`src/core/sessionStore.ts` does not exist; no session persistence anywhere. `context.globalState` is used only for `runtimeTrust.<id>`. `sessions.resumeOnStartup` is declared and schema-validated (`config.ts:163`) but consumed by nothing — a dead setting the user can change with no effect. The resumable **half** of the machinery is in place: `ConductorSession.load()` is a real `session/load` reattach that re-sends sorted servers and capability-gated directories — but nothing offers it to a user and nothing stores ids. The Task 1 gap (no pinned versioned-record shape, issue #2) means this task also lacks its schema of record.

| # | Certainty | Finding | Severity |
|---|---|---|---|
| 32 | 100 | `resumeOnStartup` is a manifest setting with zero consumer; either implement Task 10 (store + list + explicit load gate + the ADR-0010 trust-still-holds check) or drop the setting until the store lands | low |

---

## Task 11 — Sessions tree and actions — **judged Absent (with dead UI shipped)**

**Scores: Overall 10 · Completeness 5 · Security 90 · Maintainability 70**

`src/vscode/sessionsTree.ts` does not exist; grep for `TreeDataProvider` under `src/` returns zero hits. But `package.json:87–93` **does** contribute `views.agentConductor.sessions` — so every installation ships an empty placeholder pane that renders nothing (the `newSession` command there disposes the single chat session). vsce does not catch this; the user does.

| # | Certainty | Finding | Severity |
|---|---|---|---|
| 33 | 100 | View declared without a provider: dead UI in every install. Delete the `views` contribution until Task 11 lands, or register a provider that renders the current single session | medium |

---

## Task 12 — Per-Session authenticated IPC and Shim — **judged Absent (stub exists)**

**Scores: Overall 12 · Completeness 8 · Security 72 · Maintainability 90**

`src/core/ipc.ts` and `src/shim/socketClient.ts` do not exist. What exists: the 42-line shim stub (`mcp-shim.ts`) is **activation-safe** — stdio-only, writes nothing, listens on nothing, no handle before a tool call; the capability token is taken from `AGENT_CONDUCTOR_SESSION_TOKEN` env, never argv, with a correct threat comment (`/proc/<pid>/cmdline`, `ps`); and the `dist/mcp-shim.cjs` bundle target exists so the future injection point is ready. `esbuild.mjs` builds it self-contained. Everything the plan requires is missing: bounded NDJSON server, capability binding, constant-time comparison, the five tools, Zod validation, and all negative tests.

**Gap list (no code):** length-bounded frames + random 0600 unix socket; missing/malformed/expired-capability, cross-Session-replay, wrong workspace/depth, oversized-frame, disconnect, unsupported-method tests; server-side binding to {Session ID, parent ID, depth, roots, expiry, allowed methods} + ADR-0008 revocation on parent end / trust loss / orchestration off + **call-time** revalidation (the plan's test bullet covers fail-closed but not per-call re-check of active parent + current trust); `timingSafeEqual` constant-time compare; `socketClient.ts`; the five tools; removal/authentication of `orchestrator_status`; focused tests.

Issues in existing code:

| # | Certainty | Finding | Severity |
|---|---|---|---|
| 34 | 95 | `orchestrator_status` is an unauthenticated tool that leaks session configuration state (`socketConfigured`), live for the whole session. Plan requires removal or authenticated+non-sensitive. Norm: stdio MCP servers trust their spawner, so a read-only status tool is tolerable — remove it when the real tools land | low |
| 35 | 95 | The shim's header comment claims it "tunnels tool calls back to the extension over a token-authed local socket" — no such code exists. A reader assumes authentication that is not there. Mark stubs explicitly | low |
| 36 | 60 (design-level) | **Latent redaction gap that becomes live when Task 12 lands.** The capability token can only reach the shim through the agent process's environment (the agent harness spawns the shim, not the extension). `connectAgent` redacts only `secretEnvironment` values from stderr/log buffers (`acpClient.ts:249–265`) — if the token is passed via `launch.env`, an agent crash that prints its environment lands the token in logs unredacted. Fix forward: put capability tokens in the ADR-0010 redaction set (e.g. via `secretEnvironment`), which is the existing pattern | **high** (when implemented wrong) |
| 37 | 80 | `crypto.timingSafeEqual` **throws on unequal lengths** — the plan never spells out hash-first (fixed-length SHA-256 digests), which is the norm and also hides which capability was guessed | medium (plan guidance) |

---

## Task 13 — Bounded orchestration and worktree lifecycle — **judged Absent (foundations cut)**

**Scores: Overall 14 · Completeness 15 · Security 78 · Maintainability 85**

No `src/core/orchestrator.ts`, no `src/core/worktrees.ts`, no `child_process` git invocation anywhere. What exists as foundation (correct seams, zero enforcement): `verifySuppression` fail-closed predicate; per-runtime `budget` capability flag; `orchestration.enabled` (default false) + five more parsed-but-unconsumed settings (`maxConcurrentSubagents`, `maxSpawnDepth`, `subagentIsolation`, `budgetUsdPerSubagent`, `worktrees.root`); capability-gated `additionalDirectories` plumbing; `mcpServers` injection currently empty, so ADR-0008's "orchestration off ⇒ no capability, no shim, no spawn RPC" is satisfied **vacuously** — the right direction.

**Gap list (no code):** orchestrator state machine (fail-closed injection gate = depth + verified suppression + **current trust** — the plan's bullet omits trust as an explicit gate, ADR-0008 requires it); local depth/concurrency/**aggregate-spawn**/**timeout** enforcement (no aggregate or timeout setting exists either); budget forwarding that never replaces local limits; sync/background child states; cancellation cascade; Brief-only context; deterministic unique branches; git-mutation serialization (`.git/index.lock`); **record allocation before `git worktree add`** + reconcile abandoned allocations on activation; never auto-delete a dirty worktree; parent repos out of `additionalDirectories` by default; unknown-cost return; shim injection itself (absolute bundled command, name-sorted entry); all tests including the mock-Agent→Shim→child-Agent integration.

Plan-vs-ADR tension noted: ADR-0004's codex suppression runs process-wide via `CODEX_CONFIG` while ADR-0008 mandates one process per Session — reconciled in ADR-0004's Consequences ("one process per policy"), which the orchestrator must enforce (children inherit nothing).

---

## Task 14 — Replace the false integration gate — **judged Half built**

**Scores: Overall 55 · Completeness 55 · Security 90 · Maintainability 90**

The **runner** is genuinely strong: `@vscode/test-electron`, isolated `mkdtemp` workspace, `--disable-extensions`, drops inherited `VSCODE_*`/`ELECTRON_*`/`NODE_OPTIONS`; the launcher fails nonzero on missing binary/harness failure, and the suite fails on failures>0, `registered === 0`, or `registered > passed` (the skipped/`.only`/bodyless trap). Host coverage vs the plan's 11 areas: activation, trust refusal, direct prompt rendering (full render map over the wire), permission consent surface, Config Option round-trip + Read-back (`Now running:.*mock-model-fast`), and teardown are present (3 real tests, `direct_session.test.ts`); **missing in-host**: wizard save, cancellation, resume, sessions tree, Shim child result (the last two cannot exist until Tasks 11/12/13). The `make test-integration` target runs VS Code with this extension loaded — Task 8's end-to-end gate was in fact built.

Issues:

| # | Certainty | Finding | Severity |
|---|---|---|---|
| 38 | 100 | **`engines.node` is absent from `package.json`** (only `engines.vscode`). The plan's `^20.19.0 \|\| ^22.13.0 \|\| >=24` is unmet. Norm: declare `engines` + `engine-strict` | medium |
| 39 | 80 | **The repo's one green-but-empty gate.** `npm test` runs `node --test "src/test/unit/**/*.test.ts"` and relies on the **Node test runner's own globbing** — on a Node release where that glob support is absent or behaves differently, zero files match and the run reports success with everything passing. `make doctor` (`>=20`) accepts exactly those toolchains. The fix is a file-count floor (assert ≥1 test file matched) or `engines.node` enforcement. Given this repo's whole identity is "a gate that cannot fail is worse than a red build", this is the top-priority infra item | **high** |
| 40 | 90 | Console prints the full mocha output; only `reports/integration.log` keeps it. The plan wanted counts/duration/failure-summary on the console | low |

---

## Task 15 — Rich build contract — **judged: take the removal path**

**Scores: Overall 20 · Completeness 10 · Security 70 · Maintainability 60**

`scripts/gen-rich-manifest.mjs` (25 lines) backs up `package.json`, injects `enabledApiProposals: ["chatSessionsProvider","chatParticipantAdditions"]`, and stops there. There is **no `chatSessions` contribution** anywhere in the manifest and **no provider** — a sideloaded rich build is the stable build with inert proposals enabled, and `make release` ships it as a second artifact. The plan explicitly authorizes the alternative: *"remove `package-rich` from the release gate rather than shipping a proposal-only manifest with no provider"*; ADR-0002 (accepted) sanctions the rich build **with** the sessions API, so the authorization to drop is clean. Makefile hygiene around it is good (restore-always, exit-code preservation); residual: a `package.json.stable.bak` litter risk if the first step dies.

| # | Certainty | Finding | Severity |
|---|---|---|---|
| 41 | 100 | Ship a misleading second artifact or take the authorized removal. Removal is the correct call until a `chatSessions` provider + render-parity tests exist | medium |

---

## Task 16 — Documentation and release readiness — **judged Mostly clean, pre-release**

**Scores: Overall 70 · Completeness 60 · Security 90 · Maintainability 85**

No plan-reference violations anywhere: greps for `P[0-9]`/`HIGH-[0-9]`/`finding F`/`task <n>`/`implementation guide` across `src/` hit only `planId: "p1"` (an ACP protocol field) and a package-name list; test files are behaviour-named. The README makes no bootstrap-era claims — every claim (trust approval, no-download-at-session-start, orchestration off by default, API-key auth, permission prompts) matches shipped behaviour. `walkthrough/orchestrate.md` is honest about being off until enabled and about worktrees being coordination, not access control; residual tension: it promises fan-out that Tasks 12/13 cannot yet deliver **once enabled** (acceptable — enabling just disables nothing, the walkthrough never names which CLIs are reachable). No release changelog yet (expected pre-release). File sizes verified by `wc -l`: `participant.ts` 457, `session.ts` 498, `acpClient.ts` 492, `policy.ts` 474, `mock-agent.ts` 423 — all under 500 **except**:

| # | Certainty | Finding | Severity |
|---|---|---|---|
| 42 | 100 | **`src/core/runtimeRegistry.ts` is 502 lines — over the repo's 500-line rule.** No sub-agent audit flagged it; splitting by responsibility (e.g. the built-in catalog table vs the resolution/fingerprint logic) is the prescribed remedy | medium |
| 43 | 70 | Vendor/ACP claims still need primary-source verification with date+links recorded in release docs (explicitly owed by the plan; the guide's Appendix A list is the worklist) | medium |

---

## Build / Lint / Test Infrastructure (cross-cutting judgement)

**Scores: Overall 85 · Completeness 90 · Security 90 · Maintainability 90**

- **Seam check:** two independent enforcers (esbuild externals + eslint `no-restricted-imports` + grep checker writing `reports/core-imports.log`), with an *inverted* self-test — it plants five probe imports (all import forms plus a bare string) and asserts the checker **fails** each, plus a `false | tee` pipe probe proving pipefail isn't swallowed. Proof-of-detectability is the right shape. Gap: no positive case proving a healthy gate stays green (a global `SHELL` misconfig would pass gate-selftest and fail `lint`).
- **tsconfig/eslint:** `strict: true`; grep finds **zero** type-position `any` in `src/**` (38 comment hits only) — the no-`any` rule holds.
- **esbuild:** four bundles (extension CJS matching `main: ./dist/extension.cjs` — CJS is correct for the extension entry; shim; mock agent; test suite with mocha externaled); `external: ["vscode"]` on the extension.
- **`.vscodeignore`:** a correct allow-list (`**` + explicit negations for `dist/extension.cjs[.map]`, `dist/mcp-shim.cjs[.map]`, `media`, `walkthrough`, `package.json`, `README.md`, `LICENSE`); no negation reaches `src/`, tests, fixtures, or the mock. The ship-everything trap is avoided.
- **leak-guard:** right tool for the stated problem; detects sockets, ref'd timers, and children with stdio it inherits. Blind spot (documented-class): an `unref`'d child with `stdio: "ignore"` holds nothing and escapes the guard — the mock's `spawns-child` mode is that exact shape, and the focused unit test covers it, so the impact is bounded.
- **Composition root:** every host registration lands in `context.subscriptions`; the extension-store teardown is awaited in `deactivate`; the terminal integration test asserts `diffs.size === 0` after stop; a still-opening session is drained via a generation counter. No leak path found. **(95/100)**
- **Line-count rule:** breached once — `runtimeRegistry.ts` 502 (issue #42). Docs: plan files themselves exceed 600 lines where applicable; judged doc included.

---

## Issue Register (sorted by severity, then certainty)

High:

| # | Task | Certainty | Issue |
|---|---|---|---|
| 39 | 14/infra | 80 | Node test-runner glob + loose `doctor` = a possible green zero-test run on toolchains the repo accepts (G1; fix: file-count floor / `engines.node`) |
| 20 | 6 | 92 | Gemini workspace-suppression channel unwired end-to-end → Gemini permanently ineligible for Shim injection (fail-closed dead end; finish consent path or document) |
| 36 | 12 | 60* | Latent: capability token must enter the ADR-0010 redaction set at build time or an agent env-dump leaks it (*design-level; code unimplemented) |

Medium:

| # | Task | Certainty | Issue |
|---|---|---|---|
| 42 | 16 | 100 | `runtimeRegistry.ts` 502 lines breaches the 500-line rule (verified `wc -l`) |
| 33 | 11 | 100 | Sessions view contributed with no provider — dead UI in every install |
| 38 | 14 | 100 | `engines.node` missing from `package.json` |
| 41 | 15 | 100 | `package-rich` ships a proposal-only manifest with no provider — take the plan's removal path |
| 15 | 5 | 90 | `runtime_registry.test.ts` never deleted; behaviour covered by up to three overlapping test files |
| 16 | 5 | 90 | Registry feed URL user-editable, unsigned — version pin ≠ artifact authenticity (pin URL and/or document hash) |
| 37 | 12 | 80 | Plan omits hash-first for `timingSafeEqual` (throws on unequal lengths) |
| 21 | 6 | 70 | Suppression argv/env recipes need primary-source re-verification (Task 16 owes it) |
| 43 | 16 | 70 | Vendor/ACP claims unverified from primary sources with dates/links |
| 28 | 9 | 70 | Mid-probe API-key store changes the fingerprinted identity after approval; error blames the wrong cause |

Low / informational:

| # | Task | Certainty | Issue |
|---|---|---|---|
| 1 | 1 | 85 | Four of five ratified terms have no code identifiers yet |
| 2 | 1 | 80 | Versioned Persisted Session has no pinned record shape |
| 3 | 1 | 70 | Suppression `env` map skips the secret-shape tripwire |
| 4 | 1/14 | 95 | `doctor` accepts bare `>=20` (folded into #39) |
| 5 | 2 | 98 | Mock is mode-branched; script-as-data would prevent the inevitable 500-line breach |
| 6 | 2 | 75 | `spawns-child` fixture orphans its worker on Windows (leak-guard blind spot: unref'd `stdio:"ignore"` children) |
| 7 | 2 | 85 | Malformed-stdout test couples to SDK `console.error` text |
| 8 | 3 | 85 | `cwd` not pre-`stat`'d before spawn (fail-safe surfaces anyway) |
| 9 | 3 | 60 | Dead agent can leave the consent modal pending until user interaction |
| 10 | 3 | 90 | Mid-Session corrupt response line leans on the 10-minute stall limit only (document the constant) |
| 11 | 3 | 95 | Grace→SIGTERM tests live in `session_bounds.test.ts`, not the plan-named file (real tests) |
| 12 | 4 | 55 | Out-of-order `config_option_update` wins — inherent to ACP v1 |
| 13 | 4 | 80 | Pre-`sessionId` `config_option_update` adoption (protocol-violating agent only) |
| 14 | 4 | 75 | No test pin for agent-reported `currentValue` absent from its options list |
| 17 | 5 | 75 | Claude adapter bin-name drift suspected (`claude-agent-acp` vs upstream `claude-code-acp`) — verify |
| 18 | 5 | 70 | Orphaned `*.tmp` files under global storage after activation crash |
| 19 | 5 | 85 | Real-fs port of `executables.ts` untested directly |
| 22 | 7 | 95 | Case-sensitive containment ceiling on case-insensitive volumes (documented, safe direction) |
| 23 | 7 | 90 | Exact-string dirty-buffer lookup can miss one macOS spelling |
| 24 | 7 | 85 | Terminal consent dialog doesn't disclose inherited host env |
| 25 | 7 | 85 | Settings test is one-directional (schema→manifest), new manifest keys can go unconsumed |
| 26 | 7 | 80 | One bad secret literal drops the whole Runtime entry (fail-closed, heavy) |
| 27 | 9 | 85 | Fan-out modal dismissal = decline-and-continue, contradicting the wizard's cancel rule |
| 29 | 9 | 75 | `recordTrust` outside the save try/catch misdiagnosable failure |
| 30 | 9 | 95 | `wizardTerminal`/`registered` module globals bend the single-state-object claim |
| 31 | 9 | 90 | `describeRefresh` offline wording untested |
| 32 | 10 | 100 | `resumeOnStartup` dead setting (no consumer) |
| 34 | 12 | 95 | `orchestrator_status` unauthenticated placeholder tool |
| 35 | 12 | 95 | Shim header comment claims a token-authed tunnel that does not exist |
| 40 | 14 | 90 | Integration console prints full output; counts-only half of the plan unmet |
| 44 | infra | 70 | `gate-selftest` has no positive case (proves failure detection, not green-gate stability) |
| 45 | infra | 85 | leak-guard blind spot for unref'd `stdio:"ignore"` children (known ceiling; focused tests cover instances) |

---

## Bottom Line

- **Judged Overall 81 (delivered core 91, security 92, maintainability 85);** completeness 66 because four of the plan's eight remaining tasks (10, 11, 12, 13) are unimplemented, and the one implemented-but-shipped gap that hurts users today is the **dead Sessions view** (#33).
- **The implementation quality of what exists is unusually high.** The targeted classic bugs — per-chunk UTF-8 framing, cross-Session kills, unredacted secrets, glob path escapes, recycled process-group signalling, tautological tests, plan-ID references in code — were all specifically hunted and are **absent**. Fail-closed is the default posture everywhere, including in the unbuilt parts (empty shim, off-by-default orchestration, vacuously-satisfied injection gate).
- **Fix-first list (small, high leverage):** #39 green-gate floor / `engines.node` → #42 split the 502-line file → #33 remove-or-build the view → #41 drop `package-rich` → #15 delete the leftover test file. Then #20 (Gemini consent path or documentation) decides whether orchestration will ever work for Gemini at all, and #36 must be designed in **before** `ipc.ts` is written.
- **Task 8, in progress, is the milestone whose definition-of-done should consume #33, #38, #39 and #40** — the plan already says Task 14 owns them, and the runner proves the host-side harness is real.
