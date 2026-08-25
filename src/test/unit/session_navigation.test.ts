import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { SessionsTree, type SessionNode } from "../../vscode/sessionsTree.js";
import { conditions, held, liveSession, record } from "../session-fixtures.js";
/**
 * Getting to a Session: what the tree holds, what it says has changed, and what
 * a row can be asked to do.
 *
 * A Session is only ever opened, reattached to or cancelled through the one
 * participant that owns every Agent process, so these drive the real one against
 * a real mock-Agent process wherever ownership is what is being checked.
 */

test("a live session is drawn from the session itself, not from the record it left", async () => {
  const tree = new SessionsTree({
    storage: held([record({ sessionId: "sess-live", state: "idle" })]),
    conditions,
    now: () => 90_000,
  });
  tree.track(
    {
      sessionId: "sess-live",
      runtimeId: "claude",
      state: "prompting",
      modelSelection: { requested: "opus", effective: "opus", verification: "verified" },
      effortSelection: { verification: "unavailable" },
      exited: new Promise(() => undefined),
    },
    { workspace: "/repo" },
  );

  const roots = await tree.getChildren();

  // One row, not two: the record of a Session that has not finished is a
  // snapshot, and the live object is the thing that knows what it is doing.
  assert.deepEqual(roots.map((node) => node.id), ["sess-live"]);
  assert.equal(roots[0].live, true);
  assert.equal(roots[0].state, "prompting");
});

test("cost is reported only on the agent's own word, and stops the row redrawing for a repeat", async () => {
  let redraws = 0;
  const tree = new SessionsTree({
    storage: held([]),
    conditions,
    now: () => 0,
  });
  tree.onDidChangeTreeData(() => {
    redraws += 1;
  });
  tree.track(
    {
      sessionId: "sess-live",
      runtimeId: "claude",
      state: "prompting",
      modelSelection: { verification: "unavailable" },
      effortSelection: { verification: "unavailable" },
      exited: new Promise(() => undefined),
    },
    { workspace: "/repo" },
  );
  const before = tree.getTreeItem((await tree.getChildren())[0]);
  assert.match(String(before.description), /cost unknown/);

  const usage = { sessionUpdate: "usage_update", cost: { amount: 0.25, currency: "USD" } };
  tree.observe("sess-live", usage);
  const drawnOnce = redraws;
  tree.observe("sess-live", usage);
  // A cost that did not move is not news; an Agent reports usage many times a Turn.
  assert.equal(redraws, drawnOnce);
  tree.observe("sess-live", { sessionUpdate: "agent_message_chunk" });
  assert.equal(redraws, drawnOnce);

  const after = tree.getTreeItem((await tree.getChildren())[0]);
  assert.match(String(after.description), /cost 0\.25 USD/);
});

test("a session leaves the live list when its process is gone, and its record takes the row", async () => {
  let exit = (): void => undefined;
  const exited = new Promise<void>((settle) => {
    exit = settle;
  });
  let settledSaves = 0;
  const tree = new SessionsTree({
    storage: held([record({ sessionId: "sess-live", state: "failed" })]),
    conditions,
    now: () => 0,
    saved: async () => {
      settledSaves += 1;
    },
  });
  tree.track(
    {
      sessionId: "sess-live",
      runtimeId: "claude",
      state: "prompting",
      modelSelection: { verification: "unavailable" },
      effortSelection: { verification: "unavailable" },
      exited,
    },
    { workspace: "/repo" },
  );
  assert.equal((await tree.getChildren())[0].live, true);

  exit();
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();

  const [node] = await tree.getChildren();
  assert.equal(node.live, false);
  // The record is written with nothing waiting on it, so the row that replaces a
  // live one is redrawn again once the saves have settled — otherwise it would
  // say how the Session began rather than how it ended.
  assert.equal(settledSaves, 1);
  assert.equal(node.state, "failed");
});

// ---------------------------------------------------------------------------
// Resuming. The tree is where a saved Session is offered back, so the Session
// it reattaches to has to be owned by the same participant that owns every
// other one — one Agent process per Session, and one owner for it (ADR-0008).
// ---------------------------------------------------------------------------

