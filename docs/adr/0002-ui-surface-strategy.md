# ADR-0002: A stable chat participant first, with a second build for the richer UI

- Status: accepted; the second build channel is superseded by ADR-0011
- Date: 2026-08-18
- Superseded in part by: ADR-0011

## Context

The UI we actually want uses `chatSessionsProvider` and `chatParticipantAdditions`. Both are proposed APIs. VS Code blocks them at the contribution point, and an extension that uses them cannot be published to the Marketplace.

The stable alternative, `LanguageModelChatProvider`, is the wrong abstraction. It flattens a whole harness into a token endpoint inside Copilot's loop.

Anthropic's own extension takes the same route we propose here: a custom webview built on stable APIs only.

## Decision

The Marketplace build renders through a stable chat participant, `@conductor`, plus a sessions tree view and small webviews for anything the participant's stream cannot draw.

A second build channel — a sideloaded extension file, from a generated manifest — turns on `chatSessionsProvider` and `chatParticipantAdditions` for the better session UI.

One render map feeds both. The core does not know which surface it is drawing to.

We do not use `registerLanguageModelChatProvider`.

## Consequences

We can ship today. The price is worse tool-call and diff rendering in the Marketplace build.

The richer build has to keep up with changes to the proposed APIs, so it pins the VS Code version.

If Microsoft finalises the sessions API, the two channels become one.

## References

vscode.proposed.chatSessionsProvider.d.ts · code.visualstudio.com/api/extension-guides/ai/chat · code.claude.com/docs/en/vs-code
