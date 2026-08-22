import assert from "node:assert/strict";
import test from "node:test";
import { MAX_DETAIL_CHARS } from "../../vscode/permissions.js";
import { connectCli } from "../../vscode/wizard.js";
import { safeText } from "../../vscode/wizardAsk.js";
import { linkish } from "../link-forms.js";
import { mockEntry, MOCK_ID, wizardHarness } from "../wizard-fixtures.js";

/**
 * What the wizard says, and what it cannot be made to say.
 *
 * Everything here carries an Agent's own words — a refusal, a reply, a value it
 * reported — into a notification, a log file, or a modal that asks for a
 * credential. Each of those is bounded, and whoever decides what fills the bound
 * decides what is read (ADR-0007, ADR-0010).
 */

const wizardTest = (name: string, fn: () => Promise<void>) => test(name, { timeout: 30_000 }, fn);

wizardTest("a failure carrying the agent's own words is redacted before it is said", async () => {
  const harness = wizardHarness({
    // The agent is given a credential and puts it into a protocol error. What
    // ends a run is as likely to carry the agent's words as anything it says
    // while running, and all of it reaches a log file (ADR-0010).
    mode: "leak-in-error",
    saved: {
      [MOCK_ID]: {
        ...mockEntry("leak-in-error"),
        secretEnvironment: { MOCK_SECRET: "agentConductor.claude.MOCK_SECRET" },
      },
    },
    secrets: { "agentConductor.claude.MOCK_SECRET": "sk-live-THIS-IS-THE-RESOLVED-CREDENTIAL" },
  });

  await connectCli(harness.ports);

  const said = harness.said.join("\n");
  assert.match(said, /upstream rejected/, "the failure itself is still reported");
  assert.equal(
    said.includes("sk-live-THIS-IS-THE-RESOLVED-CREDENTIAL"),
    false,
    "the credential the agent was started with must not reach the log",
  );
  assert.match(said, /\[redacted\]/);
});

wizardTest("a credential with newlines in it is redacted even after flattening", async () => {
  const key = "-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBgkqhkiG9w0\n-----END PRIVATE KEY-----";
  const harness = wizardHarness({
    mode: "speak-secret",
    saved: {
      [MOCK_ID]: {
        ...mockEntry("speak-secret"),
        secretEnvironment: { MOCK_SECRET: "agentConductor.claude.MOCK_SECRET" },
      },
    },
    secrets: { "agentConductor.claude.MOCK_SECRET": key },
  });

  await connectCli(harness.ports);

  // Redaction matches the value as it is, and flattening the report first
  // destroys the newlines a PEM key carries — so the one has to know what the
  // other did (ADR-0010).
  const said = harness.said.join("\n");
  assert.equal(said.includes("MIIBVgIBADANBgkqhkiG9w0"), false, said);
  assert.match(said, /\[redacted\]/);
});

wizardTest("the client's own words about credentials survive a long refusal", async () => {
  const harness = wizardHarness({
    mode: "verbose-refusal",
    // Approve the launch, then dismiss the handoff: what is under test is not
    // what the dialog does, but what it said.
    consent: (message, choices) => (message.includes("could not open a session") ? undefined : choices[0]),
  });

  await connectCli(harness.ports);

  const dialog = harness.asked.find((said) => said.includes("could not open a session")) ?? "";
  assert.ok(dialog, `the handoff was never offered: ${harness.asked.join("\n\n")}`);
  // A modal is bounded and the agent's refusal is not, so "it is in there
  // somewhere" is not the property worth having: this dialog is the one that
  // asks for a credential, and where a pasted one goes has to be in the part
  // that is read (ADR-0010). Position, not presence.
  const at = dialog.indexOf("never collects or proxies a credential");
  assert.ok(at >= 0 && at < 400, `the client's own words start at ${at}: ${dialog.slice(0, 500)}`);
  const detail = dialog.slice(dialog.indexOf("\n") + 1);
  assert.ok(detail.length <= MAX_DETAIL_CHARS, `the detail is ${detail.length} characters`);
  assert.equal(
    dialog.includes("forward it to the vendor"),
    false,
    "the agent wrote the part of the dialog the client is answerable for",
  );
});

wizardTest("a value the agent reports cannot choose which line of the report is seen", async () => {
  // The client says it will not store this as a default. A notification shows
  // one line, so a value with a line ending in it decides where that sentence
  // stops — and what is left reads as the agent's, not this client's (ADR-0007).
  const harness = wizardHarness({ mode: "forged-effort" });

  await connectCli(harness.ports);

  const about = harness.said.find((said) => said.includes("brisk")) ?? "";
  assert.ok(about, `the value was never reported: ${harness.said.join("\n\n")}`);
  assert.equal(about.includes("\n"), false, `the agent wrote a line of its own: ${about}`);
});

