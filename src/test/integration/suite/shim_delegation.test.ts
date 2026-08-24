import assert from "node:assert/strict";
import * as vscode from "vscode";
import type { ConductorTestHooks } from "../../../vscode/composition.js";
import { DELEGATE_TO_SUBAGENT } from "../../mock-agent-delegation.js";
import { handBackTo, required, switchRuntime } from "./handover.js";

/**
 * One Agent handing work to another, inside a real VS Code extension host.
 *
 * What this proves that `make test` cannot, and what makes it worth its cost:
 * the Shim is started by the *Agent*, from the `mcpServers` entry this window
 * put into `session/new` — so the interpreter, the arguments and the environment
 * that entry names have to be ones that work when a stranger runs them. Under
 * plain Node every one of those is trivially right. An extension host is not
 * plain Node: its `process.execPath` is an Electron helper, and the Agent hands
 * its MCP servers a small environment of its own rather than the host's.
 *
 * Everything below the socket already has a test with the layers above it faked,
 * and the whole chain has one under `make test` with a hand-built client in the
 * place of an Agent. The one thing neither can show is whether the command this
 * window writes into `mcpServers` runs at all where it is actually run.
 *
 * It runs after the suites that need orchestration switched off, because turning
 * it on gives the Runtime a Suppression Plan — which is part of the launch
 * identity, so the trust granted before it is no longer trust in this Runtime
 * (ADR-0007).
 */

const EXTENSION_ID = "mariotoffia.agent-conductor";
/**
 * The Runtime this suite runs, and the one its Subagent runs: its own, so the
 * Session records it leaves cannot be confused with another suite's.
 *
 * They can be. The store keys a record by Runtime, folder and session id, and
 * every Mock Agent numbers its Sessions from one per process — so a parent, its
 * child and any later Session on the same Runtime in the same folder all arrive
 * under one key, and the last write wins. Keeping that inside this suite, where
 * nothing reads a row, is cheaper than reasoning about which write lands last.
 */
const RUNTIME = "shimdelegate";
/** The Runtime every suite after this one uses. */
const HANDOVER = "mock";

/** The Brief the Subagent is given: one word, so its answer is checkable. */
const BRIEF = "Reply with exactly: OK";

/** Everything the participant said, in order. */
function recordingStream() {
  const written: string[] = [];
  return {
    text: () => written.join("\n"),
    stream: {
      markdown: (value: string) => written.push(value),
      progress: () => undefined,
      button: () => undefined,
    },
  };
}

/**
 * The Subagent result the Agent reported, as an object.
 *
 * A Shim that cannot reach the Orchestrator says so in prose, and an MCP tool
 * that throws is carried back as prose too — neither has a brace in it. Reading
 * that as an empty object would turn every one of those into the same failure,
 * `state: undefined`, with what actually went wrong nowhere on screen. So the
 * absence of an answer is its own failure, quoting what the Agent really said.
 */
function subagentAnswer(said: string): Record<string, unknown> {
  const found = /\{[\s\S]*\}/.exec(said)?.[0];
  assert.ok(
    found,
    `the agent reported no subagent result — it said instead: ${said.trim() || "(nothing at all)"}`,
  );
  try {
    return JSON.parse(found) as Record<string, unknown>;
  } catch (error) {
    assert.fail(`the subagent result is not JSON (${String(error)}): ${found}`);
  }
}

const liveToken = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
};

