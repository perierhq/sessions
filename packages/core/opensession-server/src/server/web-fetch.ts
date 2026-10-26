/**
 * Web fetching for agents: read a page without pouring it into the transcript.
 *
 * The shape matters more than the plumbing. A naive fetch tool returns the
 * whole page as its tool result, so an 80k-token doc page is in context for
 * the rest of the session whether or not the one paragraph you wanted was on
 * it. Here a fetch returns a bounded HEAD plus a HANDLE, the full body goes to
 * disk, and `readFetched` pulls the rest by search or explicit offset. The
 * model decides how much of a page it pays for.
 *
 * Deliberately NOT a search tool. There is no provider, no API key and no
 * ranking: this turns a URL you already have into text you can read. Search
 * belongs to whatever MCP server an instance chooses to mount.
 *
 * Safety: every hop is checked against private address space before it is
 * dialled, redirects included (an allowed hostname can redirect to
 * 169.254.169.254 or into a tailnet, so checking only the first URL is not a
 * check at all). Each hop resolves its host once, checks every address, and
 * connects only to those checked addresses, so a DNS answer that changes
 * between the check and the connect cannot move the request. Blocked:
 * loopback, RFC1918, link-local and cloud metadata, CGNAT/tailnet 100.64/10,
 * IETF-reserved 192.0.0/24 and benchmarking 198.18/15, unique-local IPv6,
 * multicast, IPv4-compatible ::/96, Teredo, IPv6 forms that embed one of
 * those IPv4 addresses, and the reserved *.localhost/*.internal/*.home.arpa
 * names. Requests connect directly and ignore HTTP(S)_PROXY: a proxy would
 * resolve the name again and undo the pin.
 * There is no allowlist to bypass it, because the caller is a model reading
 * untrusted text.
 *
 * The cache is scratch, not a store: entries expire in an hour and the
 * directory is capped, so a handle is good for the conversation that made it
 * and nothing is expected to survive a restart.
 */
import { createHash } from "crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "fs";
import { stateDir } from "./paths";
import { writeFileAtomic, writeJsonAtomic } from "./shared/atomic-write";
import { isBlockedAddress } from "./shared/network-address";
import {
  decodeBody as decodeWithin,
  type FetchTarget,
  nodeTransport,
  type PinnedTransport,
  pinnedHttpRequest,
  type ResolveHost,
  resolvePinnedTarget,
  resolveWithDns,
  untilAborted,
} from "./shared/pinned-fetch";

export { isBlockedAddress } from "./shared/network-address";
export {
  type FetchTarget,
  type PinnedTransport,
  pinnedLookup,
  type ResolveHost,
  untilAborted,
} from "./shared/pinned-fetch";

export const MAX_REDIRECTS = 5;
export const FETCH_TIMEOUT_MS = 30_000;
/** Refuse a body larger than this rather than filling the disk. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Default head returned inline; the rest waits behind the handle. */
export const DEFAULT_HEAD_CHARS = 4_000;
export const MAX_HEAD_CHARS = 40_000;
/** Cache lifetime and caps — this is scratch, not a store. */
export const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 128;
const CACHE_MAX_BYTES = 128 * 1024 * 1024;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export interface FetchedPage {
  /** Handle for readFetched. */
  handle: string;
  url: string;
  /** Where the redirect chain ended, when it moved. */
  finalUrl: string;
  status: number;
  contentType: string;
  title?: string;
  /** Total characters stored. */
  chars: number;
  /** The leading slice, inline in the tool result. */
  head: string;
  /** True when `head` is shorter than the stored body. */
  truncated: boolean;
}

export interface FetchedSlice {
  handle: string;
  url: string;
  chars: number;
  /** Character offset this slice starts at, for a plain read. */
  offset?: number;
  text: string;
  /** Set for a search: how many times the needle occurs in the whole body. */
  matches?: number;
  truncated: boolean;
}

// ── Address safety ──────────────────────────────────────────────────────────

