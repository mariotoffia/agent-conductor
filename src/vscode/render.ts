import type * as acp from "@agentclientprotocol/sdk";
import { discoverConfig } from "../core/index.js";
import type { Assert } from "./permissions.js";

/**
 * The surface-neutral render model: one `session/update` in, a list of things to
 * draw out (ADR-0002).
 *
 * Nothing here knows which surface it is drawing to, and nothing here calls into
 * VS Code — a chat participant, a session provider, or a test can each consume
 * the same items. Keeping the mapping pure is what makes "every documented
 * Update is rendered" a statement a test can check, rather than a claim about
 * code that only runs inside an extension host.
 *
 * Every variant of ACP's `SessionUpdate` union maps to an item. An Agent may
 * still send one this Client's protocol version never documented, so the union
 * has an `unsupported` arm rather than a silent drop: an Update nobody drew is
 * indistinguishable from an Agent that sent nothing.
 */

/** One plan entry, flattened out of ACP's stable and experimental plan shapes. */
export interface RenderPlanEntry {
  content: string;
  priority: string;
  status: string;
}

export interface RenderCommand {
  name: string;
  description: string;
}

export type RenderItem =
  /** Text the Agent addressed to the user. */
  | { kind: "message"; text: string }
  /** Reasoning; shown only when `agentConductor.ui.showThinking` allows it. */
  | { kind: "thought"; text: string }
  /** The Agent replaying a user turn — `session/load` history, mostly. */
  | { kind: "userMessage"; text: string }
  | {
      kind: "toolCall";
      toolCallId: string;
      /** Absent on an update that changes only the status. */
      title?: string;
      /** The Agent's own label. Display metadata, never a decision (ADR-0007). */
      toolKind?: string;
      status?: string;
      /** Absolute paths the Agent says the call touches. */
      locations: string[];
      /** True for `tool_call_update`: the call was already announced. */
      update: boolean;
    }
  /** A before/after pair the Agent produced. Rendered through `DiffDocuments`. */
  | { kind: "diff"; toolCallId: string; path: string; oldText: string; newText: string }
  /** Output of a command this Client is running for the Agent. */
  | { kind: "terminal"; toolCallId: string; terminalId: string }
  | { kind: "plan"; planId?: string; entries: RenderPlanEntry[] }
  /** A plan the Agent expressed as prose or as a file rather than as entries. */
  | { kind: "planText"; planId: string; text: string }
  | { kind: "planRemoved"; planId: string }
  | { kind: "commands"; commands: RenderCommand[] }
  | { kind: "mode"; modeId: string }
  /**
   * What the Agent now reports it is running, from the refreshed Config Option
   * array. These are effective values because the Agent reported them; the
   * requested half of a Read-back lives on the Session, not in a notification.
   */
  | { kind: "config"; model?: string; effort?: string }
  | { kind: "usage"; used: number; size: number; cost?: { amount: number; currency: string } }
  | { kind: "info"; title?: string; updatedAt?: string }
  /** An Update this Client's protocol version does not document. */
  | { kind: "unsupported"; sessionUpdate: string };

/**
 * Maps one Update to what should be drawn for it.
 *
 * `unknown` on purpose: notifications are schema-checked by the SDK, but this
 * also runs over recorded fixtures and over whatever a future Agent sends, and a
 * mapping that trusts its declared type cannot say what it did with the rest.
 */
export function renderUpdate(update: unknown): RenderItem[] {
  if (!isRecord(update)) return [{ kind: "unsupported", sessionUpdate: "" }];
  const variant = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";
  switch (variant) {
    case "agent_message_chunk":
      return [{ kind: "message", text: contentText(update.content) }];
    case "agent_thought_chunk":
      return [{ kind: "thought", text: contentText(update.content) }];
    case "user_message_chunk":
      return [{ kind: "userMessage", text: contentText(update.content) }];
    case "tool_call":
    case "tool_call_update":
      return toolCallItems(update, variant === "tool_call_update");
    case "plan":
      return [{ kind: "plan", entries: planEntries(update.entries) }];
    case "plan_update":
      return planUpdateItems(update.plan);
    case "plan_removed":
      return [{ kind: "planRemoved", planId: text(update.planId) }];
    case "available_commands_update":
      return [{ kind: "commands", commands: commands(update.availableCommands) }];
    case "current_mode_update":
      return [{ kind: "mode", modeId: text(update.currentModeId) }];
    case "config_option_update": {
      const config = discoverConfig(update.configOptions);
      return [{
        kind: "config",
        ...(config.model ? { model: config.model.currentValue } : {}),
        ...(config.effort ? { effort: config.effort.currentValue } : {}),
      }];
    }
    case "usage_update":
      return [usageItem(update)];
    case "session_info_update":
      return [{
        kind: "info",
        ...(typeof update.title === "string" ? { title: update.title } : {}),
        ...(typeof update.updatedAt === "string" ? { updatedAt: update.updatedAt } : {}),
      }];
    default:
      return [{ kind: "unsupported", sessionUpdate: variant }];
  }
}

/**
 * A tool call and whatever it carried. The call itself is always one item, so a
 * status change with no content still draws; its content adds items of its own,
 * which is where diffs and terminals come from.
 */
