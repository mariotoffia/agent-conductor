import * as vscode from "vscode";
import type { OpenDocuments } from "./fsProvider.js";
import type { FormHost } from "./elicitation.js";
import type { ConsentHost } from "./permissions.js";

/**
 * The surfaces that really are the VS Code API: the modal, the form, and the
 * editor's own buffers.
 *
 * Nothing here decides anything, and nothing here can be unit tested — which is
 * exactly why it holds only the bindings. Every rule lives on the other side of
 * one of these, in a module with no `vscode` in it.
 */

export const modalConsentHost = (): ConsentHost => ({
  ask: (message, options, ...choices) => vscode.window.showWarningMessage(message, options, ...choices),
});

export const formHost = (): FormHost => ({
  input: (options) => vscode.window.showInputBox(options),
  pick: (items, options) => vscode.window.showQuickPick(items, options),
  pickMany: (items, options) => vscode.window.showQuickPick(items, options),
});

/** Open editor buffers, so a read serves what is on screen rather than the last save. */
export function openDocuments(): OpenDocuments {
  const find = (path: string): vscode.TextDocument | undefined =>
    vscode.workspace.textDocuments.find(
      (document) => document.uri.scheme === "file" && document.uri.fsPath === path,
    );
  return {
    text: (path) => find(path)?.getText(),
    async replace(path, content) {
      const document = find(path);
      if (!document) return false;
      const edit = new vscode.WorkspaceEdit();
      // Through the editor, so the change joins the user's undo history.
      edit.replace(document.uri, wholeDocument(document), content);
      return vscode.workspace.applyEdit(edit);
    },
  };
}

function wholeDocument(document: vscode.TextDocument): vscode.Range {
  return new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
}