export interface FetchedResponse {
  status: number;
  headers: Headers;
  /** Decoded body bytes; empty for a redirect that was not read. */
  body: Uint8Array;
}

/** The seams of a fetch. Production uses the defaults; tests inject a
 *  resolver and a transport so no test depends on real DNS. */
export interface WebFetchDeps {
  resolve: ResolveHost;
  isBlocked: (address: string) => boolean;
  request: (
    target: FetchTarget,
    signal: AbortSignal,
    deps: WebFetchDeps,
  ) => Promise<FetchedResponse>;
}

/** Parse, resolve, and prove every resolved address is public. Throws
 *  otherwise. The returned addresses are the ones the request must dial. */
export async function resolveFetchTarget(
  raw: string,
  deps: Pick<WebFetchDeps, "resolve" | "isBlocked"> = defaultDeps,
): Promise<FetchTarget> {
  return resolvePinnedTarget(raw, deps);
}

/** Parse, then prove every resolved address is public. Throws otherwise.
 *  A check only: a caller that then dials the URL itself resolves it again.
 *  Use `fetchWeb`, or `pinnedFetch` from shared/pinned-fetch, to fetch with
 *  the checked address pinned. */
export async function assertFetchableUrl(raw: string): Promise<URL> {
  return (await resolveFetchTarget(raw)).url;
}

// ── HTML → text ─────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "-",
  ndash: "-",
  hellip: "...",
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Elements whose content is chrome or code, never the page's prose. */
const DROP =
  "script, style, noscript, svg, canvas, iframe, object, embed, template, nav, footer, aside, form, button, select";
/** Elements that end a line of prose. */
const BLOCK =
  "p, div, section, article, main, li, tr, br, pre, blockquote, figcaption, dt, dd, h1, h2, h3, h4, h5, h6";

/**
 * Readable text from HTML, using Bun's streaming HTMLRewriter — no DOM, no
 * dependency. Not readability-grade (it does not score candidate article
 * nodes), just chrome dropped and block structure preserved as newlines.
 */
export async function htmlToText(
  html: string,
): Promise<{ title?: string; text: string }> {
  let title = "";
  const stripped = await new HTMLRewriter()
    .on("title", { text: (t) => void (title += t.text) })
    .on(DROP, { element: (e) => void e.remove() })
    .on(BLOCK, { element: (e) => void e.before("\n", { html: true }) })
    .on("h1, h2, h3, h4, h5, h6", {
      element: (e) => void e.after("\n", { html: true }),
    })
    .transform(new Response(html))
    .text();
  // `[^<>]`, not `[^>]`: a run of `<` without a `>` would make each `<`
  // scan to the end of the page (quadratic).
  const text = decodeEntities(stripped.replace(/<[^<>]*>/g, ""))
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title: title.trim() || undefined, text };
}

// ── Cache ───────────────────────────────────────────────────────────────────

interface CacheMeta {
  handle: string;
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  title?: string;
  chars: number;
  at: number;
}

function cacheDir(): string {
  const dir = stateDir("web-cache");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  return dir;
}

function handleFor(url: string): string {
  return `web_${createHash("sha256").update(url).digest("hex").slice(0, 16)}`;
}

/** Drop expired entries, then oldest-first until under the caps. */
function sweepCache(now = Date.now()): void {
  try {
    const dir = cacheDir();
    const entries: Array<{ base: string; at: number; bytes: number }> = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      const base = file.slice(0, -".json".length);
      try {
        const stat = statSync(`${dir}/${file}`);
        const body = `${dir}/${base}.txt`;
        const bytes = stat.size + (existsSync(body) ? statSync(body).size : 0);
        entries.push({ base, at: stat.mtimeMs, bytes });
      } catch {}
    }
    const drop = (base: string) => {
      rmSync(`${dir}/${base}.json`, { force: true });
      rmSync(`${dir}/${base}.txt`, { force: true });
    };
    const live = entries.filter((e) => {
      if (now - e.at > CACHE_TTL_MS) {
        drop(e.base);
        return false;
      }
      return true;
    });
    live.sort((a, b) => a.at - b.at); // oldest first
    let count = live.length;
    let bytes = live.reduce((sum, e) => sum + e.bytes, 0);
    for (const entry of live) {
      if (count <= CACHE_MAX_ENTRIES && bytes <= CACHE_MAX_BYTES) break;
      drop(entry.base);
      count -= 1;
      bytes -= entry.bytes;
    }
  } catch {}
}

