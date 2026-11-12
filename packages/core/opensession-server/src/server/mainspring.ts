/**
 * Mainspring: a self-hosted gateway that pools Claude, Codex and other
 * subscriptions behind one Anthropic- and OpenAI-compatible endpoint
 * (docs/setup/mainspring.md).
 *
 * Settings live in model-providers.json, next to the other model providers,
 * under a top-level `mainspring` block:
 *
 *   { url, keyRef, keyHint, routeClaude, fallbackDirect, models }
 *
 * The key is a workspace secret (workspace-secrets.ts, purpose
 * `mainspring.key`); the block holds only its ref and its last four
 * characters. The key is never returned, logged or put in a run's
 * environment: this module resolves it for the server's own requests and for
 * the Pi runtime binding, which sends it as the provider's API key.
 *
 * `models` caches what `GET /v1/models` listed at the last Test, so the
 * picker and the runner read model metadata without a network call.
 *
 * Exported for the runner and the follow-up that reads `/v1/pool` and
 * Mainspring's MCP web tools: `mainspringConfig()` (the URL and the resolved
 * key) and `mainspringFetch()` (an authorized request). Settings writes are
 * async and serialized; the sync reader exists for the runner's synchronous
 * checks (piModelUnservableReason, the picker refresh), which already read
 * model-providers.json that way. Nothing runs at import.
 */
import { chmod, readFile } from "fs/promises";
import { isIP } from "net";
import { configPath, catalogRows } from "./model-providers";
import type { ProviderCatalogModel } from "./model-providers";
import { formatAnthropicReset } from "./anthropic-rate-limit";
import { writeJsonAtomicAsync } from "./shared/atomic-write";
import { fetchWithTimeout } from "./shared/fetch-with-timeout";
import { readJsonFileShared } from "./shared/json-file-cache";
import { isBlockedAddress, isPrivateHostName } from "./shared/network-address";
import {
  deleteWorkspaceSecretAsync,
  putWorkspaceSecretAsync,
  resolveWorkspaceSecretAsync,
} from "./workspace-secrets";

/** The Pi provider id: `pi/mainspring/<model>`. */
export const MAINSPRING_PROVIDER = "mainspring";

/** The workspace secret's purpose. */
export const MAINSPRING_SECRET_PURPOSE = "mainspring.key";

const KEY_PREFIX = "sk-ms-";
const MAX_KEY_LENGTH = 512;
const MAX_URL_LENGTH = 2048;
const TEST_TIMEOUT_MS = 10_000;
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/** What model-providers.json stores under `mainspring`. */
export interface MainspringRecord {
  url?: string;
  keyRef?: string;
  keyHint?: string;
  routeClaude: boolean;
  fallbackDirect: boolean;
  models?: { at: string; models: Record<string, ProviderCatalogModel> };
}

/** What the settings route returns: never the key, only its last four. */
export interface MainspringView {
  url: string | null;
  keySet: boolean;
  keyHint: string | null;
  routeClaude: boolean;
  fallbackDirect: boolean;
  models: Array<{ id: string; name?: string; contextWindow?: number }>;
  modelsAt: string | null;
}

/** A checked change. Absent fields stay as they are. */
export interface MainspringPatch {
  url?: string;
  key?: string;
  routeClaude?: boolean;
  fallbackDirect?: boolean;
}

export type MainspringResult =
  | { ok: true; settings: MainspringView }
  | { ok: false; status: number; error: string };

/** The URL and the resolved key: what a request to Mainspring needs. */
export interface MainspringConfig {
  /** The address without `/v1`, e.g. `https://mainspring.example.test`. */
  baseUrl: string;
  key: string;
}

interface Deps {
  fetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response>;
  now(): number;
}

const defaultDeps: Deps = {
  fetch: (url, init, timeoutMs) => fetchWithTimeout(url, init, timeoutMs),
  now: Date.now,
};

let deps: Deps = defaultDeps;

