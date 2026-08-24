import type * as acp from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * The Mock Agent doing what a real agent CLI does with an injected MCP server:
 * starting it and calling one of its tools.
 *
 * Its own module because it is the only part of the Mock Agent that acts as a
 * client rather than a server, and because what it does has to be a real MCP
 * client rather than an imitation of one. The Shim is started by the *Agent*,
 * not by this Client — so the interpreter, the arguments and the environment the
 * Shim actually receives are decided over there, and a stand-in that spawned it
 * some other way would prove nothing about the ones we hand over.
 */

/** What asks the Agent to delegate, keyed on the prompt for the same reason the
 *  standstill is: an extension host has one participant with one Runtime. */
export const DELEGATE_TO_SUBAGENT = "Delegate this to a subagent";

/** The name the Shim is injected under. Spelled here rather than imported: this
 *  file stands in for an agent CLI, which knows the servers only by what arrived
 *  in `session/new`. */
const ORCHESTRATOR = "orchestrator";

/**
 * Starts the injected orchestration server and spawns one Subagent through it.
 *
 * The environment is built the way the MCP TypeScript SDK builds it — a small
 * default set, with the server's own entries on top — because that is what a
 * real agent CLI hands its MCP servers. An implementation that forwarded its own
 * whole environment instead would hide every variable the injected command
 * silently depends on.
 */
export async function delegate(
  request: acp.NewSessionRequest | undefined,
  prompt: string,
): Promise<string> {
  // Everything after the marker is the Brief, so one prompt carries both what to
  // do and what to ask for.
  const brief = prompt.slice(prompt.indexOf(DELEGATE_TO_SUBAGENT) + DELEGATE_TO_SUBAGENT.length).trim();
  const server = request?.mcpServers?.find((entry) => entry.name === ORCHESTRATOR);
  if (!server || !("command" in server)) {
    return JSON.stringify({ error: `no ${ORCHESTRATOR} server was injected into this session` });
  }
  const client = new Client({ name: "agent-conductor-mock", version: "0.0.1" });
  const transport = new StdioClientTransport({
    command: server.command,
    args: [...(server.args ?? [])],
    env: {
      ...getDefaultEnvironment(),
      ...Object.fromEntries((server.env ?? []).map((entry) => [entry.name, entry.value])),
    },
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "spawn_subagent", arguments: { brief } });
    return text(result);
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** A tool result as the Agent reads it: the text parts, joined. */
function text(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  return content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
}
