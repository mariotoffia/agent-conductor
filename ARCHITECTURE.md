# ARCHITECTURE

Canonical architecture for Agent Conductor. Decisions behind it live in `docs/adr/` (ADR-0001…0010); terms in `UBIQUITOUS.md`. Change the shape here → supersede the relevant ADR first.

## Premise

We are an **ACP client**, never a harness (ADR-0001). Each Runtime executes inside its own CLI's harness — its system prompt, tools, memory files, compaction. The extension renders `session/update` and answers `session/request_permission` / `fs/*` / `terminal/*`. Conversation context is never shared across Runtimes; delegation is Brief-level by construction.

## System

```
┌─ VS Code window ────────────────────────────────────────────────────────┐
│  UI layer (src/vscode/**, may import core)                              │
│  ├─ Chat participant @conductor        (stable API — Marketplace build) │
│  ├─ Sessions tree · transcript webview · Connect-a-CLI wizard           │
│  └─ chatSessions provider              (proposed API — VSIX build only) │
│                                                                         │
│  Conductor core (src/core/**, NO `vscode` imports — extraction seam)    │
│  ├─ RuntimeRegistry   catalog · detection · ACP-Registry resolution     │
│  ├─ AcpClient         spawn · handshake · connections                   │
│  ├─ ConductorSession  prompt loop · update pump · cancel                │
│  ├─ PolicyEngine      Suppression Plans per Runtime                     │
│  ├─ ConfigDiscovery   configOptions → model/effort · Read-back          │
│  ├─ Orchestrator      spawn tree · semaphore · budgets · worktrees      │
│  └─ ipc               socket server for the Shim (capability-authed)    │
│                                                                         │
│  Client services (src/vscode/**): PermissionRouter · FsProvider         │
│  (dirty buffers first) · TerminalService                                │
└──────────┬──────────────────────────────────────────────────────────────┘
           │ spawns; ACP v1 = ndjson JSON-RPC over stdio
   ┌───────┴────────┬───────────────┬───────────────┐
   ▼                ▼               ▼               ▼
claude-agent-acp  codex-acp    gemini --acp   copilot --acp   … any ACP agent
   ▲                ▲               ▲               ▲
   └────────────────┴───────┬───────┴───────────────┘
                            │ opted-in + trusted + suppression-verified only
                    ┌───────┴────────┐
                    │ MCP Shim       │ dist/mcp-shim.cjs — spawned BY the harness
                    └───────┬────────┘ tools: spawn_subagent · list_runtimes · …
                            │ unix socket / named pipe (Session Capability)
                            ▼
                    Orchestrator (extension host)
```

Two process facts anchor everything: the **extension spawns each Agent**; the **Agent spawns our Shim**, whose tool calls tunnel back into the extension — so `spawn_subagent` runs where it can open new ACP sessions and route child permissions into the same UI.

## Protocol surfaces

| Surface | Side we implement | Purpose | Status |
|---|---|---|---|
| ACP | client | drive every Agent (downstream) | v1, core |
| MCP | server (Shim) | orchestrator tools injected per session | core |
| ACP | agent (Facade) | expose the Conductor to Zed/JetBrains/etc. | planned |
| AHP | client / server | VS Code Agent Host interop | deferred (ADR-0001) |

## Layering rules

`src/core/**` may not import `vscode` (checked by `make lint`). Everything the core needs from its host arrives through Client Ports — permission, filesystem, terminal, elicitation, logging, clock, and process spawning. `src/vscode/**` may import core and supplies those adapters. `src/shim/**` is standalone — bundled separately, no imports from either (it runs outside the extension host). TypeScript only — no other implementation languages (ADR-0003). The core's internal API mirrors ACP semantics: it runs under plain Node in unit tests, and could later back the ACP-agent Facade as a Node process reusing `src/core` — a packaging change, not a rewrite.

## Data flows

**Prompt.** Chat input → participant → `ConductorSession` (one Agent process; created via `session/new`: workspace `cwd`, sorted `mcpServers` incl. Shim only when opt-in, trust, suppression, and Depth Cap allow; Suppression `_meta`) → `session/prompt` → update pump → render map → stop reason.