wizardTest("a long enough answer cannot push the read-back out of the report", async () => {
  // The answer passes: one line, and `OK` once the padding is discounted. The
  // report it is quoted into is bounded, and the mismatch is the part of it
  // worth having — a mismatch nobody sees is a mismatch nobody acted on
  // (ADR-0005).
  const harness = wizardHarness({ mode: "padded-ok" });

  await connectCli(harness.ports);

  const said = harness.said.find((line) => line.includes("answered:")) ?? "";
  assert.ok(said, `nothing reported the answer: ${harness.said.join("\n\n")}`);
  assert.match(said, /mismatch/);
});

wizardTest("redaction cannot push the read-back out of the report either", async () => {
  // `[redacted]` is longer than the value it replaces whenever that value is
  // eight or nine characters, so a report sized before redaction is not sized
  // after it — and the agent has the credential in its own environment to echo.
  const harness = wizardHarness({
    mode: "echo-secret",
    saved: {
      [MOCK_ID]: {
        ...mockEntry("echo-secret"),
        secretEnvironment: { MOCK_SECRET: "agentConductor.claude.MOCK_SECRET" },
      },
    },
    secrets: { "agentConductor.claude.MOCK_SECRET": "sk-abcd1" },
  });

  await connectCli(harness.ports);

  const said = harness.said.find((line) => line.includes("answered:")) ?? "";
  assert.ok(said, `nothing reported the answer: ${harness.said.join("\n\n")}`);
  assert.equal(said.includes("sk-abcd1"), false, said);
  assert.match(said, /mismatch/);
});

wizardTest("a failure the wizard reports cannot carry something to click", async () => {
  // What `report` says reaches `showInformationMessage`, and VS Code renders a
  // notification through its own linked-text parser — so an agent's refusal is
  // as able to offer a link there as it is in the transcript (ADR-0007).
  const harness = wizardHarness({ mode: "link-in-error" });

  await connectCli(harness.ports);

  const said = harness.said.join("\n");
  assert.match(said, /example\.invalid/, "what it said is still reported");
  const clickable = linkish(said);
  assert.equal(clickable, undefined, `the wizard reported ${clickable ?? ""}: ${said}`);
});

wizardTest("a value carrying a credential is never written into settings", async () => {
  // Settings are synced and committed; a resolved secret reaching one is the
  // leak ADR-0010 exists to stop, and the agent chooses what it reports.
  const secret = "sk-live-THIS-IS-THE-RESOLVED-CREDENTIAL";
  const harness = wizardHarness({
    mode: "echo-config",
    saved: {
      [MOCK_ID]: {
        ...mockEntry("echo-config"),
        secretEnvironment: { MOCK_SECRET: "agentConductor.claude.MOCK_SECRET" },
      },
    },
    secrets: { "agentConductor.claude.MOCK_SECRET": secret },
  });

  await connectCli(harness.ports);

  const written = JSON.stringify(harness.writes);
  assert.equal(written.includes(secret), false, `a credential reached settings: ${written}`);
  assert.equal(written.includes("defaultModel"), false, `an unstorable value was stored: ${written}`);
});

wizardTest("a credential the sealing runs through is still redacted", async () => {
  // Sealing takes a character from either side of what it breaks — the rule for
  // an address does — so a value that matched the text before sealing does not
  // match it after, and the Agent writes the character next to its own
  // credential (ADR-0010).
  const secret = "svc-acct@internal.example";
  const harness = wizardHarness({
    mode: "speak-secret",
    saved: {
      [MOCK_ID]: {
        ...mockEntry("speak-secret"),
        secretEnvironment: { MOCK_SECRET: "agentConductor.claude.MOCK_SECRET" },
      },
    },
    secrets: { "agentConductor.claude.MOCK_SECRET": secret },
  });

  await connectCli(harness.ports);

  const said = harness.said.join("\n");
  assert.equal(said.includes("internal.example"), false, said);
  assert.match(said, /\[redacted\]/);
});

wizardTest("a credential the agent re-spelled the whitespace of is still redacted", async () => {
  // A CLI that re-wraps what it prints changes the whitespace inside a value,
  // and then the value as it was stored is not in the text at all. Both are the
  // same credential once the text has been flattened, which is why redaction
  // runs after the sealing as well as before it (ADR-0010).
  const secret = "sk live not a real credential 0123456789";
  const harness = wizardHarness({
    mode: "respace-secret",
    saved: {
      [MOCK_ID]: {
        ...mockEntry("respace-secret"),
        secretEnvironment: { MOCK_SECRET: "agentConductor.claude.MOCK_SECRET" },
      },
    },
    secrets: { "agentConductor.claude.MOCK_SECRET": secret },
  });

  await connectCli(harness.ports);

  const said = harness.said.join("\n");
  assert.equal(said.includes("not a real credential"), false, said);
  assert.match(said, /\[redacted\]/);
});

/**
 * `safeText` on its own. The wizard happens to apply it twice on the smoke-test
 * path, so an end-to-end test cannot tell whether one call is enough — and one
 * call is what every other caller makes.
 *
 * Redaction runs on both sides of the sealing, against the value as stored and
 * against the value sealed. Each of those four is the only thing that catches
 * one of these.
 */
