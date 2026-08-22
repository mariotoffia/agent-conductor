import assert from "node:assert/strict";
import { test } from "node:test";
import type * as acp from "@agentclientprotocol/sdk";
import {
  applyRequestedSelections,
  asConfigOptions,
  discoverConfig,
  isMismatch,
  pickEffortChoices,
  pickModelChoices,
  readBack,
  type ModelHint,
} from "../../core/index.js";

function select(
  id: string,
  category: string | undefined,
  currentValue: string,
  options: acp.SessionConfigSelectOptions,
): acp.SessionConfigOption {
  return { type: "select", id, name: id, ...(category ? { category } : {}), currentValue, options };
}

/** Agent-shaped Config Options: a model select, an effort select, and one the
 *  categories do not claim. */
const agentOptions: acp.SessionConfigOption[] = [
  select("model", "model", "sonnet", [
    { value: "sonnet", name: "Sonnet" },
    { value: "opus", name: "Opus" },
  ]),
  select("thought", "thought_level", "medium", [{ value: "medium", name: "Medium" }]),
];

test("categories select the model and effort pickers", () => {
  const config = discoverConfig(agentOptions);

  assert.equal(config.model?.id, "model");
  assert.equal(config.model?.currentValue, "sonnet");
  assert.deepEqual(config.model?.choices.map((choice) => choice.value), ["sonnet", "opus"]);
  assert.equal(config.effort?.id, "thought");
  assert.equal(config.effort?.currentValue, "medium");
  assert.deepEqual(config.other, []);
});

test("options the categories do not claim are preserved verbatim and in order", () => {
  const mode = select("mode", "mode", "ask", [{ value: "ask", name: "Ask" }]);
  const bare = select("verbosity", undefined, "terse", [{ value: "terse", name: "Terse" }]);
  const unknown = select("vendor", "_vendor_thing", "on", [{ value: "on", name: "On" }]);

  const config = discoverConfig([mode, ...agentOptions, bare, unknown]);

  assert.equal(config.model?.id, "model");
  assert.deepEqual(config.other, [mode, bare, unknown]);
});

test("a boolean never becomes a model picker, whatever category it claims", () => {
  const toggle: acp.SessionConfigOption = {
    type: "boolean",
    id: "web",
    name: "Web search",
    category: "model",
    currentValue: true,
  };

  const config = discoverConfig([toggle, ...agentOptions]);

  // The boolean claims the model category first and is still not taken for it.
  assert.equal(config.model?.id, "model");
  assert.deepEqual(config.other, [toggle]);
});

test("a second option claiming a taken category is kept rather than dropped", () => {
  const duplicate = select("model-2", "model", "haiku", [{ value: "haiku", name: "Haiku" }]);

  const config = discoverConfig([...agentOptions, duplicate]);

  assert.equal(config.model?.id, "model");
  assert.deepEqual(config.other, [duplicate]);
});

test("grouped select values flatten into one picker list that remembers its groups", () => {
  const grouped = select("model", "model", "opus", [
    { group: "anthropic", name: "Anthropic", options: [{ value: "opus", name: "Opus" }] },
    { group: "other", name: "Other", options: [{ value: "haiku", name: "Haiku" }] },
  ]);

  const config = discoverConfig([grouped]);

  assert.deepEqual(config.model?.choices, [
    { value: "opus", label: "Opus", group: "Anthropic" },
    { value: "haiku", label: "Haiku", group: "Other" },
  ]);
});

test("an Agent that reports no Config Options yields no pickers", () => {
  assert.deepEqual(discoverConfig([]), { other: [] });
  assert.deepEqual(discoverConfig(), { other: [] });
});

test("Read-back reports the Agent's current value as verified", () => {
  const config = discoverConfig(agentOptions);

  assert.deepEqual(readBack(config.model, "sonnet"), {
    requested: "sonnet",
    effective: "sonnet",
    verification: "verified",
  });
});

