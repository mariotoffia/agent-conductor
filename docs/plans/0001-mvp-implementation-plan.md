# Agent Conductor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the documented Agent Conductor MVP as a secure, testable TypeScript VS Code extension that drives ACP v1 agents, renders sessions, and supports policy-controlled cross-runtime subagents.

**Architecture:** Keep ACP/session/orchestration logic in the `vscode`-free core and adapt it through explicit VS Code client-service ports. Resolve the trust, process-lifecycle, worktree, authentication, and orchestration-capability flaws below in durable ADRs before enabling agent execution. Build one tested direct-session vertical slice before adding registry, orchestration, and richer UI surfaces.

**Tech Stack:** TypeScript, Node.js, VS Code Extension API, `@agentclientprotocol/sdk`, `@modelcontextprotocol/sdk`, Zod, esbuild, Node test runner, `@vscode/test-electron`.

---

Status: active. Plans are temporary; promote durable decisions to ADRs or canonical root documents before deleting them.

## Milestone Status

| Deliverable | Exit criterion | Status |
|---|---|---|
| Core ACP client and mock Agent | Handshake, prompt, Updates, cancel, and permissions covered by unit tests | Done |
| Stable direct Session | `@conductor` streams messages, thoughts, tool calls, diffs, permissions, usage, and Read-back | Pending |
| Wizard, settings, and multiple Runtimes | Claude, Codex, Gemini, and Copilot can be validated and configured from live Config Options | Pending |
| Orchestrator | Suppression, authenticated Shim tools, worktrees, limits, cancellation cascade, and Sessions tree pass integration tests | Pending |
| Real release gate | `make check-all` runs non-empty extension-host tests against the mock Agent | Pending |
| Rich VSIX build | Proposed Session UI has render parity with the stable sink, or the unfinished package target is removed | Pending |
| ACP-agent Facade | Conductor is exposed as an ACP Agent by reusing `src/core` | Deferred until the MVP gates pass |

## Audit Basis

This plan compares all root Markdown documents, `docs/**/*.md`, `package.json`, `Makefile`, build configuration, and every `src/**/*.ts` file as of 2026-08-18.

Authority order used by the audit:

1. Accepted ADRs and the canonical root documents `AGENTS.md`, `ARCHITECTURE.md`, `UBIQUITOUS.md`, and `PERSONAS.md`.
2. Current source and executable tests as evidence of implementation.
3. `docs/plans/**` as temporary implementation guidance only.
4. `README.md` and walkthroughs as user-facing claims, not proof of implementation.

`CLAUDE.md` is a symlink to `AGENTS.md`; no rule conflict was found. The worktree already contained unrelated changes before this plan was written; implementation must preserve them.

## Current Implementation Status

