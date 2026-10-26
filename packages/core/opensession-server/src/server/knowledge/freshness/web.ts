/**
 * The web signal of knowledge freshness: a page's readable text and a hash
 * of it. An item that depends on `url:<page>` goes stale when the page's
 * hash no longer matches the one recorded in its sources.
 *
 * Pages are fetched with the pinned fetcher (web-fetch.ts fetchChecked:
 * private addresses refused on every hop), over https only, and only from
 * an exact, non-wildcard host of the project's Support websites, the rule
 * an automatic reply's links follow (support/policy.ts linkAllowed). The
 * host is checked before the first request and on every redirect hop
 * before its name is resolved and again before it is dialled (with the
 * scheme), so a listed page can't lead the crawler anywhere else.
 *
 * The text that is hashed is NFC-normalised and leaves out what changes
 * without the content changing (`<header>`, `<time>`, besides what
 * htmlToText drops). A page with under 200 characters of readable text (a
 * script shell, a loading screen) or over 256 KB of it is an error, not a
 * hash. Nothing runs at import.
 */

import { createHash } from "node:crypto";
import { linkAllowed } from "../../support/policy";
import {
  fetchChecked,
  htmlToText,
  isBlockedAddress,
  pinnedRequest,
  type WebFetchDeps,
} from "../../web-fetch";
import { resolveWithDns } from "../../shared/pinned-fetch";

const TEXT_TYPES =
  /^(text\/(plain|markdown|x-markdown)|application\/(xhtml\+xml))\b/i;
const HTML_TYPES = /\b(html|xhtml)\b/i;
/** Elements that churn without the page's content changing. */
const CHURN = "header, time";
/** Less readable text than this is no page to hash. */
const MIN_TEXT_CHARS = 200;
const MAX_TEXT_BYTES = 256 * 1024;

async function withoutChurn(html: string): Promise<string> {
  return new HTMLRewriter()
    .on(CHURN, { element: (e) => void e.remove() })
    .transform(new Response(html))
    .text();
}

/** A page's readable text: HTML through htmlToText (without `<header>`
 *  and `<time>`), plain text and Markdown as they are; NFC-normalised,
 *  lines trimmed, runs of blank lines folded. */
export async function normalizedPageText(
  html: string,
  contentType: string,
): Promise<{ title?: string; text: string }> {
  let title: string | undefined;
  let text = html;
  if (HTML_TYPES.test(contentType)) {
    const extracted = await htmlToText(await withoutChurn(html));
    title =
      extracted.title?.normalize("NFC").replace(/\s+/g, " ").trim() ||
      undefined;
    text = extracted.text;
  }
  const lines = text
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v\u00a0]+/g, " ").trim());
  const folded = lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return title ? { title, text: folded } : { text: folded };
}

/** sha256 (hex) of the text with every whitespace run collapsed, so a
 *  reflowed page hashes the same and a changed word does not. */
export function pageHash(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return createHash("sha256").update(collapsed).digest("hex");
}

const defaultDeps: WebFetchDeps = {
  resolve: resolveWithDns,
  isBlocked: isBlockedAddress,
  request: pinnedRequest,
};