test("every session event the tree knows about is delivered to the view", async () => {
  const tree = new SessionsTree({ storage: held([]), conditions, now: () => 0, saved: async () => undefined });
  const drawn: (SessionNode | undefined)[] = [];
  const subscription = tree.onDidChangeTreeData((value) => drawn.push(value));
  let exit = (): void => undefined;
  const exited = new Promise<void>((settle) => {
    exit = settle;
  });

  tree.track(
    {
      sessionId: "sess-live",
      runtimeId: "claude",
      state: "prompting",
      modelSelection: { verification: "unavailable" },
      effortSelection: { verification: "unavailable" },
      exited,
    },
    { workspace: "/repo" },
  );
  assert.equal(drawn.length, 1, "opening a session must redraw");

  tree.observe("sess-live", { sessionUpdate: "usage_update", cost: { amount: 1, currency: "USD" } });
  assert.equal(drawn.length, 2, "a cost that moved must redraw");

  exit();
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  // Twice: once when the process is gone, and again once the record that takes
  // the row over has been written.
  assert.equal(drawn.length, 4, "a session ending must redraw, and again once its record is written");

  subscription.dispose();
  tree.refresh();
  assert.equal(drawn.length, 4, "a disposed listener must stop being called");
});

test("a listener that throws does not take the agent's update with it", () => {
  const tree = new SessionsTree({ storage: held([]), conditions, now: () => 0 });
  const seen: string[] = [];
  tree.onDidChangeTreeData(() => {
    throw new Error("the view is gone");
  });
  tree.onDidChangeTreeData(() => seen.push("second"));

  // This runs on the path an Agent's notification takes. A view that has been
  // torn down must not be able to swallow the Update behind it.
  assert.doesNotThrow(() => tree.refresh());
  assert.deepEqual(seen, ["second"]);
});

test("a session this window does not hold cannot put a figure on a row or a load on the host", () => {
  // An Agent may name any Session it likes in a notification, and the Session
  // layer forwards those rather than adopting them. Adopted here they would be a
  // map an Agent grows without bound, a file read per notification, and a cost
  // drawn against a Session whose own Agent never sent it.
  let redraws = 0;
  const tree = new SessionsTree({ storage: held([]), conditions, now: () => 0 });
  tree.onDidChangeTreeData(() => {
    redraws += 1;
  });
  tree.track(liveSession(), { workspace: "/repo" });
  const after = redraws;

  for (let n = 0; n < 100; n += 1) {
    tree.observe(`not-ours-${n}`, {
      sessionUpdate: "usage_update",
      cost: { amount: n, currency: "USD" },
    });
  }
  // And an update that is not about usage carries no cost, whatever it says.
  tree.observe("sess-live", { sessionUpdate: "agent_message_chunk", cost: { amount: 9, currency: "USD" } });

  assert.equal(redraws, after);
});

test("a cost belongs to the session that earned it and does not outlive it", async () => {
  let exit = (): void => undefined;
  const exited = new Promise<void>((settle) => {
    exit = settle;
  });
  const tree = new SessionsTree({
    storage: held([]),
    conditions,
    now: () => 0,
    saved: async () => undefined,
  });
  tree.track(liveSession({ exited }), { workspace: "/repo" });
  tree.observe("sess-live", { sessionUpdate: "usage_update", cost: { amount: 7, currency: "USD" } });
  assert.match(String(tree.getTreeItem((await tree.getChildren())[0]).description), /cost 7 USD/);

  exit();
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  // A later Session an Agent gave the same name to starts from unknown, never
  // from what the last one spent.
  tree.track(liveSession(), { workspace: "/repo" });

  assert.match(String(tree.getTreeItem((await tree.getChildren())[0]).description), /cost unknown/);
});

test("a listener bound to a receiver is called on it, and unsubscribes with its collection", () => {
  const tree = new SessionsTree({ storage: held([]), conditions, now: () => 0 });
  const receiver = { seen: 0, note(): void {
    this.seen += 1;
  } };
  const disposables: { dispose(): unknown }[] = [];
  tree.onDidChangeTreeData(receiver.note, receiver, disposables);

  tree.refresh();
  assert.equal(receiver.seen, 1, "the listener must run on the receiver it was bound to");

  for (const entry of disposables) entry.dispose();
  tree.refresh();
  assert.equal(receiver.seen, 1, "a disposed collection must take its listener with it");
});


test("a session is written down before the tree starts waiting for it to have been", async () => {
  // Both hang off the same `exited` promise, and the tree waits for the writes
  // already queued against the store. So the write that says how a Session ended
  // has to be queued first — otherwise the row that replaces the live one says
  // how it began, and nothing ever redraws it again.
  const launch = await readFile(new URL("../../vscode/sessionLaunch.ts", import.meta.url), "utf8");

  assert.ok(
    launch.indexOf("remember(session") < launch.indexOf("sessions.track(session"),
    "the tree is told about a session before its record is queued",
  );
});