**Spawn.** Model calls `spawn_subagent{runtime?, model?, effort?, brief, …}` → Shim → socket → Orchestrator: validate the active Session Capability, Runtime Trust fingerprint, provider consent, depth, semaphore, local limits, and optional Budget Capability → resolve Preset defaults → optional `git worktree add` → child `session/new` on the target Runtime (Suppression on; **no Shim below Depth Cap** — the recursion guard) → child updates render nested under the parent tool call → child's final message returns as the tool result.

**Permission.** Any Session → `session/request_permission` → policy (automatic allow/reject by Client Operation, remembered always-choices; `ToolKind` display-only) → else modal → `selected`/`cancelled`. Cancelled turns must answer `cancelled`. This is consent and audit, not an Agent sandbox.

**Failure.** A Session owns one Agent process for its whole life. Every wait on a Runtime is bounded: a Setup Deadline bounds each request made outside a Turn — the handshake, Session creation, and setting a Config Option — and a Stall Limit bounds silence inside a Turn — a stalled Turn is cancelled cooperatively first, then falls back to termination like any cancel. Time the Client owes the Agent an answer never counts as silence. A Turn fails when that process or the ACP connection dies, and the failure carries the exit status when it is known and the recent Agent stderr either way; an Agent that merely refuses one Turn keeps the Session usable. ACP transports skip unparseable lines instead of closing, so stream corruption surfaces as a stranded request rather than a transport error. A refused handshake reports both its reason and how the process ended: a Runtime that shuts down cooperatively exits exactly like one that died on its own, so the cause cannot be inferred after the fact. The Client advertises only the capabilities a Client Port can actually serve, and answers `cancelled` when no permission route exists. The SDK schema-checks the notifications the Client receives but not the responses to the requests it sends, so agent-supplied arrays are narrowed to trustworthy shapes on arrival rather than assumed from their declared types (ADR-0007).

**Cancel.** `session/cancel` → revoke its Session Capability → await `stopReason:"cancelled"` under a grace timer → terminate only that Session's process as fallback. Parent cancel cascades to tracked children.

## Runtime catalog

Built-in Runtimes: `claude` (adapter; per-session `_meta` policy), `codex` (adapter; process-scoped `CODEX_CONFIG`), `gemini` (native `--acp`; workspace-settings suppression, consent-gated), `copilot` (native `--acp --stdio`; model/effort/tools process-scoped), plus user-defined custom ACP agents. Every Session owns one Agent process. Launch specs refresh from the ACP Registry (cached, pinnable, offline-safe), and Runtime Trust is bound to the resolved artifact plus effective launch specification.

## Model & effort

Resolution order: `configOptions` (categories `model`, `thought_level`) → catalog/argv fallback → **Read-back always** (agents clamp silently). Setting a Config Option returns the complete refreshed array; agents may also push `config_option_update` unprompted — always re-render from the latest array (ADR-0005).

The fallback is consulted only in the agent's silence, and it populates a picker — never a Read-back: a requested value becomes *effective* only when the agent itself reports it, so a process-scoped Runtime that reports nothing leaves the selection `unavailable` rather than confirming its own argv. A Session is busy for the whole of a set, so no Turn can begin under a configuration still being changed and two sets cannot race each other's refreshed array.

## Security invariants

Workspace trust and Runtime Trust gate every spawn; safe mode reduces repository exposure but is not a sandbox. Orchestration defaults off and issues no Session Capability, injects no Shim, and exposes no spawn RPC while disabled. Capabilities are per Session, revocable, and checked against active parent, roots, methods, expiry, and current trust. Worktrees coordinate changes but do not restrict Agent access; parent repositories are omitted from child `additionalDirectories` by default. Secrets and resume-token values live in SecretStorage; settings and Persisted Sessions hold references only. Claude subscription authentication is disabled by default (ADR-0010). Local depth, concurrency, spawn-count, and stall limits apply to every Subagent; monetary limits are capability-dependent.
