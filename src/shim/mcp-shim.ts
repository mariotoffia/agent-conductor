/**
 * Orchestrator MCP shim — spawned by an Agent's own harness over stdio, never by
 * the extension. Every tool here is a message passed back to the extension over
 * a local socket, under the Session Capability that harness was started with
 * (ADR-0004, ADR-0008).
 *
 * It decides nothing. Depth, concurrency, trust, budgets and which Runtimes
 * exist are all settled on the other end, because this process is one an Agent
 * controls: its arguments describe what it may ask for, never what it may have.
 * Runs fully outside the extension host: it imports neither VS Code nor the core.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { connectOrchestrator, type OrchestratorLink } from "./socketClient.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const socketPath = arg("socket");
// The capability comes from the environment, never from argv: process arguments
// are readable by any local process — `/proc/<pid>/cmdline` on Linux, `ps` on
// macOS — and a secret anyone can read authenticates anyone.
const secret = process.env.AGENT_CONDUCTOR_SESSION_SECRET;

let link: OrchestratorLink | undefined;

/**
 * One tool call, passed on.
 *
 * A Shim with no socket or no capability fails every call by saying so, rather
 * than starting and offering tools that hang: an Agent told plainly that
 * delegation is unavailable can get on with the work itself.
 */
async function call(method: string, params: Record<string, unknown>): Promise<{
  content: Array<{ type: "text"; text: string }>;
}> {
  if (!socketPath || !secret) {
    throw new Error("orchestration is unavailable: this shim was started with no socket or capability");
  }
  link ??= connectOrchestrator(socketPath, secret);
  const result = await link.call(method, params);
  return { content: [{ type: "text" as const, text: JSON.stringify(result ?? null) }] };
}

const server = new McpServer({ name: "orchestrator", version: "1.0.0" });

const handle = { handle: z.string().describe("Handle returned by spawn_subagent.") };

server.registerTool(
  "spawn_subagent",
  {
    description:
      "Delegate a self-contained task to a subagent, on this CLI runtime or another one. " +
      "The child has NO access to this conversation: write a complete brief, and pass file " +
      "PATHS rather than file contents. Every argument but the brief is optional; what is " +
      "left out comes from the user's own defaults.",
    inputSchema: {
      brief: z.string().describe("The whole task, self-contained. The child sees nothing else."),
      runtime: z.string().optional().describe("Runtime id from list_runtimes. Defaults to the user's."),
      model: z.string().optional().describe("Model id the target runtime offers."),
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
      files: z.array(z.string()).optional().describe("Absolute paths the child should read."),
      isolation: z
        .enum(["shared", "worktree"])
        .optional()
        .describe("worktree gives the child its own checkout to change."),
      mode: z
        .enum(["sync", "background"])
        .optional()
        .describe("background returns a handle at once; poll it with check_subagent."),
      budget_usd: z.number().optional().describe("Monetary limit, where the runtime enforces one."),
      timeout_ms: z.number().optional(),
    },
  },
  async (args) => call("spawn_subagent", args),
);

server.registerTool(
  "list_runtimes",
  {
    description:
      "The runtimes this user has configured, with their models and defaults. " +
      "Ask before naming a runtime or model in spawn_subagent.",
    inputSchema: {},
  },
  async () => call("list_runtimes", {}),
);

server.registerTool(
  "check_subagent",
  { description: "Whether a background subagent is still running.", inputSchema: handle },
  async (args) => call("check_subagent", args),
);

server.registerTool(
  "subagent_result",
  {
    description: "The result of a background subagent, waiting for it if it is still running.",
    inputSchema: handle,
  },
  async (args) => call("subagent_result", args),
);

server.registerTool(
  "cancel_subagent",
  { description: "Stop a subagent and everything it started.", inputSchema: handle },
  async (args) => call("cancel_subagent", args),
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  console.error("mcp-shim fatal:", err);
  process.exit(1);
});
