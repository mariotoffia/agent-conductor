import { basename } from "node:path";
import * as vscode from "vscode";
import { DIFF_SCHEME, type DiffDocuments } from "./diffDocs.js";

/**
 * The command behind a reported diff, and the only part of diffs that needs a
 * running window.
 *
 * Apart from `DiffDocuments` on purpose: that module names `vscode` for its
 * types alone, which is what lets it — and everything that reads a diff — be
 * loaded and tested under plain Node. Opening an editor cannot be, so it lives
 * here rather than costing the module beside it its independence.
 *
 * Both sides of a diff are virtual documents: the right-hand side is what the
 * Agent reported writing, which is not the same thing as what the file says now.
 */
export async function openDiff(diffs: DiffDocuments, id: unknown): Promise<void> {
  if (typeof id !== "string") return;
  const entry = diffs.entry(id);
  if (!entry) {
    void vscode.window.showInformationMessage("That diff is no longer available.");
    return;
  }
  const side = (which: string): vscode.Uri =>
    vscode.Uri.from({ scheme: DIFF_SCHEME, path: displayPath(entry.path), query: `${id}:${which}` });
  await vscode.commands.executeCommand(
    "vscode.diff",
    side("old"),
    side("new"),
    `${basename(entry.path)} (agent diff)`,
  );
}

/** A URI path is slash-separated and rooted; this one is only ever a label. */
function displayPath(path: string): string {
  const slashed = path.replace(/\\/g, "/");
  return slashed.startsWith("/") ? slashed : `/${slashed}`;
}