function toolCallItems(update: Record<string, unknown>, isUpdate: boolean): RenderItem[] {
  const toolCallId = text(update.toolCallId);
  const items: RenderItem[] = [{
    kind: "toolCall",
    toolCallId,
    ...(typeof update.title === "string" ? { title: update.title } : {}),
    ...(typeof update.kind === "string" ? { toolKind: update.kind } : {}),
    ...(typeof update.status === "string" ? { status: update.status } : {}),
    locations: locations(update.locations),
    update: isUpdate,
  }];
  for (const entry of array(update.content)) {
    if (!isRecord(entry)) continue;
    if (entry.type === "diff") {
      items.push({
        kind: "diff",
        toolCallId,
        path: text(entry.path),
        // ACP allows a diff with no previous text: a file being created. An
        // empty left-hand side is the truthful rendering of that.
        oldText: typeof entry.oldText === "string" ? entry.oldText : "",
        newText: text(entry.newText),
      });
      continue;
    }
    if (entry.type === "terminal") {
      items.push({ kind: "terminal", toolCallId, terminalId: text(entry.terminalId) });
      continue;
    }
    // `content`: a plain content block produced by the tool. A block this
    // protocol version does not document renders as nothing, which is the one
    // outcome this model refuses to produce silently — but a documented block
    // that is legitimately empty is not that, and says nothing about the
    // protocol.
    if (entry.type !== "content") {
      items.push({ kind: "unsupported", sessionUpdate: `tool_call content ${text(entry.type)}` });
      continue;
    }
    const rendered = contentText(entry.content);
    if (rendered) items.push({ kind: "message", text: rendered });
  }
  return items;
}

/** The experimental plan shapes, each reduced to something drawable. */
function planUpdateItems(plan: unknown): RenderItem[] {
  if (!isRecord(plan)) return [{ kind: "unsupported", sessionUpdate: "plan_update" }];
  const planId = text(plan.planId);
  if (plan.type === "items") return [{ kind: "plan", planId, entries: planEntries(plan.entries) }];
  if (plan.type === "markdown") return [{ kind: "planText", planId, text: text(plan.content) }];
  if (plan.type === "file") return [{ kind: "planText", planId, text: text(plan.uri) }];
  return [{ kind: "unsupported", sessionUpdate: "plan_update" }];
}

function usageItem(update: Record<string, unknown>): RenderItem {
  const cost = isRecord(update.cost) && typeof update.cost.amount === "number"
    ? { amount: update.cost.amount, currency: text(update.cost.currency) }
    : undefined;
  return {
    kind: "usage",
    used: typeof update.used === "number" ? update.used : 0,
    size: typeof update.size === "number" ? update.size : 0,
    ...(cost ? { cost } : {}),
  };
}

function planEntries(entries: unknown): RenderPlanEntry[] {
  return array(entries)
    .filter(isRecord)
    .map((entry) => ({
      content: text(entry.content),
      priority: text(entry.priority),
      status: text(entry.status),
    }));
}

function commands(available: unknown): RenderCommand[] {
  return array(available)
    .filter(isRecord)
    .map((command) => ({ name: text(command.name), description: text(command.description) }));
}

/** ACP requires absolute paths, so a location that is not a string is not one. */
function locations(value: unknown): string[] {
  return array(value)
    .filter(isRecord)
    .map((location) => location.path)
    .filter((path): path is string => typeof path === "string");
}

/**
 * A content block as one line of text.
 *
 * Binary blocks are named rather than drawn: this is the render model every
 * surface shares, and a megabyte of base64 in it would reach a chat stream, a
 * log and a tree label alike.
 */
export function contentText(content: unknown): string {
  if (!isRecord(content)) return "";
  switch (content.type) {
    case "text":
      return text(content.text);
    case "image":
      return `_(image${mime(content)})_`;
    case "audio":
      return `_(audio${mime(content)})_`;
    case "resource_link":
      return `[${text(content.name) || text(content.uri)}](${text(content.uri)})`;
    case "resource": {
      const resource = content.resource;
      if (!isRecord(resource)) return "";
      // A blob resource carries `blob`, not `text`; naming it is the whole point.
      return typeof resource.text === "string" ? resource.text : `_(resource ${text(resource.uri)})_`;
    }
    default:
      return "";
  }
}

function mime(content: Record<string, unknown>): string {
  return typeof content.mimeType === "string" && content.mimeType ? ` ${content.mimeType}` : "";
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Compile-time proof that the mapping covers ACP's union. `renderUpdate` takes
 * `unknown`, so no `switch` could prove it: an Update variant added by a later
 * SDK would simply fall through to `unsupported` and nothing would say so. This
 * fails the build instead, which is the point at which a variant can still be
 * given a real rendering. The last row is the check's own self-test.
 */
type RenderedVariant =
  | "agent_message_chunk"
  | "agent_thought_chunk"
  | "user_message_chunk"
  | "tool_call"
  | "tool_call_update"
  | "plan"
  | "plan_update"
  | "plan_removed"
  | "available_commands_update"
  | "current_mode_update"
  | "config_option_update"
  | "usage_update"
  | "session_info_update";

export type UpdateVariantsAreRendered = [
  Assert<acp.SessionNotification["update"]["sessionUpdate"] extends RenderedVariant ? true : false>,
  Assert<"invented_by_a_later_sdk" extends RenderedVariant ? false : true>,
];
