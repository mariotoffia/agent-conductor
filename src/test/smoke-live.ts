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
    // composed it — a site that seals its own way is how one gets missed.
    outcome = { ...outcome, detail: reportLine(outcome.detail, secrets) };
    outcomes.push(outcome);
    options.log?.(`${outcome.id.padEnd(8)} ${outcome.outcome.toUpperCase().padEnd(7)} ${outcome.detail}`);
  }
  return { outcomes, probed, failed };
}

async function main(): Promise<void> {
  // The catalog under the same policy a default direct Session launches with.
  const specs = builtinRuntimes({ suppressBuiltInSubagents: true, hideSubscriptionAuth: true });
  const result = await smokeLive(specs, {
    executable: executablePort(),
    log: (line) => console.log(line),
    // Everything the shell holds: this script cannot know which of it is a
    // credential, and the probe handed the child all of it.
    secrets: Object.values(process.env).filter((value): value is string => value !== undefined),
  });
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
