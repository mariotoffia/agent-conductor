import { z } from "zod";
import { message } from "./failures.js";
import { plainText } from "./sealText.js";
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
export const MAX_REGISTRY_TEXT = 4 * 1024 * 1024;

/** How long a Registry request may take. The built-in catalog is the fallback,
 *  so waiting longer buys nothing a user watching a progress notification wants. */
export const REGISTRY_TIMEOUT_MS = 10_000;

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

/** Fetches a Registry document. Replaceable so a test never needs the network. */
export type FetchText = (url: string) => Promise<string>;

/** What a refresh left the extension with, and what to say about it. */
export interface RegistryRefresh {
  /** The snapshot to use now: the fresh one, or the cached copy it fell back
   *  to. Absent means neither exists and the built-in catalog is all there is. */
  snapshot?: RegistrySnapshot;
  /** Why the refresh did not happen, in words a notification can show. Absent
   *  when the document really was refreshed. */
  problem?: string;
}

/**
 * Refreshes the cached Registry, falling back visibly.
 *
 * Nothing here throws, because nothing here is essential: the built-in catalog
 * launches every Runtime offline, and the Registry only supplies exact Adapter
 * versions. What matters is that a failure is *said* rather than swallowed — an
 * extension that quietly serves a month-old document looks identical to one
 * that just refreshed (ARCHITECTURE.md §Runtime catalog).
 *
 * The previous cache survives every failure, including a document that does not
 * validate: it is the copy the user is offline with.
 */
export async function refreshRegistry(
  storage: StoragePort,
  url: string,
  now: number,
  options: { fetchText?: FetchText; ttlMs?: number } = {},
): Promise<RegistryRefresh> {
  try {
    return { snapshot: await cacheRegistry(storage, await (options.fetchText ?? fetchText)(url), now) };
  } catch (error) {
    const cached = await readCachedRegistry(storage, now, options.ttlMs);
    return { ...(cached ? { snapshot: cached } : {}), problem: message(error) };
  }
}

/** The registry over HTTP, bounded in both time and size — it is a remote
 *  document, and the extension host is what would hold an unbounded one. */
const fetchText: FetchText = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`registry answered ${response.status} ${response.statusText}`);
  }
  // A declared length is a chance to refuse before reading anything. It is in
  // bytes and the cap is in characters, which for this document differ only in
  // the safe direction: no encoding produces fewer bytes than characters.
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REGISTRY_TEXT) {
    throw new Error(`registry document is too large: ${declared} bytes`);
  }
  return readBounded(response.body, MAX_REGISTRY_TEXT);
};

/** Reads a response body, stopping at the cap rather than after it: a server
 *  that under-declares its length must not decide how much memory this costs. */
async function readBounded(body: ReadableStream<Uint8Array> | null, limit: number): Promise<string> {
  if (!body) return "";
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      text += decoder.decode(value, { stream: true });
      if (text.length > limit) {
        throw new Error(`registry document is too large: over ${limit} characters`);
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** What a refresh leaves the user with. A stale or missing snapshot is said out
 *  loud: quietly serving a month-old document looks like a fresh refresh. */
export function describeRefresh(result: RegistryRefresh): string {
  const agents = result.snapshot?.document.agents.length ?? 0;
  if (!result.problem) return `ACP agent registry refreshed — ${agents} agents.`;
  // What went wrong carries the host's own words — a reason phrase it chose, a
  // snippet of the document it served — and this line is shown in a
  // notification, where a link is something to click (ADR-0007).
  const problem = plainText(result.problem);
  if (!result.snapshot) {
    return `The ACP agent registry is unavailable (${problem}); the built-in catalog is in use.`;
  }
  const cached = new Date(result.snapshot.fetchedAt).toISOString();
  return (
    `The ACP agent registry is unavailable (${problem});` +
    ` using the copy cached ${cached}${result.snapshot.stale ? " (stale)" : ""}.`
  );
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
