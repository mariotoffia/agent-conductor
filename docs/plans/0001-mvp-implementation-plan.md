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
| Orchestrator | Suppression, authenticated Shim tools, worktrees, limits, cancellation cascade, and Sessions tree pass integration tests | Partial — the Sessions tree passes extension-host tests; the rest waits on the Shim and Orchestrator |
| Real release gate | `make check-all` runs non-empty extension-host tests against the mock Agent | Pending |
| Rich VSIX build | Proposed Session UI has render parity with the stable sink, or the unfinished package target is removed | Removed — no second build channel exists (ADR-0011) |
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
| Connect-a-CLI command | Implemented | `src/vscode/wizard*.ts`, `src/core/connect.ts`; wizard and probe tests under `src/test/unit/` | Keep Runtime Trust recorded only after a Probe Session answers. |
| Chat participant and slash commands | Stub | Participant always prints bootstrap text and ignores the request | Create sessions, dispatch commands, stream every supported Update, and cancel turns. |
| ACP client and Session lifecycle | Implemented | `src/core/acpClient.ts`, `src/core/session.ts`; contract and lifecycle tests under `src/test/unit/` | Keep one process per Session; Config Option Read-back and persistence build on it. |
| Config Option discovery and Read-back | Absent | Types mention effort but no protocol handling exists | Drive selectors from live `configOptions`, retain complete refreshes, and expose requested versus effective values. |
| Permission, filesystem, terminal, and elicitation client services | Absent | No `src/vscode/**` implementation exists | Add validated ports and VS Code adapters without claiming they sandbox the Agent process. |
| Sessions tree, transcript, and diff provider | Implemented for direct Sessions | `src/vscode/sessionsTree.ts`, `sessionRows.ts`, `sessionActions.ts`; unit and extension-host coverage | Child Session rows need the Orchestrator to record lineage and worktrees. |
| Runtime registry refresh | Stub | Command only logs; `make registry-cache` is a developer download | Add schema validation, cache TTL, pinning, offline fallback, and manual refresh. |
| MCP Shim | Stub | `orchestrator_status` does not authenticate or tunnel | Require a session capability, implement framed IPC, and expose lifecycle tools. |
| Orchestrator | Absent | No spawn tree, limits, budget, worktree, or child cancellation code | Implement after the direct Session path and security decisions are green. |
| Settings consumption and SecretStorage | Absent | Manifest settings are never read; runtime `env` can store secrets | Add typed configuration and secret references; remove plaintext secret paths. |
| Stable Marketplace UI | Partial manifest only | Participant/view declarations exist | Complete stable UI before presenting the extension as usable. |
| Rich proposed-API VSIX | Removed | The generator and `package-rich` are gone; a gate refuses a manifest declaring a proposal nothing implements | None. Reviving the channel starts with an ADR superseding ADR-0011. |
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

**Files:** Create `src/core/discovery.ts`, `src/test/unit/config_discovery.test.ts`, `src/test/unit/config_readback_session.test.ts`, `src/core/sessionSpec.ts`; modify `src/core/types.ts`, `src/core/session.ts`, `src/test/mock-agent.ts`.

- [x] Test category-based model/thought-level extraction, uncategorized preservation, complete-array replacement, unsolicited updates, changed valid values, mismatch detection, and unavailable Read-back.
- [x] Represent selection state explicitly:

```ts
interface EffectiveSelection {
  requested?: string;
  effective?: string;
  verification: "verified" | "unavailable";
}
```

- [x] Never synthesize model lists. Use catalog fallback only when Config Options are absent, and never call a fallback requested value effective without Agent evidence.
- [x] Run `node --import tsx --test src/test/unit/config_discovery.test.ts`; expect pass. Commit: `feat: add config discovery and read-back`.

### Task 5: Make Runtime resolution secure and offline-safe

**Files:** Modify `src/core/runtimeRegistry.ts`, `src/core/types.ts`; create `src/core/registryCache.ts`, `src/test/unit/runtime_registry.test.ts` (split into `runtime_trust.test.ts` and `registry_cache.test.ts` with shared `src/test/runtime-fixtures.ts` to stay under the 500-line rule).

- [x] Test built-in overrides, disabled/custom Runtimes, trust state, suppression/budget/read-back capabilities, exact version pins, invalid schemas, stale cache, offline fallback, and executable validation.
- [x] Resolve command paths in the wizard/registry layer and reject relative or missing commands before Session spawn.
- [x] Allow exact-version adapter installation only as an explicit wizard action; Session startup must never invoke an installer or network-fetching `npx` path.
- [x] Validate registry JSON with Zod and atomically cache it under VS Code global storage through a core storage port. Core port and contract only; the global-storage adapter lands with the VS Code layer in Task 7.
- [x] Run `node --import tsx --test src/test/unit/runtime_registry.test.ts`; expect pass. Commit: `feat: resolve trusted runtime launches`.

### Task 6: Complete and verify Suppression Plans

**Files:** Modify `src/core/policy.ts`, `src/core/runtimeRegistry.ts`; create `src/test/unit/suppression_policy.test.ts` and golden fixtures under `src/test/fixtures/suppression/`.

- [x] Test exact enabled/disabled argv, env, workspace merge, and Session `_meta` for all built-ins.
- [x] Add Gemini merge/revert with preserved unrelated JSON and crash-safe atomic writes; require recorded consent.
- [x] Core-side verification lands here and fails closed (unreadable or empty tool list, plan naming nothing, no plan); the wizard-side probe that supplies the tool list lands with the wizard in Task 9.
- [x] Mark custom Runtimes ineligible for Shim injection until the user supplies and verifies a Suppression Plan.
- [x] Run `node --import tsx --test src/test/unit/suppression_policy.test.ts`; expect pass. Commit: `feat: enforce runtime suppression capabilities`.

### Task 7: Add typed VS Code configuration and client services

**Files:** Create `src/vscode/config.ts`, `permissions.ts`, `elicitation.ts`, `fsProvider.ts`, `terminals.ts`; create focused unit tests with VS Code ports under `src/test/unit/`.

- [x] Parse and validate all `agentConductor.*` settings; reject invalid conflicting auto-allow/auto-reject entries and secret literals.
- [x] Resolve `secretEnvironment` values from `ExtensionContext.secrets`; redact values from errors and logs.
- [x] Decide client-owned fs/terminal policy from method and normalized arguments, using Agent `ToolKind` only as display metadata.
- [x] Serve dirty buffers first; normalize real paths; reject paths outside the Session roots; use `WorkspaceEdit` for open files.
- [x] Spawn terminal commands with structured command/args and `shell: false`; implement bounded ring-buffer output, wait, kill, and release.
- [x] Add form elicitation with cancel behavior so supported Agents need not silently disable questions.
- [x] Run focused tests, then `make lint`; expect pass. Commit: `feat: add VS Code ACP client services`.

### Task 8: Deliver the direct Session vertical slice

**Files:** Create `src/vscode/participant.ts`, `diffDocs.ts`, `composition.ts`; modify `src/extension.ts`, `package.json`; create integration tests.

- [x] Gate every spawn on `vscode.workspace.isTrusted` and a configured trusted Runtime.
- [x] Dispatch `/runtime`, `/model`, `/effort`, `/cancel`, and ordinary prompts; remove the bootstrap response.
- [x] Map every documented Update to a stable render model, including messages, thoughts, tool calls/updates, diffs, plans, available commands, usage, and Session info.
- [x] Register `agentConductor.openDiff` and a virtual document provider; keep old text bounded and dispose it with the Session.
- [x] Wire cancellation tokens to Session cancel and return the ACP cancelled outcome.
- [x] Run the extension-host test for one mock Session end to end; expect streamed content, permission behavior, Read-back, diff command, and clean teardown. Commit: `feat: run direct ACP sessions in chat`.
  - `make test-integration` runs VS Code with this extension loaded and drives one Session against the bundled mock Agent. The wider coverage, the Node range and what the run prints came later, with the gate itself.

