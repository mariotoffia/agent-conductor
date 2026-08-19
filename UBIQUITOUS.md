# UBIQUITOUS — authoritative glossary

Code identifiers, settings keys, docs, and commit messages use these words with exactly these meanings. If a term must change meaning, update this file first (ADR if the semantics shift).

| Term | Meaning |
|---|---|
| **Agent** | The ACP-side counterparty: a coding CLI (or adapter) we spawn and drive over stdio. |
| **Client** | The ACP role we implement: spawns the Agent, renders updates, answers permission/fs/terminal requests. Never runs the loop. |
| **Client Port** | A narrow interface through which the `vscode`-free core reaches one host service: permission, filesystem, terminal, elicitation, logging, clock, process spawning. A port's presence is what allows the Client to advertise the matching ACP capability. |
| **Harness** | A CLI's own agent loop — its system prompt, tools, memory files, compaction, permission engine. Always the CLI's, never ours. |
| **Adapter** | An ACP wrapper around a non-ACP CLI (`claude-agent-acp`, `codex-acp`). |
| **Runtime** | A configured, launchable agent: id + launch spec + suppression plan + quirks. Settings key `agentConductor.runtimes`. |
| **Runtime Trust** | User approval bound to the canonical Agent/Adapter artifact and effective launch specification. Re-verified before every spawn; mismatches fail closed. |
| **Conductor** | Our orchestration layer as a whole; also the future ACP-agent facade name. |
| **Session** | One ACP session on one Runtime (`ConductorSession` wraps it). |
| **Persisted Session** | Versioned, metadata-only Session record. Sensitive resume-token values live in SecretStorage, never in the record. |
| **Turn** | One `session/prompt` → stop-reason cycle. |
| **Setup Deadline** | How long a Runtime may take to answer *each* setup request — the handshake, then Session creation — before the Client abandons it and terminates its process. |
| **Stall Limit** | How long a Turn may go without any Agent activity before the Client ends it. Time the Client owes the Agent an answer does not count. |
| **Cancel Grace** | How long a cancelled Turn may keep running after `session/cancel` before the Client terminates that Session's Agent process. |
| **Update** | One `session/update` notification variant (message/thought chunk, tool_call, plan, …). |
| **Config Option** | ACP `configOptions` entry; categories `model`, `thought_level`, `mode`, `model_config`. The only sanctioned model/effort channel. |
| **Effort** | Reasoning/thought level (`low…max`). Always advisory — see Read-back. |
| **Read-back** | Surfacing the *effective* model/effort reported by the agent after clamping, next to what was requested. Mandatory. |
| **Preset** | Named (runtime, model, effort) tuple in settings; default source for spawns. |
| **Persona** | A role with scope + guardrails (`PERSONAS.md`); maps onto a Preset when spawned as a subagent. |
| **Subagent** | A child Session created by the Orchestrator on any Runtime. Shares no conversation context with its parent. |
| **Brief** | The self-contained task description handed to a Subagent — file *paths*, never contents or history. |
| **Shim** | `dist/mcp-shim.cjs`: the bundled stdio MCP server a harness spawns; tunnels tool calls to the extension under a Session Capability. |
| **Orchestrator** | Extension-side owner of the spawn tree: defaults, semaphore, budgets, worktrees, cancel cascade. |
| **Suppression Plan** | Per-runtime recipe (flags/env/settings/`_meta`) that disables the CLI's built-in delegation. |
| **Suppression Capability** | Current evidence that a Suppression Plan works for an exact Runtime Trust fingerprint; required before Shim injection. |
| **Budget Capability** | A Runtime's verified ability to enforce a monetary child limit. Local depth, concurrency, count, and timeout limits remain mandatory. |
| **Session Capability** | Short-lived Shim authority bound server-side to one active parent Session, depth, roots, expiry, allowed methods, and current Runtime Trust. |
| **Depth Cap** | `maxSpawnDepth`; below it the Shim is *not injected* — this is the recursion guard. |
| **Isolation** | Change-coordination mode: `shared` cwd or a dedicated git `worktree`. It is not an Agent security boundary. |
| **Probe Session** | Throwaway session the wizard opens for auth check and Config Option discovery. |
| **Smoke Test** | Wizard step: one-line prompt proving stream + Read-back end to end. |
| **Registry** | The machine-readable ACP agent registry JSON (launch specs, pinned versions). |
| **Facade** | An upstream protocol surface of the Conductor (ACP-agent now-ish, AHP later). |
| **Client Operation** | Authorization key derived by the Client from an ACP method and normalized arguments (`fs.read`, `terminal.spawn`, …). |
| **ToolKind** | Agent-supplied ACP tool classification (`read`, `edit`, `execute`, …), used for display only. |
