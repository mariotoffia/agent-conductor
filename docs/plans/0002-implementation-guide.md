# Plan 0002 — Implementation guide (working document)

Status: active · **temporary** — per `AGENTS.md`, nothing in code, comments, or tests may reference this file; promote durable content before deletion. Canonical homes: architecture → `../../ARCHITECTURE.md` · terms → `../../UBIQUITOUS.md` · personas → `../../PERSONAS.md` · decisions → `../adr/` (ADR-0001…0010) · milestones → `0001-mvp-implementation-plan.md`.

Scope kept here: the concrete how-to — scaffold, manifest, settings schema, code skeletons, wizard, testing, packaging — plus Appendix A (per-runtime evidence incl. the unverified list).

## Design

### 6. Runtime catalog & registry resolution

A **RuntimeSpec** describes how to launch and constrain one agent:

```ts
interface RuntimeSpec {
  id: string;                        // "claude" | "codex" | "gemini" | "copilot" | custom
  displayName: string;
  launch: { command: string; args: string[]; env: Record<string, string> };
  suppression: SuppressionPlan;      // see §9
  meta?: (opts: SessionOptions) => object | undefined;  // session/new _meta builder
  modelCatalog?: ModelHint[];        // fallback when configOptions absent
  loginCommand?: string;             // shown by the wizard when auth is required
  detection: { binaries: string[]; versionArgs: string[] };
  quirks: { effortReadback: boolean; processScopedConfig: boolean;
            slashCommandAllowlist: string[] };
}
```

Built-in catalog (ids fixed, everything overridable in settings):

| id | launch | notes |
|---|---|---|
| `claude` | `npx @agentclientprotocol/claude-agent-acp --hide-claude-auth` | adapter; `_meta.claudeCode.options` passthrough; subscription auth disabled |
| `codex` | `npx -y @agentclientprotocol/codex-acp` + `CODEX_CONFIG` env | config is process-scoped; one process per Session |
| `gemini` | `gemini --acp` | suppression via workspace `.gemini/settings.json` (consent-gated) |
| `copilot` | `copilot --acp --stdio` + startup flags | model/effort/tools are process-scoped |
| `custom-*` | user-defined | any ACP agent works |

At activation (and on demand in the wizard) the RuntimeRegistry refreshes launch specs from the machine-readable ACP registry — `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json` (38 agents, pinned versions, sha256) — cached in `globalStorage` with TTL, versions pinnable via `agentConductor.registry.pin`. Network access is optional; the built-in catalog always works offline.

### 7. Session management

`AcpClient` owns one agent subprocess + connection; `ConductorSession` wraps one ACP session. Lifecycle rules learned from the adapters' behavior:

- Every Session owns exactly one Agent process so cancellation fallback and crashes cannot affect another Session.
- Keep the `mcpServers` array **stable and sorted by name** — claude-agent-acp fingerprints `(cwd, mcpServers)` and respawns the underlying query when it changes.
- On `session/load`/`resume`, **always re-send `mcpServers`** (codex-acp skips MCP recovery otherwise) and re-send `additionalDirectories` only when supported and authorized.
- Advertise `clientCapabilities: { fs: {readTextFile:true, writeTextFile:true}, terminal: true, _meta: {"subagent-transcript": true} }`. The `_meta` capability makes claude-agent-acp forward nested subagent text tagged with `parentToolUseId` — without it, any delegation that slips through renders as an opaque tool result.
- Implement `elicitation/create` (form flavor) or accept that claude-agent-acp silently disables `AskUserQuestion`.
- Cancellation is two-layered and can hang: revoke the Session Capability, send `session/cancel`, await `stopReason:"cancelled"` under a grace timer, then terminate that Session's subprocess as fallback. Parent cancel cascades to tracked children.

### 8. Model & effort selection

Decision record: ADR-0005. Never hardcode. Resolution order:

