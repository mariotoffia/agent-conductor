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
- **Secrets and sign-in.** Claude runs on the login Claude Code already has;
  `agentConductor.claude.hideSubscriptionAuth` enforces an API key instead
  (ADR-0013). Settings hold SecretStorage references, never values; agent
  output is redacted before it reaches a log, a message or the transcript
  (ADR-0010).

### Cross-CLI subagents

Turn `agentConductor.orchestration.enabled` on and every trusted Runtime whose
agent accepts MCP servers is given the Shim: its agent can hand a Brief to a
Subagent on any CLI, model and effort, bounded by depth, concurrency, aggregate
count and timeout, in a worktree or the parent's folder, cancelled with its
parent. Handing work to a CLI on another provider needs Fan-out Consent, given
in the wizard.

A CLI's own subagents are allowed beside the Shim (ADR-0014). ACP has no
method that reports an agent's tools (verified below), so whether a
Suppression Plan worked can never be proved; rather than keep the feature
unreachable, the decision is that a CLI may fork its own helpers inside its
session — under the CLI's own permission mode, its cost, and outside the
limits, which bound what goes through the Shim. `suppressBuiltInSubagents` on a Runtime
still asks its CLI to switch them off, as optional hardening.

### Verification record — 2026-08-24

| Claim this product relies on | Verdict | Primary source |
|---|---|---|
| ACP defines no method or notification that reports an agent's tool list — why a Suppression Plan can never be proved to have worked, and why ADR-0014 allows a CLI's own subagents instead of waiting for proof | Verified | [agentclientprotocol.com/protocol/schema](https://agentclientprotocol.com/protocol/schema) |
| `session/load`, `session/set_config_option`, `session/request_permission`, `fs/*`, `terminal/*` exist as this client uses them | Verified | [agentclientprotocol.com/protocol/schema](https://agentclientprotocol.com/protocol/schema) |
| `@agentclientprotocol/claude-agent-acp@0.70.0` exists, is `latest`, and its `bin` is `claude-agent-acp` — the command the catalog launches | Verified | [registry.npmjs.org](https://registry.npmjs.org/@agentclientprotocol/claude-agent-acp/0.70.0) |
| `@agentclientprotocol/codex-acp@1.4.0` exists with `bin` `codex-acp`; the ACP Registry currently publishes 1.6.2, which resolution may move forward to | Verified | [registry.npmjs.org](https://registry.npmjs.org/@agentclientprotocol/codex-acp/1.4.0) |
| The ACP Registry feed is reachable, `version: "1.0.0"`, and lists `claude-acp` and `codex-acp` under those package names | Verified | [cdn.agentclientprotocol.com](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json) |
| `gemini --acp` starts Gemini CLI's ACP mode; its documentation does not mark the mode experimental | Verified | [google-gemini/gemini-cli docs](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md) |
| The install commands the wizard shows for a missing CLI are the vendors' own: `brew install gemini-cli` / `npm install -g @google/gemini-cli`, and `brew install --cask copilot-cli` / `npm install -g @github/copilot` | Verified | [gemini-cli](https://github.com/google-gemini/gemini-cli) · [docs.github.com](https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli) |
| `copilot --acp --stdio` starts Copilot CLI's ACP server; `--excluded-tools` and `--effort` (`low`…`max`) apply to every session it creates — process-scoped, as the catalog's quirks say | Verified | [docs.github.com](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server) |
| Anthropic's legal page: a third-party product may not offer a Claude.ai sign-in of its own or route through Free/Pro/Max credentials on behalf of its users; sign-in must complete through Anthropic's own flow — which `claude /login` is | Verified | [code.claude.com/docs/en/legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance) |
| Anthropic's support article: a Claude plan covers "third-party apps that authenticate with your Claude subscription through the Agent SDK" (the adapter is one); the separate Agent SDK credit is paused and such usage draws from the plan's ordinary limits — why Claude now launches on the CLI's own login (ADR-0013) | Verified | [support.claude.com](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) |
| `--hide-claude-auth` removes the subscription auth method and rejects subscription credentials at session start | Corroborated (third-party analysis; our argv is pinned by test) | [vanssata/jetbrains-claude-subscription](https://github.com/vanssata/jetbrains-claude-subscription) |
| DeepSeek Harness: `@deepseek-ai/dsh@0.1.1-rc.2` (bin `dsh`) is a developer preview; its own ACP server `@deepseek-ai/dsh-acp@0.1.1-rc.2` is a plugin with no executable, and `dsh --profile acp` boots it once the profile holds the package and a four-line patch inserting it (`walkthrough/install.md`). Under that launch dsh answered `initialize` and opened a session through this client's own Probe Session; the turn itself was not verified, since it needs a provider credential the test machine did not hold | Verified as stated | [registry.npmjs.org](https://registry.npmjs.org/@deepseek-ai/dsh-acp) · [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) |
| dsh's ACP plugin takes its own `provider` and `model` and does not fall back to dsh's default: without both, the session opens and every turn fails with "has no provider/model". Driven here against dsh 0.1.1-rc.2 — with them the turn reaches the configured endpoint, which is as far as a machine without that endpoint can prove | Verified as stated | driven locally 2026-08-24 · [packages/acp/acp](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/acp/acp) |
| dsh's ACP is automation-only by its own README (shipped in the package as `README.md`, and at `packages/acp/acp` in the repository): no Config Options, committed answers only, and `session/new` rejects a non-empty `mcpServers` — so Read-back reads *unavailable* and the Shim could never be injected even if a plan existed | Verified | [packages/acp/acp](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/acp/acp) · [registry.npmjs.org](https://registry.npmjs.org/@deepseek-ai/dsh-acp) |

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
- Any way of switching DeepSeek Harness's own subagents off: nothing documents
  one, so the catalog's `dsh` entry carries no Suppression Plan at all rather
  than an invented recipe — which keeps it ineligible for the Shim outright.

Nothing gates on them: a recipe is applied only where a Runtime's
`suppressBuiltInSubagents` asks for it, as hardening whose effect cannot be
proved (see above), and the Shim is injected regardless (ADR-0014). Verify
them before relying on that hardening for anything.