| Capability | Status | Evidence | Required outcome |
|---|---|---|---|
| TypeScript build and core extraction seam | Implemented | `esbuild.mjs`, `tsconfig.json`, `Makefile`; `src/core/**` has no `vscode` import | Keep both bundles and enforce the seam in `make lint`. |
| Toolchain preflight | Partial | `make doctor` accepts Node 20+, while the locked lint dependency requires `^20.19.0 || ^22.13.0 || >=24` | Align package engines and doctor checks with the lockfile-supported runtime range. |
| Built-in runtime metadata | Partial | `src/core/runtimeRegistry.ts` contains four static entries | Add overrides, detection, secure executable resolution, custom runtimes, registry cache, and launch validation. |
| Suppression value builders | Partial | `src/core/policy.ts` builds Claude, Codex, Gemini, and Copilot values | Attach them to launch/session flows, make capability explicit, verify every recipe, and add merge/revert handling for Gemini. |
| Unit tests | Partial | Protocol, lifecycle, mock-Agent, policy, and manifest coverage under `src/test/unit/` | Add discovery, registry, IPC, orchestrator, and VS Code integration coverage. |
| Extension activation | Implemented | `src/extension.ts` registers an output channel and manifest commands | Replace bootstrap handlers with a composition root and deterministic teardown. |
| Connect-a-CLI command | Stub | Runtime picker only; no detection, probe, auth, smoke test, or save | Implement the cancellable wizard and persist only validated configuration. |
| Chat participant and slash commands | Stub | Participant always prints bootstrap text and ignores the request | Create sessions, dispatch commands, stream every supported Update, and cancel turns. |
| ACP client and Session lifecycle | Implemented | `src/core/acpClient.ts`, `src/core/session.ts`; contract and lifecycle tests under `src/test/unit/` | Keep one process per Session; Config Option Read-back and persistence build on it. |
| Config Option discovery and Read-back | Absent | Types mention effort but no protocol handling exists | Drive selectors from live `configOptions`, retain complete refreshes, and expose requested versus effective values. |
| Permission, filesystem, terminal, and elicitation client services | Absent | No `src/vscode/**` implementation exists | Add validated ports and VS Code adapters without claiming they sandbox the Agent process. |
| Sessions tree, transcript, and diff provider | Absent | Manifest contributes a view but no provider is registered | Render direct and child Session state and wire cancel/resume/diff commands. |
| Runtime registry refresh | Stub | Command only logs; `make registry-cache` is a developer download | Add schema validation, cache TTL, pinning, offline fallback, and manual refresh. |
| MCP Shim | Stub | `orchestrator_status` does not authenticate or tunnel | Require a session capability, implement framed IPC, and expose lifecycle tools. |
| Orchestrator | Absent | No spawn tree, limits, budget, worktree, or child cancellation code | Implement after the direct Session path and security decisions are green. |
| Settings consumption and SecretStorage | Absent | Manifest settings are never read; runtime `env` can store secrets | Add typed configuration and secret references; remove plaintext secret paths. |
| Stable Marketplace UI | Partial manifest only | Participant/view declarations exist | Complete stable UI before presenting the extension as usable. |
| Rich proposed-API VSIX | Stub | Script only injects proposal names | Add the proposal contribution/provider or remove the target until implemented. |
| Integration release gate | False positive | `test:integration` prints a placeholder and exits successfully | Replace it with an extension-host/mock-agent suite; an unavailable harness must fail. |
| ACP-agent Facade | Deferred | Canonical architecture calls it planned/optional | Keep outside MVP until stable UI and orchestration gates pass. |
| AHP support | Intentionally deferred | ADR-0001 | Do not implement without a superseding ADR. |

## Architecture and Design Issues

### Permission routing is not an Agent sandbox (critical)

An ACP Agent is a spawned executable with the user's OS privileges and may have native tools outside client-mediated ACP requests. `ToolKind` is Agent-supplied classification and cannot be a security boundary. Treat configured Agent binaries and adapters as part of the trusted computing base; classify client-owned fs/terminal operations from the requested method and arguments, and describe permission routing as user consent/audit policy. Custom runtimes must not receive orchestration capabilities until explicitly trusted.

### Orchestration authentication is too broad (high)

`ARCHITECTURE.md` specifies one Shim token per window. Any eligible compromised Session could impersonate another Session. Issue random per-Session capabilities bound in the extension to parent Session, depth, workspace roots, expiry, and allowed RPC methods. Do not accept caller-supplied lineage or policy fields.

### Process reuse conflicts with cancellation fallback (high)

The temporary guide permits multiple Sessions per connection, while cancellation escalates to terminating the process. A hung Session could therefore kill unrelated Sessions. Use one Agent process per Session for v1. Revisit pooling only after the protocol/lifecycle layer can isolate cancellation and crash ownership.

### Worktrees are coordination isolation, not security isolation (high)

A Git worktree separates branches and working files but cannot make the parent repository read-only to an Agent process. Do not grant the parent repository through `additionalDirectories` by default and do not call a worktree a security boundary. Define allocation, branch naming, Git locking, cleanup, crash recovery, and user-retained work semantics.

### Authentication defaults contradict the stated fan-out posture (high)

ADR-0006 calls subscription fan-out opt-in, while inherited CLI auth and orchestration are enabled by default in the manifest. Direct Sessions may inherit a user's CLI login; subagent fan-out must require explicit acknowledgement or API-key-backed configuration after current vendor policy is verified from primary sources. Never infer credential type from logs or persist credentials in settings.

### Plaintext runtime environment settings violate the secret invariant (high)

`agentConductor.runtimes.*.env` permits arbitrary secrets in settings JSON. Replace it with SecretStorage references for sensitive variables and catalog-owned computed environment values. Log environment variable names only, never values.

### Suppression and budget guarantees are overstated (high)