1. **`configOptions`** from `session/new` — filter by `category`: `"model"` and `"thought_level"` populate the pickers; set via `session/set_config_option {configId, value}`; the agent replies with the complete updated array (a model change can change valid effort values) and may push `config_option_update` unprompted (rate-limit fallback) — always re-render from the latest array.
2. **Spawn-time fallback** for agents without config options: argv/env from the catalog (`--model`, `-c model_reasoning_effort=…`, `--effort`, `GOOSE_MODEL`, …), plus live enumeration where offered (`cursor-agent --list-models`).
3. **Read-back, always.** Effort is advisory everywhere: Claude silently clamps (`xhigh`→`high` on 4.6-class models; org caps clamp silently in json modes), Codex documents `xhigh` as model-dependent, Copilot has open bugs degrading `xhigh`→`medium`. Surface the *effective* model/effort (Claude: `system/init` and `modelUsage`; otherwise the refreshed `configOptions`) in the session header, with a subtle "requested ≠ effective" warning when they differ.

Claude effort×model matrix to encode (v2.1.234): Fable 5 / Opus 5 / Sonnet 5 / Opus 4.8 / 4.7 accept `low…max`; Opus 4.6 / Sonnet 4.6 lack `xhigh`; older models accept none. Out-of-range clamps down silently.

### 9. Suppressing built-in delegation

Decision record: ADR-0004.

`SuppressionPlan` per Runtime is applied only after orchestration opt-in. Shim injection additionally requires current Runtime Trust and Suppression Capability:

| Runtime | Mechanism | Where applied |
|---|---|---|
| claude | `_meta.claudeCode.options = { disallowedTools:["Agent","SendMessage","ListAgents"], agents:{} }` (+ optional PreToolUse deny hook for audit trail) | per **session** |
| codex | `CODEX_CONFIG='{"agents":{"enabled":false},"features":{"multi_agent_v2":false,"collab":false}}'` | per **process** |
| gemini | workspace `.gemini/settings.json`: `{"experimental":{"enableAgents":false},"tools":{"exclude":["invoke_agent"]}}` | per **workspace** (consent-gated setting; we merge, never clobber, and offer to revert) |
| copilot | `--excluded-tools "task,read_agent"` (verify tool names against the live tool list at wizard time) | per **process** |

Traps encoded in the plan: Claude's tool is `Agent` — the old name `Task` silently no-ops; `features.multi_agent_v2` is checked *before* `agents.enabled` on Codex; Gemini's `/model` does not apply to its subagents (moot once suppressed).

### 10. Orchestrator & MCP shim

The shim (`dist/mcp-shim.cjs`, bundled, zero-dependency) is spawned by eligible harnesses via the `mcpServers` entry. ACP requires an **absolute** `command` for stdio MCP servers — resolve it; inside VS Code use `process.execPath` with `ELECTRON_RUN_AS_NODE=1` in the env list so no system Node is needed. The shim speaks MCP over stdio and tunnels tool calls over a local socket / named pipe using a short-lived Session Capability.

Tools exposed to the model:

| Tool | Behavior |
|---|---|
| `spawn_subagent` | `{runtime?, model?, effort?, brief, files?, cwd?, isolation?: "shared"\|"worktree", mode?: "sync"\|"background", budget_usd?, timeout_ms?}` → sync returns the child's final message; background returns a handle. Description stresses: *the child has no access to this conversation — write a self-contained brief; pass file paths, not contents.* |
| `check_subagent` / `subagent_result` / `cancel_subagent` | background lifecycle |
| `list_runtimes` | configured runtimes + models + current defaults, so the model can choose intelligently |

Orchestrator invariants: while disabled, issue no Session Capability, inject no Shim, and expose no spawn RPC. Otherwise all spawn params are optional (defaults from settings/presets); enforce local concurrency, depth, spawn-count, and timeout limits; forward monetary limits only with a Budget Capability; bind provider consent to the target Runtime Trust fingerprint; enforce Depth Cap by **not injecting the Shim** below it. `isolation:"worktree"` serializes Git mutations, journals allocation, and never deletes dirty worktrees automatically. It passes the worktree as child `cwd` and omits the parent repository from `additionalDirectories` by default. Worktrees coordinate changes; they do not restrict Agent access. Parent cancel cascades, and every child result records Runtime, effective model/effort, cost or unknown, and duration.

### 11. Permission routing, fs, terminals

