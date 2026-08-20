import { after } from "node:test";

/**
 * Fails a test file that leaves the process running.
 *
 * A test can pass and still leave a child process, a socket, or a ref'd timer
 * holding the event loop open. Every test then reports `ok`, the file's process
 * never exits, and the run hangs — reporting success right up until something
 * external kills it. That is the worst shape a gate can take: green output and
 * no result. So when a file's tests are done, anything still holding the loop
 * open is a failure of that file, named and attributed.
 *
 * Loaded with `--import` for every test file (see `package.json`). The timer is
 * unref'd, which is what makes this precise rather than a timeout: it can only
 * fire if something *else* is keeping the process alive, so a file that cleans
 * up exits before it ever runs.
 */
const GRACE_MS = Number(process.env.TEST_LEAK_GRACE_MS ?? 2_000);

after(() => {
  const linger = setTimeout(() => {
    const counted = new Map<string, number>();
    for (const resource of process.getActiveResourcesInfo()) {
      counted.set(resource, (counted.get(resource) ?? 0) + 1);
    }
    const held = [...counted].map(([name, count]) => `${name}×${count}`).join(", ");
    process.stderr.write(
      `\nleak-guard: ${process.argv[1] ?? "this test file"} finished its tests but kept the` +
        ` process alive for ${GRACE_MS}ms.\nleak-guard: still held: ${held || "nothing identifiable"}.` +
        `\nleak-guard: a test that starts a process, a socket, or a timer has to stop it.\n`,
    );
    process.exit(1);
  }, GRACE_MS);
  linger.unref();
});
