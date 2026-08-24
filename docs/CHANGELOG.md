# Changelog

Releases of the Agent Conductor VS Code extension. A version appears here only
after `make check-all` has passed on the commit that builds it; publishing the
package is a human decision and is recorded when it happens (`AGENTS.md`).

Claims about other CLIs, adapters and protocols go stale within weeks, so each
release carries a **verification record**: what was checked, against which
primary source, on what date. A claim that could not be verified is listed as
exactly that — nothing in the product may rest on it (the suppression recipes
are refused, not trusted, until evidence exists; ADR-0008).

## 0.0.1 — unreleased

The first buildable extension: one Marketplace-shaped artifact (`make package`,
ADR-0011), stable VS Code APIs only.

### What it does

- **Direct sessions.** The `@conductor` chat participant runs one ACP agent per
  session — one process per Session (ADR-0008) — streaming messages, thoughts,
  tool calls, diffs, plans, usage and permission requests into chat. `/runtime`,
  `/model` and `/effort` set Config Options and always show the Read-back:
  requested beside effective, with mismatches called out (ADR-0005).
- **Connect-a-CLI wizard.** Detects installed CLIs, shows the exact launch it
  will run, records Runtime Trust against that fingerprint (ADR-0007), offers
  adapter installation at one exact version, hands authentication to the CLI's
  own login, and saves only after a Probe Session answers a Smoke Test.
- **Sessions view.** Live and remembered Sessions with state, Read-back, cost
  (or unknown), and duration; cancel, resume, worktree actions. Persistence is
  versioned metadata only — never a prompt, a payload or a credential.
- **Client services.** Permission routing keyed by what this client is about to
  do (never the agent's `ToolKind`), dirty-buffers-first file access, structured
  terminals, form elicitation. Consent and audit, not a sandbox (ADR-0007).
- **Secrets.** Settings hold SecretStorage references, never values; agent
  output is redacted before it reaches a log, a message or the transcript
  (ADR-0010).

### Designed, tested, and deliberately unreachable

Cross-CLI subagents — the Orchestrator, the injected MCP Shim, per-Session
capabilities, worktree isolation and the cancellation cascade — are implemented
and hold under unit and extension-host tests, where a test-only hook supplies
the one piece of evidence the real protocol cannot: the agent's live tool list.

ACP has no method that reports an agent's tools (verified below), so a
Suppression Plan cannot be verified against any real CLI, no Runtime can hold a
Suppression Capability, and the Shim is injected for nobody. Turning
`agentConductor.orchestration.enabled` on changes none of that today. This is
the fail-closed direction, chosen in ADR-0008; direct sessions are the product
until the protocol can carry the evidence.

### Verification record — 2026-08-24

| Claim this product relies on | Verdict | Primary source |
|---|---|---|
| ACP defines no method or notification that reports an agent's tool list — why suppression stays unverifiable and fan-out stays off (ADR-0008) | Verified | [agentclientprotocol.com/protocol/schema](https://agentclientprotocol.com/protocol/schema) |
| `session/load`, `session/set_config_option`, `session/request_permission`, `fs/*`, `terminal/*` exist as this client uses them | Verified | [agentclientprotocol.com/protocol/schema](https://agentclientprotocol.com/protocol/schema) |
| `@agentclientprotocol/claude-agent-acp@0.70.0` exists, is `latest`, and its `bin` is `claude-agent-acp` — the command the catalog launches | Verified | [registry.npmjs.org](https://registry.npmjs.org/@agentclientprotocol/claude-agent-acp/0.70.0) |
| `@agentclientprotocol/codex-acp@1.4.0` exists with `bin` `codex-acp`; the ACP Registry currently publishes 1.6.2, which resolution may move forward to | Verified | [registry.npmjs.org](https://registry.npmjs.org/@agentclientprotocol/codex-acp/1.4.0) |
| The ACP Registry feed is reachable, `version: "1.0.0"`, and lists `claude-acp` and `codex-acp` under those package names | Verified | [cdn.agentclientprotocol.com](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json) |
| `gemini --acp` starts Gemini CLI's ACP mode; its documentation does not mark the mode experimental | Verified | [google-gemini/gemini-cli docs](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md) |
| `copilot --acp --stdio` starts Copilot CLI's ACP server; `--excluded-tools` and `--effort` (`low`…`max`) apply to every session it creates — process-scoped, as the catalog's quirks say | Verified | [docs.github.com](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server) |
| Anthropic policy: third-party products use API-key authentication and may not route through Free/Pro/Max subscription credentials — why Claude launches with `--hide-claude-auth` (ADR-0010) | Verified | [code.claude.com/docs/en/legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance) |
| `--hide-claude-auth` removes the subscription auth method and rejects subscription credentials at session start | Corroborated (third-party analysis; our argv is pinned by test) | [vanssata/jetbrains-claude-subscription](https://github.com/vanssata/jetbrains-claude-subscription) |

### Not verified

The insides of the Suppression Plans — the tool names and configuration keys
each recipe disables — have no primary source that lists them:

- Copilot delegation tool names `task`, `read_agent` (GitHub's ACP reference
  names no built-in tools).
- Gemini workspace keys `experimental.enableAgents`, `tools.exclude:
  ["invoke_agent"]`.
- Codex `CODEX_CONFIG` keys `agents.enabled`, `features.multi_agent_v2`,
  `collab`.
- The Claude adapter's `_meta.claudeCode.options` passthrough (its own source
  is the authority; not re-read for this record).

Nothing rests on them: a plan counts only when a live tool list proves the
named tools gone, no such list can be obtained (see above), so every one of
these recipes is currently refused rather than trusted. Verify them the day
the protocol can carry the evidence, before granting the first Suppression
Capability.