**Permissions.** Derive a Client Operation from the ACP method and normalized arguments, then apply automatic/remembered policy by that key. `ToolKind` is display-only. Otherwise show a modal with the Agent's option names and Client-derived operation detail. Permission routing is consent/audit, not an Agent sandbox. Cancelled turn ⇒ respond `cancelled`.

**fs/read_text_file** serves **dirty editor buffers first** (`workspace.textDocuments`) — that's the point of the capability — falling back to disk; both handlers validate the path against `cwd` + `additionalDirectories` and refuse outside it. **fs/write_text_file** applies through `WorkspaceEdit` when the file is open (preserves undo) else writes to disk.

**terminal/*** is implemented with `child_process.spawn` (never `shell:true`; command+args come structured), a ring buffer honoring `outputByteLimit` with `truncated` flag, and exit-status plumbing for `wait_for_exit`. Optionally mirror output into a read-only VS Code terminal (`window.createTerminal({pty})`) for visibility. `kill` terminates but keeps the buffer readable until `release`.

### 12. UI surfaces

**Chat participant (stable, Marketplace).** `session/update` → `ChatResponseStream` mapping:

| ACP update | Rendering (stable API) |
|---|---|
| `agent_message_chunk` | `stream.markdown()` |
| `agent_thought_chunk` | collapsed details block / italic quote, toggle via `agentConductor.ui.showThinking` |
| `tool_call` | `stream.progress("⚙ title")`; on update, one markdown line with kind icon + `stream.anchor(uri)` per location |
| `tool_call_update` content `diff` | fenced diff + `stream.button` → command opening a real diff editor (virtual doc provider holds `oldText`) |
| `plan` | markdown checklist (replace wholesale each update, per spec) |
| `available_commands_update` | filtered by allowlist (interactive TUI commands hang ACP sessions), surfaced in `/help` |
| `usage_update` | footer line: context %, cost |
| `session_info_update` | rename in the sessions tree |

Participant slash commands (static, ours): `/runtime`, `/model`, `/effort`, `/spawn`, `/sessions`, `/cancel`. Agent-side slash commands pass through as prompt text (per spec).

**Sessions tree** (Activity Bar): session → subagent children with runtime/model/effort/cost badges; context menu: cancel, resume, open worktree diff. **VSIX-only build** adds `chatSessionsProvider@3` + `chatParticipantAdditions@3` for native tool-call/diff/todo rendering — same core, different render target.

### 13. Security posture

Auth decision record: ADR-0010 (supersedes ADR-0006).

Workspace trust and Runtime Trust gate every spawn. Runtime Trust fingerprints the canonical artifact plus effective launch specification and is re-verified on each spawn. Safe-mode flags reduce repository exposure but are not a sandbox. Secret values and sensitive resume tokens live in `context.secrets`; settings and Persisted Sessions contain references only. Claude defaults to `--hide-claude-auth` and requires API-key or supported cloud-provider credentials. Re-check provider policy before release. Session Capabilities are bound to parent, depth, roots, methods, expiry, and current trust; cancellation, parent termination, trust invalidation, and orchestration disablement revoke them immediately.

### 14. Core/UI seam

See ADR-0003 (TypeScript only). Operative rule: `src/core/**` never imports `vscode` and its internal API stays ACP-shaped (`make lint` enforces the import seam).

---

## Implementation

### 15. Scaffold & repo layout

```bash
npm i -g yo generator-code @vscode/vsce
yo code            # New Extension (TypeScript), bundler: esbuild
npm i @agentclientprotocol/sdk @modelcontextprotocol/sdk
```

```
agent-conductor/
├─ package.json                  # manifest — §16
├─ esbuild.mjs                   # two bundles: extension.cjs + mcp-shim.cjs
├─ src/
│  ├─ extension.ts               # activate(): wire everything
│  ├─ core/                      # ← NO `vscode` imports anywhere below
│  │  ├─ runtimeRegistry.ts      # catalog, detection, ACP-registry refresh
│  │  ├─ acpClient.ts            # spawn + handshake + connection mgmt
│  │  ├─ session.ts              # ConductorSession: prompt loop, updates, cancel
│  │  ├─ policy.ts               # SuppressionPlan builders per runtime
│  │  ├─ discovery.ts            # configOptions → model/effort pickers, read-back
│  │  ├─ orchestrator.ts         # spawn tree, semaphore, budgets, worktrees
│  │  └─ ipc.ts                  # socket server for the shim (token auth)
│  ├─ vscode/
│  │  ├─ participant.ts          # chat participant + renderUpdate()
│  │  ├─ permissions.ts          # PermissionRouter
│  │  ├─ fsProvider.ts           # fs/* handlers (dirty buffers first)
│  │  ├─ terminals.ts            # terminal/* handlers
│  │  ├─ sessionsTree.ts         # TreeDataProvider
│  │  ├─ wizard.ts               # Connect-a-CLI wizard — §19
│  │  └─ diffDocs.ts             # TextDocumentContentProvider for oldText
│  ├─ shim/mcp-shim.ts           # standalone MCP stdio server — §18
│  └─ test/                      # mock agent + integration tests — §20
└─ media/ walkthrough/ …
```

esbuild builds **two** entry points: `dist/extension.cjs` (external: `vscode`) and `dist/mcp-shim.cjs` (fully bundled, `platform:"node"`, no externals — it runs outside the extension host).

### 16. package.json — the manifest

```jsonc
{
  "name": "agent-conductor",
  "displayName": "Agent Conductor",
  "publisher": "mario",
  "engines": { "vscode": "^1.104.0" },
  "main": "./dist/extension.cjs",
  "activationEvents": ["onStartupFinished"],        // session restore only; commands/participant auto-activate
  "capabilities": {
    "untrustedWorkspaces": { "supported": false, "description": "Agents execute code; trust is required." },
    "virtualWorkspaces": false
  },
  "contributes": {
    "chatParticipants": [{
      "id": "agentConductor.chat",
      "name": "conductor",
      "fullName": "Agent Conductor",
      "description": "Drive Claude Code, Codex, Gemini, Copilot & any ACP agent",
      "isSticky": true,
      "commands": [
        { "name": "runtime", "description": "Switch CLI runtime for this session" },
        { "name": "model",   "description": "Pick model" },
        { "name": "effort",  "description": "Pick reasoning effort" },
        { "name": "spawn",   "description": "Manually spawn a subagent" },
        { "name": "cancel",  "description": "Cancel the current turn" }
      ]
    }],
    "commands": [
      { "command": "agentConductor.connectCli",  "title": "Agent Conductor: Connect a CLI…" },
      { "command": "agentConductor.newSession",  "title": "Agent Conductor: New Session", "icon": "$(add)" },
      { "command": "agentConductor.cancelAll",   "title": "Agent Conductor: Cancel All Sessions" },
      { "command": "agentConductor.openDiff",    "title": "Agent Conductor: Open Tool-Call Diff" },
      { "command": "agentConductor.refreshRegistry", "title": "Agent Conductor: Refresh ACP Agent Registry" }
    ],
    "viewsContainers": { "activitybar": [{ "id": "agentConductor", "title": "Agent Conductor", "icon": "media/icon.svg" }] },
    "views": { "agentConductor": [{ "id": "agentConductor.sessions", "name": "Sessions" }] },
    "menus": { "view/title": [{ "command": "agentConductor.newSession", "when": "view == agentConductor.sessions", "group": "navigation" }] },
    "walkthroughs": [{
      "id": "agentConductor.gettingStarted",
      "title": "Set up Agent Conductor",
      "description": "Connect your agent CLIs and run your first orchestrated session.",
      "steps": [
        { "id": "install",  "title": "Install at least one agent CLI",
          "description": "Claude Code, Codex, Gemini CLI or Copilot CLI.\n[Check what's installed](command:agentConductor.connectCli)",
          "media": { "markdown": "walkthrough/install.md" } },
        { "id": "connect",  "title": "Run the connection wizard",
          "description": "[Connect a CLI…](command:agentConductor.connectCli)",
          "media": { "markdown": "walkthrough/connect.md" },
          "completionEvents": ["onSettingChanged:agentConductor.runtimes"] },
        { "id": "firstChat", "title": "Start a session",
          "description": "Open Chat and mention **@conductor**.",
          "media": { "markdown": "walkthrough/chat.md" } },
        { "id": "orchestrate", "title": "Enable cross-CLI subagents",
          "description": "[Review orchestration settings](command:workbench.action.openSettings?%22agentConductor.orchestration%22)",
          "media": { "markdown": "walkthrough/orchestrate.md" } }
      ]
    }],
    "configuration": { /* §17 */ }
  }
}
```

The proposed-API build adds `"enabledApiProposals": ["chatSessionsProvider", "chatParticipantAdditions"]` plus the `chatSessions` contribution — generated by a build script, **stripped for the Marketplace build** (vsce rejects proposals; users of the rich build sideload the VSIX with `--enable-proposed-api`).

### 17. Settings (`contributes.configuration`)

```jsonc
"configuration": {
  "title": "Agent Conductor",
  "properties": {
    "agentConductor.runtimes": {
      "type": "object", "scope": "resource",
      "markdownDescription": "Configured agent runtimes, keyed by id. Managed by the wizard; hand-editable.",
      "additionalProperties": { "type": "object", "properties": {
        "enabled":       { "type": "boolean", "default": true },
        "command":       { "type": "string" },
        "args":          { "type": "array", "items": { "type": "string" } },
        "secretEnvironment": { "type": "object", "additionalProperties": { "type": "string" } },
        "defaultModel":  { "type": "string" },
        "defaultEffort": { "type": "string", "enum": ["low","medium","high","xhigh","max"] },
        "suppressBuiltInSubagents": { "type": "boolean", "default": true },
        "safeMode":      { "type": "boolean", "default": false,
                           "description": "Claude: pass --bare/--safe-mode (skips repo hooks & .mcp.json — recommended for cloned repos)" }
      }, "additionalProperties": false}},
    "agentConductor.defaultRuntime":  { "type": "string", "default": "claude" },
    "agentConductor.presets": {
      "type": "object", "scope": "resource",
      "markdownDescription": "Named (runtime, model, effort) presets, e.g. `\"reviewer\": {\"runtime\":\"codex\",\"model\":\"gpt-5.6-sol\",\"effort\":\"high\"}` — usable from `/spawn` and as orchestrator defaults.",
      "additionalProperties": { "type": "object", "properties": {
        "runtime": {"type":"string"}, "model": {"type":"string"}, "effort": {"type":"string"} }}},

    "agentConductor.orchestration.enabled":               { "type": "boolean", "default": false },
    "agentConductor.orchestration.maxConcurrentSubagents":{ "type": "number",  "default": 3, "minimum": 1, "maximum": 16 },
    "agentConductor.orchestration.maxSpawnDepth":         { "type": "number",  "default": 1,
      "description": "Depth below which the orchestrator MCP server is not injected (recursion guard)." },
    "agentConductor.orchestration.subagentIsolation":     { "type": "string",  "enum": ["shared","worktree"], "default": "worktree" },
    "agentConductor.orchestration.budgetUsdPerSubagent":  { "type": "number",  "default": 2 },
    "agentConductor.orchestration.defaultSubagentPreset": { "type": "string",  "default": "" },

    "agentConductor.permissions.autoAllowClientOperations": { "type": "array", "items": { "type": "string",
      "enum": ["fs.read","fs.write","terminal.spawn","terminal.wait","terminal.kill","terminal.release"] },
      "default": ["fs.read"],
      "description": "Client operations approved without prompting; ACP ToolKind is display-only." },
    "agentConductor.permissions.autoRejectClientOperations": { "type": "array", "items": { "type": "string" }, "default": [] },
    "agentConductor.permissions.rememberAlwaysChoices": { "type": "boolean", "default": true },

    "agentConductor.claude.hideSubscriptionAuth": { "type": "boolean", "default": true,
      "markdownDescription": "Disable claude.ai subscription credentials; configure API-key or supported cloud-provider authentication." },
    "agentConductor.gemini.writeWorkspaceSettings": { "type": "boolean", "default": false,
      "description": "Allow merging subagent-suppression keys into the workspace .gemini/settings.json (asked once by the wizard)." },

    "agentConductor.registry.autoResolve": { "type": "boolean", "default": true },
    "agentConductor.registry.url": { "type": "string",
      "default": "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json" },
    "agentConductor.registry.pin": { "type": "object", "additionalProperties": { "type": "string" },
      "description": "Pin registry agents to versions, e.g. {\"claude-acp\": \"0.69.0\"}." },

    "agentConductor.sessions.resumeOnStartup": { "type": "boolean", "default": false },
    "agentConductor.worktrees.root": { "type": "string", "default": "",
      "description": "Empty = <workspace>/.conductor/worktrees (git-ignored)." },
    "agentConductor.ui.showThinking":  { "type": "boolean", "default": true },
    "agentConductor.ui.slashCommandAllowlist": { "type": "array", "items": {"type":"string"},
      "default": ["compact","init","review","plan","context"],
      "description": "Agent slash commands surfaced to the user. Interactive TUI commands hang ACP sessions and are filtered." },
    "agentConductor.logging.level": { "type": "string", "enum": ["off","error","info","debug","trace"], "default": "info" }
  }
}
```

### 18. Core code

The snippets pin `@agentclientprotocol/sdk@1.3.0` — its fluent API is young, so treat the SDK README as the source of truth for exact names and pin the version. (Fallback precedent: `formulahendry.acp-client` hand-rolls the ndjson JSON-RPC layer — ~a day of work if you ever prefer zero deps.)

**Spawn + handshake + long-lived session (`core/acpClient.ts`):**

```ts
import * as acp from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

