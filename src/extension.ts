import type * as vscode from "vscode";
import { activateConductor, type ConductorTestHooks } from "./vscode/composition.js";

/**
 * Extension entry point. Everything it owns is registered as a disposable on the
 * context, so VS Code's own teardown ends the Sessions — including the Agent
 * processes they own (ADR-0008).
 */
/**
 * The extension's API. Empty in an installed window: the object is only ever
 * populated for the extension-host tests, which have no other way to send a
 * chat participant a turn (see `ConductorTestHooks`).
 */
export function activate(context: vscode.ExtensionContext): ConductorTestHooks | undefined {
  const activation = activateConductor(context);
  teardown = activation.teardown;
  return activation.hooks;
}

/** Awaited so VS Code gets its (bounded) chance to see the Agent processes go
 *  away, rather than only the synchronous half of disposal. */
let teardown: () => Promise<void> = async () => undefined;

export function deactivate(): Promise<void> {
  return teardown();
}
