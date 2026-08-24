import assert from "node:assert/strict";
import * as vscode from "vscode";
import type { ConductorTestHooks } from "../../../vscode/composition.js";

/**
 * Giving the participant back to the suites that follow.
 *
 * A VS Code extension host has exactly one chat participant, and it remembers
 * the Runtime it was last given. A suite that brings a Runtime of its own — so
 * that the Sessions it leaves behind cannot be confused with anybody else's —
 * therefore owes the next suite a participant pointing somewhere that suite has
 * configured. Left as it was, the next ordinary prompt is refused for a Runtime
 * that is no longer in settings, and the failure reads as if that suite were
 * broken.
 *
 * Done the way a user does it, through `/runtime`, rather than by a hook that
 * reaches inside: nothing about the Runtime being moved to is approved by
 * arriving there, which is what a suite whose opening test is a refusal needs to
 * still be true.
 */
export async function handBackTo(hooks: ConductorTestHooks, runtimeId: string): Promise<void> {
  const settings = vscode.workspace.getConfiguration("agentConductor");
  await settings.update(
    "runtimes",
    {
      [runtimeId]: {
        command: required("AGENT_CONDUCTOR_TEST_NODE"),
        args: [required("AGENT_CONDUCTOR_TEST_AGENT"), "--mode=full-turn"],
      },
    },
    vscode.ConfigurationTarget.Workspace,
  );
  await settings.update("defaultRuntime", runtimeId, vscode.ConfigurationTarget.Workspace);
  await switchRuntime(hooks, runtimeId);
}

/**
 * Moves the participant onto one Runtime the caller has already configured.
 *
 * The same `/runtime` a user picks, so a suite arriving with a Runtime of its
 * own gets there the way anybody would — and the Session the suite before it
 * left open is ended by the switch rather than by a separate command, because
 * ending it is what switching CLI means.
 */
export async function switchRuntime(hooks: ConductorTestHooks, runtimeId: string): Promise<void> {
  const seen: string[] = [];
  hooks.useForm(pickingRuntime(runtimeId, seen));
  const said: string[] = [];

  const result = await hooks.participant.handle(
    { prompt: "", command: "runtime" },
    { markdown: (text: string) => said.push(text), progress: () => undefined, button: () => undefined },
    { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) },
  );

  hooks.useForm(undefined);
  // Asserted rather than assumed: a handover that quietly did nothing would show
  // up as the *next* suite failing, which is the hardest kind of failure to read.
  assert.deepEqual(seen, ["Runtime for this session"], "the runtime picker was never opened");
  assert.equal(result.metadata.stopReason, "end_turn");
  // What the window said it did, matched literally. A pattern built from an id
  // would mean whatever the characters in that id happen to mean.
  assert.ok(said.join("\n").includes(runtimeId), `the window did not say it moved to ${runtimeId}`);
  // `/runtime` ends the Session it had — the one thing about switching CLI the
  // next turn cannot undo. Vacuous when the caller had already ended it, and
  // kept anyway: this is the helper's own contract, not the caller's.
  assert.equal(hooks.participant.currentSessionId, undefined, "the session outlived the handover");
}

/**
 * A window that picks one Runtime, and refuses to guess between two.
 *
 * A Runtime is offered under its shown name, which is built from its id — so an
 * id is a substring of every longer id containing it, and `mock` would match
 * `wizardmock` as readily. Taking the first match would then move the
 * participant somewhere plausible and wrong, and the assertion above reads back
 * the very label that matched, so it would agree. Exactly one match, or nothing
 * is picked and the caller says so.
 */
function pickingRuntime(runtimeId: string, seen: string[]) {
  return {
    input: () => Promise.resolve(undefined),
    pick: (items: readonly { label: string }[], options: { title: string }) => {
      seen.push(options.title);
      const wanted = items.filter((item) => item.label.includes(runtimeId));
      assert.equal(
        wanted.length,
        1,
        `${wanted.length} of the offered runtimes are called "${runtimeId}":` +
          ` ${items.map((item) => item.label).join(", ")}`,
      );
      return Promise.resolve(wanted[0]);
    },
    pickMany: () => Promise.resolve([]),
  };
}

export function required(name: string): string {
  const value = process.env[name];
  assert.ok(value, `${name} must be set by the test launcher`);
  return value;
}