export async function connectRuntime(rt: RuntimeSpec, svc: ClientServices) {
  const proc = spawn(rt.launch.command, rt.launch.args, {
    env: { ...process.env, ...rt.launch.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.stderr.on("data", d => log.debug(`[${rt.id}] ${d}`));

  const stream = acp.ndJsonStream(
    Writable.toWeb(proc.stdin!),
    Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>,
  );

  return acp.client({ name: "agent-conductor", version: EXT_VERSION })
    .onRequest(acp.methods.client.session.requestPermission, c => svc.permissions.handle(c.params))
    .onRequest(acp.methods.client.fs.readTextFile,  c => svc.fs.read(c.params))
    .onRequest(acp.methods.client.fs.writeTextFile, c => svc.fs.write(c.params))
    // + terminal/* handlers via svc.terminals
    .connectWith(stream, async (ctx) => {
      const init = await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,   // 1
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
          _meta: { "subagent-transcript": true },
        },
        clientInfo: { name: "agent-conductor", version: EXT_VERSION },
      });
      if (init.authMethods?.length) svc.auth.noteMethods(rt.id, init.authMethods);
      // hold the connection open; sessions are created/prompted through `ctx`
      await svc.sessions.runConnectionLoop(rt, ctx, init);   // resolves on dispose
    });
}
```

**`session/new` with orchestration policy (inside `runConnectionLoop`):**

```ts
const mcpServers = orchestration.enabled && runtimeTrust.current && suppression.current
  && depth < cfg.maxSpawnDepth
  ? [{
      name: "orchestrator",
      command: process.execPath,                       // absolute — spec requires it
      args: [ctx.shimPath, "--socket", ipc.socketPath, "--capability", sessionCapability],
      env: [{ name: "ELECTRON_RUN_AS_NODE", value: "1" }],
    }]
  : [];