test("a clamped value is a verified mismatch, not a silent substitution", () => {
  const config = discoverConfig(agentOptions);

  const selection = readBack(config.effort, "xhigh");

  assert.deepEqual(selection, { requested: "xhigh", effective: "medium", verification: "verified" });
  assert.equal(isMismatch(selection), true);
});

test("Read-back without a Config Option stays unavailable and names no effective value", () => {
  const selection = readBack(undefined, "opus");

  assert.deepEqual(selection, { requested: "opus", verification: "unavailable" });
  assert.equal(selection.effective, undefined);
  // Unverified is unknown, never a mismatch: there is no Agent evidence to differ from.
  assert.equal(isMismatch(selection), false);
});

test("Read-back with nothing requested still surfaces what the Agent runs", () => {
  const config = discoverConfig(agentOptions);

  const selection = readBack(config.model);

  assert.deepEqual(selection, { effective: "sonnet", verification: "verified" });
  assert.equal(isMismatch(selection), false);
});

const catalog: ModelHint[] = [
  { id: "catalog-model", label: "Catalog Model", efforts: ["low", "high"] },
];

test("the Runtime catalog is ignored whenever the Agent exposes its own lists", () => {
  const config = discoverConfig(agentOptions);

  assert.deepEqual(pickModelChoices(config, catalog), {
    choices: [
      { value: "sonnet", label: "Sonnet" },
      { value: "opus", label: "Opus" },
    ],
    source: "agent",
  });
  assert.deepEqual(pickEffortChoices(config, catalog[0]), {
    choices: [{ value: "medium", label: "Medium" }],
    source: "agent",
  });
});

test("the catalog fills the pickers only in the Agent's silence", () => {
  const config = discoverConfig([]);

  assert.deepEqual(pickModelChoices(config, catalog), {
    choices: [{ value: "catalog-model", label: "Catalog Model" }],
    source: "catalog",
  });
  assert.deepEqual(pickEffortChoices(config, catalog[0]), {
    choices: [
      { value: "low", label: "low" },
      { value: "high", label: "high" },
    ],
    source: "catalog",
  });
});

test("no Config Options and no catalog yields no choices rather than an invented list", () => {
  const config = discoverConfig([]);

  assert.deepEqual(pickModelChoices(config), { choices: [], source: "none" });
  assert.deepEqual(pickModelChoices(config, []), { choices: [], source: "none" });
  // A model that declares no efforts offers none — not the conductor's vocabulary.
  assert.deepEqual(pickEffortChoices(config, { id: "m", label: "M" }), { choices: [], source: "none" });
  assert.deepEqual(pickEffortChoices(config), { choices: [], source: "none" });
});

test("shapes an Agent can send but the schema forbids never become pickers", () => {
  const wire = [
    null,
    "not an option",
    { type: "select", id: "a", name: "A", category: "model", currentValue: "x", options: null },
    { type: "select", id: "b", name: "B", category: "model", currentValue: "x", options: {} },
    { type: "select", id: "c", name: "C", category: "model", currentValue: 42, options: [] },
    { type: "select", id: "d", name: "D", category: "model", currentValue: "x", options: [null] },
    { type: "select", id: "e", name: "E", category: "model", currentValue: "x", options: [{ group: "g", name: "G", options: null }] },
    { type: "boolean", id: "f", name: "F", category: "model", currentValue: true },
    { type: "select", id: "g", name: "G", category: {}, currentValue: "x", options: [] },
    { type: "select", id: "h", name: "H", category: "model", currentValue: "x", options: [], description: 7 },
    // Deliberately ill-typed: the point is what an agent can put on the wire.
  ] as unknown as acp.SessionConfigOption[];

  const config = discoverConfig(wire);

  // A boolean never poses as a model picker, whatever category it claims, and a
  // malformed select is not a picker either.
  assert.equal(config.model, undefined);
  assert.equal(config.effort, undefined);
  assert.deepEqual(readBack(config.model, "opus"), { requested: "opus", verification: "unavailable" });
});