/** Swap the network and clock in tests. Returns a restore function. */
export function __setMainspringDepsForTest(
  overrides: Partial<Deps>,
): () => void {
  const previous = deps;
  deps = { ...defaultDeps, ...overrides };
  return () => {
    deps = previous;
  };
}

const obj = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Raw `mainspring` block → typed record. Unknown or malformed fields drop. */
export function parseMainspringRecord(raw: unknown): MainspringRecord {
  const o = obj(raw) ?? {};
  const str = (key: string) =>
    typeof o[key] === "string" && (o[key] as string).trim()
      ? (o[key] as string).trim()
      : undefined;
  const url = str("url");
  const checked = url ? validateMainspringUrl(url) : undefined;
  const models = obj(o.models);
  return {
    ...(checked && "url" in checked ? { url: checked.url } : {}),
    ...(str("keyRef") ? { keyRef: str("keyRef") } : {}),
    ...(str("keyHint") ? { keyHint: str("keyHint") } : {}),
    routeClaude: o.routeClaude === true,
    fallbackDirect: o.fallbackDirect === true,
    ...(models
      ? {
          models: {
            at: typeof models.at === "string" ? models.at : "",
            models: catalogRows(models.models),
          },
        }
      : {}),
  };
}

/** Whether a URL and a key are both stored. */
export function mainspringConfigured(record: MainspringRecord): boolean {
  return Boolean(record.url && record.keyRef);
}

/** Whether `pi/anthropic/*` turns go to Mainspring. */
export function mainspringRoutesClaude(record: MainspringRecord): boolean {
  return record.routeClaude && mainspringConfigured(record);
}

// ── URL ─────────────────────────────────────────────────────────────────

/** Where plain http is acceptable: a tailnet, private or loopback host. */
function isPrivateHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "");
  if (isIP(bare)) return isBlockedAddress(bare) && !isLinkLocal(bare);
  return isPrivateHostName(bare);
}

/** Link-local (cloud metadata) is never a Mainspring. */
function isLinkLocal(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  return /^169\.254\./.test(bare) || /^fe[89ab][0-9a-f]:/.test(bare);
}

/**
 * The panel's address, normalized to scheme, host, port and any path prefix,
 * without `/v1` or a trailing slash. https anywhere; http only for a tailnet,
 * private or loopback host, since the key travels in a header.
 */