const session = await ctx.request(acp.methods.agent.session.new, {
  cwd: workspaceFolder,                                 // absolute
  mcpServers: sortByName(mcpServers),                   // stable order — fingerprinting
  _meta: rt.meta?.({ suppress: true }),                 // e.g. claude: disallowedTools/agents:{}
});
// session.configOptions → discovery.applyConfigOptions(rt, session)
```

**Update pump → UI (consumed by the participant):**

```ts
for (;;) {
  const msg = await session.nextUpdate();
  if (msg.kind === "stop") return msg.response;          // { stopReason }
  await sink.render(msg.notification);                   // session/update variant
}
```

**Permission handler (`vscode/permissions.ts`):**

```ts
async handle(p: RequestPermissionParams): Promise<RequestPermissionResponse> {
  if (this.turnCancelled(p.sessionId)) return { outcome: { outcome: "cancelled" } }; // spec
  const operation = classifyClientOperation(p);          // method + normalized arguments
  const auto = this.policy.decide(operation);             // ToolKind is display-only
  if (auto) return { outcome: { outcome: "selected", optionId: auto } };

  const pick = await vscode.window.showWarningMessage(
    `${p.toolCall.title ?? "Agent action"}`,
    { modal: true, detail: describe(p.toolCall) },       // diff summary / command line / paths
    ...p.options.map(o => o.name),
  );
  const chosen = p.options.find(o => o.name === pick);
  if (chosen && chosen.kind.endsWith("_always") && this.cfg.rememberAlwaysChoices)
    this.policy.remember(p.toolCall, chosen);
  return { outcome: chosen
    ? { outcome: "selected", optionId: chosen.optionId }
    : { outcome: "cancelled" } };
}
```

**MCP shim (`shim/mcp-shim.ts` → bundled `dist/mcp-shim.cjs`):**

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { rpc } from "./socketClient";                    // ndjson over the unix socket, token-authed

const srv = new McpServer({ name: "orchestrator", version: "1.0.0" });

srv.tool("spawn_subagent",
  "Delegate a self-contained task to a subagent on another (or the same) CLI runtime. " +
  "The child has NO access to this conversation: write a complete brief; pass file PATHS, never contents.",
  {
    runtime: z.enum(["claude","codex","gemini","copilot"]).optional(),
    model: z.string().optional(),
    effort: z.enum(["low","medium","high","xhigh","max"]).optional(),
    brief: z.string(),
    files: z.array(z.string()).optional(),
    isolation: z.enum(["shared","worktree"]).optional(),
    mode: z.enum(["sync","background"]).optional(),
    budget_usd: z.number().optional(),
    timeout_ms: z.number().optional(),
  },
  async (args) => ({ content: [{ type: "text", text: await rpc("spawn", args) }] }),
);
srv.tool("list_runtimes", "Configured runtimes, models and defaults.", {},
  async () => ({ content: [{ type: "text", text: await rpc("listRuntimes", {}) }] }));
// + check_subagent / subagent_result / cancel_subagent

await srv.connect(new StdioServerTransport());
```

