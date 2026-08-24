import assert from "node:assert/strict";
import * as vscode from "vscode";
import Mocha from "mocha";
import type { ConductorTestHooks } from "../../../vscode/composition.js";

/**
 * Entry point VS Code loads as `--extensionTestsPath`.
 *
 * A rejected promise is what fails the run, so every way this can go wrong has
 * to reject. A failing test is the obvious one. The rest are the ways a harness
 * reports success while proving nothing, and each of them has happened to
 * somebody: a suite that registered no tests, and a suite that registered tests
 * and then ran none of them — every one skipped, a `test("name")` with no body,
 * or a `.only` left behind after debugging. The last is the one that will
 * actually happen here, and it is the one a passing count hides best.
 */
export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: "tdd", color: true, timeout: 120_000 });
  // The suite is bundled into this one file, so there is nothing to glob for.
  // Installing the interface by hand is what lets the tests register themselves
  // when they are imported, which must therefore happen after this line.
  mocha.suite.emit("pre-require", globalThis, "", mocha);
  // Order matters, and three things decide it. These suites share one
  // participant — the host has exactly one — and it remembers the Runtime it was
  // last given. Runtime Trust is recorded per Runtime, so a suite that needs one
  // unapproved has to run before whatever approves it. And `mcpServers` travels
  // inside `session/new`, so a setting that changes what is injected only
  // reaches a Session opened after it.
  //
  // The wizard goes first: nothing has approved anything yet, so a connection it
  // saves cannot be something an earlier suite did. Then the direct session,
  // whose opening test is that an unapproved Runtime is refused, and the
  // cancellation suite on the Session it leaves open. Then delegation, because
  // switching orchestration on gives the Runtime a Suppression Plan — part of
  // the launch identity, so trust granted either side of it is trust in a
  // different Runtime (ADR-0007) — and each of these grants its own. Last is the
  // suite that stops the participant, which is final.
  await import("./wizard_save.test.js");
  await import("./direct_session.test.js");
  await import("./cancellation.test.js");
  await import("./shim_delegation.test.js");
  await import("./sessions_tree.test.js");

  // Counted before the run, from the tree itself: `mocha.suite.total()` reflects
  // what Mocha decided to run, which is the very thing being checked.
  const registered = countTests(mocha.suite);
  requireTeardownLast(mocha.suite);
  let runner: Mocha.Runner | undefined;
  const failures = await new Promise<number>((settle) => {
    runner = mocha.run(settle);
  });

  if (failures > 0) throw new Error(`${failures} extension-host test(s) failed`);
  if (registered === 0) {
    throw new Error("no extension-host tests were registered — the harness proved nothing");
  }
  // `<`, not `!=`: a suite that grew a test after it was counted would make the
  // count high rather than low, and the message must never say something that
  // is not true of what happened.
  const passed = runner?.stats?.passes ?? 0;
  if (passed < registered) {
    throw new Error(
      `only ${passed} of ${registered} extension-host tests ran —` +
        " a skipped, bodyless or `.only` test cannot be a passing gate",
    );
  }
  await assertTornDown();
}

/**
 * The ordering contract above, enforced rather than described.
 *
 * The suites share one participant and the last of them stops it for good. A
 * test appended after that one would run against a stopped participant and fail
 * for a reason that has nothing to do with what it was checking — so the run
 * itself asserts that the teardown happened, and happened last.
 */
async function assertTornDown(): Promise<void> {
  const extension = vscode.extensions.getExtension("mariotoffia.agent-conductor");
  const hooks = (await extension?.activate()) as ConductorTestHooks | undefined;
  assert.ok(hooks, "the extension returned no test hooks");
  assert.equal(hooks.participant.currentSessionId, undefined, "a session outlived the suite");
  const said: string[] = [];
  const result = await hooks.participant.handle(
    { prompt: "hello" },
    { markdown: (text: string) => said.push(text), progress: () => undefined, button: () => undefined },
    { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) },
  );
  assert.equal(result.metadata.stopReason, "refused");
  assert.match(said.join("\n"), /shutting down/, "the participant was never stopped");
}

/**
 * The teardown test really is the last one registered.
 *
 * `assertTornDown` below proves the participant was stopped; this proves nothing
 * ran after it was. A test appended below the terminal one would drive a stopped
 * participant and fail for a reason that has nothing to do with what it checked,
 * so the run says which rule was broken instead.
 */
function requireTeardownLast(suite: Mocha.Suite): void {
  const titles = everyTest(suite);
  const last = titles[titles.length - 1];
  if (last === undefined || !last.includes("teardown")) {
    throw new Error(
      `the last extension-host test is "${last ?? "none"}" —` +
        " teardown stops the shared participant, so it has to be the last one registered",
    );
  }
}

function everyTest(suite: Mocha.Suite): string[] {
  return [
    ...suite.tests.map((test) => test.title),
    ...suite.suites.flatMap((child) => everyTest(child)),
  ];
}

/** Every test in the tree, whatever Mocha would go on to select. */
function countTests(suite: Mocha.Suite): number {
  return suite.tests.length + suite.suites.reduce((total, child) => total + countTests(child), 0);
}
