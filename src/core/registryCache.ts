import { z } from "zod";
import type { AdapterPackage, StoragePort } from "./types.js";

/**
 * The ACP Registry: the machine-readable catalogue of ACP agents, their current
 * versions, and how each one is distributed.
 *
 * Every distribution it publishes is a way to *obtain* an agent over the network —
 * an `npx`/`uvx` invocation, a downloadable archive — and never a way to launch one
 * already installed. So the Registry can say which exact version to install, but
 * nothing about how a Session starts: only the version is taken from it, and only
 * for a package the built-in catalog already names (ADR-0007).
 */
const npxDistribution = z
  .object({ package: z.string().min(1), args: z.array(z.string()).optional() })
  .passthrough();

const registryAgent = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    version: z.string().min(1),
    distribution: z.object({ npx: npxDistribution.optional() }).passthrough(),
  })
  .passthrough();

/** Only the fields we consume are required; the rest is preserved untouched. */
export const registrySchema = z
  .object({ version: z.string().min(1), agents: z.array(registryAgent) })
  .passthrough();

export type RegistryDocument = z.infer<typeof registrySchema>;

/** A validated Registry document and how old it is. */
export interface RegistrySnapshot {
  document: RegistryDocument;
  /** Epoch milliseconds at which it was fetched. */
  fetchedAt: number;
  /** Past its lifetime. Still usable — it is the offline copy — but say so. */
  stale: boolean;
}

const cacheEnvelope = z.object({
  fetchedAt: z.number().int().nonnegative(),
  document: registrySchema,
});

export const REGISTRY_CACHE_KEY = "acp-registry.json";
export const DEFAULT_REGISTRY_TTL_MS = 24 * 60 * 60 * 1000;

/** An exact release. A range or a dist-tag names whatever is published later,
 *  which is not an identity anyone can approve in advance. Leading zeros are out:
 *  `01.2.3` and `1.2.3` would otherwise be two spellings of one release. */
const EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$/;

/** The published document is tens of kilobytes. This bounds what a hostile or
 *  broken response can make the extension parse and hold — applied both when a
 *  document arrives and when a cached one is read back at startup. */
const MAX_REGISTRY_TEXT = 4 * 1024 * 1024;

export function isExactVersion(version: string): boolean {
  return EXACT_VERSION.test(version);
}

/** Validates one Registry document. Throws on anything else. */
export function parseRegistry(text: string): RegistryDocument {
  if (text.length > MAX_REGISTRY_TEXT) {
    throw new Error(`registry document is too large: ${text.length} characters`);
  }
  return registrySchema.parse(JSON.parse(text));
}

/**
 * Whether `candidate` is a later release than `floor`, comparing the numeric
 * triple only — a prerelease of the same triple does not count as later. Used to
 * keep the Registry from moving a Runtime backwards onto an older artifact.
 */
export function isNewerVersion(candidate: string, floor: string): boolean {
  const triple = (version: string): number[] => (version.split(/[-+]/)[0] ?? "").split(".").map(Number);
  const [left, right] = [triple(candidate), triple(floor)];
  // A version this cannot read is never evidence that something is newer. Said
  // here rather than left to the caller: answering "yes" by accident replaces an
  // artifact, and a leading part can decide the comparison before a bad part is
  // ever reached.
  const readable = (parts: number[]): boolean =>
    parts.length === 3 && parts.every((part) => Number.isSafeInteger(part) && part >= 0);
  if (!readable(left) || !readable(right)) return false;

  for (let part = 0; part < 3; part += 1) {
    if (left[part] !== right[part]) return left[part] > right[part];
  }
  return false;
}

/**
 * Validates, then replaces the cached snapshot. Validation happens first on
 * purpose: a rejected document must leave the previous cache — the copy the user
 * is offline with — exactly as it was.
 */
export async function cacheRegistry(
  storage: StoragePort,
  text: string,
  now: number,
): Promise<RegistrySnapshot> {
  const document = parseRegistry(text);
  await storage.writeAtomic(REGISTRY_CACHE_KEY, JSON.stringify({ fetchedAt: now, document }));
  return { document, fetchedAt: now, stale: false };
}

/**
 * The cached snapshot, or `undefined` when there is none we can trust. Never
 * throws: the built-in catalog is always a working fallback, so an unreadable
 * cache is a missing refresh, not a broken extension.
 */
export async function readCachedRegistry(
  storage: StoragePort,
  now: number,
  ttlMs: number = DEFAULT_REGISTRY_TTL_MS,
): Promise<RegistrySnapshot | undefined> {
  try {
    const raw = await storage.read(REGISTRY_CACHE_KEY);
    if (raw === undefined || raw.length > MAX_REGISTRY_TEXT) return undefined;
    const cached = cacheEnvelope.safeParse(JSON.parse(raw));
    if (!cached.success) return undefined;
    const { document, fetchedAt } = cached.data;
    // A stamp in the future comes from a wrong clock or a copied storage file;
    // treating it as fresh would pin the extension to that copy forever.
    const stale = fetchedAt > now || now - fetchedAt > ttlMs;
    return { document, fetchedAt, stale };
  } catch {
    return undefined;
  }
}

/**
 * Exact version the Registry publishes for one agent, when its distribution still
 * names the package the catalog expects. A renamed package is a different artifact
 * however the Registry labels it, so it is ignored rather than followed.
 */
export function registryAdapterVersion(
  snapshot: RegistrySnapshot | undefined,
  registryId: string,
  packageName: string,
): string | undefined {
  const distributed = snapshot?.document.agents.find((agent) => agent.id === registryId)
    ?.distribution.npx?.package;
  if (!distributed) return undefined;
  // Package names are scoped (`@scope/name@1.2.3`), so the version is the last `@`.
  const at = distributed.lastIndexOf("@");
  if (at <= 0 || distributed.slice(0, at) !== packageName) return undefined;
  const version = distributed.slice(at + 1);
  return isExactVersion(version) ? version : undefined;
}

/** An npm package name, optionally scoped. Checked because the name becomes an
 *  argument to a package manager: anything else could be a flag redirecting the
 *  install, or something a terminal would read as more than a name. */
const PACKAGE_NAME = /^(?:@[a-z0-9~][a-z0-9-._~]*\/)?[a-z0-9~][a-z0-9-._~]*$/;

/**
 * Command the connection wizard runs — deliberately, with the user watching — to
 * install an Adapter at one exact version. It is the only place the extension
 * names a package manager, and no Session path calls it: starting a Session must
 * never install or fetch anything (ADR-0007).
 */
export function adapterInstallCommand(adapter: AdapterPackage): { command: string; args: string[] } {
  if (!PACKAGE_NAME.test(adapter.package)) {
    throw new Error(`adapter package name is not one: "${adapter.package}"`);
  }
  if (!isExactVersion(adapter.version)) {
    throw new Error(
      `adapter ${adapter.package}: installation needs an exact version, got "${adapter.version}"`,
    );
  }
  return { command: "npm", args: ["install", "--global", `${adapter.package}@${adapter.version}`] };
}