Suppression is vendor-specific and cannot be guaranteed for arbitrary custom Agents. Cost limits are unavailable on some Runtimes. Model these as discovered capabilities: orchestration is fail-closed unless suppression is verified, while concurrency, depth, spawn-count, and timeout limits are always enforced locally. Display cost as unknown when the Agent does not report it.

### Mandatory Read-back conflicts with unsupported Runtime declarations (high)

Gemini and Copilot currently declare `effortReadback: false`, but ADR-0005 requires effective-value Read-back. Do not label requested values as effective. Hide an unverifiable selector or show it as requested/unverified; enable it only when live Config Options or Session updates provide effective values.

### Built-in adapter launch is mutable and network-dependent (high)

PATH-resolved `npx` without an exact version can execute changed remote code at spawn time and contradicts cached, pinnable, offline-safe registry claims. The wizard must resolve an installed absolute executable or install an exact pinned adapter with explicit consent. Normal Session startup must not download code.

### ACP capability handling is too absolute (medium)

Only send `additionalDirectories` when the Agent advertises support. Treat Config Option categories as UI hints: preserve and surface uncategorized options rather than making category presence a correctness requirement. Re-send sorted `mcpServers` and supported directories on load/resume.

### Brief-only delegation is policy, not enforceable data isolation (medium)

A Brief can still cause an Agent/provider to read and transmit repository data. Add an explicit cross-provider delegation notice and Runtime allowlist. Record target Runtime/provider in Session history without recording secrets or hidden prompt content.

### Persistence and rich-channel contracts are underspecified (medium)

Canonical docs require resume and a second rendering sink but define neither the persisted Session record nor parity contract. Specify versioned metadata-only persistence and a shared render-model interface before implementing resume or the rich provider.

### Toolchain compatibility is checked too loosely (medium)

`Makefile` accepts every Node release from 20 onward, but the locked lint dependency rejects early Node 20, early Node 22, and Node 23. This makes `make doctor` capable of approving an unsupported environment. Declare and check the exact supported ranges `^20.19.0 || ^22.13.0 || >=24` unless a dependency update broadens them.

## Target File Map

| File | Responsibility |
|---|---|
| `docs/adr/0007-agent-trust-and-client-permissions.md` | Trusted computing base, advisory ACP permissions, custom Runtime trust. |
| `docs/adr/0008-session-process-and-orchestration-capabilities.md` | Process-per-Session lifecycle and per-Session Shim capabilities. |
| `docs/adr/0009-worktree-and-provider-isolation.md` | Worktree semantics, cleanup, and cross-provider consent. |
| `docs/adr/0010-authentication-and-secret-references.md` | Direct-session auth, fan-out opt-in, and SecretStorage references. |
| `ARCHITECTURE.md`, `UBIQUITOUS.md` | Durable corrected invariants and terms. |
| `src/core/runtimeRegistry.ts` | Built-ins, overrides, detection, registry resolution, trust/capabilities. |
| `src/core/acpClient.ts` | One subprocess and ACP connection per Session. |
| `src/core/session.ts` | Session state machine, prompt/update loop, cancel/load/dispose. |
| `src/core/discovery.ts` | Config Option normalization and requested/effective Read-back. |
| `src/core/policy.ts` | Permission decisions and complete Suppression Plans. |
| `src/core/ipc.ts` | Authenticated framed IPC with per-Session capability lookup. |
| `src/core/orchestrator.ts` | Child lifecycle, limits, worktrees, and cancellation cascade. |
| `src/core/sessionStore.ts` | Versioned metadata-only Session persistence. |
| `src/vscode/config.ts` | Typed settings and SecretStorage adapter. |
| `src/vscode/permissions.ts` | Modal consent and remembered choices. |
| `src/vscode/fsProvider.ts` | Root-validated reads/writes, dirty buffers first. |
| `src/vscode/terminals.ts` | Structured process execution and bounded output. |
| `src/vscode/participant.ts` | Stable chat commands and render-model sink. |
| `src/vscode/sessionsTree.ts` | Session/Subagent tree and actions. |
| `src/vscode/diffDocs.ts` | Virtual old-text documents and diff command. |
| `src/vscode/wizard.ts` | Detection, probe, auth handoff, discovery, smoke test, save. |
| `src/vscode/composition.ts` | Extension wiring and disposal. |
| `src/shim/mcp-shim.ts` | MCP tools and capability-authenticated IPC client. |
| `src/test/mock-agent.ts` | Deterministic ACP v1 test Agent. |
| `src/test/unit/**`, `src/test/integration/**` | Behavior-focused unit and extension-host tests. |