test("a cost that moved is drawn, and a figure that is not one is not", async () => {
  const tree = new SessionsTree({ storage: held([]), conditions, now: () => 0 });
  tree.track(liveSession(), { workspace: "/repo" });
  const shown = async (): Promise<string> =>
    String(tree.getTreeItem((await tree.getChildren())[0]).description);

  tree.observe("sess-live", { sessionUpdate: "usage_update", cost: { amount: 1, currency: "USD" } });
  assert.match(await shown(), /cost 1 USD/);
  tree.observe("sess-live", { sessionUpdate: "usage_update", cost: { amount: 2.5, currency: "USD" } });
  // A turn that spends more has to say so; a row frozen on the first figure an
  // Agent reported is worse than one that said nothing.
  assert.match(await shown(), /cost 2\.5 USD/);

  for (const malformed of ["free", {}, { amount: "3" }, { currency: "USD" }, null]) {
    tree.observe("sess-live", { sessionUpdate: "usage_update", cost: malformed });
  }
  // Cost is only ever the Agent's own word, and a shape that is not one is not
  // a word — never `cost undefined undefined` (ADR-0005).
  assert.match(await shown(), /cost 2\.5 USD/);
});

test("a store that will not settle still leaves the row redrawn and nothing unhandled", async () => {
  const rejections: unknown[] = [];
  const note = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", note);
  try {
    let exit = (): void => undefined;
    const exited = new Promise<void>((settle) => {
      exit = settle;
    });
    let drawn = 0;
    const tree = new SessionsTree({
      storage: held([]),
      conditions,
      now: () => 0,
      saved: () => Promise.reject(new Error("the storage directory is gone")),
    });
    tree.onDidChangeTreeData(() => {
      drawn += 1;
    });
    tree.track(liveSession({ exited }), { workspace: "/repo" });

    exit();
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();

    // Saving is a convenience — every Session starts without it — so a store
    // that fails must not take the view down with it, nor the Update path this
    // runs on.
    assert.equal(drawn, 3);
    assert.deepEqual(rejections, []);
  } finally {
    process.off("unhandledRejection", note);
  }
});

test("the view the extension registers is the view the manifest contributes", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
  ) as { contributes: { views: Record<string, { id: string }[]> } };
  const composition = await readFile(new URL("../../vscode/composition.ts", import.meta.url), "utf8");
  const declared = Object.values(manifest.contributes.views).flat();

  assert.equal(declared.length, 1);
  // Nothing else fails when these differ: the extension registers a provider
  // for a view nobody declared, the declared view stays empty forever, and
  // every row action's `when` clause matches nothing.
  assert.ok(
    composition.includes(`createTreeView("${declared[0].id}"`),
    `no provider is registered for ${declared[0].id}`,
  );
});

test("the wizard is reachable from the view, and every route to it names a command that exists", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
  ) as {
    contributes: {
      commands: { command: string }[];
      viewsWelcome: { view: string; contents: string }[];
      menus: { "view/title": { command: string; when: string }[] };
      configuration: { properties: Record<string, { markdownDescription?: string }> };
      views: Record<string, { id: string }[]>;
    };
  };
  const { commands, viewsWelcome, menus, configuration } = manifest.contributes;
  const declared = new Set(commands.map((entry) => entry.command));
  const WIZARD = "agentConductor.connectCli";

  // Found through the palette alone, the wizard is found by someone who already
  // knows its name. The view is where a window with no runtimes is looked at.
  assert.ok(menus["view/title"].some((item) => item.command === WIZARD));
  assert.ok(viewsWelcome.some((entry) => entry.contents.includes(`command:${WIZARD}`)));

  // A command URI is a string until it is clicked, and a renamed command leaves
  // every link that named it looking exactly as it did while it worked.
  const linked = [
    ...viewsWelcome.flatMap((entry) => [...entry.contents.matchAll(/command:([\w.]+)/g)]),
    ...Object.values(configuration.properties).flatMap((property) => [
      ...(property.markdownDescription ?? "").matchAll(/command:(agentConductor[\w.]+)/g),
    ]),
  ].map(([, id]) => id);
  assert.ok(linked.length > 0);
  for (const id of [...linked, ...menus["view/title"].map((item) => item.command)]) {
    assert.ok(declared.has(id), `${id} is linked but not contributed`);
  }

  // The welcome only ever draws in the view it was declared for.
  const views = new Set(
    Object.values(manifest.contributes.views)
      .flat()
      .map((view) => view.id),
  );
  for (const entry of viewsWelcome) assert.ok(views.has(entry.view), `${entry.view} is not a view`);
});