test("one call redacts a value whichever side of the sealing it matches", () => {
  // Sealing breaks the address and takes the character before the `@` with it,
  // so the stored form is in the text before sealing and in nothing after. The
  // sealed form of a value starting with `@` is the value, so it does not help.
  const addressed = "@abcd.example-key-value";
  const broken = safeText(`token${addressed} was rejected`, [addressed], 2_000);

  // The agent re-wrapped what it printed, so the whitespace inside the value is
  // neither what was stored nor what sealing turns that into — the two are the
  // same string only once both have been through it.
  const wrapped = "sk-live\nsecret-value-here";
  const respaced = safeText("configured with sk-live  secret-value-here", [wrapped], 2_000);

  // Sealing this one down to below the length redaction bothers with: the value
  // as stored is the only form long enough to be removed at all.
  const starred = "**secret**";
  const shortened = safeText(`configured with ${starred} ok`, [starred], 2_000);

  assert.equal(broken.includes("abcd.example"), false, broken);
  assert.equal(respaced.includes("secret-value-here"), false, respaced);
  assert.equal(shortened.includes("secret"), false, shortened);
});


wizardTest("declining fan-out says so without drawing what the repository wrote", async () => {
  // Every other thing the wizard says goes through `report`. This one is on the
  // path taken by declining, and a Runtime's name is a settings key from a scope
  // a repository writes (ADR-0007).
  const harness = wizardHarness({
    orchestration: true,
    workspaceSaved: { "[Click here](https://evil.invalid)": mockEntry() },
    pick: { "Connect a CLI": "Click here" },
    consent: (message, choices) => (/fan-out|subagent/i.test(message) ? choices[choices.length - 1] : choices[0]),
  });

  await connectCli(harness.ports);

  const said = harness.said.find((line) => line.includes("direct sessions only")) ?? "";
  assert.ok(said, `fan-out was never declined: ${harness.said.join("\n\n")}`);
  const clickable = linkish(said);
  assert.equal(clickable, undefined, `it drew ${clickable ?? ""}: ${said}`);

  // And the same name leads every step the wizard runs under progress, which is
  // a notification too — the surface, not the call, decides what sealing is for.
  for (const title of harness.progress) {
    const drawn = linkish(title);
    assert.equal(drawn, undefined, `a progress title drew ${drawn ?? ""}: ${title}`);
  }
  assert.ok(harness.progress.length > 0, "nothing ran under progress");
});

wizardTest("a runtime's own mark survives being shown, however its name is sealed", async () => {
  // `customName` cuts to fit and adds the mark last. Sealing runs after that and
  // *inserts* characters, so a name that fitted exactly no longer does — and
  // what a clamp takes off the right is the one thing saying whose name it is.
  const key = "Claude Code - support: help@acme.example ops@acme.example sre@acme.example dev@acme.ex";
  const harness = wizardHarness({ workspaceSaved: { [key]: mockEntry() } });

  await connectCli(harness.ports);

  const approval = harness.asked.find((said) => said.includes("exactly as it will be launched")) ?? "";
  assert.ok(approval, `the approval was never asked: ${harness.asked.join("\n\n")}`);
  const heading = approval.split("\n")[0] ?? "";
  assert.match(heading, /\(custom\)/, `the mark was cut: ${heading}`);
});

wizardTest("an answer built from the sealing's own characters cannot hide the read-back", async () => {
  // The reply is sealed when the report is composed and again when it is said.
  // Padding that seals differently the second time grows the line past the
  // budget it was sized against, and what falls off the end is the mismatch
  // (ADR-0005).
  const harness = wizardHarness({ mode: "chained-ok" });

  await connectCli(harness.ports);

  const said = harness.said.find((line) => line.includes("answered:")) ?? "";
  assert.ok(said, `nothing reported the answer: ${harness.said.join("\n\n")}`);
  assert.match(said, /mismatch/);
});

wizardTest("an answer cannot turn the read-back beside it backwards", async () => {
  // The reply is quoted first and the Read-back follows it, so a direction
  // override at the end of an otherwise acceptable answer draws the mismatch
  // backwards (ADR-0005). Padding is what is neither a letter nor a number, and
  // an override is neither — so the Smoke Test accepts this.
  const harness = wizardHarness({ mode: "bidi-ok" });

  await connectCli(harness.ports);

  const said = harness.said.find((line) => line.includes("answered:")) ?? "";
  assert.ok(said, `nothing reported the answer: ${harness.said.join("\n\n")}`);
  assert.match(said, /mismatch/);
  assert.equal(
    /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(said),
    false,
    `a direction override survived: ${JSON.stringify(said)}`,
  );
});

wizardTest("a value too long to be a name is never written into settings", async () => {
  // Settings sync and get committed. The Agent chooses what it reports, and a
  // value of any length would otherwise be stored as this Runtime's default.
  const harness = wizardHarness({ mode: "huge-config", saved: { [MOCK_ID]: mockEntry("huge-config") } });

  await connectCli(harness.ports);

  const written = JSON.stringify(harness.writes);
  assert.equal(written.includes("defaultModel"), false, `an unstorable value was stored: ${written.length} bytes`);
});