function storePage(meta: CacheMeta, body: string): void {
  const dir = cacheDir();
  writeFileAtomic(`${dir}/${meta.handle}.txt`, body, FILE_MODE);
  writeJsonAtomic(`${dir}/${meta.handle}.json`, meta, true, FILE_MODE);
  sweepCache();
}

function loadPage(
  handle: string,
): { meta: CacheMeta; body: string } | undefined {
  try {
    const dir = cacheDir();
    const metaPath = `${dir}/${handle}.json`;
    const bodyPath = `${dir}/${handle}.txt`;
    if (!existsSync(metaPath) || !existsSync(bodyPath)) return undefined;
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as CacheMeta;
    if (Date.now() - meta.at > CACHE_TTL_MS) return undefined;
    return { meta, body: readFileSync(bodyPath, "utf8") };
  } catch {
    return undefined;
  }
}

// ── Fetch ───────────────────────────────────────────────────────────────────

const UA =
  "Mozilla/5.0 (compatible; OpenSession/1.0; +https://github.com/perierhq/sessions)";

/** Undo a content-encoding within the body limit. Exported for tests. */
export function decodeBody(url: URL, encoding: string, body: Buffer): Buffer {
  return decodeWithin(url, encoding, body, MAX_BODY_BYTES);
}

/** One GET over node:http(s), dialling only the target's checked addresses
 *  (see shared/pinned-fetch). */
export function pinnedRequest(
  target: FetchTarget,
  signal: AbortSignal,
  deps: Pick<WebFetchDeps, "isBlocked">,
  transport: PinnedTransport = nodeTransport,
): Promise<FetchedResponse> {
  return pinnedHttpRequest(
    target,
    {
      method: "GET",
      headers: {
        "user-agent": UA,
        accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5",
        "accept-encoding": "gzip, deflate, br",
      },
      signal,
      maxBodyBytes: MAX_BODY_BYTES,
    },
    deps.isBlocked,
    transport,
  );
}

const defaultDeps: WebFetchDeps = {
  resolve: resolveWithDns,
  isBlocked: isBlockedAddress,
  request: pinnedRequest,
};

/** Follow redirects by hand so every hop is resolved, address-checked and
 *  dialled at the checked address, not just the first. Returns the final
 *  response and the URL it came from. One deadline covers the whole chain,
 *  DNS included, so redirects cannot stretch a fetch past it. */
export async function fetchChecked(
  raw: string,
  signal?: AbortSignal,
  deps: WebFetchDeps = defaultDeps,
): Promise<{ response: FetchedResponse; finalUrl: string }> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let target = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const checked = await untilAborted(
      resolveFetchTarget(target, deps),
      deadline,
    );
    const { url } = checked;
    const response = await deps.request(checked, deadline, deps);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return { response, finalUrl: url.toString() };
      target = new URL(location, url).toString();
      continue;
    }
    return { response, finalUrl: url.toString() };
  }
  throw new Error(
    `Too many redirects (more than ${MAX_REDIRECTS}) from ${raw}`,
  );
}

export interface FetchWebOptions {
  /** "text" (default) extracts readable text from HTML; "raw" keeps the
   *  body verbatim, for JSON, plain text or reading markup itself. */
  mode?: "text" | "raw";
  headChars?: number;
  /** Re-fetch even when a live cache entry exists. */
  refresh?: boolean;
  signal?: AbortSignal;
}

