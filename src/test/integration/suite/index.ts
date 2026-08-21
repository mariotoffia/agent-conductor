import Mocha from "mocha";

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
  await import("./direct_session.test.js");

  // Counted before the run, from the tree itself: `mocha.suite.total()` reflects
  // what Mocha decided to run, which is the very thing being checked.
  const registered = countTests(mocha.suite);
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
}

/** Every test in the tree, whatever Mocha would go on to select. */
function countTests(suite: Mocha.Suite): number {
  return suite.tests.length + suite.suites.reduce((total, child) => total + countTests(child), 0);
}
