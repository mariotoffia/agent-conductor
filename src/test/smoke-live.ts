import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  builtinRuntimes,
  detectRuntimes,
  executablePort,
  message,
  openProbeSession,
  redactSecrets,
  resolveRuntime,
  type EffectiveSelection,
  type ExecutablePort,
  type RuntimeSpec,
} from "../core/index.js";
import { MOCK_MODEL, startMockProvider, type MockProvider } from "./mock-provider.js";

/**
 * `make smoke-live`: probe whichever agent CLIs are installed on this machine,
 * with the same Probe Session and Smoke Test the connection wizard runs.
 *
 * Manual and optional by rule (PERSONAS.md): CI must not require installed
 * CLIs, credentials, subscriptions, or network, so nothing in `make check` or
 * `make check-all` reaches this. It runs under plain Node because the core is
 * `vscode`-free (ADR-0003), and it inherits this shell's environment, so the
 * probe runs on whatever logins and keys the shell already has.
 *
 * The identity probed is the catalog's own under product-default policy, and it
 * is approved by the person running the command: typing `make smoke-live` is
 * the consent, the way running the CLI by hand would be. Nothing here writes
 * settings, records Runtime Trust, or touches storage — the wizard stays the
 * only thing that connects a Runtime (ADR-0007).
 */

export interface SmokeLiveOutcome {
  id: string;
  outcome: "ok" | "failed" | "skipped";
  detail: string;
}

export interface SmokeLiveResult {
  outcomes: SmokeLiveOutcome[];
  /** Runtimes that were actually started. Skips prove nothing either way. */
  probed: number;
  failed: number;
}

interface SmokeLiveOptions {
  executable: ExecutablePort;
  /** One line per Runtime as it finishes, so a slow probe is visibly under way. */
  log?: (line: string) => void;
  /**
   * Values scrubbed from every report line. The probe inherits this shell's
   * whole environment so the CLI can authenticate, and the product's redaction
   * is keyed off SecretStorage values this script never has — so what the shell
   * holds is the honest value set here, and `main` passes all of it. Removing a
   * benign long value from a message is the cheap direction; printing an echoed
   * credential is not (ADR-0010).
   */
  secrets?: readonly string[];
  /**
   * What a row means, where it does not mean what every other row means, by
   * Runtime id. `dsh OK` and `copilot OK` are otherwise the same three
   * characters for two different claims — one probed against the provider the
   * user configured, the other against a fixture — and a table read on its own,
   * piped or grepped, keeps whichever line it was printed beside.
   */
  notes?: Readonly<Record<string, string>>;
}

/** One selection for a report line: the effective value or an honest absence. */
function said(name: string, selection: EffectiveSelection): string {
  return selection.effective === undefined
    ? `${name} unavailable`
    : `${name} ${selection.effective} (${selection.verification})`;
}

const collapsed = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * One bounded line with the secrets gone: this report is a summary, not a
 * transcript. Redaction runs before collapsing and again after, against values
 * collapsed the same way — whatever is done to the text has to be done to the
 * value, or a credential with a line ending in it survives its own removal.
 * The clamp comes last, because a cut can leave a fragment of a value that was
 * about to be matched whole.
 */
function reportLine(text: string, secrets: readonly string[]): string {
  const flat = redactSecrets(collapsed(redactSecrets(text, secrets)), secrets.map(collapsed));
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
}

/**
 * Probes sequentially on purpose: four coding CLIs starting at once compete for
 * the machine and interleave their answers, and a report read live should fill
 * in the order it lists.
 */
export async function smokeLive(
  specs: RuntimeSpec[],
  options: SmokeLiveOptions,
): Promise<SmokeLiveResult> {
  const { executable, secrets = [] } = options;
  const outcomes: SmokeLiveOutcome[] = [];
  let probed = 0;
  let failed = 0;

  for (const detection of await detectRuntimes(specs, { executable })) {
    const { spec, runtime, problem } = detection;
    let outcome: SmokeLiveOutcome;
    if (runtime === undefined) {
      outcome = { id: spec.id, outcome: "skipped", detail: problem ?? "not launchable" };
    } else {
      probed += 1;
      try {
        // Self-approval of the identity just resolved — the consent is the
        // person running the command. Held in memory for this process only.
        const trusted = await resolveRuntime(spec, {
          executable,
          trust: { fingerprint: runtime.fingerprint },
        });
        const probe = await openProbeSession({ runtime: trusted });
        try {
          const smoke = await probe.smoke();
          const readBack = `${said("model", probe.session.modelSelection)} · ${said("effort", probe.session.effortSelection)}`;
          outcome = smoke.ok
            ? { id: spec.id, outcome: "ok", detail: readBack }
            : {
                id: spec.id,
                outcome: "failed",
                detail: `smoke reply "${smoke.reply}" · stop ${smoke.stopReason} · ${readBack}`,
              };
        } finally {
          await probe.close();
        }
      } catch (error) {
        outcome = { id: spec.id, outcome: "failed", detail: message(error) };
      }
      if (outcome.outcome === "failed") failed += 1;
    }
    // Every detail passes the one scrubber on its way out, whatever path
    // composed it — a site that seals its own way is how one gets missed. The
    // note goes first, so the bound falls on the Agent's words rather than on
    // what this Client is saying about the run.
    const note = options.notes?.[outcome.id];
    outcome = {
      ...outcome,
      detail: reportLine(note ? `${note} · ${outcome.detail}` : outcome.detail, secrets),
    };
    outcomes.push(outcome);
    options.log?.(`${outcome.id.padEnd(8)} ${outcome.outcome.toUpperCase().padEnd(7)} ${outcome.detail}`);
  }
  return { outcomes, probed, failed };
}