/**
 * Fetch a URL, store the body, and return a bounded head plus a handle.
 * Re-fetching the same URL inside the cache TTL is served from disk.
 */
export async function fetchWeb(
  raw: string,
  opts: FetchWebOptions = {},
  deps: WebFetchDeps = defaultDeps,
): Promise<FetchedPage> {
  const headChars = Math.max(
    200,
    Math.min(MAX_HEAD_CHARS, opts.headChars ?? DEFAULT_HEAD_CHARS),
  );
  const handle = handleFor(raw);
  const cached = opts.refresh ? undefined : loadPage(handle);
  if (cached) return page(cached.meta, cached.body, headChars);

  const { response, finalUrl } = await fetchChecked(raw, opts.signal, deps);
  const contentType = response.headers.get("content-type") ?? "";
  const raw_body = new TextDecoder("utf-8", { fatal: false }).decode(
    response.body,
  );

  let title: string | undefined;
  let body = raw_body;
  if (opts.mode !== "raw" && /html/i.test(contentType)) {
    const extracted = await htmlToText(raw_body);
    title = extracted.title;
    body = extracted.text;
  }
  const meta: CacheMeta = {
    handle,
    url: raw,
    finalUrl,
    status: response.status,
    contentType,
    title,
    chars: body.length,
    at: Date.now(),
  };
  storePage(meta, body);
  return page(meta, body, headChars);
}

function page(meta: CacheMeta, body: string, headChars: number): FetchedPage {
  return {
    handle: meta.handle,
    url: meta.url,
    finalUrl: meta.finalUrl,
    status: meta.status,
    contentType: meta.contentType,
    title: meta.title,
    chars: body.length,
    head: body.slice(0, headChars),
    truncated: body.length > headChars,
  };
}

export interface ReadFetchedOptions {
  /** Return passages around this needle instead of a positional slice. */
  find?: string;
  caseSensitive?: boolean;
  /** Characters of context each side of a match. Default 500. */
  context?: number;
  offset?: number;
  limit?: number;
}

/** Read more of a fetched page: by search (`find`) or by offset. */
export function readFetched(
  handle: string,
  opts: ReadFetchedOptions = {},
): FetchedSlice {
  const loaded = loadPage(handle);
  if (!loaded) {
    throw new Error(
      `No fetched page for handle "${handle}" — it expired (entries live one hour) or was never fetched. Fetch the URL again.`,
    );
  }
  const { meta, body } = loaded;
  const limit = Math.max(200, Math.min(MAX_HEAD_CHARS, opts.limit ?? 20_000));

  if (opts.find) {
    const needle = opts.caseSensitive ? opts.find : opts.find.toLowerCase();
    const haystack = opts.caseSensitive ? body : body.toLowerCase();
    const context = Math.max(0, Math.min(4_000, opts.context ?? 500));
    const passages: string[] = [];
    let matches = 0;
    let at = haystack.indexOf(needle);
    let used = 0;
    while (at !== -1) {
      matches += 1;
      if (used < limit) {
        const start = Math.max(0, at - context);
        const end = Math.min(body.length, at + needle.length + context);
        const passage = `${start > 0 ? "…" : ""}${body.slice(start, end)}${end < body.length ? "…" : ""}`;
        passages.push(passage);
        used += passage.length;
      }
      at = haystack.indexOf(needle, at + needle.length);
    }
    return {
      handle,
      url: meta.url,
      chars: body.length,
      matches,
      text: passages.length
        ? passages.join("\n\n---\n\n")
        : `No match for ${JSON.stringify(opts.find)} in ${body.length} characters.`,
      truncated: used >= limit,
    };
  }

  const offset = Math.max(0, Math.min(body.length, opts.offset ?? 0));
  const text = body.slice(offset, offset + limit);
  return {
    handle,
    url: meta.url,
    chars: body.length,
    offset,
    text,
    truncated: offset + text.length < body.length,
  };
}