## Implementation Tasks

### Task 1: Ratify the security and lifecycle model

**Files:** Create ADRs 0007-0010; modify `ARCHITECTURE.md`, `UBIQUITOUS.md`, `package.json`.

- [ ] Draft the four ADRs with `Status: proposed`, alternatives, consequences, and the exact trust, lifecycle, worktree, provider, authentication, and secret decisions listed above.
- [ ] Obtain repository-owner approval for all four ADRs and change their status to `accepted`; do not begin Agent process implementation while any remains proposed.
- [ ] Change orchestration to explicit opt-in in `package.json`:

```json
"agentConductor.orchestration.enabled": { "type": "boolean", "default": false }
```

- [ ] Replace plaintext Runtime `env` with secret references:

```json
"secretEnvironment": {
  "type": "object",
  "additionalProperties": { "type": "string" },
  "description": "Environment variable name to VS Code SecretStorage key reference."
}
```

- [ ] Define `RuntimeTrust`, `SuppressionCapability`, `BudgetCapability`, `SessionCapability`, and versioned `PersistedSession` in the canonical docs before adding identifiers to code.
- [ ] Run `make lint && make test`; expect exit 0. Commit: `docs: ratify agent trust and session lifecycle`.

### Task 2: Build the mock ACP Agent before production protocol code

**Files:** Create `src/test/mock-agent.ts`, `src/test/unit/mock_agent.test.ts`; modify `package.json`.

- [x] Implement a deterministic stdio ACP v1 Agent using the pinned SDK's actual APIs. It scripts initialize/auth methods, Session creation, two Config Options, message/thought/tool/diff/plan/usage updates, permission requests, cancellation, load, and malformed/timeout modes.
- [x] Test the mock Agent as a real subprocess, including Session setup/reinjection capture, prompt updates, permission forwarding, cooperative cancellation, malformed stdout, stderr, timeout, and child-exit modes.
- [x] Make `make test` include every `src/test/unit/**/*.test.ts` file rather than a single directory glob.
- [x] Run the focused mock Agent tests, then `make lint && make test`; expect exit 0. Commit: `test: add deterministic ACP mock agent`.

### Task 3: Implement one-process-per-Session ACP lifecycle

**Files:** Create `src/core/acpClient.ts`, `src/core/session.ts`; modify `src/core/types.ts`, `src/core/index.ts`.

- [x] Write failing client contract tests for initialize, absolute `cwd`, stable sorted `mcpServers`, capability-conditional `additionalDirectories`, prompt updates, permission forwarding, cancellation grace fallback, load/resume reinjection, malformed stdout, stderr capture, and child exit.
- [x] Define narrow ports for permission, fs, terminal, elicitation, logging, clocks, and process spawning. Do not import `vscode`.
- [x] Spawn only validated absolute commands with `shell: false`, inherited non-secret environment, catalog policy environment, and resolved SecretStorage values supplied by the UI adapter.
- [x] Implement initialize, `session/new`, `session/load`, prompt/update dispatch, Config Option notifications, cancel grace timer, SIGTERM fallback, child-exit failure, and idempotent dispose.
- [x] Ensure every Session owns exactly one process and cancellation cannot terminate another Session.
- [x] Run `node --import tsx --test src/test/unit/acp_client.test.ts`; expect all ACP lifecycle tests to pass. Run `make lint`; expect exit 0. Commit: `feat: add ACP session lifecycle`.

### Task 4: Implement Config Option discovery and Read-back

**Files:** Create `src/core/discovery.ts`, `src/test/unit/config_discovery.test.ts`; modify `src/core/types.ts`, `src/core/session.ts`.

- [ ] Test category-based model/thought-level extraction, uncategorized preservation, complete-array replacement, unsolicited updates, changed valid values, mismatch detection, and unavailable Read-back.
- [ ] Represent selection state explicitly:

```ts
interface EffectiveSelection {
  requested?: string;
  effective?: string;
  verification: "verified" | "unavailable";
}
```

- [ ] Never synthesize model lists. Use catalog fallback only when Config Options are absent, and never call a fallback requested value effective without Agent evidence.
- [ ] Run `node --import tsx --test src/test/unit/config_discovery.test.ts`; expect pass. Commit: `feat: add config discovery and read-back`.