/**
 * DeepSeek Harness, pointed at a model endpoint that is always there.
 *
 * Its provider is one the user hosts, so probing it as configured proves only
 * whether that machine was up — and fails whenever it is not, which is not what
 * a run of this is asking. The endpoint is redirected through a patch overlay
 * dsh applies after its own profile, written to a temporary file: nothing of
 * the user's configuration is read, changed, or needed.
 *
 * The provider is given a variable to read a key from because dsh insists on
 * holding one, and the mock accepts any value — there is no credential here.
 *
 * `llm-pi-ai` is the entry dsh's own base profile gives its provider plugin;
 * overriding that entry's config is what adds a route, and `acp` is the entry
 * `walkthrough/install.md` has the user insert. Both, and the `--patch` flag,
 * are recorded in `docs/CHANGELOG.md` with the date they were checked.
 */
const DSH_MOCK_KEY = "AGENT_CONDUCTOR_MOCK_KEY";

async function pointDshAtMock(
  specs: RuntimeSpec[],
): Promise<{ specs: RuntimeSpec[]; provider?: MockProvider; close: () => Promise<void> }> {
  const dsh = specs.find((spec) => spec.id === "dsh");
  if (!dsh) return { specs, close: () => Promise.resolve() };

  const provider = await startMockProvider();
  // Whatever fails after the server is listening takes the server with it: an
  // open socket keeps this process alive, so a leak here is a run that hangs
  // rather than one that fails.
  try {
    return await pointedAt(specs, provider);
  } catch (error) {
    await provider.close();
    throw error;
  }
}

async function pointedAt(
  specs: RuntimeSpec[],
  provider: MockProvider,
): Promise<{ specs: RuntimeSpec[]; provider?: MockProvider; close: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "agent-conductor-mock-"));
  // The directory goes the same way the server does if what follows fails:
  // only the returned `close` removes it, and a throw never returns one.
  try {
    return await withPatchIn(specs, provider, directory);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function withPatchIn(
  specs: RuntimeSpec[],
  provider: MockProvider,
  directory: string,
): Promise<{ specs: RuntimeSpec[]; provider?: MockProvider; close: () => Promise<void> }> {
  const patch = join(directory, "cordis.patch.yml");
  await writeFile(
    patch,
    [
      "- id: llm-pi-ai",
      "  config:",
      "    providers:",
      "      mock:",
      "        api: openai-completions",
      `        baseURL: ${provider.url}`,
      `        apiKeyEnv: ${DSH_MOCK_KEY}`,
      "        models:",
      `          - id: ${MOCK_MODEL}`,
      "- id: acp",
      `  config: {provider: mock, model: ${MOCK_MODEL}}`,
      "",
    ].join("\n"),
    "utf8",
  );
  // Inherited by the Agent this script starts, which is how a shell would
  // supply it. Any value does: the mock reads none of it.
  const had = process.env[DSH_MOCK_KEY];
  process.env[DSH_MOCK_KEY] = "mock";
  return {
    specs: specs.map((spec) =>
      spec.id === "dsh"
        ? { ...spec, launch: { ...spec.launch, args: [...spec.launch.args, "--patch", patch] } }
        : spec,
    ),
    provider,
    close: async () => {
      // Put back rather than deleted: this is a global, and a second caller in
      // this process did not ask for its environment to be edited.
      if (had === undefined) delete process.env[DSH_MOCK_KEY];
      else process.env[DSH_MOCK_KEY] = had;
      await provider.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function main(): Promise<void> {
  // The catalog under the same policy a default direct Session launches with.
  const catalog = builtinRuntimes({ suppressBuiltInSubagents: false });
  const mock = await pointDshAtMock(catalog);
  let result;
  try {
    result = await smokeLive(mock.specs, {
      executable: executablePort(),
      log: (line) => console.log(line),
      // Everything the shell holds: this script cannot know which of it is a
      // credential, and the probe handed the child all of it.
      secrets: Object.values(process.env).filter((value): value is string => value !== undefined),
      ...(mock.provider ? { notes: { dsh: "via the bundled mock provider, not dsh's own" } } : {}),
    });
  } finally {
    await mock.close();
  }
  const skipped = result.outcomes.length - result.probed;
  console.log(`probed ${result.probed} · ok ${result.probed - result.failed} · failed ${result.failed} · skipped ${skipped}`);
  if (result.probed === 0) console.log("no agent CLI was found to probe — nothing was verified");
  process.exitCode = result.failed > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(message(error));
    process.exitCode = 1;
  });
}
