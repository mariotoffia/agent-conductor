# ADR-0002: UI surface — stable chat participant first, chatSessions as a VSIX channel

- Status: accepted
- Date: 2026-08-18

## Context

The ideal surface (`chatSessionsProvider` + `chatParticipantAdditions`) is proposed API: hard-gated at the contribution point and unpublishable to the Marketplace. The stable `LanguageModelChatProvider` route is the wrong abstraction (flattens a harness into a token endpoint inside Copilot's loop). Anthropic's own extension ships a custom webview on stable APIs only.

## Decision

Marketplace build renders through a stable chat participant (`@conductor`) plus a sessions tree view and targeted webviews for what the participant stream cannot draw. A second build channel (sideloaded VSIX, generated manifest) enables `chatSessionsProvider`/`chatParticipantAdditions` for first-class session UI. One render map, two sinks; core is surface-agnostic. `registerLanguageModelChatProvider` is not used.

## Consequences

Public availability today at the cost of degraded tool-call/diff rendering in the Marketplace build. The rich build must track proposal churn (version-pinned). If Microsoft finalizes the sessions API, the channels merge.

## References

vscode.proposed.chatSessionsProvider.d.ts · code.visualstudio.com/api/extension-guides/ai/chat · code.claude.com/docs/en/vs-code