### Task 5: Make Runtime resolution secure and offline-safe

**Files:** Modify `src/core/runtimeRegistry.ts`, `src/core/types.ts`; create `src/core/registryCache.ts`, `src/test/unit/runtime_registry.test.ts`.

- [ ] Test built-in overrides, disabled/custom Runtimes, trust state, suppression/budget/read-back capabilities, exact version pins, invalid schemas, stale cache, offline fallback, and executable validation.
- [ ] Resolve command paths in the wizard/registry layer and reject relative or missing commands before Session spawn.
- [ ] Allow exact-version adapter installation only as an explicit wizard action; Session startup must never invoke an installer or network-fetching `npx` path.
- [ ] Validate registry JSON with Zod and atomically cache it under VS Code global storage through a core storage port.
- [ ] Run `node --import tsx --test src/test/unit/runtime_registry.test.ts`; expect pass. Commit: `feat: resolve trusted runtime launches`.

### Task 6: Complete and verify Suppression Plans

**Files:** Modify `src/core/policy.ts`, `src/core/runtimeRegistry.ts`; create `src/test/unit/suppression_policy.test.ts` and golden fixtures under `src/test/fixtures/suppression/`.

- [ ] Test exact enabled/disabled argv, env, workspace merge, and Session `_meta` for all built-ins.
- [ ] Add Gemini merge/revert with preserved unrelated JSON and crash-safe atomic writes; require recorded consent.
- [ ] Probe Copilot's live tool list in the wizard and fail orchestration closed if delegation-tool suppression cannot be verified.
- [ ] Mark custom Runtimes ineligible for Shim injection until the user supplies and verifies a Suppression Plan.
- [ ] Run `node --import tsx --test src/test/unit/suppression_policy.test.ts`; expect pass. Commit: `feat: enforce runtime suppression capabilities`.

### Task 7: Add typed VS Code configuration and client services

**Files:** Create `src/vscode/config.ts`, `permissions.ts`, `fsProvider.ts`, `terminals.ts`; create focused unit tests with VS Code ports under `src/test/unit/`.

- [ ] Parse and validate all `agentConductor.*` settings; reject invalid conflicting auto-allow/auto-reject entries and secret literals.
- [ ] Resolve `secretEnvironment` values from `ExtensionContext.secrets`; redact values from errors and logs.
- [ ] Decide client-owned fs/terminal policy from method and normalized arguments, using Agent `ToolKind` only as display metadata.
- [ ] Serve dirty buffers first; normalize real paths; reject paths outside the Session roots; use `WorkspaceEdit` for open files.
- [ ] Spawn terminal commands with structured command/args and `shell: false`; implement bounded ring-buffer output, wait, kill, and release.
- [ ] Add form elicitation with cancel behavior so supported Agents need not silently disable questions.
- [ ] Run focused tests, then `make lint`; expect pass. Commit: `feat: add VS Code ACP client services`.

### Task 8: Deliver the direct Session vertical slice

**Files:** Create `src/vscode/participant.ts`, `diffDocs.ts`, `composition.ts`; modify `src/extension.ts`, `package.json`; create integration tests.

- [ ] Gate every spawn on `vscode.workspace.isTrusted` and a configured trusted Runtime.
- [ ] Dispatch `/runtime`, `/model`, `/effort`, `/cancel`, and ordinary prompts; remove the bootstrap response.
- [ ] Map every documented Update to a stable render model, including messages, thoughts, tool calls/updates, diffs, plans, available commands, usage, and Session info.
- [ ] Register `agentConductor.openDiff` and a virtual document provider; keep old text bounded and dispose it with the Session.
- [ ] Wire cancellation tokens to Session cancel and return the ACP cancelled outcome.
- [ ] Run the extension-host test for one mock Session end to end; expect streamed content, permission behavior, Read-back, diff command, and clean teardown. Commit: `feat: run direct ACP sessions in chat`.

### Task 9: Implement the Connect-a-CLI wizard

**Files:** Create `src/vscode/wizard.ts`; modify `src/vscode/composition.ts`, `runtimeRegistry.ts`; create wizard unit and integration tests.

