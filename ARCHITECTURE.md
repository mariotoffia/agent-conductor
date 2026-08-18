# ARCHITECTURE

Canonical architecture for Agent Conductor. Decisions behind it live in `docs/adr/` (ADR-0001…0006); terms in `UBIQUITOUS.md`. Change the shape here → supersede the relevant ADR first.

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
│  └─ ipc               socket server for the Shim (token-authed)         │
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
                            │ every eligible session gets the Shim injected
                    ┌───────┴────────┐
                    │ MCP Shim       │ dist/mcp-shim.cjs — spawned BY the harness
                    └───────┬────────┘ tools: spawn_subagent · list_runtimes · …
                            │ unix socket / named pipe (token)
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

`src/core/**` may not import `vscode` (checked by `make lint`). `src/vscode/**` may import core. `src/shim/**` is standalone — bundled separately, no imports from either (it runs outside the extension host). TypeScript only — no other implementation languages (ADR-0003). The core's internal API mirrors ACP semantics: it runs under plain Node in unit tests, and could later back the ACP-agent Facade as a Node process reusing `src/core` — a packaging change, not a rewrite.

## Data flows

**Prompt.** Chat input → participant → `ConductorSession` (created via `session/new`: workspace `cwd`, sorted `mcpServers` incl. Shim when Depth Cap allows, Suppression `_meta`) → `session/prompt` → update pump → render map → stop reason.

**Spawn.** Model calls `spawn_subagent{runtime?, model?, effort?, brief, …}` → Shim → socket → Orchestrator: validate (depth, semaphore, budget) → resolve Preset defaults → optional `git worktree add` → child `session/new` on the target Runtime (Suppression on; **no Shim below Depth Cap** — the recursion guard) → child updates render nested under the parent tool call → child's final message returns as the tool result.

**Permission.** Any session → `session/request_permission` → policy (autoAllow/autoReject by ToolKind, remembered always-choices) → else modal → `selected`/`cancelled`. Cancelled turns must answer `cancelled`.

**Cancel.** `session/cancel` → await `stopReason:"cancelled"` under a grace timer → SIGTERM fallback. Parent cancel cascades to tracked children.

## Runtime catalog

Built-in Runtimes: `claude` (adapter; per-session `_meta` policy), `codex` (adapter; process-scoped `CODEX_CONFIG` → one process per policy), `gemini` (native `--acp`; workspace-settings suppression, consent-gated), `copilot` (native `--acp --stdio`; model/effort/tools process-scoped), plus user-defined custom ACP agents. Launch specs refresh from the ACP Registry (cached, pinnable, offline-safe).

## Model & effort

Resolution order: `configOptions` (categories `model`, `thought_level`) → catalog/argv fallback → **Read-back always** (agents clamp silently). Setting a Config Option returns the complete refreshed array; agents may also push `config_option_update` unprompted — always re-render from the latest array (ADR-0005).

## Security invariants

Workspace-trust gate before any spawn; per-runtime safe mode for untrusted/cloned repos; Shim socket token per window; fs handlers validate paths against `cwd` + `additionalDirectories`; keys in `SecretStorage`; auth posture per ADR-0006; budgets and stall timeouts on every Subagent.
