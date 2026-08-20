/**
 * Orchestrator MCP shim — spawned by agent harnesses over stdio (never by the
 * extension). Tunnels tool calls back to the extension over a token-authed
 * local socket. Runs fully outside the extension host: keep it dependency-light
 * and vscode-free.
 *
 * Bootstrap state: MCP handshake only; orchestration tools (spawn_subagent,
 * list_runtimes, background lifecycle) land with the orchestrator work.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const socketPath = arg("socket");
// The capability token comes from the environment, never from argv: process
// arguments are readable by any local process — `/proc/<pid>/cmdline` on Linux,
// `ps` on macOS — and a token anyone can read authenticates anyone.
const token = process.env.AGENT_CONDUCTOR_SESSION_TOKEN;

const server = new McpServer({ name: "orchestrator", version: "0.0.1" });

// Placeholder no-op tool so hosts see a well-formed server during bootstrap.
server.tool("orchestrator_status", "Reports conductor shim status.", {}, async () => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({ ok: true, socketConfigured: Boolean(socketPath && token) }),
    },
  ],
}));

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  console.error("mcp-shim fatal:", err);
  process.exit(1);
});