Extension side (`core/ipc.ts`): a `net.createServer` on `os.tmpdir()/agent-conductor-<nonce>.sock` (Windows: `\\.\pipe\agent-conductor-<nonce>`), first line must be the token, then ndjson request/response dispatched to the Orchestrator. `spawn` resolves defaults → acquires the semaphore → optional `git worktree add` → opens a child ACP session (suppression `_meta`, **no** shim below depth cap) → streams child updates into the sessions tree under the parent → returns the child's final assistant message (plus effective model/effort and cost) as the tool result text.

### 19. The Connect-a-CLI wizard (`agentConductor.connectCli`)

Sequential QuickInput flow; every step cancellable; state carried forward so ⟵ works.

```
1 Detect     which/where over {claude,codex,gemini,copilot,cursor-agent,opencode,goose}
             + npx present? + ACP registry (cached) for adapter launch specs
             → QuickPick (multi): "✓ claude 2.1.234 — via claude-agent-acp adapter",
               "✗ codex — not found (npm i -g @openai/codex)", "＋ Custom ACP agent…"
2 Configure  per selection: launch spec prefilled from catalog/registry; custom → command+args input;
             approve Runtime Trust fingerprint (artifact + effective launch specification)
3 Auth       protocol-clean probe: spawn → initialize → session/new in a temp dir.
             -32000 auth_required / authMethods present →
               Claude → configure API-key or supported cloud-provider secret reference;
               other Runtimes → open their permitted login command → "Press Continue when done" → retry.
4 Models     from the probe session read configOptions:
               category "model"        → defaultModel QuickPick
               category "thought_level"→ defaultEffort QuickPick
             absent → catalog fallback (+ live `cursor-agent --list-models` style enumeration)
5 Policy     orchestration opt-in · verified suppression · Client Operation allow/reject keys ·
             local limits + supported per-subagent budget · [claude] safe mode ·
             target Runtime/provider fingerprint consent ·
             [gemini] consent to write workspace .gemini/settings.json
6 Smoke test session/prompt "Reply with exactly: OK" under withProgress;
             show streamed reply + EFFECTIVE model/effort read back; surface mismatch here
7 Save       config.update("agentConductor.runtimes", merged, Global|Workspace picked by user)
             → "Runtime connected. Open Chat with @conductor?" [Open Chat]
```