/** The URL with its fragment dropped: a fragment never reaches the server. */
function withoutHash(raw: string): string | null {
  try {
    const url = new URL(raw);
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/** The lowercased host names (no port) of the exact entries in `hosts`. */
function hostNames(hosts: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const entry of hosts) {
    const e = entry.trim().toLowerCase();
    if (!e || e.startsWith("*.")) continue;
    const host = /^(.+?)(?::\d+)?$/.exec(e)?.[1]?.replace(/\.+$/, "");
    if (host) names.add(host);
  }
  return names;
}

/** https, and on one of `hosts` by linkAllowed's exact-host rule. */
function allowed(raw: string, hosts: readonly string[]): boolean {
  try {
    if (new URL(raw).protocol !== "https:") return false;
  } catch {
    return false;
  }
  return linkAllowed(raw, hosts);
}

/** One response of the project's websites, read as it came. */
export interface RawResponse {
  /** The final URL, after redirects. */
  url: string;
  status: number;
  contentType: string;
  body: Uint8Array;
}

/**
 * One request to the project's websites, with web.ts's host rule on every
 * hop: https and an exact, non-wildcard entry of `hosts`, checked before
 * the name is resolved and again before it is dialled. Any refusal or
 * network failure comes back as `{ error }`; every status is an answer.
 * fetchPage reads pages through it; the crawler reads robots.txt,
 * sitemaps and a page's links through it. `signal` aborts the request
 * (it then comes back as `{ error }` like any failure).
 */
export async function fetchRaw(
  url: string,
  hosts: string[],
  deps: WebFetchDeps = defaultDeps,
  signal?: AbortSignal,
): Promise<RawResponse | { error: string }> {
  const start = withoutHash(url);
  if (!start || !allowed(start, hosts))
    return {
      error: `Not an https page of the project's websites: ${url.slice(0, 200)}`,
    };
  // Every hop, the first included, passes the host rule before its name
  // is resolved, and the full rule (scheme, host, port) before it is
  // dialled; fetchChecked address-checks it as usual.
  const names = hostNames(hosts);
  const guarded: WebFetchDeps = {
    ...deps,
    resolve: (hostname) => {
      if (!names.has(hostname.toLowerCase().replace(/\.+$/, "")))
        throw new Error(`Redirected off the project's websites: ${hostname}`);
      return deps.resolve(hostname);
    },
    request: (target, signal, inner) => {
      if (!allowed(withoutHash(target.url.toString()) ?? "", hosts))
        throw new Error(
          `Redirected off the project's https websites: ${target.url.protocol}//${target.url.host}`,
        );
      return deps.request(target, signal, inner);
    },
  };
  try {
    const { response, finalUrl } = await fetchChecked(start, signal, guarded);
    if (!allowed(finalUrl, hosts))
      return { error: `Redirected off the project's websites: ${finalUrl}` };
    return {
      url: finalUrl,
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      body: response.body,
    };
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message : "The page couldn't be read",
    };
  }
}

/** A fetched response as a page: its text and hash, or `{ error }` for an
 *  error status, a non-text body, too little or too much text. */
export async function pageOf(
  raw: RawResponse,
): Promise<
  | { url: string; title?: string; text: string; hash: string }
  | { error: string }
> {
  if (raw.status < 200 || raw.status >= 300)
    return { error: `The page answered ${raw.status}` };
  const contentType = raw.contentType;
  if (!HTML_TYPES.test(contentType) && !TEXT_TYPES.test(contentType))
    return {
      error: `Not a text page: ${contentType.split(";")[0] || "unknown type"}`,
    };
  const body = new TextDecoder("utf-8", { fatal: false }).decode(raw.body);
  const page = await normalizedPageText(body, contentType);
  if (Buffer.byteLength(page.text) > MAX_TEXT_BYTES)
    return { error: "The page has more than 256 KB of text" };
  if (page.text.length < MIN_TEXT_CHARS)
    return { error: "The page has almost no readable text" };
  return {
    url: raw.url,
    ...(page.title ? { title: page.title } : {}),
    text: page.text,
    hash: pageHash(page.text),
  };
}

/**
 * Fetch one page of the project's websites and return its text and hash.
 * `hosts` is the project's Support websites list; only exact, non-wildcard
 * entries count. Any refusal, error status, non-text body or network
 * failure comes back as `{ error }`.
 */
export async function fetchPage(
  url: string,
  hosts: string[],
  deps: WebFetchDeps = defaultDeps,
): Promise<
  | { url: string; title?: string; text: string; hash: string }
  | { error: string }
> {
  const raw = await fetchRaw(url, hosts, deps);
  if ("error" in raw) return raw;
  try {
    return await pageOf(raw);
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message : "The page couldn't be read",
    };
  }
}

/** Whether fetchPage would try `url` at all (the crawler filters sitemap
 *  entries with it). https only; query strings are refused, as in a
 *  reply's links. */
export function crawlable(url: string, hosts: string[]): boolean {
  const plain = withoutHash(url);
  return !!plain && allowed(plain, hosts);
}