export function validateMainspringUrl(
  input: string,
): { url: string } | { error: string } {
  const text = input.trim();
  if (!text) return { error: "url: enter Mainspring's address" };
  if (text.length > MAX_URL_LENGTH) return { error: "url: too long" };
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return { error: "url: not a URL, e.g. https://mainspring.example.test" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    return { error: "url: use https://" };
  if (parsed.username || parsed.password)
    return { error: "url: leave the key out of the address" };
  if (parsed.search || parsed.hash)
    return { error: "url: leave out the query and fragment" };
  if (!parsed.hostname) return { error: "url: no host" };
  if (isLinkLocal(parsed.hostname))
    return { error: "url: link-local addresses are not allowed" };
  if (parsed.protocol === "http:" && !isPrivateHost(parsed.hostname))
    return {
      error:
        "url: use https://. Plain http is only allowed for a tailnet or private address",
    };
  const path = parsed.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  return { url: `${parsed.origin}${path}` };
}

// ── Storage ─────────────────────────────────────────────────────────────

/** The record as the runner's synchronous checks read it. Fail-soft: an
 *  unreadable file reads as "not set up". */
export function readMainspringRecordSync(): MainspringRecord {
  try {
    const raw = readJsonFileShared<Record<string, unknown>>(configPath());
    return parseMainspringRecord(raw?.mainspring);
  } catch {
    return parseMainspringRecord(undefined);
  }
}

/** The raw file, async. Missing reads as `{}`; anything unparseable throws,
 *  so a write never replaces a file it couldn't read. */
async function readRawAsync(): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(configPath(), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const raw = JSON.parse(text);
  if (!obj(raw))
    throw new Error(
      `Cannot update ${configPath()}: existing content is not a JSON object`,
    );
  return raw as Record<string, unknown>;
}

export async function readMainspringRecord(): Promise<MainspringRecord> {
  return parseMainspringRecord((await readRawAsync()).mainspring);
}

let writeChain: Promise<unknown> = Promise.resolve();

/** Read-modify-write of the `mainspring` block on one promise chain; every
 *  other field of the file is kept as stored. */
function updateRecord(
  change: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<MainspringRecord> {
  const run = async () => {
    const raw = await readRawAsync();
    const next = change({ ...(obj(raw.mainspring) ?? {}) });
    raw.mainspring = next;
    const path = configPath();
    await writeJsonAtomicAsync(path, raw, true, 0o600);
    await chmod(path, 0o600);
    return parseMainspringRecord(next);
  };
  const next = writeChain.then(run, run);
  writeChain = next.catch(() => {});
  return next;
}

export function mainspringView(record: MainspringRecord): MainspringView {
  const rows = Object.values(record.models?.models ?? {});
  return {
    url: record.url ?? null,
    keySet: Boolean(record.keyRef),
    keyHint: record.keyRef && record.keyHint ? record.keyHint : null,
    routeClaude: record.routeClaude,
    fallbackDirect: record.fallbackDirect,
    models: rows
      .map((row) => ({
        id: row.id,
        ...(row.name ? { name: row.name } : {}),
        ...(row.contextWindow ? { contextWindow: row.contextWindow } : {}),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    modelsAt: record.models?.at || null,
  };
}

export async function getMainspringSettings(): Promise<MainspringView> {
  return mainspringView(await readMainspringRecord());
}

/** The PUT body, checked. Field-named errors (`key: …`) for the form. */
export function validateMainspringPatch(
  body: unknown,
): MainspringPatch | { error: string } {
  const o = obj(body);
  if (!o) return { error: "body: expected a JSON object" };
  const patch: MainspringPatch = {};
  if (o.url !== undefined) {
    if (typeof o.url !== "string") return { error: "url: must be a string" };
    const checked = validateMainspringUrl(o.url);
    if ("error" in checked) return checked;
    patch.url = checked.url;
  }
  if (o.key !== undefined) {
    if (typeof o.key !== "string") return { error: "key: must be a string" };
    // Pasted keys often carry line-wrap whitespace.
    const key = o.key.replace(/\s+/g, "");
    if (!key) return { error: "key: paste a key" };
    if (!key.startsWith(KEY_PREFIX))
      return { error: "key: a Mainspring key starts with sk-ms-" };
    if (key.length > MAX_KEY_LENGTH) return { error: "key: too long" };
    patch.key = key;
  }
  for (const field of ["routeClaude", "fallbackDirect"] as const) {
    if (o[field] === undefined) continue;
    if (typeof o[field] !== "boolean")
      return { error: `${field}: must be true or false` };
    patch[field] = o[field] as boolean;
  }
  return patch;
}

/**
 * Apply a checked patch. A new URL on a different host needs the key again,
 * so a stored key is never sent to an address it wasn't entered for.
 * Routing Claude through Mainspring needs both a URL and a key.
 */
export async function saveMainspringSettings(
  patch: MainspringPatch,
): Promise<MainspringResult> {
  const current = await readMainspringRecord();
  if (
    patch.url !== undefined &&
    current.url &&
    current.keyRef &&
    patch.key === undefined &&
    new URL(patch.url).host !== new URL(current.url).host
  )
    return {
      ok: false,
      status: 400,
      error: "key: paste the key again for the new address",
    };
  const url = patch.url ?? current.url;
  const keySet = patch.key !== undefined || Boolean(current.keyRef);
  if ((patch.routeClaude ?? current.routeClaude) && !(url && keySet))
    return {
      ok: false,
      status: 400,
      error: "routeClaude: add Mainspring's address and a key first",
    };
  let keyRef = current.keyRef;
  if (patch.key !== undefined)
    keyRef = await putWorkspaceSecretAsync(
      MAINSPRING_SECRET_PURPOSE,
      patch.key,
      current.keyRef,
    );
  const record = await updateRecord((raw) => {
    const next = { ...raw };
    if (patch.url !== undefined) {
      // The cached model list belongs to the old address.
      if (patch.url !== current.url) delete next.models;
      next.url = patch.url;
    }
    if (patch.key !== undefined && keyRef) {
      next.keyRef = keyRef;
      next.keyHint = patch.key.slice(-4);
    }
    if (patch.routeClaude !== undefined) next.routeClaude = patch.routeClaude;
    if (patch.fallbackDirect !== undefined)
      next.fallbackDirect = patch.fallbackDirect;
    return next;
  });
  return { ok: true, settings: mainspringView(record) };
}

/** Forget the key and turn routing off: without a key nothing can go to
 *  Mainspring, and turns must not keep trying. */
export async function removeMainspringKey(): Promise<MainspringView> {
  const current = await readMainspringRecord();
  if (current.keyRef) await deleteWorkspaceSecretAsync(current.keyRef);
  const record = await updateRecord((raw) => {
    const next = { ...raw };
    delete next.keyRef;
    delete next.keyHint;
    next.routeClaude = false;
    return next;
  });
  return mainspringView(record);
}

// ── Client ──────────────────────────────────────────────────────────────

/** The URL and the resolved key, or null when either is missing. */
export async function mainspringConfig(
  record?: MainspringRecord,
): Promise<MainspringConfig | null> {
  const r = record ?? (await readMainspringRecord());
  if (!r.url || !r.keyRef) return null;
  const key = await resolveWorkspaceSecretAsync(r.keyRef);
  return key ? { baseUrl: r.url, key } : null;
}

/** `<base>/v1/<path>` for a path like `/v1/models` or `models`. */
export function mainspringUrl(baseUrl: string, path: string): string {
  const tail = path.replace(/^\/+/, "").replace(/^v1\//, "");
  return `${baseUrl}/v1/${tail}`;
}

/**
 * An authorized request to Mainspring (`Authorization: Bearer sk-ms-…`).
 * Throws when Mainspring is not set up. The key goes only in the header.
 */
export async function mainspringFetch(
  path: string,
  init: RequestInit = {},
  options: { config?: MainspringConfig; timeoutMs?: number } = {},
): Promise<Response> {
  const config = options.config ?? (await mainspringConfig());
  if (!config) throw new Error("Mainspring is not set up");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${config.key}`);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  return deps.fetch(
    mainspringUrl(config.baseUrl, path),
    { ...init, headers },
    options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
  );
}

/** What a failed Test says, in the owner's words. Never the response body:
 *  the address is the owner's, but nothing upstream is echoed back. */
function testFailure(status: number): string {
  if (status === 401) return "Mainspring key was refused";
  if (status === 403) return "This key isn't allowed to list models";
  if (status === 404)
    return "Mainspring didn't answer /v1/models at that address";
  return `Mainspring answered ${status}`;
}

/**
 * Test the saved settings with `GET /v1/models`. On success the list is
 * cached for the picker and the runner.
 */
export async function testMainspring(): Promise<
  | { ok: true; models: number; settings: MainspringView }
  | { ok: false; error: string }
> {
  const record = await readMainspringRecord();
  if (!record.url)
    return { ok: false, error: "Add Mainspring's address first" };
  const config = await mainspringConfig(record);
  if (!config) return { ok: false, error: "Paste a key first" };
  let response: Response;
  try {
    response = await mainspringFetch(
      "/v1/models",
      {},
      { config, timeoutMs: TEST_TIMEOUT_MS },
    );
  } catch {
    return {
      ok: false,
      error: `Couldn't reach Mainspring at ${config.baseUrl}`,
    };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return { ok: false, error: testFailure(response.status) };
  }
  const body = await response.json().catch(() => undefined);
  const models = catalogRows(body);
  if (!Object.keys(models).length)
    return { ok: false, error: "Mainspring listed no models" };
  const saved = await updateRecord((raw) =>
    // A URL changed while the request ran: the list belongs to the old one.
    raw.url !== config.baseUrl
      ? raw
      : {
          ...raw,
          models: { at: new Date(deps.now()).toISOString(), models },
        },
  );
  return {
    ok: true,
    models: Object.keys(models).length,
    settings: mainspringView(saved),
  };
}

/** The cached catalog row for a model Mainspring serves, if any. */
export function mainspringCatalogModel(
  modelID: string,
  record: MainspringRecord = readMainspringRecordSync(),
): ProviderCatalogModel | undefined {
  const rows = record.models?.models;
  if (!rows) return undefined;
  return (
    rows[modelID] ??
    Object.values(rows).find(
      (row) => row.id.toLowerCase() === modelID.toLowerCase(),
    )
  );
}

/** Picker ids for the cached models. While Claude is routed through
 *  Mainspring, Claude models already appear as `pi/anthropic/*`. */
export function mainspringPickerModels(
  record: MainspringRecord = readMainspringRecordSync(),
): string[] {
  if (!mainspringConfigured(record)) return [];
  return Object.keys(record.models?.models ?? {})
    .filter((id) => !(record.routeClaude && isClaudeModelId(id)))
    .sort()
    .map((id) => `pi/${MAINSPRING_PROVIDER}/${id}`);
}

/** Claude model ids go to Mainspring's Anthropic Messages endpoint. */
export function isClaudeModelId(modelID: string): boolean {
  return /^claude-/i.test(modelID);
}

// ── Responses and failures ──────────────────────────────────────────────

/** One limit window from `X-Mainspring-Limits`. */
export interface MainspringLimit {
  label: string;
  left?: number;
  resetsAt?: number;
}

/** What the latest response from Mainspring said. */
export interface MainspringResponseSnapshot {
  httpStatus: number;
  /** From `Retry-After`, when it lies ahead (at most 14 days). */
  resetAt?: number;
  /** `X-Mainspring-Account`: which account served the request. */
  account?: string;
  /** `X-Mainspring-Provider`. */
  provider?: string;
  /** `X-Mainspring-Limits`, parsed. */
  limits?: MainspringLimit[];
  /** `X-Mainspring-Moved-From` / `-Moved-Reason`. */
  movedFrom?: string;
  movedReason?: string;
}

const MAX_RESET_AHEAD_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_HEADER_TEXT = 200;

type HeaderSource = Headers | Record<string, string | undefined>;

function header(headers: HeaderSource, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  for (const [key, value] of Object.entries(headers))
    if (key.toLowerCase() === name) return value;
  return undefined;
}

const clip = (value: string | undefined) => {
  const text = value?.trim();
  return text ? text.slice(0, MAX_HEADER_TEXT) : undefined;
};

/** `Retry-After`: seconds or an HTTP date, as epoch ms. */
export function parseRetryAfter(
  value: string | undefined,
  now: number,
): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  const at = /^\d+(?:\.\d+)?$/.test(text)
    ? now + Number(text) * 1000
    : Date.parse(text);
  return Number.isFinite(at) && at > now && at - now <= MAX_RESET_AHEAD_MS
    ? at
    : undefined;
}

function parseLimits(value: string | undefined): MainspringLimit[] | undefined {
  if (!value) return undefined;
  try {
    const raw = JSON.parse(value);
    if (!Array.isArray(raw)) return undefined;
    const limits = raw
      .map((row) => obj(row))
      .filter((row): row is Record<string, unknown> => !!row)
      .filter((row) => typeof row.label === "string")
      .slice(0, 10)
      .map((row) => ({
        label: String(row.label).slice(0, 40),
        ...(typeof row.left === "number" ? { left: row.left } : {}),
        ...(typeof row.resets_at === "number"
          ? { resetsAt: row.resets_at }
          : {}),
      }));
    return limits.length ? limits : undefined;
  } catch {
    return undefined;
  }
}

/** Read Mainspring's headers off one response. */
export function readMainspringResponse(
  httpStatus: number,
  headers: HeaderSource,
  now: number = Date.now(),
): MainspringResponseSnapshot {
  const resetAt = parseRetryAfter(header(headers, "retry-after"), now);
  const account = clip(header(headers, "x-mainspring-account"));
  const provider = clip(header(headers, "x-mainspring-provider"));
  const limits = parseLimits(header(headers, "x-mainspring-limits"));
  const movedFrom = clip(header(headers, "x-mainspring-moved-from"));
  const movedReason = clip(header(headers, "x-mainspring-moved-reason"));
  return {
    httpStatus,
    ...(resetAt !== undefined ? { resetAt } : {}),
    ...(account ? { account } : {}),
    ...(provider ? { provider } : {}),
    ...(limits ? { limits } : {}),
    ...(movedFrom ? { movedFrom } : {}),
    ...(movedReason ? { movedReason } : {}),
  };
}

/** How a request to Mainspring failed, when it is one we name. */
export type MainspringFailure =
  /** 429: every account of the provider is resting. */
  | { kind: "resting"; resetAt?: number }
  /** 429: the key's daily token cap is used up. */
  | { kind: "cap"; resetAt?: number }
  /** 401: no key, or a revoked one. */
  | { kind: "refused" }
  /** 502/503: the provider failed, or no account of it is connected. */
  | { kind: "unavailable"; status: number };

/** The HTTP status an error message leads with ("429 {…}"), if any. */
function leadingStatus(message: string): number | undefined {
  const m = /^\s*(?:pi:\s*)?(\d{3})\b/.exec(message);
  return m ? Number(m[1]) : undefined;
}

/**
 * Classify a failed request. The status comes from the captured response
 * when the latest one failed, else from the error text (pi formats provider
 * errors as `<status> <body>`). Anything else is not Mainspring's to name.
 */
export function classifyMainspringFailure(
  message: string,
  snapshot?: MainspringResponseSnapshot,
): MainspringFailure | null {
  const captured =
    snapshot && snapshot.httpStatus >= 400 ? snapshot.httpStatus : undefined;
  const status =
    captured ??
    leadingStatus(message) ??
    (/rate_limit_error|rate_limit_exceeded/.test(message)
      ? 429
      : /authentication_error|invalid api key/i.test(message)
        ? 401
        : undefined);
  if (status === 429) {
    const resetAt = captured === 429 ? snapshot?.resetAt : undefined;
    return /daily (?:token )?cap/i.test(message)
      ? { kind: "cap", ...(resetAt ? { resetAt } : {}) }
      : { kind: "resting", ...(resetAt ? { resetAt } : {}) };
  }
  if (status === 401) return { kind: "refused" };
  if (status === 502 || status === 503) return { kind: "unavailable", status };
  return null;
}

/** The person-facing text for a classified failure. The resting copy keeps
 *  Claude's reset format, which describeUsageLimitReset reads back. */
export function mainspringFailureText(
  failure: MainspringFailure,
  modelID: string,
): string {
  const until = (resetAt: number | undefined) =>
    resetAt !== undefined ? ` until ${formatAnthropicReset(resetAt)}` : "";
  switch (failure.kind) {
    case "resting":
      return isClaudeModelId(modelID)
        ? `Every Claude account in Mainspring is resting${until(failure.resetAt)}.`
        : `Every account in Mainspring that serves ${modelID} is resting${until(failure.resetAt)}.`;
    case "cap":
      return `This Mainspring key's daily token cap is used up${until(failure.resetAt)}.`;
    case "refused":
      return "Mainspring key was refused. Paste a new key under Settings, Providers, Mainspring.";
    case "unavailable":
      return `Mainspring is unavailable (${failure.status}): the provider failed or no account of it is connected. Retry in a minute.`;
  }
}