- [ ] Implement cancellable detect, configure, trust, auth handoff, Config Option discovery, policy, smoke test, and save stages with a single state object.
- [ ] Probe in a temporary directory with writes/execute rejected; require the smoke response `OK`; show effective selections and mismatches.
- [ ] Give every probe stage a short Setup Deadline instead of the Session default, so a silent Runtime fails the wizard step quickly rather than after the full session-setup wait.
- [ ] Persist only after successful validation; preserve existing Runtime entries and let the user choose global or workspace scope.
- [ ] Require explicit acknowledgement for cross-provider/subscription-backed fan-out; direct Sessions remain independently configurable.
- [ ] Wire registry refresh to validated cache refresh and visible offline fallback.
- [ ] Run focused wizard tests and the mock-Agent smoke integration test; expect pass. Commit: `feat: connect and validate ACP runtimes`.

### Task 10: Specify and implement metadata-only Session persistence

**Files:** Create `src/core/sessionStore.ts`, `src/test/unit/session_store.test.ts`; modify `src/core/session.ts`, `src/vscode/config.ts`.

- [ ] Test schema migration, corrupt records, missing Runtime/workspace, restart recovery, and metadata redaction.
- [ ] Persist IDs, Runtime, workspace, timestamps, requested/effective selection, stop state, parent ID, worktree metadata, and Agent resume token only when supported. Do not persist prompts, hidden context, credentials, or tool payloads by default.
- [ ] On startup, list resumable metadata; load only on explicit user action unless `resumeOnStartup` is enabled and trust still holds.
- [ ] Re-send sorted MCP servers and capability-supported directories on load.
- [ ] Run `node --import tsx --test src/test/unit/session_store.test.ts`; expect pass. Commit: `feat: persist resumable session metadata`.

### Task 11: Add the Sessions tree and actions

**Files:** Create `src/vscode/sessionsTree.ts`; modify `src/vscode/composition.ts`, `package.json`; create integration tests.

- [ ] Render Session/Subagent hierarchy with Runtime, verified selection, cost/unknown, duration, state, and mismatch markers.
- [ ] Wire new, cancel, cancel-all, resume, and open-worktree-diff commands to actual Session ownership.
- [ ] Update on Session events without blocking the extension host; remove disposed Sessions predictably.
- [ ] Run the sessions-tree extension-host tests; expect direct Session state and actions to pass. Commit: `feat: add session navigation`.

### Task 12: Implement per-Session authenticated IPC and the Shim

**Files:** Create `src/core/ipc.ts`, `src/shim/socketClient.ts`; modify `src/shim/mcp-shim.ts`; create IPC and Shim tests.

- [ ] Test missing/malformed/expired capabilities, cross-Session replay, wrong workspace/depth, oversized frames, disconnects, and unsupported methods before happy paths.
- [ ] Use length-bounded NDJSON request/response over a random local socket/pipe with restrictive filesystem permissions where supported.
- [ ] Bind each random capability server-side to immutable Session ID, parent ID, depth, roots, expiry, and allowed methods; compare secrets in constant time.
- [ ] Expose `list_runtimes`, `spawn_subagent`, `check_subagent`, `subagent_result`, and `cancel_subagent`; validate every input with Zod.
- [ ] Remove `orchestrator_status` or make it authenticated and non-sensitive.
- [ ] Run focused IPC/Shim tests; expect pass. Commit: `feat: authenticate orchestrator shim calls`.

### Task 13: Implement bounded orchestration and worktree lifecycle

**Files:** Create `src/core/orchestrator.ts`, `src/core/worktrees.ts`; modify `session.ts`, `ipc.ts`, `composition.ts`; create orchestrator tests.

- [ ] Test suppression/trust fail-closed behavior, defaults, depth, concurrency, aggregate spawn count, timeout, optional Runtime budget forwarding, background handles, parent cancellation, and result metadata.
- [ ] Inject the absolute bundled Shim command only when depth and verified suppression allow it; sort MCP servers by name.
- [ ] Implement sync/background child states and cancellation cascade without sharing conversation context.
- [ ] Serialize Git mutations; use deterministic unique branches; record allocation before `git worktree add`; reconcile abandoned allocations on activation; never delete a dirty worktree automatically.
- [ ] Keep parent repositories out of `additionalDirectories` by default. Describe worktree mode as change coordination, not access control.
- [ ] Return unknown cost when unsupported and enforce local limits regardless of Runtime budget support.
- [ ] Run focused orchestrator tests and a mock Agent -> Shim -> child Agent integration test; expect pass. Commit: `feat: orchestrate bounded subagent sessions`.

