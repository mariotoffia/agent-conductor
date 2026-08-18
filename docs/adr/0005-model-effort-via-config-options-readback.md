# ADR-0005: Model/effort via ACP config options, with mandatory read-back

- Status: accepted
- Date: 2026-08-18

## Context

`session/set_model` was removed from ACP (2026-06); the sanctioned channel is `configOptions` (categories `model`, `thought_level`) + `session/set_config_option`. Effort is advisory everywhere: Claude clamps silently per model and org cap; Codex documents `xhigh` as model-dependent; Copilot degrades levels on some plans. Model catalogs churn monthly.

## Decision

Pickers are populated from the agent's `configOptions` at session start; catalog/argv fallback only when absent. No hardcoded model lists anywhere. After any set (and on `config_option_update`), re-render from the complete refreshed array. Every session surfaces the *effective* model/effort (Read-back) beside the requested values, with a visible mismatch indicator.

## Consequences

New models appear without extension releases; users see truth, not intent. Costs: a probe session in the wizard; per-runtime quirks tables for the fallback path.

## References

agentclientprotocol.com/protocol/v1/session-config-options · UBIQUITOUS.md: Read-back