### Task 9: Implement the Connect-a-CLI wizard

**Files:** Created `src/core/connect.ts` and `src/vscode/wizard.ts`, `wizardPorts.ts`, `wizardSettings.ts`, `wizardTrust.ts`, `wizardHost.ts`; modified `src/vscode/composition.ts`, `src/core/{discovery,registryCache,session,types}.ts`; created wizard, probe and trust-disclosure unit tests.

- [x] Implement cancellable detect, configure, trust, auth handoff, Config Option discovery, policy, smoke test, and save stages with a single state object.
  - The policy stage is the fan-out acknowledgement, bound to the trust fingerprint. It records no Suppression Capability: verification needs both a live tool list, which ACP v1 cannot supply, and consent for a plan's workspace file — collecting the second alone would write into a repository to prove nothing. Orchestration stays unavailable, which is the fail-closed direction. The rest of what the guide sketched for this stage (allow/reject keys, local limits, per-subagent budget, safe mode) is settings the user edits directly and belongs with the Orchestrator.
- [x] Probe in a temporary directory with writes/execute rejected; require the smoke response `OK`; show effective selections and mismatches.
- [x] Give every probe stage a short Setup Deadline instead of the Session default, so a silent Runtime fails the wizard step quickly rather than after the full session-setup wait.
- [x] Persist only after successful validation; preserve existing Runtime entries and let the user choose global or workspace scope.
- [x] Require explicit acknowledgement for cross-provider/subscription-backed fan-out; direct Sessions remain independently configurable.
- [x] Wire registry refresh to validated cache refresh and visible offline fallback.
- [x] Run focused wizard tests and the mock-Agent smoke integration test; expect pass. Commit: `feat: connect and validate ACP runtimes`.
  - Those tests drive the wizard end to end against the bundled mock Agent process under `make test`. The extension-host coverage of the same path — the ports the composition root builds — stays with Task 14, which already lists "wizard save".
  - Fixed while implementing, since no later task owned it: `agentConductor.claude.hideSubscriptionAuth` now reaches the Claude launch as `--hide-claude-auth`, folded into the launch identity so turning it off asks for approval again (ADR-0010). `src/test/unit/subscription_auth.test.ts` pins the argv and that no other Runtime's fingerprint moves with the setting.
  - Also fixed: `quirks.processScopedConfig` was read by nothing, so `/model` on a Runtime whose model is fixed at process start said "this agent exposes no model" instead of telling the user to reconnect.
  - Pre-existing defects found by audit and fixed here, since no later task owned them: commands an Agent started outlived their Session (the terminal port had a `dispose` nobody called); `secretEnvironment` was outside the trust fingerprint and could displace the policy environment a Suppression Plan travels in; a Runtime id spelled like an `Object` member took the whole catalog down; the Probe Session accumulated an Agent's reply without a bound; the Agent's stderr tail was cut before it was redacted, which could leave half a credential; a `session/prompt` answer was read without checking it; an Agent's tool title and its Read-back values reached a dialog and the transcript able to imitate this Client's own lines; and a `session_info_update` with nothing to show was neither drawn nor recorded.
  - Found by reviewing those fixes and fixed in turn: a credential stored during the authentication handoff changed the launch identity after it had been approved, so the ADR-0010 Claude path always ended untrusted; an agent's own protocol error carried a resolved secret into a failure message, a log and the transcript, and could draw markdown that read as this client's voice; an override naming the command the catalog already names silently dropped `--hide-claude-auth`, and the approval prompt said nothing either way about subscription authentication.
  - And by reviewing those: the ACP handshake's own failure path was the one `stageError` call site still printing an agent's words unredacted (the parameter is now required, so no site can omit it silently); naming the same adapter by absolute path dropped `--hide-claude-auth` while the approval said the switch did not exist, where the honest answer is that it exists and is not in use; a probe whose stored credential was gone still saved and trusted a connection whose first turn would fail; and five of the previous round's fixes had no test that could fail — each now has one, proven by reverting the fix and watching it break.
  - And by reviewing those: `/model` and `/effort` printed an Agent's refusal unredacted into the transcript and `errorDetails` (redaction moved to `setConfigOption`, the point every caller routes through); a stale credential reference dead-ended the wizard with a message telling the user to do the thing that fails, so resolution now happens inside the probe attempt and routes into the handoff that can store one; the approval prompt could state the opposite of the command line one row above it, so the authentication line is read off the argv; the arguments box prefilled our own policy flags as the user's, which made accepting the prefill count as a replaced launch and cost the Runtime its Suppression Plan; a markdown link in an Agent's error rendered as something to click.
  - From the working tree's own judged audit (`0001-mvp-implementation-plan-judged.md`), the issues it raises against implemented code: a credential pasted into a Suppression Plan's environment now meets the same tripwire `secretEnvironment` values do (#3); dismissing the fan-out notice cancels the run instead of quietly declining, and declining is now a choice (#27); recording the approval sits inside the same guard as the settings write (#29); the offline wording of a failed Registry refresh is tested, which moved `describeRefresh` into the core where it can be (#31); scratch files a crashed host left under global storage are cleared by the next write (#18); the real filesystem port has direct tests for symlinks, directories and the digest ceiling (#19). Its #28 and #42 were already closed by the work above.
  - And by reviewing those: `agentConductor.permissions.*` were window-scoped, so a cloned repository's own settings could switch off every consent prompt — they are `machine` scope now, like the registry keys; the arguments prefill fixed last round dropped the flags that make Gemini and Copilot speak ACP at all, since those live in the catalog's own launch (a Runtime now carries its pre-policy arguments for exactly this); the transcript hardening had sealed two renderers and left their siblings able to draw a rule and a line in this Client's voice, so one sanitiser now covers every Agent string the chat sink draws; a markdown autolink and a bare address still rendered as something to click; the scratch-file sweep added last round deleted a concurrent writer's live file, so it sweeps by age instead; and the credential handoff only recovered when the stale reference happened to be spelled the way the wizard derives one.
  - And by reviewing those: a lone carriage return ended the blockquote an Agent's thoughts are drawn in, letting what followed render as ordinary transcript with this Client's emphasis available; `user_message_chunk` was drawn unsealed inside the Client's own `**user:**` attribution, so an Agent could forge a turn nobody took; a Smoke Test reply of three hundred blank lines and an "ok" passed, because `\W` matches a line ending — and the wizard then reported it on the Agent's own first line, pushing the Read-back out of the only part a notification shows; `orchestration.*`, `worktrees.root` and `gemini.writeWorkspaceSettings` were still a repository's to set, and flipping the first changes every Runtime's fingerprint; and sealing an Agent string by deleting `*` turned the globs that fill tool titles into paths nobody has, so emphasis is escaped rather than removed.
  - And by reviewing those: a credential with line endings in it — a PEM key — survived the wizard's report, because the report flattened the text before redacting and the stored value no longer matched it (redaction now runs against both forms, since whatever is done to the text has to be done to the value); the dialog that offers to store an API key put the Agent's refusal first and this Client's own sentences after it, so a long enough refusal pushed the only assurance about where a pasted key goes off the end of a bounded modal; `clampForDisplay` returned all but two characters of its input when the budget handed to it had already been spent, which is precisely the case a bound exists for; an effort value the Agent reported decided which line of a notification was read; a launch command a repository supplied wrote a line of its own into the dialog that asks whether to trust that launch; and the wizard's login terminal was registered per run rather than per activation, so every run left the one before it holding a shell nothing disposed.
  - And by reviewing those: the Agent commands that are *not* offered as something to type — most of them, since the allowlist is short and some Runtimes offer none — were drawn bare in a line of this Client's, unescaped, so one could put our own bold in the transcript; the test written to catch exactly that put the forged name on the allowlist, which is the one branch it does not take. Two of the previous round's tests were weaker than their names as well: the credential dialog's asserted that this Client's sentences were *present* rather than in the part a bounded modal shows, and a reply that passes the Smoke Test can still be long enough to clamp the Read-back off the end of the report — so the reply gets what the Read-back leaves, not the other way round. Sealing is now chosen by destination: `progress` takes a plain string, where an escape is a backslash the reader sees and the globs that fill tool titles read as themselves, while markdown parts take a `MarkdownString`, where an unescaped `*` is our own emphasis.
  - And by reviewing those, where the previous round had got it wrong: sealing was split by destination on the belief that a progress line is plain text, because `progress` takes a `string` where the markdown parts of the same stream take a `MarkdownString`. It is not — VS Code builds the part with the same conversion and draws it with the same renderer — so a running tool call's title, its kind and a terminal id were live markdown in a line this Client wrote, and a link in one was something to click. All of them are escaped again, `spanText` is documented as being for a code span and nothing else, and the sweep no longer exempts the renderer it could not see. Two more strings went the same way: a Runtime id and a Runtime label are settings keys, and `agentConductor.runtimes` is a scope a repository writes, so both were its text drawn into the transcript before anything about that Runtime had been trusted. And the Smoke Test report was sized before it was redacted, which is the wrong order in the one direction nobody expects: `[redacted]` is longer than an eight-character credential, so an Agent echoing the one it was started with pushed the Read-back off the end. Each half is made safe before either is measured now.
  - `UBIQUITOUS.md` gained **Sealing**. Three rounds running found a string drawn unsealed somewhere, each time in a place the round before had not thought of, and each time reasoned about from scratch — the glossary now says what the rule is and that it follows the destination rather than the source.
  - And by reviewing those: the dialog that approves a command an Agent wants to run was cutting the command line at its budget, so forty harmless flags and then the one that matters showed as forty harmless flags — the environment beside it has always been shown in full or refused, and the command is now held to the same rule, which is what the code claimed it already did. Sealing still let a link through: emphasis was escaped but `](`, `<…>` and a bare address were not, so an Agent could put something to click into any line this Client wrote, including the one attributed to the user — the failure path had been fixed for exactly this and its sibling had not. A custom Runtime's display name is its settings key, and a repository writes that scope, so it could add lines to the heading of the approval modal; it is flattened where it enters rather than at each of the ten dialogs that print it. An Agent's refusal could still render as one of this Client's own italic asides, so underscores that markdown could emphasise are dropped while the ones inside a word — the environment variables and settings keys a reader needs — are kept.
  - The ceiling test written the round before did not reach the ceiling: it filled the environment in twenty-one-character steps and stopped forty-nine short, so the budget correction it existed to protect could be deleted without it failing. It fills with the cheapest variable the checker accepts now, which is what an Agent would send.
  - And by reviewing those: link-breaking covered the two forms the mock happened to send and not the ones that need neither brackets nor a slash — `<mailto:…>` is an autolink, and a bare `www.` or an address with an `@` in it is made into a link by any renderer with GitHub's extensions on, which is every renderer drawn into here. The wizard had a third copy of the rule that had none of it at all, and what it produces is read in a notification, which VS Code renders through its own linked-text parser. All of it is now one module named after the concept the glossary defines, so there is one rule rather than three that drift; the tests ask whether any clickable form is left rather than whether a particular syntax was removed. Flattening a custom Runtime's name — added the round before — let a repository normalise `Claude  Code` into a byte-exact `Claude Code` and present as the built-in, so a custom entry is marked the way a replaced built-in already is. And refusing a command line longer than a fixed six hundred characters refused a test runner given a monorepo's paths: the command now gets whatever the rest of the dialog does not need, which is never less than that fixed share because the environment beside it has a ceiling of its own.
  - Two more the same round: the guard that keeps an Agent-reported value out of settings — the one path by which a resolved credential could reach a synced file — had no test at all, and disabling it left every one of them passing. And the test for a killed command slept two hundred milliseconds instead of waiting for the command to say it had started, which fails for a reason that has nothing to do with what it protects.
  - And by reviewing those: the consolidation missed one call site — the failure line drawn in the transcript kept its own two-rule copy of the link breaker, which is the copy the mock's own scenario was written against, so the test and the code agreed with each other and neither was right. Redaction in the wizard ran after the sealing, and sealing takes a character from *outside* what it breaks: an Agent that ends its sentence directly after a credential containing an `@` moved the value out of the form it was stored in, and it reached a notification and the log. It now runs on both sides of the sealing, and each pass has a test that fails without it. The mark that stops a custom Runtime reading as a built-in was appended and then clamped from the right, so a name padded past what a dialog shows — with characters `\s` does not cover — dropped the mark and kept the familiar part; the name is cut before the mark is added, and padding that takes up characters but no width is removed. And breaking every address made `claude-agent-acp@0.70.0` unreadable, which is the string a first-time user is shown when an adapter is missing, so an address is only broken where a renderer would make one a link.
  - And by reviewing those: one thing the wizard says still went out unsealed — the line that reports fan-out declined — and a Runtime's name is a settings key from a scope a repository writes, so it could put something to click in a notification. Every other thing the wizard says had been routed through the one function that seals; this was the fourth round in a row to find exactly one more site nobody had thought of, which is the argument for the rule having a name and a module rather than a habit. The redaction added the round before was three-quarters unverified: two of its four parts were only mutually redundant, and the test written to prove the sealing side could no longer fail, because narrowing the address rule had made its own fixture a no-op. Each part now has a case that fails without it. Formatting characters other than the zero-width ones — an override that draws what follows it backwards — survived a custom Runtime's name, and the test that guarded that restated the production character set instead of the property. And the address rule and the shared list the tests ask disagreed about the same question: the rule is now what a renderer actually links, which costs the legibility of `package@1.2.3` and buys one authoritative answer.
  - And by reviewing those, this time against the renderer itself rather than against a reading of it: `www.` was only broken at a word boundary, and the renderer makes a link of it anywhere, so `9www.example.invalid` survived every seal in the codebase — and the shared list the tests ask carried the same boundary, so all three tests agreed with the code and none of them was right. Progress notifications were the surface nobody had checked: the wizard runs its slowest steps under one, titled with the Runtime's name, which for a custom Runtime is a settings key a repository writes. That is the fifth round running to find exactly one more place, so the name is now sealed once, by a function, at every site that shows one. The address rule broadened the round before had no test that could tell it from the rule it replaced. And the modal that offers to make a Runtime the default drew the name of the old one unsealed.
  - And by reviewing those: the shared list the tests ask had been transcribed from the sealing rules, so it asked the same question twice and answered it the same way both times — which is why an address written `<ops!@evil.example>` was live in the transcript and clean by every test. The list is written from the renderer's own grammar now, deliberately able to disagree with the code it checks, and the angle form is broken on the bracket rather than on what precedes the `@`. Sealing a name after cutting it to fit undid the cut, because breaking an address inserts characters — so the mark saying a Runtime is a repository's own was pushed past the budget and clamped off the approval heading. And the Smoke Test's idea of padding was ASCII, so a paragraph of Cyrillic ending in "ok" answered a question that is meant to admit one word.
  - And by reviewing those: sealing was not a fixed point. The rule that breaks an address consumed the character before the `@`, so in `a@b.@c.example` the second one was skipped and a later pass over the same text found more to do — which matters because the Smoke Test report is sealed when it is composed and again when it is said. An Agent could answer acceptably in padding built from those characters, grow the line past the budget it had been sized against, and push the whole Read-back off the end while the connection saved and reported itself connected. The same defect left a live address in the transcript inside this Client's own bold. One line fixes both: the rule matches without consuming either side. Separately, a right-to-left override survived every seal, so an Agent could draw the words this Client wrote around its own text backwards; those are removed now, though not the joiner that builds one emoji out of several. And the Probe Session's refusal of an Agent's own permission request had no test that it was wired at all — the function was proven and the wiring was not, so a probe that allowed every tool call passed the whole suite.
  - And by reviewing those: the failure line drawn in the transcript was a fourth place that sealed text its own way, and the one that had not been given the direction-override strip — so it is composed from the one sealer now, with its own rule about underscores applied first, because removing a character can put a link back together and `http:_//evil.example` is not an address until the underscore is gone. Two guards had no test that could fail: the strip of those overrides on the path the Smoke Test report takes, which is where an Agent could reverse the Read-back beside its own answer, and the half of the settings guard that refuses a value too long to be a name.
  - And by reviewing those, in the last round: what a Registry host says about itself — a reason phrase it chose, a snippet of the document it served — reached a notification unsealed, so the sealing rules that need no display budget moved into the core, where a message composed there is safe by construction rather than by whoever shows it remembering. Strikethrough was not sealed, and it spans until its pair, so an Agent could swallow the Client's own emphasis into it. The approval dialog said a Runtime's plan *edits* a file in the workspace when nothing in this Client makes that edit — the line beside it is deliberately read off the launch rather than off the intent, and this one was not. A Session could resolve already failed, so the first Turn reported only that it was failed instead of the exit status and the stderr tail. The stderr flush dropped its redaction guard on a path that settles on a timer rather than on the pipe ending, where something the Agent started can still write the rest of a value. And the shared list of clickable forms claimed to be written independently of the rules it checks, which most of it is not — what settles that question is rendering with the renderer, and the comment says so now.
  - And by reviewing the last round's own fixes, which nothing had yet read: the guard added to stop a Session resolving on a dead Agent never fired. What sets the state to failed is the exit handler, and a request in flight rejects the moment the pipe closes — its own `finally` puts the state back to idle before that handler runs. It asks the connection now, which is the test a Turn already makes. And the sentence added to the approval dialog saying a Runtime cannot be handed work contradicted the question asked a few steps later, and by sitting in the branch for plans with a workspace file it implied the opposite for every other Runtime; whether a Runtime may be handed work is asked separately, so it is answered separately.
  - The two things the review left open are closed. A direction override survived the two helpers that flatten text for a modal — the dialog that approves a command, and the one that approves a launch — where the command, its arguments and its environment all come from a scope a repository writes; both went through their own copy of the same flattening, which is what let one of them drift, so there is one now. It also survived the command line itself, which is composed separately and was not on the list. And the held-back end of a stderr buffer, which a drained pipe keeps so that the rest of a value is redacted together with it, had no test: dropping it wrote a credential to the log in two halves and every test still passed.
  - The unit suite could report success having run nothing. `node --test` exits 0 when its glob matches no files, and `npm test` relied on that glob, so a toolchain where it behaved differently would have turned every branch green. The files are found by name now, a run that finds none fails, and `make gate-selftest` re-proves that refusal on every lint — the standard the seam check is already held to.
  - Also `machine` scope now, so a cloned repository cannot set them: `orchestration.subagentIsolation`, `orchestration.defaultSubagentPreset`, and `sessions.resumeOnStartup`, which decides whether opening a folder starts an agent at all.
  - Moved somewhere it survives this file: why no Runtime can hold a Suppression Capability — ACP v1 cannot report the tool list an Agent ended up with, and consent for a plan's workspace edit alone would write into a repository to prove nothing — and therefore why fan-out stays off for every Runtime. It is in ADR-0008's consequences.
  - Pre-existing, from the working tree's own judged audit, against code that is already built: the dialog that approves a command an Agent wants to run listed the variables the Agent set and said nothing about the rest — the command also inherits this window's whole environment, which on the machine somebody develops on is where their credentials are. It says so now, above the list and paid for out of the same budget, and a test pins that the parts still add up to less than the dialog will show, since a sentence added without being paid for is how they stop adding up (#24). An Agent reporting that it is running a model its own list does not contain is read back as what it said rather than as the nearest listed thing, which is now pinned (#14). A `config_option_update` arriving before setup has answered with a session id is nobody's, and is no longer adopted (#13). Which settings the Client parses but nothing acts on is a test now, not a paragraph here (#25). Left alone deliberately: the case-spelling ceilings (#22, #23) are documented and fail in the safe direction, and re-verifying every Runtime's suppression recipe against its vendor's own documentation (#21, #43) needs sources this branch cannot reach. `src/test/mock-agent.ts` is within thirty lines of the size limit and grows with every scenario added to it (#5); it needs splitting along the same seam as its options — the prompt behaviours — before the next one is written.
  - The unit suite left a temporary directory per test — 11,500 of them had accumulated. Every fixture that makes one now removes it, and a full run leaks none.
  - Dead weight removed: `RuntimeSpec.detection` described detecting a CLI by running it, which the security model deliberately does not do, and nothing read it.
  - Which settings nothing acts on yet is pinned by a test rather than by this list, so it outlives this file; the reasons are beside the names there. Settings whose consumer belongs to a later task, left unread on purpose: `orchestration.*`, `worktrees.root`, `presets` and `gemini.writeWorkspaceSettings` (Task 13); `sessions.resumeOnStartup` (Task 10). `ui.slashCommandAllowlist` is now read: every Agent command is still drawn, and only the ones it names — together with the Runtime catalog's own list for that CLI — are offered as something to type, which is what "safe to surface" was for. Still with no consumer and no owner: `runtimes.<id>.safeMode`. `RuntimeSpec.modelCatalog` is the sanctioned fallback of ADR-0005 and no catalog entry supplies hints, so the fallback never fires; populating it means writing model ids nobody here can verify.

### Task 10: Specify and implement metadata-only Session persistence

**Files:** Created `src/core/sessionStore.ts`, `src/vscode/sessionRecords.ts`, `src/test/unit/session_store.test.ts` and `session_records.test.ts`; modified `src/core/index.ts`, `src/vscode/composition.ts`, `src/test/unit/client_settings.test.ts`; added the Resume flow to `ARCHITECTURE.md` and rewrote **Persisted Session** in `UBIQUITOUS.md`.

- [x] Test schema migration, corrupt records, missing Runtime/workspace, restart recovery, and metadata redaction.
  - A store written under a version this build does not know is not read, and the ordinary save that follows keeps it aside rather than replacing it. Bumping the version otherwise makes every record unreadable and the user's next session silently destroys them, which is not a thing a migration can be written against afterwards.
  - A read that *failed* is not a store that is empty. Those were one answer at first, so a momentary read error would have had the next save write one record over every record it could not see.
- [x] Persist IDs, Runtime, workspace, timestamps, requested/effective selection, stop state, parent ID, worktree metadata, and Agent resume token only when supported. Do not persist prompts, hidden context, credentials, or tool payloads by default.
  - There is no Agent resume token to persist. Both ways back into an ACP session — `session/load` and `session/resume` — take the session id, the `cwd`, the MCP servers and the additional directories, and nothing secret, so the id is the handle. This Client sends `session/load` alone, so what a record carries is whether the Agent advertised `loadSession`. Checked against the installed schema rather than assumed, after a review found the first wording claimed more than that.
  - Nothing gets in that the record has no field for: it is built field by field on the way in, and stripped on the way out. Those are two separate barriers at two boundaries, because one that another layer quietly covers for is one no test can break.
  - Everything an Agent worded — the session id most of all, since the Agent chooses it — is redacted against the values its process was started with before it becomes durable, and before records are compared, or every update would file as a new Session. Values and record counts are both bounded: an Agent picks its own session id, and a window can open a Session per Turn.
  - The parent id and worktree fields exist and stay empty until the Orchestrator fills them (Task 13).
  - `src/core/session.ts` needed no change: everything a record holds was already exposed. `src/vscode/config.ts` needed none either — `fileStorage` was already the durable-storage port.
- [x] On startup, list resumable metadata; load only on explicit user action unless `resumeOnStartup` is enabled and trust still holds.
  - The decision is implemented and tested, and fails closed four ways: a Runtime that is gone, a launch whose fingerprint no longer matches what that conversation ran under, a folder this window has not opened, and an Agent this Client cannot reattach to. Nothing is resumed at startup unless the setting says so, and then one Session at most.
  - The consumer arrived with the Sessions tree, so the setting is off the list of ones nothing acts on. It is read where it is acted on rather than cached, and the decision is re-derived against what holds at that moment.
- [x] Re-send sorted MCP servers and capability-supported directories on load.
  - Already true and already pinned in the ACP client tests; confirmed rather than reimplemented.
- [x] Run `node --import tsx --test src/test/unit/session_store.test.ts`; expect pass. Commit: `feat: persist resumable session metadata`.
  - Found by two independent adversarial reviews of the finished change, and fixed: the save that clobbers a store it could not read; a window closing without waiting for the record of how a Session ended, where the function that exists to wait for exactly that had no caller; and eviction that always kept the record being written, so a clock that stepped back could push out the newest Session instead of the oldest.
  - And by reviewing those fixes: what a bump keeps aside had one name, so a second bump would have destroyed what the first one kept — and two bumps with no migration written in between is ordinary, since nothing forces one. It is keyed by the version it holds now.
  - Three of the tests were weaker than their names. The oversize-file case was padded with text no JSON parser would accept, so the size gate it existed for could be deleted with it still green; the "no prompt on disk" case passed whichever of the two barriers was removed; and the one for a Session with no approved launch identity could not tell the decision not to write from the schema refusing to. Every guard added here was then probed by removing it and checking the test fails.

### Task 11: Add the Sessions tree and actions

**Files:** Created `src/vscode/sessionsTree.ts`, `sessionRows.ts`, `sessionActions.ts`, `sessionLaunch.ts`, `clientPorts.ts`, `hostPorts.ts`, `participantPorts.ts`; modified `src/vscode/{composition,participant,spawnGate,sessionRecords}.ts`, `src/core/sessionStore.ts`, `package.json`; created `src/test/unit/session_{rows,row_sealing,hierarchy,navigation,actions,ownership,launch}.test.ts`, `client_ports.test.ts`, `src/test/session-fixtures.ts` and the sessions-tree extension-host suite; added the Sessions tree to `ARCHITECTURE.md`, `UBIQUITOUS.md`, `README.md` and a walkthrough page.

- [x] Render Session/Subagent hierarchy with Runtime, verified selection, cost/unknown, duration, state, and mismatch markers.
  - A row is keyed the way the store keys a record — Runtime, folder and session id — because an Agent chooses its own session id and nothing makes it unique across either. Keyed on the id alone, one of two Sessions is silently never drawn, and a Session nothing draws is one nothing can cancel.
  - Live rows are drawn from the Session object and remembered ones from the record, never both. Records are written with nothing waiting on them, so a row fed by the file lags the Turn it is meant to be showing.
  - Time means two different things and says so: a live row has been running for *X*, a remembered one was last active *X* ago. A record keeps when it was first and last written, and a Session resumed the next day keeps its original stamp — the span between them is not the time anybody spent in it.
  - The lineage is walked to the top with a visited set rather than followed one step. A ring written into a file two windows share would otherwise leave every node a child of another and the view empty.
  - Everything an Agent worded — the session id, both selections, the cost currency — passes the redaction a record passes, and everything drawn is sealed for a surface with no markdown of its own and bounded. What a row is *addressed* by stays raw, because a handle nothing answers to is a button that quietly does nothing.
  - Nothing yet fills in lineage or worktrees; both are the Orchestrator's to record, and a test names them so that gaining a writer has to be deliberate.
- [x] Wire new, cancel, cancel-all, resume, and open-worktree-diff commands to actual Session ownership.
  - The commands are a table the composition root registers in a loop, so which command runs which action is something a test reads rather than a string it greps.
  - Resuming goes through the participant that owns every other Session and the gate that starts every other Agent. Everything the row claimed is re-derived at the moment of the click through the same rule the row was drawn by — because the gate would otherwise refuse only *after* the live Session had been ended to make room for it.
  - Worktree changes are shown through VS Code's own Git extension; a worktree is an ordinary checkout, and its changes are what Source Control already draws.
- [x] Update on Session events without blocking the extension host; remove disposed Sessions predictably.
  - Every moment what the window owns changes is one the view is told about — a Turn starting, a Turn ending, a cancel, a reattach, a disposal, a Session adopted — pinned as a sequence, because one operation passes several of those moments and a count cannot say which went missing.
  - A row leaves when the process is gone, so a Session that died on its own goes as predictably as one that was disposed; the record that takes the row over is redrawn once the saves have settled, and a Session whose Agent died mid-Turn is recorded as having ended rather than as still taking one.
  - An Update naming a Session this window does not hold is drawn and never adopted: anything else is a map an Agent can grow, and a figure drawn against a Session whose Agent never sent it.
- [x] Run the sessions-tree extension-host tests; expect direct Session state and actions to pass. Commit: `feat: add session navigation`.
  - The host runner takes a profile of its own per run. Without one the extension's global storage survived every invocation, so a suite read Sessions saved by the run before it and a gate green on a clean machine went red on the second.
  - The suites share one participant and the last of them stops it, so the run asserts that the teardown test really is the last one registered rather than describing it in a comment.
  - Sessions are remembered per machine, so a record says whether one is in use: the window running it re-writes the moment it last still had it, and its own id beside that. A Session stamped by another window within the last half-minute is not offered back. A stamp rather than a flag, because a window that is killed simply stops re-writing it — a flag would be one a crash leaves set, and coming back to a conversation a crash interrupted is what resuming is for.
  - Found by six rounds of adversarial review and a mutation sweep of the new modules, and fixed: credentials read for a launch about to be refused; a live row that could not be told from its own record; a resume that ended the live Session before finding out it could not proceed; a row that went on saying `prompting` for the whole of a Turn; and a tooltip whose clamp cut off the one line saying why a Session could not be resumed.

### Task 12: Implement per-Session authenticated IPC and the Shim

**Files:** Created `src/core/ipc.ts`, `src/core/ipcProtocol.ts`, `src/shim/socketClient.ts`, `src/test/ipc-fixtures.ts`, `src/test/unit/{ipc_capability,ipc_framing,ipc_connections,shim_orchestration_tools,shim_socket_client}.test.ts`; modified `src/shim/mcp-shim.ts`, `src/core/{index,types}.ts`, `src/vscode/{config,wizardProbe}.ts`, `src/test/unit/manifest_security.test.ts`, `eslint.config.mjs`, `Makefile`, `ARCHITECTURE.md`, `UBIQUITOUS.md`.

- [x] Test missing/malformed/expired capabilities, cross-Session replay, wrong workspace/depth, oversized frames, disconnects, and unsupported methods before happy paths.
  - A frame that cannot be answered — no id, not an object, not JSON — is refused with a null id *and* ends the connection: the Shim matches answers by id, so a nameless failure on its own is a call that never returns, and the Agent waits out its whole turn to learn nothing. For the same reason a throw on the way to composing an answer is caught where every call routes through rather than trusted not to happen, since an untrusted frame can make describing it throw.
  - The transport is bounded in both directions and at both ends, and both ends check the two ways a frame can be too long: one that never ends, and one whose ending arrives past the limit. Only the first was checked at first, and only a test that produced the second found it.
  - An answer is bounded by what it *quotes*, not only by what it says: the id comes back in every one, so a request inside the limit whose id was nearly all of it produced an answer beyond the limit — which the Shim refuses wholesale, taking every call in flight on that connection with it. Bounding the message alone left that open, twice.
- [x] Use length-bounded NDJSON request/response over a random local socket/pipe with restrictive filesystem permissions where supported.
  - The socket sits in a directory of its own created `0700`, and is itself `0600`: Linux honours the socket's mode and macOS the directory's, so neither alone is the guarantee.
  - Bounded as the bytes arrive rather than once a frame is whole, and the limit is read per line rather than per chunk — the handshake's own tight limit still being in force behind it refused every brief longer than a secret, which is every real one.
- [x] Bind each random capability server-side to immutable Session ID, parent ID, depth, roots, expiry, and allowed methods; compare secrets in constant time.
  - Every request schema is `strict`, so a frame that so much as names a lineage field is refused rather than having it ignored. What is issued is copied at the mint, so an issuer that later mutates its own array does not widen what is enforced.
  - Authority is re-checked per call and not only at the handshake: a frame read while a capability was live can still be waiting behind a slow one when it is withdrawn, and that frame must not reach the Orchestrator.
  - The comparison is hashed first so both sides are one length — answering "wrong length" quickly is itself an answer — and the table is scanned without an early exit. Neither is testable: a `===` or a `break` passes the whole suite, and the code says so where it does it.
- [x] Expose `list_runtimes`, `spawn_subagent`, `check_subagent`, `subagent_result`, and `cancel_subagent`; validate every input with Zod.
  - `runtime` is a string rather than an enum of the four built-ins, because the catalog says which Runtimes exist and a user-defined one is a full member of it. Effort is an enum, and the vocabulary now has one home the type derives from: `satisfies` proves every entry is a level, never that every level is an entry, and there were four copies of that list drifting apart. The two that cannot derive it — the Shim, which imports nothing, and the manifest, which VS Code reads instead of the code — are held to it by tests.
  - A path in a Brief must be absolute here, because that is where ACP's rule can still be applied to what an Agent wrote. Which roots it must fall inside is the Orchestrator's to say.
- [x] Remove `orchestrator_status` or make it authenticated and non-sensitive.
  - Removed. A tool that only says the Shim is alive is authority spent on nothing; a test pins the exact tool set so it cannot come back unnoticed.
- [x] Run focused IPC/Shim tests; expect pass. Commit: `feat: authenticate orchestrator shim calls`.
  - Three rounds of adversarial review found, and this fixes: a peer refused or lapsed that the server went on reading, at 13.6 MB and quadratic copying on the extension host's only thread; a handshake deadline that was an idle timer, so one byte per half-deadline held a connection indefinitely and enough of them locked every Session out; connections and calls with no ceiling at all, where one read started twenty thousand handlers; a goodbye that was never reaped, and one that reset the peer before it could read why.
  - Twice the same shape: a guard read once outside a loop whose body changes what it guards. The frame limit was one; the goodbye was the other, where the very frame just dispatched ends the connection and the next turn of the loop resumed the socket it had paused.
  - Every guard was probed by deleting it, and a test that survived its guard was rewritten or removed — one such was deleted outright rather than propped up, because the mechanism it named is one shared function whose other caller already pins it falsifiably. Three tests passed with their guard gone — two writes that arrived as one read, so the split they claimed to test never happened; a backlog measured only against the constant it was testing; and a refusal matched against text the server also produces. A fourth passed for the wrong reason: the unfixed server is merely slow, and slowness makes backpressure too, so it was measured against both paths before being trusted.

### Task 13: Implement bounded orchestration and worktree lifecycle

**Files:** Created `src/core/{orchestrator,worktrees,shimInjection,spawnLimits}.ts`, `src/vscode/orchestration.ts`; modified `src/core/index.ts`, `src/vscode/{composition,sessionLaunch,spawnGate,sessionRecords,config}.ts`, `src/shim/{mcp-shim,socketClient}.ts`, `package.json`; created `src/test/orchestrator-fixtures.ts` and `src/test/unit/{orchestration_bounds,orchestration_lifecycle,orchestration_wiring,shim_injection,worktree_lifecycle,subagent_end_to_end}.test.ts`; extended `session_launch`, `session_records`, `client_settings` and `shim_socket_client` tests; updated `ARCHITECTURE.md`, `UBIQUITOUS.md` and the orchestration walkthrough page.

- [x] Test suppression/trust fail-closed behavior, defaults, depth, concurrency, aggregate spawn count, timeout, optional Runtime budget forwarding, background handles, parent cancellation, and result metadata.
  - Every condition is refused on its own, and each refusal is measured by a test that fails when that one condition is deleted. Orchestration switched off, trust that no longer holds, no Suppression Capability, and a Session already at the cap each stop the injection before anything is minted — a capability issued "just in case" is authority only a Shim nobody injected could present.
  - The aggregate count is read and reserved with nothing awaited in between. It was not, at first: two calls that arrive in one read are two handlers in one turn of the loop, and both saw the same number and both passed. The test that names it fails when the reservation is moved back after the await.
- [x] Inject the absolute bundled Shim command only when depth and verified suppression allow it; sort MCP servers by name.
  - The Depth Cap works by there being no tool to call, not by refusing a call: a Session at the cap is created with no orchestration server in `mcpServers` at all. The same rule is checked again where a call arrives, against the depth the capability was minted with rather than anything a caller sent, so a bypass would have to be a bypass of both.
  - What decides eligibility reads nothing and starts nothing, which is what lets a window with orchestration off have no socket rather than an empty one — a directory count either side of an injection is what says so.
  - The capability names the Session by a key this side mints. `mcpServers` travels inside `session/new`, so at the moment it has to exist the Agent has not chosen a session id.
- [x] Implement sync/background child states and cancellation cascade without sharing conversation context.
  - A handle is the child's key, so the thing a parent polls and the thing that child's own Shim acts under are one name. A handle is only ever answerable to the Session that made it, and a stranger asking gets the same answer as one that never existed.
  - Ending a Session cancels the tree beneath it, not its first level, and withdraws the capability with it. What crosses to a child is a Brief — words and absolute paths inside the granted roots, never file contents and never history.
- [x] Serialize Git mutations; use deterministic unique branches; record allocation before `git worktree add`; reconcile abandoned allocations on activation; never delete a dirty worktree automatically.
  - The journal entry is written first and the command run second, so a host killed between them leaves a record of what it intended rather than a directory nothing remembers making. An `add` that git refused takes its own record back.
  - A name already taken is stepped past rather than reused, because checking out a branch somebody's work is on is how that work is lost. A session id an Agent chose stops being able to name a path or a ref at the slug.
  - Reconciliation drops what git does not know about and prunes; it never removes. A `git status` that could not be run is refused as if it were dirty, because "we could not tell" and "there is nothing there" must not have the same consequence. Removing never deletes the branch: what was committed lives only there.
- [x] Keep parent repositories out of `additionalDirectories` by default. Describe worktree mode as change coordination, not access control.
- [x] Return unknown cost when unsupported and enforce local limits regardless of Runtime budget support.
  - Unknown is a real answer and never a zero. A money limit reaches only a Runtime that says it can hold one, and is clamped to the user's figure either way; depth, concurrency, count and timeout apply whatever the Runtime supports. This Client has no channel to set a money limit on any catalog Runtime, and says so in the log rather than dropping the figure in silence.
- [x] Run focused orchestrator tests and a mock Agent -> Shim -> child Agent integration test; expect pass. Commit: `feat: orchestrate bounded subagent sessions`.
  - The end-to-end test is the one place nothing is faked: a real MCP client drives the real bundled Shim in its own process, which opens a real socket to the real Orchestrator, which starts a real Agent. It is what shows the parts *agree* — that the Shim's tool schema is the one the socket validates, and the socket's answer is one the Shim can read. Both sides can pass their own tests and still disagree about that.
  - Four rounds of adversarial review found, and this fixes: a composition root that dropped the callback every result is made of, so a Subagent would have finished and told its parent nothing — now a required field, which makes the compiler the witness rather than a test nobody wrote; a spawn queued behind the semaphore that registered its child after the cancellation which would have reached it, twice over; a reconciliation that read "git could not be asked" as "these worktrees are gone" and forgot a checkout holding somebody's work; a live Subagent's row that carried no worktree until it had finished, which is when looking at its changes stops being useful; and a claim that a money limit was being enforced by a Runtime nothing had sent one to.
  - One test was found to be measuring the machine rather than the code — it scanned the temporary directory every socket in the suite shares, and failed five runs in six when those files ran together. It now asks this Orchestration where its socket is, which is also worth having.
  - Removing a worktree is a row action, because the documentation described a cleanup nothing exposed. It refuses a dirty checkout once with the reason, removes it only if asked again, and never touches the branch.
  - A fifth round found two more, both in that new action and both created by the fixes before it: it escalated to `--force` for *any* refusal, including one where git could not be asked whether there was work in the checkout at all — so the second question said "losing those changes" about changes nobody had seen; and it was offered on a live Subagent's row, whose worktree is the working directory of a process that is mid-turn. A refusal now says which kind it is rather than only why, and only uncommitted changes are a refusal asking again can overturn.
  - The same round showed `git worktree prune` could only ever harm: git *lists* a worktree whose directory is missing rather than forgetting it, so nothing this reconciliation drops is left for prune to find, and what prune would reach is an unmounted drive — as likely somebody else's worktree as ours. It is gone.
  - Two guards were found to be unfalsifiable and were made falsifiable rather than trusted: the socket assertion, which passed against an `address()` broken outright, and the cancel answer, which only looked settled because the fake child ended its own Turn inside `cancel` — a real one does not, so the fake no longer does either.
  - A sixth round found the same deletion reachable through the other door: both guards asked whether the Session was live *in this window*, and Sessions are remembered per machine while every window's worktrees sit under one root — so the second window drew the first window's running Subagent as an ordinary past row and could delete the checkout its Agent was working in. A row now says when another window holds a Session, and the action refuses it outright, because this window cannot cancel that one.
  - The same round showed a checkout somebody deleted by hand had become impossible to clear: `git status` cannot run in a directory that is not there, and refusing on that was correct but final. Git itself reports such a worktree as prunable, which is the difference between "nobody knows what is in there" and "there is provably nothing there", so that one case is cleared without a second question.
  - A journal that could not be *understood* had the same shape of problem: refusing for ever disabled worktrees in every window with no way back from inside the product. It is now kept whole under a name of its own and the window starts afresh — the rule the Persisted Session store already followed. A journal that could not be *read* still fails, because that file probably still says what it said.
  - Removing a worktree is what pushed the row-action tests past the file-length rule, so they are their own file: they are one behaviour with a harness of its own. Nothing in the build measures a file's length, which is why the breach was there to find at all — the claim that every file was inside the cap had been made against two directories rather than the repository.
  - A seventh round found the one defect a fake git could never show, and it had been there since the file was written: git records a worktree's realpath rather than the path it was handed, and the journal wrote down what it was given. A worktree root reached through a symlink — `/tmp` on macOS, which is the obvious thing to type into that setting — produced a journal that never matched what git listed, so the first activation after a Subagent ran called its live checkout abandoned and dropped the only record that could reach it. It also silently defeated the fix above, since a lost directory could never be recognised either. The path is resolved where it is written down, and the lifecycle now has one test against real git, which is what the fake cannot stand in for: it echoes back whatever path the test authored, so it agrees with itself forever.

### Task 14: Replace the false integration gate

**Files:** Created `scripts/{check-node,report-integration}.mjs`, `src/test/integration/suite/{wizard_save,cancellation,shim_delegation}.test.ts`, `src/test/{mock-agent-cancellation,mock-agent-delegation}.ts`, `src/test/unit/{node_engine_gate,integration_gate_summary}.test.ts`, `src/vscode/diffCommand.ts`; modified `package.json`, `Makefile`, `src/core/shimInjection.ts`, `src/vscode/composition.ts`, `src/test/mock-agent.ts`, the integration suite index and the Shim injection tests; updated `AGENTS.md`, `ARCHITECTURE.md` and `README.md`.

- [x] Add `engines.node: "^20.19.0 || ^22.13.0 || >=24"` to `package.json` and make `doctor` enforce the same ranges before dependency installation.
  - The range is declared once and read from there. `npm` treats `engines` as advice and installs anyway, so the declaration alone gated nothing; `install` depends on `doctor`, which is what makes it a refusal. A second copy in the Makefile would only ever drift in the direction of the gate being wider than the declaration.
  - A clause the check cannot read is an error about the range, never a verdict about the Node, and every clause is read rather than stopping at the first that matches — a short-circuit would leave an unreadable clause unseen for as long as some earlier one kept saying yes, which is a range widened by something nothing ever looked at.
- [x] Add `@vscode/test-electron` and run the extension in an isolated test workspace against the bundled mock Agent.
  - Workspace and profile are both made and destroyed with the run. Without a profile of its own the extension's global storage outlives every invocation, and a suite would read Sessions saved by the run before it, in folders that no longer exist.
- [x] Cover activation, trust refusal, wizard save, direct prompt rendering, permissions, Config Option round-trip, cancellation, resume, sessions tree, Shim child result, and teardown.
  - Delegation is the one that repaid its cost, and it found the defect the gate exists for. An extension host's `process.execPath` is an Electron binary, and the Shim is started by the *Agent* — with a small environment of its own, not ours — so what makes that interpreter behave as Node has to travel in the `mcpServers` entry. Every unit test passed either way, because they all run under plain Node. Taking the variable back out fails the run with the Shim's socket closing on it.
  - The capability variable now appears exactly once whatever else that entry carries: which of two entries sharing a name reaches the process is the Agent's decision, so an ordering rule here would be one enforced in somebody else's code.
  - Standing still and delegating are asked for by the prompt rather than by a `--mode=`. A host has one participant and it remembers the Runtime it was last given, so a Runtime of their own would have to be switched to and switched back for nothing.
  - What the wizard's suite adds is the half every other test fakes: settings written at a chosen scope and read back through `inspect`, and a credential that goes to `SecretStorage` while settings keep only its name — asserted by looking for the value in both scopes and not finding it.
  - Lineage is deliberately not asserted in the extension host. It has a suite of its own, and the Mock Agent numbers its Sessions from one per process, so parent and child arrive under one id and the row this would read is the one that collision folds away. A test that can only fail for its fixture's reason is worse than none when finding that out costs a VS Code.
- [x] Make missing VS Code binaries, harness setup failures, or zero discovered tests fail nonzero.
  - Two refusals that do not depend on each other: the suite counts what it registered against what ran, and the reporter refuses a run that exits zero having printed no count — or a count of zero, which is the same thing said differently. Neither being wrong on its own is enough to make an empty run green.
- [x] Keep full output in `reports/integration.log` and print only count, duration, and failure summary.
  - Not piped: a `tee` would put the window's own diagnostics back on the terminal this is clearing. `gate-selftest` re-proves the refusal, as it does for every other checker — a checker added without its probe would be the very defect the self-test exists to catch.
  - The escape the reporter strips is written out rather than typed. An invisible `ESC` is one a patch can drop with nothing looking different, and it did: a fixture that lost its colour made a test pass for the wrong refusal, which is how the zero-count hole stayed hidden until the fixture was made to say what it meant.
  - Two rounds of adversarial review found, and this fixes: a lint annotation that had stopped being needed, on the one file the gate depends on and in the one directory `make lint` never looked at — `src` and `scripts` are both checked now, and `npm run lint` says the same thing the Makefile does; a window that shared its form surface with the wizard in two places out of three, leaving an Agent's own elicitation reaching a dialog nothing in a headless host can click; a picker that took the first Runtime whose name merely *contained* the id it wanted, guarded by an assertion that read back the very name it had matched; a row looked up on two of the three parts a record is keyed by; and a range that could be replaced from the environment, which is a build-wide off switch with nothing in the Makefile to show for it.
  - The suites no longer depend on which write lands last. Every Mock Agent numbers its Sessions from one per process, so a parent, its child and a later Session on the same Runtime in one folder all arrive under a single record key — the delegation suite therefore brings a Runtime of its own, and moves the participant on and off it through the `/runtime` a user would pick. That the credential test proves the *value* survived rather than that something did is the same kind of repair: the Agent it connects now refuses to start on anything but the exact key, so truncating what SecretStorage gives back fails the run.
  - The Mock Agent's process-level scenarios are their own module. The file had reached the length rule twice in this task, and a file one line under a hard cap is a trap for whoever adds the next scenario.
- [x] Run `make check-all`; expect build, lint, unit, and real extension-host integration tests to pass. Commit: `test: enforce extension-host release gate`.

### Task 15: Complete or remove the rich build contract

**Files:** Deleted `scripts/gen-rich-manifest.mjs`; modified `Makefile`, `README.md`, `AGENTS.md`, `ARCHITECTURE.md`, `PERSONAS.md`, `src/vscode/render.ts`; added `docs/adr/0011-one-render-surface-until-the-sessions-proposal-is-usable.md` and `src/test/unit/proposed_api_declarations.test.ts`; linked the supersession from ADR-0002.

- [x] Keep one surface-neutral render model, so a second sink is an addition rather than a rewrite — one sink exists today.
  - The model was already there and is unchanged: `src/vscode/render.ts` maps one Update to a list of items, knows no surface, and calls nothing in VS Code — with a compile-time proof that every variant of ACP's union is covered. What was corrected is its own description of itself. There is exactly one sink, the chat participant's, and the comment said otherwise; a render model that claims two consumers when it has one is a claim nobody can check.
- [x] The rich sink is not implementable here, so the second build channel is removed rather than half-shipped.
  - Three things have to exist before a proposed-API provider can be written, and none do: `@types/vscode` ships the stable API only and nothing in this toolchain fetches a `vscode.proposed.*.d.ts`, so under `strict` the provider will not compile; the extension-host gate launches stable VS Code with no `--enable-proposed-api`, so render parity would be a claim no gate could check; and the declarations move between VS Code releases, so the version pin is one that has to be chased.
  - What existed was a script that copied the manifest, added two proposals, packaged, and put the original back. No provider was registered and the `chatSessions` contribution was never generated, so the second artifact `make release` shipped was the first one with two extra words in its manifest — and `vsce publish` refuses proposals anyway, leaving a sideload as its only route to someone expecting the better UI.
- [x] Removed from the release gate, along with the target and the generator behind it.
  - Deleting the target and leaving the generator would have kept a runnable thing that produces a manifest that lies; a target nobody runs rots into a target somebody runs.
  - A gate replaces it, because the defect is one nothing in the build could see: a manifest may only ask VS Code for a proposal this extension implements, and it implements none. Both halves are exact — the committed manifest declares no proposal, and no build input writes that field either. The second half is the one that matters: a build step that rewrites the manifest on its way to `vsce` declares just as effectively and leaves the committed file looking innocent, which is precisely what was happening.
  - The first version of that gate was blind to the defect it exists for. It scraped proposal names off the line that mentioned the field, so the same injection written across two lines passed it — the check was proved unfalsifiable by planting one, not by reading it. It now detects the field however the declaration is written, and its self-test proves each half fires on a fixture rather than only that the repository is currently clean.
  - What it reads is what git says the repository is made of, not a list of the files that build it today. The list it started with was the second way to be blind: a build step added to a directory nobody had named would have been one the gate could not see, and a gate open to the next file added is open by default. Planting one there is now a failure, as is planting the field in the manifest, in a command `package.json` defines, and in the bundler across two lines.
  - Adversarial review found the remaining heuristic and it is gone rather than repaired: "some production file mentions the name" was satisfied by a comment, and the prefix that excluded test sources would have swallowed a future `src/testing/`. Judging whether a provider is real is work for the ADR that revives the channel, not for a check standing in for one.
- [x] Ran `make lint` and `make test` green; `package-rich` no longer exists to run. Commit: `build: defer rich session package`.
  - `make check-all` does not pass on this branch, and does not pass without it either: the extension-host suite's delegation test fails on roughly one run in two or three, ending a Turn with nothing JSON-shaped in the stream and no duration against its name — it fails fast rather than waiting for a child. Nothing in this task can reach it. Its only change under `src/` is a comment, and `dist/extension.cjs` and `dist/mcp-shim.cjs` hash the same with the change and without it, so the extension host runs the identical bundle either way. It belongs to whoever owns the delegation gate.

### Task 16: Align user-facing documentation and release readiness

**Files:** Modify `README.md`, `walkthrough/*.md`, `docs/plans/0001-mvp-implementation-plan.md`; add release changelog under `docs/`.

- [ ] Remove bootstrap usability claims until the direct vertical slice passes; then document actual prerequisites, trust, auth, cost, provider egress, worktree limits, and supported Runtime capabilities.
- [ ] Mark milestones from executable evidence only. Promote remaining durable guidance from temporary plans into canonical docs/ADRs, then delete obsolete plan content without leaving code/test references to it.
- [ ] Verify current ACP and vendor claims against primary sources before release; record verification date and links in release documentation, not code.
- [ ] Run `make lint` and `make test`; expect pass. Run `make check-all`; expect a real integration count greater than zero.
- [ ] Confirm all code files are at most 500 lines and docs at most 600 lines; split by responsibility when exceeded.
- [ ] Package with `make package`. There is one extension file (ADR-0011). Never publish automatically. Commit: `docs: describe verified Agent Conductor behavior`.

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