Implementation notes: steps 3–6 reuse `connectRuntime` with silent handlers (auto-reject writes/execute — the probe needs none); the probe session is closed (`session/close` where supported, else process exit) before saving; wizard results also fill `quirks` (e.g. record whether `configOptions` were present, so the picker knows its data source). The walkthrough (§16) links here, and `completionEvents` ticks the step when `agentConductor.runtimes` first changes.

### 20. Testing

Ship a **mock ACP agent** (`test/mock-agent.ts`, ~100 lines): speaks ndjson ACP v1, advertises fixed `configOptions` (2 models × 3 thought levels), replies to `session/prompt` with a scripted update sequence (message chunk → thought → tool_call with diff → permission request → plan → stop). Integration tests (`@vscode/test-electron`) drive the participant against it and assert: rendering per variant, permission modal policy short-circuit, config-option round-trip (set model → refreshed array), cancel → `stopReason:"cancelled"`, and the orchestrator path (mock agent calls `spawn_subagent` via the shim → child mock session → result text returned). Unit-test the policy builders (exact argv/env/`_meta` per runtime) against golden files — that's where regressions bite when CLIs rename flags.

### 21. Packaging & builds

`esbuild.mjs` produces `dist/extension.cjs` + `dist/mcp-shim.cjs`. Two release channels from one tree: **Marketplace** (stable APIs only; `vsce package`) and **rich VSIX** (build script injects `enabledApiProposals` + `chatSessions` contribution; sideload with `code --install-extension … --enable-proposed-api mario.agent-conductor`). No platform-specific VSIX needed in v1 (no native binaries; the shim runs on VS Code's own Node). CI: lint, unit, mock-agent integration on Linux/macOS/Windows, then optional live smoke against real CLIs where runners have them.

### 22. Milestones

Moved to `0001-mvp-implementation-plan.md`.

---

## Appendix A — per-runtime launch & policy matrix

| Runtime | Launch | Suppression | Model | Effort | Auth probe hint |
|---|---|---|---|---|---|
| claude | `npx @agentclientprotocol/claude-agent-acp --hide-claude-auth` | `_meta.claudeCode.options.disallowedTools:["Agent","SendMessage","ListAgents"], agents:{}` | configOptions `model` (aliases: fable/opus/sonnet/haiku/…) | configOptions `effort` — clamps silently; read back | API-key or supported cloud-provider secret reference |
| codex | `CODEX_CONFIG='{"agents":{"enabled":false},"features":{"multi_agent_v2":false}}' npx -y @agentclientprotocol/codex-acp` | via `CODEX_CONFIG` (process-scoped) | configOptions (gpt-5.6-sol/terra/luna, …) | configOptions `reasoning_effort` (minimal…xhigh; max/ultra unverified) | `codex login` |
| gemini | `gemini --acp` | workspace `.gemini/settings.json` merge (consent) | `-m` / configOptions if exposed | none (thinkingBudget only) | first-run OAuth in terminal |
| copilot | `copilot --acp --stdio --excluded-tools "task,read_agent" --model=… --effort=…` | startup flags (process-scoped; one process per model×effort) | startup flag only | startup flag only (low/med/high verified; xhigh flaky) | `copilot` → `/login` |
| custom | user command | user-provided | configOptions when present | configOptions when present | agent `authMethods` |

Unverified items to re-check at implementation time: Copilot delegation tool names (`task`, `read_agent`); Codex `max`/`ultra` effort via config; Cursor model IDs; Claude `toolAliases` redirect in practice.