### Task 14: Replace the false integration gate

**Files:** Create `src/test/integration/**`, test runner configuration; modify `package.json`, `Makefile`.

- [ ] Add `engines.node: "^20.19.0 || ^22.13.0 || >=24"` to `package.json` and make `doctor` enforce the same ranges before dependency installation.
- [ ] Add `@vscode/test-electron` and run the extension in an isolated test workspace against the bundled mock Agent.
- [ ] Cover activation, trust refusal, wizard save, direct prompt rendering, permissions, Config Option round-trip, cancellation, resume, sessions tree, Shim child result, and teardown.
- [ ] Make missing VS Code binaries, harness setup failures, or zero discovered tests fail nonzero.
- [ ] Keep full output in `reports/integration.log` and print only count, duration, and failure summary.
- [ ] Run `make check-all`; expect build, lint, unit, and real extension-host integration tests to pass. Commit: `test: enforce extension-host release gate`.

### Task 15: Complete or remove the rich build contract

**Files:** Create `src/vscode/richSessions.ts` and proposal-specific tests, or modify `scripts/gen-rich-manifest.mjs` and `Makefile` to remove the unfinished target; update ADR-0002 if the decision changes.

- [ ] Define one surface-neutral render model consumed by both stable and rich sinks.
- [ ] If retained, generate both proposal declarations and the required `chatSessions` contribution, register the provider only in the rich build, and test render parity for every Update variant.
- [ ] If proposal APIs have drifted or parity is not implementable, remove `package-rich` from the release gate rather than shipping a proposal-only manifest with no provider.
- [ ] Run `make check-all package package-rich` only when the rich provider exists and tests pass. Commit: `feat: add rich session rendering` or `build: defer rich session package`.

### Task 16: Align user-facing documentation and release readiness

**Files:** Modify `README.md`, `walkthrough/*.md`, `docs/plans/0001-mvp-implementation-plan.md`; add release changelog under `docs/`.

- [ ] Remove bootstrap usability claims until the direct vertical slice passes; then document actual prerequisites, trust, auth, cost, provider egress, worktree limits, and supported Runtime capabilities.
- [ ] Mark milestones from executable evidence only. Promote remaining durable guidance from temporary plans into canonical docs/ADRs, then delete obsolete plan content without leaving code/test references to it.
- [ ] Verify current ACP and vendor claims against primary sources before release; record verification date and links in release documentation, not code.
- [ ] Run `make lint` and `make test`; expect pass. Run `make check-all`; expect a real integration count greater than zero.
- [ ] Confirm all code files are at most 500 lines and docs at most 600 lines; split by responsibility when exceeded.
- [ ] Package with `make package` and, only if Task 15 retained it, `make package-rich`. Never publish automatically. Commit: `docs: describe verified Agent Conductor behavior`.

## Deferred Work

The ACP-agent Facade remains optional and must be planned separately after Tasks 1-16 pass. AHP remains excluded by ADR-0001. Live-CLI smoke tests remain manual/optional because CI must not require installed CLIs, credentials, subscriptions, or network.

## Global Completion Gate

The MVP is complete only when all of the following are evidenced in a fresh run:

```bash
make lint
make test
make check-all
```

All commands must exit 0; integration output must report real extension-host tests rather than a placeholder. The implementation must also show: no `vscode` imports under `src/core/**`; no plaintext secrets or secret values in logs; one process per Session; absolute commands/paths; stable sorted MCP servers; capability-conditional directories; verified requested/effective Read-back; fail-closed Shim injection; cancellation cascade; and no automatic deletion of dirty worktrees.

## Plan Self-Review

- Spec coverage: ACP client, stable UI, runtime discovery, Read-back, suppression, permissions/fs/terminal, wizard, registry, auth, persistence, orchestration, worktrees, Shim, tests, packaging, and docs are assigned to tasks.
- Deferred scope is explicit: Facade, AHP, and credentialed live-CLI CI are not hidden MVP requirements.
- Names are durable domain terms from `UBIQUITOUS.md`; implementation identifiers and test names do not reference plan/task/finding IDs.
- No implementation step relies on an unversioned remote executable, Agent-supplied security classification, shared process cancellation, or a placeholder integration pass.
