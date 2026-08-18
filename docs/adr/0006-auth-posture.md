# ADR-0006: Auth posture — inherit CLI logins; subscription fan-out is opt-in and flagged

- Status: accepted
- Date: 2026-08-18

## Context

CLIs read credentials from their own homes, so spawned agents inherit the user's existing logins. Anthropic's policy: third-party developers must not offer claude.ai login or route through Pro/Max credentials; Pro/Max limits assume "ordinary, individual usage" — parallel fan-out is the likeliest tripwire. The claude adapter ships `--hide-claude-auth` for exactly this. Codex/Copilot have plan-scoped rate windows and seat rules.

## Decision

Default: inherit whatever auth the user's CLIs already have; never collect or proxy credentials ourselves. Expose `agentConductor.claude.hideSubscriptionAuth` (forces API-key auth) and show a one-time notice before first subscription-backed subagent fan-out. API keys live only in VS Code SecretStorage, injected as env at spawn, never logged. Re-verify vendor policies before each release (they changed twice in 2026).

## Consequences

Zero-friction start for CLI users; a compliant path for teams via API keys. Cost: a policy-watch duty on the Release Engineer persona.

## References

code.claude.com/docs/en/legal-and-compliance · claude-agent-acp `--hide-claude-auth`