test("a Config Option array is narrowed to what the client can actually trust", () => {
  const good: acp.SessionConfigOption = select("model", "model", "opus", [{ value: "opus", name: "Opus" }]);
  const boolean: acp.SessionConfigOption = {
    type: "boolean",
    id: "web",
    name: "Web search",
    currentValue: false,
  };

  assert.deepEqual(asConfigOptions([good, boolean]), [good, boolean]);
  // Anything that is not an array of options at all yields none.
  assert.deepEqual(asConfigOptions(undefined), []);
  assert.deepEqual(asConfigOptions(null), []);
  assert.deepEqual(asConfigOptions("configOptions"), []);
  assert.deepEqual(asConfigOptions({}), []);
  assert.deepEqual(asConfigOptions([null, 1, { id: "x" }]), []);
  // Display-only fields are checked too: a consumer that renders them must not
  // be handed something other than the string its type promises.
  assert.deepEqual(asConfigOptions([{ ...good, category: {} }]), []);
  assert.deepEqual(asConfigOptions([{ ...good, description: 7 }]), []);
  // Absent and explicitly null are both fine — the schema allows them.
  assert.deepEqual(asConfigOptions([{ ...good, category: null, description: null }]).length, 1);
});

test("a value that also looks like a group is one shape to the validator and the picker alike", () => {
  // An Agent that labels each flat value with its group name instead of nesting
  // satisfies both shapes at once. Whichever way it is read, it must be read
  // the same way twice — a value accepted as flat and then flattened as a group
  // dereferences values that were never checked.
  const wire = [
    {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "opus",
      options: [
        { value: "opus", name: "Opus", group: "anthropic" },
        { value: "sonnet", name: "Sonnet", group: "anthropic" },
      ],
    },
    // Deliberately ill-typed: the point is what an agent can put on the wire.
  ] as unknown as acp.SessionConfigOption[];

  // Accepting it and then crashing on it is the failure this pins.
  const config = discoverConfig(wire);

  assert.deepEqual(config.model?.choices, [
    { value: "opus", label: "Opus" },
    { value: "sonnet", label: "Sonnet" },
  ]);
  assert.equal(config.model?.currentValue, "opus");
});

/**
 * Applying the selection a Session was opened with (ADR-0005).
 */

const selector = (id: string, current: string, values: string[]) => ({
  id,
  name: id,
  currentValue: current,
  choices: values.map((value) => ({ value, label: value })),
});

test("a refused selection stops the next one being asked for", async () => {
  const asked: string[] = [];
  const session = {
    config: {
      model: selector("model", "a", ["a", "b"]),
      effort: selector("effort", "low", ["low", "high"]),
      other: [],
    },
    setConfigOption: async (configId: string) => {
      asked.push(configId);
      throw new Error("the agent answered nothing useful");
    },
  };

  await applyRequestedSelections(session, { model: "b", effort: "high" }, () => undefined);

  // Each attempt is bounded by a Setup Deadline, so an Agent that could not
  // answer the first would double how long a Session takes to open.
  assert.deepEqual(asked, ["model"]);
});

test("a value the agent does not list is never asked for", async () => {
  const asked: string[] = [];
  const session = {
    config: { model: selector("model", "a", ["a", "b"]), other: [] },
    setConfigOption: async (configId: string) => {
      asked.push(configId);
      return session.config;
    },
  };

  await applyRequestedSelections(session, { model: "gone-in-this-release" }, () => undefined);

  assert.deepEqual(asked, [], "a stale setting is a mismatch, not a request");
});

test("what an agent says it is running is read back even where its own list omits it", () => {
  const config = discoverConfig([
    {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "mock-model-preview",
      options: [{ value: "mock-model", name: "Mock Model" }],
    },
  ] as acp.SessionConfigOption[]);

  // Effective comes from the Agent and nowhere else (ADR-0005). A list that
  // does not contain the value is the Agent contradicting itself, and the
  // honest answer is what it says it is running — not the nearest thing on the
  // list, which would report a model nobody is being charged for.
  assert.equal(readBack(config.model, "mock-model").effective, "mock-model-preview");
  assert.equal(readBack(config.model, "mock-model").verification, "verified");
  assert.equal(isMismatch(readBack(config.model, "mock-model")), true);
});
