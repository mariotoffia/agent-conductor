# ADR-0006: Inherit the logins the user's CLIs already have

- Status: superseded by ADR-0010
- Date: 2026-08-18
- Superseded by: ADR-0010

> Kept as a record of what was decided on 2026-08-18. The active decision about
> authentication is ADR-0010, which requires an API key for Claude by default.

## Context

Each CLI reads credentials from its own home directory, so an agent we start inherits whatever the user is already logged in as.

Anthropic's policy says a third-party developer must not offer claude.ai login, and must not route through Pro or Max credentials. Those plans assume "ordinary, individual usage", and running many agents in parallel is the most likely way to breach that. The Claude adapter ships `--hide-claude-auth` for exactly this situation.

Codex and Copilot have their own rate windows and seat rules, which depend on the plan.

## Decision

By default, inherit whatever authentication the user's CLIs already have. Never collect or proxy credentials ourselves.

Offer `agentConductor.claude.hideSubscriptionAuth`, which forces API-key authentication. Show a one-time notice before the first time subagents fan out on subscription credentials.

API keys live only in VS Code SecretStorage. They are passed to the child process as environment variables at startup, and never logged.

Check each vendor's policy again before every release. They changed twice during 2026.

## Consequences

A user with a working CLI can start immediately, and a team has a compliant path through API keys.

The cost is a standing duty on the Release Engineer persona to watch those policies.

## References

code.claude.com/docs/en/legal-and-compliance · claude-agent-acp `--hide-claude-auth`
