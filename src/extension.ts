import * as vscode from "vscode";
import { builtinRuntimes } from "./core/index.js";

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("Agent Conductor", { log: true });
  context.subscriptions.push(log);
  log.info("Agent Conductor activated.");

  context.subscriptions.push(
    vscode.commands.registerCommand("agentConductor.connectCli", async () => {
      // Wizard: detect → configure → auth probe → model discovery → policy →
      // smoke test → save (docs/plans has the full flow while it is built out).
      const runtimes = builtinRuntimes({ suppressBuiltInSubagents: true });
      const picked = await vscode.window.showQuickPick(
        runtimes.map((r) => ({ label: r.displayName, description: r.id })),
        { title: "Connect an agent CLI (wizard under construction)", canPickMany: true },
      );
      if (picked?.length) {
        void vscode.window.showInformationMessage(
          `Selected: ${picked.map((p) => p.description).join(", ")} — wizard steps land next.`,
        );
      }
    }),
    vscode.commands.registerCommand("agentConductor.newSession", () => {
      void vscode.window.showInformationMessage("Sessions arrive with the ACP client core.");
    }),
    vscode.commands.registerCommand("agentConductor.cancelAll", () => log.info("cancelAll: no sessions yet")),
    vscode.commands.registerCommand("agentConductor.refreshRegistry", () => log.info("registry refresh: not implemented")),
  );

  const participant = vscode.chat.createChatParticipant("agentConductor.chat", async (_request, _ctx, stream) => {
    stream.markdown(
      "Agent Conductor is bootstrapped but the ACP client core is not wired yet.\n\n" +
        "Run **Agent Conductor: Connect a CLI…** to see detected runtimes.",
    );
  });
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.svg");
  context.subscriptions.push(participant);
}

export function deactivate(): void {
  // Subprocess/session teardown arrives with the ACP client core.
}
