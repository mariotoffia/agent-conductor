# ADR-0005: Model and effort come from the agent's config options, and we always read back what it actually runs

- Status: accepted
- Date: 2026-08-18

## Context

ACP removed `session/set_model` in June 2026. The sanctioned way is now `configOptions` — categories `model` and `thought_level` — plus `session/set_config_option`.

Effort is advisory everywhere. Claude quietly lowers it depending on the model and the organisation's cap. Codex documents `xhigh` as depending on the model. Copilot drops levels on some plans.

Model lists change every month.

## Decision

Fill the pickers from the agent's own `configOptions` when the session starts. Fall back to the catalog, or to command-line arguments, only when the agent offers none. No model list is hardcoded anywhere.

After setting an option — and whenever `config_option_update` arrives — redraw from the complete refreshed array the agent sent.

Every session shows the **effective** model and effort, as reported by the agent, next to what was asked for. If they differ, say so visibly.

## Consequences

New models show up without shipping a new version of the extension, and the user sees what is true rather than what was intended.

The costs: the wizard has to open a probe session, and the fallback path needs a small table of quirks per runtime.

## References

agentclientprotocol.com/protocol/v1/session-config-options · UBIQUITOUS.md: Read-back