suite("an agent delegating through the injected shim in the extension host", () => {
  let hooks: ConductorTestHooks;

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} is not installed in this host`);
    const activated: unknown = await extension.activate();
    assert.ok(activated, "the extension returned no test hooks");
    hooks = activated as ConductorTestHooks;

    const settings = vscode.workspace.getConfiguration("agentConductor");
    // Machine-scoped settings are only writable in user settings, which is why
    // the run has a profile of its own — it is thrown away with the workspace.
    await settings.update("orchestration.enabled", true, vscode.ConfigurationTarget.Global);
    // The test workspace is a temporary directory rather than a checkout, and a
    // worktree cannot be cut from something that is not a repository.
    await settings.update("orchestration.subagentIsolation", "shared", vscode.ConfigurationTarget.Global);
    await settings.update(
      "runtimes",
      {
        [RUNTIME]: {
          command: required("AGENT_CONDUCTOR_TEST_NODE"),
          args: [required("AGENT_CONDUCTOR_TEST_AGENT")],
          // A plan for a Runtime the catalog knows no recipe for. It disables
          // nothing real — this Agent has no delegation tool to take away — and
          // it does not have to: what makes a plan count is the evidence below,
          // which is a tool list that no longer holds what the plan names.
          suppression: {
            env: { MOCK_SUBAGENTS: "off" },
            delegationTools: ["spawn_agent"],
          },
        },
      },
      vscode.ConfigurationTarget.Workspace,
    );
    await settings.update("defaultRuntime", RUNTIME, vscode.ConfigurationTarget.Workspace);
    hooks.useConsent({ ask: () => Promise.resolve("Allow") });
    // Approved with what a Probe Session saw: a tool list that has none of the
    // delegation tools in it. The verdict is not recorded and cannot be —
    // eligibility is recomputed from this evidence against the plan every time
    // the Runtime is resolved (ADR-0008).
    await hooks.grantTrust(RUNTIME, { tools: ["read_file", "edit_file"] });
    // Moved onto this suite's own Runtime, which also ends the Session the suites
    // before it left open. Both halves matter: the participant remembers the
    // Runtime it was last given, and `mcpServers` travels inside `session/new` —
    // so it is fixed for that Session's whole life and nothing set above could
    // reach it. The next turn opens a Session of its own, under these settings.
    await switchRuntime(hooks, RUNTIME);
  });

  suiteTeardown(async () => {
    hooks.useConsent(undefined);
    // Orchestration goes back off before the handover, so the Runtime the next
    // suite is moved to is composed without a Suppression Plan — the same
    // identity that suite will resolve when it grants its own trust (ADR-0007).
    const settings = vscode.workspace.getConfiguration("agentConductor");
    await settings.update("orchestration.enabled", undefined, vscode.ConfigurationTarget.Global);
    await settings.update(
      "orchestration.subagentIsolation",
      undefined,
      vscode.ConfigurationTarget.Global,
    );
    await handBackTo(hooks, HANDOVER);
  });

  test("the shim this window injects is a command the agent can actually start", async () => {
    const out = recordingStream();

    const result = await hooks.participant.handle(
      { prompt: `${DELEGATE_TO_SUBAGENT}\n${BRIEF}` },
      out.stream,
      liveToken,
    );

    assert.equal(result.metadata.stopReason, "end_turn");
    const answer = subagentAnswer(out.text());
    // A refusal from our own side is a legible failure and says which condition
    // it was; anything else means the Agent could not start what we injected.
    assert.equal(answer.error, undefined, `the agent could not use the injected shim: ${out.text()}`);
    assert.equal(answer.state, "done");
    assert.equal(answer.stopReason, "end_turn");
    // The child Agent's own words, carried back through the Shim to its parent.
    assert.equal(answer.text, "OK");
    assert.equal(answer.runtime, RUNTIME);
    // No Runtime in the catalog takes a money limit over ACP, and this Client
    // has no channel to set one — so the honest answers are "unknown" and
    // "unenforced" rather than a figure nothing was told about.
    assert.equal(answer.cost, "unknown");
    assert.equal(answer.budget, "unenforced");
  });

  test("the socket exists because a session needed it, and delegating leaves it usable", async () => {
    // A socket was made, which is the half this suite is placed to show: the
    // Shim above really reached the Orchestrator over one rather than being
    // answered by something else. That none is made while orchestration is off
    // is the other half, and it is pinned where it can be driven both ways under
    // `make test` rather than asserted here, where only one way is reachable.
    assert.ok(hooks.orchestrationAddress(), "no orchestration socket was ever created");

    // And the parent is where it was: delegating is a tool call inside a Turn,
    // not something that replaces the Session it happened in.
    const out = recordingStream();
    const result = await hooks.participant.handle({ prompt: BRIEF }, out.stream, liveToken);

    assert.equal(result.metadata.stopReason, "end_turn");
    assert.match(out.text(), /OK/);
  });

  // What is deliberately not asserted here: that the Subagent is drawn beneath
  // the Session that started it. The tree's lineage has its own suite under
  // `make test`, including two Sessions an Agent gave one name — and the Mock
  // Agent numbers its Sessions from one per process, so parent and child arrive
  // with the same id and the row this would read is the one that rule folds
  // away. A test that can only fail for its fixture's reason is worse here than
  // no test, because it costs a VS Code to find out.
});
