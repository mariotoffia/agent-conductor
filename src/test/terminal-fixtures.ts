import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TerminalService } from "../vscode/terminals.js";
import type { ClientOperation, Consent } from "../vscode/permissions.js";

/** Consent that records what it was asked, and agrees unless told otherwise. */
export function consent(over: Partial<Consent> = {}): Consent & { readonly asked: ClientOperation[] } {
  const asked: ClientOperation[] = [];
  return {
    get asked() {
      return asked;
    },
    authorize: async (operation) => {
      asked.push(operation);
      return true;
    },
    permits: () => true,
    ...over,
  };
}

/** Consent that refuses everything and keeps the detail it was shown. */
export function shownDetail(): Consent & { readonly details: string[] } {
  const details: string[] = [];
  return {
    get details() {
      return details;
    },
    authorize: async (_operation, detail) => {
      details.push(detail);
      return false;
    },
    permits: () => true,
  };
}

export const workspace = (): Promise<string> => mkdtemp(join(tmpdir(), "conductor-term-"));

/** Runs a snippet of JavaScript as the agent's command; no shell anywhere. */
export const script = (source: string, ...args: string[]): { command: string; args: string[] } => ({
  command: process.execPath,
  args: ["-e", source, ...args],
});

export async function run(
  service: TerminalService,
  request: { command: string; args: string[]; cwd?: string; outputByteLimit?: number },
): Promise<{ terminalId: string; exit: { exitCode?: number | null; signal?: string | null } }> {
  const { terminalId } = await service.createTerminal({ sessionId: "s1", ...request });
  const exit = await service.waitForTerminalExit({ sessionId: "s1", terminalId });
  return { terminalId, exit };
}
