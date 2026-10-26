/**
 * The website import: the project's support websites as trusted knowledge
 * mirrors, one `sources/web/<host>/<slug>.md` item per page.
 *
 * Only exact, non-wildcard hosts of the project's Support websites are
 * crawled, over https, through web.ts fetchRaw (pinned, private addresses
 * refused, the host rule checked on every redirect hop). Per host:
 * `robots.txt` first (its `Disallow`/`Allow` rules for `*` are honoured; a
 * robots.txt that can't be read skips the host), then `/sitemap.xml` with
 * nested sitemap indexes to depth 2; a host without a sitemap is walked
 * from `/` following same-host links to depth 3. Pages the project already
 * mirrors are fetched again too, so a page dropped from the sitemap that
 * now answers 404 or 410 is noticed. At most `maxPages` pages per run
 * (default 200), one request per second per host.
 *
 * A page is mirrored as web.ts reads it (fetchPage's text and hash, so
 * B2's re-validation hashes it the same way): `trust: trusted`,
 * `sources: url:<url>#sha256=<hash>`, `dependsOn: url:<url>`, `validAsOf`
 * today. An unchanged hash is left alone (a rerun makes no commit); a page
 * gone (404, 410) retires its mirror, text kept. Text is stored as read,
 * never redacted: a page that looks like it holds a credential, or is too
 * large, is skipped and counted. One commit per run, authored by Pat.
 *
 * Reuses web.ts (fetchRaw, pageOf, crawlable), jobs.ts, B2's frontMatterOf
 * and PAT author and trailer, the repo import's write-and-retry shape.
 * Nothing runs at import.
 */
import type {
  KnowledgeFrontMatter,
  KnowledgeImportJob,
  KnowledgeItem,
} from "../../../shared/knowledge";
import type { Author } from "../../memory-repo/git-store";
import { MemoryRepoError } from "../../memory-repo/git-store";
import { findSecrets } from "../../memory-repo/secrets";
import { knowledgeRepo } from "../client";
import {
  frontMatterOf,
  PAT_AUTHOR,
  PAT_TRAILER,
} from "../freshness/revalidate";
import {
  crawlable,
  fetchRaw,
  pageOf,
  type RawResponse,
} from "../freshness/web";
import { knowledgeRepoName, webItemPath } from "../layout";
import type { KnowledgeChange } from "../service";
import { MAX_ARTICLE_BYTES } from "../validate";
import { startJob } from "./jobs";

export const DEFAULT_MAX_PAGES = 200;
export const MAX_PAGES_LIMIT = 1000;
/** One request per this many milliseconds per host. */
export const HOST_INTERVAL_MS = 1000;
/** Nested sitemap indexes followed below /sitemap.xml. */
const SITEMAP_DEPTH = 2;
/** Sitemap files read per host at most. */
const MAX_SITEMAPS = 20;
/** Links followed from `/` without a sitemap. */
const LINK_DEPTH = 3;
const BODY_BYTES = MAX_ARTICLE_BYTES - 4096;
const LIST_PAGE = 200;
const WRITE_ATTEMPTS = 3;
const PROGRESS_EVERY = 10;

export const NO_WEBSITES_COPY =
  "Add the project's support website under Support websites first.";

export interface CrawledPage {
  url: string;
  title?: string;
  text: string;
  hash: string;
}

export interface CrawlDeps {
  /** One request through the host rule (web.ts fetchRaw). */
  fetchRaw(
    url: string,
    hosts: string[],
  ): Promise<RawResponse | { error: string }>;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Pages fetched per run, across hosts. */
  maxPages: number;
  /** URLs mirrored before: fetched again (after what the host lists) so a
   *  page gone from the sitemap is noticed. */
  known: string[];
  /** A page that is no page: `gone` for 404 and 410. */
  onMiss?(url: string, error: string, gone: boolean): void;
  /** Called once when maxPages (or the sitemap cap) left pages out. */
  onTruncated?(): void;
  /** Aborted: the crawl throws before its next request. */
  signal?: AbortSignal;
}

export interface WebsiteDeps {
  /** YYYY-MM-DD, UTC. */
  today(): string;
  /** The project's Support websites (roleWebAccess). */
  hosts(project: string): Promise<string[]>;
  crawl: Partial<CrawlDeps>;
  /** Called every few pages with the pages handled so far. */
  onProgress?(handled: number): Promise<void> | void;
}

export interface WebsiteResult {
  /** Pages fetched (readable or not). */
  pages: number;
  /** maxPages left pages out. */
  truncated: boolean;
  /** Pages written (new or changed). */
  written: number;
  /** Mirrors retired because their page is gone. */
  retired: number;
  /** Pages left out: unreadable, a credential, too large. */
  skipped: number;
}

function bindCrawl(over: Partial<CrawlDeps>): CrawlDeps {
  return {
    fetchRaw: over.fetchRaw ?? ((url, hosts) => fetchRaw(url, hosts)),
    now: over.now ?? (() => Date.now()),
    sleep: over.sleep ?? ((ms) => Bun.sleep(ms)),
    maxPages: over.maxPages ?? DEFAULT_MAX_PAGES,
    known: over.known ?? [],
    onMiss: over.onMiss,
    onTruncated: over.onTruncated,
    signal: over.signal,
  };
}

function bind(over: Partial<WebsiteDeps>): WebsiteDeps {
  return {
    today: over.today ?? (() => new Date().toISOString().slice(0, 10)),
    hosts:
      over.hosts ??
      (async (project) => {
        const { roleWebAccess } = await import("../../projects/effective");
        return (await roleWebAccess(project, "support")).websites;
      }),
    crawl: over.crawl ?? {},
    onProgress: over.onProgress,
  };
}

function checkProject(project: string): void {
  try {
    knowledgeRepoName(project);
  } catch {
    throw new MemoryRepoError(`"${project}" isn't a project name.`);
  }
}

/** The exact `host[:port]` entries of a websites list: wildcards and
 *  anything that isn't a plain host name are left out. */
export function exactHosts(hosts: readonly string[]): string[] {
  const out = new Set<string>();
  for (const entry of hosts) {
    const e = entry.trim().toLowerCase();
    const m = /^([a-z0-9-]+(?:\.[a-z0-9-]+)*)\.?(:\d{1,5})?$/.exec(e);
    if (m) out.add(`${m[1]}${m[2] ?? ""}`);
  }
  return [...out];
}

function withoutHash(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

const decoder = () => new TextDecoder("utf-8", { fatal: false });
const ok = (raw: RawResponse) => raw.status >= 200 && raw.status < 300;

// ── robots.txt ──────────────────────────────────────────────────────────

/** robots.txt bytes read (the rest is ignored, as Google does). */
export const MAX_ROBOTS_BYTES = 500 * 1024;
/** Allow/Disallow rules kept per robots.txt. */
export const MAX_ROBOTS_RULES = 1000;

interface RobotsRule {
  allow: boolean;
  /** The pattern split at `*`: the first part is a prefix, the rest are
   *  found in order. */
  parts: string[];
  /** Ends in `$`: the last part must end the path. */
  anchored: boolean;
  length: number;
}

/** The `Allow`/`Disallow` rules of the groups for every agent (`*`), at
 *  most MAX_ROBOTS_RULES. */
export function robotsRules(text: string): RobotsRule[] {
  const rules: RobotsRule[] = [];
  let agents: string[] = [];
  let inRules = false;
  for (const raw of text.split("\n")) {
    const hash = raw.indexOf("#");
    const line = (hash < 0 ? raw : raw.slice(0, hash)).trim();
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (inRules) agents = [];
      inRules = false;
      agents.push(value.toLowerCase());
      continue;
    }
    if (key !== "allow" && key !== "disallow") continue;
    inRules = true;
    if (!agents.includes("*") || !value) continue;
    const anchored = value.endsWith("$");
    rules.push({
      allow: key === "allow",
      parts: (anchored ? value.slice(0, -1) : value).split("*"),
      anchored,
      length: value.length,
    });
    if (rules.length >= MAX_ROBOTS_RULES) break;
  }
  return rules;
}

/** Whether `rule` matches `path` from its start: the first part as a
 *  prefix, each later part at its leftmost place after the one before
 *  (leftmost is always safe for `*`), and with `$` the last part ending
 *  the path. No regular expression, no backtracking. */
function ruleMatches(rule: RobotsRule, path: string): boolean {
  const { parts, anchored } = rule;
  const first = parts[0]!;
  if (!path.startsWith(first)) return false;
  if (parts.length === 1) return !anchored || path.length === first.length;
  const last = parts[parts.length - 1]!;
  // With `$` the last part is pinned to the end; the middle must fit before.
  const end = anchored ? path.length - last.length : path.length;
  if (anchored && (end < first.length || !path.endsWith(last))) return false;
  let at = first.length;
  const middle = anchored ? parts.length - 1 : parts.length;
  for (let i = 1; i < middle; i++) {
    const part = parts[i]!;
    if (!part) continue;
    const found = path.indexOf(part, at);
    if (found < 0 || found + part.length > end) return false;
    at = found + part.length;
  }
  return true;
}

/** Whether `path` may be crawled: the longest matching rule wins, Allow on
 *  a tie; no matching rule allows. */
export function robotsAllow(rules: RobotsRule[], path: string): boolean {
  let best: RobotsRule | null = null;
  for (const rule of rules) {
    if (!ruleMatches(rule, path)) continue;
    if (
      !best ||
      rule.length > best.length ||
      (rule.length === best.length && rule.allow)
    )
      best = rule;
  }
  return best ? best.allow : true;
}

// ── Sitemaps and links ──────────────────────────────────────────────────

/** Sitemap bytes read at most (the sitemap protocol's own limit). */
export const MAX_SITEMAP_BYTES = 10 * 1024 * 1024;
/** URLs read per sitemap at most (the sitemap protocol's own limit). */
export const MAX_SITEMAP_URLS = 50_000;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** ASCII letters lowered, so indexes match the original string. */
const asciiLower = (text: string) =>
  text.replace(/[A-Z]+/g, (run) => run.toLowerCase());

/** The `<loc>` values of a sitemap or sitemap index, at most
 *  MAX_SITEMAP_URLS: a plain scan for `<loc>` … `</loc>`, trimmed, a CDATA
 *  wrapper dropped, the five XML entities decoded. An unclosed `<loc>`
 *  ends the scan. */
export function sitemapLocs(xml: string): string[] {
  const lower = asciiLower(xml);
  const locs: string[] = [];
  let at = 0;
  while (locs.length < MAX_SITEMAP_URLS) {
    const open = lower.indexOf("<loc>", at);
    if (open < 0) break;
    const start = open + "<loc>".length;
    const close = lower.indexOf("</loc>", start);
    if (close < 0) break;
    at = close + "</loc>".length;
    let value = xml.slice(start, close).trim();
    if (value.startsWith("<![CDATA[") && value.endsWith("]]>"))
      value = value.slice("<![CDATA[".length, -"]]>".length).trim();
    else
      value = value.replace(
        /&(amp|lt|gt|quot|apos);/g,
        (_, e: string) => ENTITIES[e]!,
      );
    if (value && !value.includes("<")) locs.push(value);
  }
  return locs;
}

async function linksOf(html: string, base: string): Promise<string[]> {
  const hrefs: string[] = [];
  await new HTMLRewriter()
    .on("a[href]", {
      element: (e) => {
        const href = e.getAttribute("href");
        if (href) hrefs.push(href);
      },
    })
    .transform(new Response(html))
    .text();
  const links: string[] = [];
  for (const href of hrefs) {
    try {
      const url = withoutHash(new URL(href, base).toString());
      if (url) links.push(url);
    } catch {
      // Not a URL: skipped.
    }
  }
  return links;
}

// ── The crawl ───────────────────────────────────────────────────────────

/**
 * Crawl the exact hosts of `hosts` and yield every readable page. See the
 * module comment for the order and limits. Pages that aren't readable go
 * to `onMiss`.
 */
export async function* crawlHosts(
  hosts: string[],
  over: Partial<CrawlDeps> = {},
): AsyncGenerator<CrawledPage> {
  const d = bindCrawl(over);
  let budget = Math.max(0, Math.floor(d.maxPages));
  let cut = false;
  const truncate = () => {
    if (!cut) d.onTruncated?.();
    cut = true;
  };
  const requested = new Set<string>();
  for (const host of exactHosts(hosts)) {
    if (budget <= 0) {
      truncate();
      return;
    }
    const only = [host];
    const root = `https://${host}/`;
    let last = Number.NEGATIVE_INFINITY;
    const get = async (url: string) => {
      d.signal?.throwIfAborted();
      const wait = last + HOST_INTERVAL_MS - d.now();
      if (wait > 0) await d.sleep(wait);
      d.signal?.throwIfAborted();
      last = d.now();
      return d.fetchRaw(url, only);
    };

    const robots = await get(`${root}robots.txt`);
    if ("error" in robots || robots.status >= 500 || robots.status < 200) {
      d.onMiss?.(
        `${root}robots.txt`,
        "error" in robots
          ? robots.error
          : `robots.txt answered ${robots.status}`,
        false,
      );
      continue;
    }
    const rules = ok(robots)
      ? robotsRules(decoder().decode(robots.body.subarray(0, MAX_ROBOTS_BYTES)))
      : [];
    const allowed = (url: string) =>
      crawlable(url, only) && robotsAllow(rules, new URL(url).pathname);

    // The sitemap's pages, else a walk from `/`.
    const listed: string[] = [];
    const listedSet = new Set<string>();
    const maps = new Set<string>();
    const visitMap = async (url: string, depth: number): Promise<void> => {
      if (depth > SITEMAP_DEPTH || maps.has(url)) return;
      if (maps.size >= MAX_SITEMAPS || listed.length >= budget) {
        truncate();
        return;
      }
      maps.add(url);
      const raw = await get(url);
      if ("error" in raw || !ok(raw)) return;
      if (raw.body.length > MAX_SITEMAP_BYTES) {
        truncate();
        return;
      }
      const xml = decoder().decode(raw.body);
      const index = /<sitemapindex[\s>]/i.test(xml);
      for (const loc of sitemapLocs(xml)) {
        const target = withoutHash(loc);
        if (!target || !allowed(target)) continue;
        if (index) await visitMap(target, depth + 1);
        else if (listedSet.has(target)) continue;
        else if (listed.length >= budget) truncate();
        else {
          listedSet.add(target);
          listed.push(target);
        }
      }
    };
    await visitMap(`${root}sitemap.xml`, 0);

    const queue: Array<{ url: string; depth: number }> = listed.length
      ? listed.map((url) => ({ url, depth: LINK_DEPTH }))
      : [{ url: root, depth: 0 }];
    const queued = new Set(queue.map((q) => q.url));
    async function* visit(
      url: string,
      depth: number,
    ): AsyncGenerator<CrawledPage> {
      if (requested.has(url) || !allowed(url)) return;
      if (budget <= 0) {
        truncate();
        return;
      }
      requested.add(url);
      budget--;
      const raw = await get(url);
      if ("error" in raw) {
        d.onMiss?.(url, raw.error, false);
        return;
      }
      const final = withoutHash(raw.url) ?? url;
      if (final !== url) {
        if (requested.has(final) || !allowed(final)) return;
        requested.add(final);
      }
      if (ok(raw) && depth < LINK_DEPTH && /html/i.test(raw.contentType)) {
        for (const link of await linksOf(decoder().decode(raw.body), final)) {
          if (queued.has(link) || !allowed(link)) continue;
          queued.add(link);
          queue.push({ url: link, depth: depth + 1 });
        }
      }
      const page = await pageOf({ ...raw, url: final }).catch((error) => ({
        error: error instanceof Error ? error.message : "Unreadable page",
      }));
      if ("error" in page) {
        d.onMiss?.(final, page.error, raw.status === 404 || raw.status === 410);
        return;
      }
      yield page;
    }

    while (queue.length) {
      const { url, depth } = queue.shift()!;
      yield* visit(url, depth);
    }
    // Pages mirrored before and not listed now: still there?
    for (const url of d.known) {
      const target = withoutHash(url);
      if (target) yield* visit(target, LINK_DEPTH);
    }
  }
}

// ── Mirrors ─────────────────────────────────────────────────────────────

async function webItems(
  project: string,
  today: string,
): Promise<Map<string, KnowledgeItem>> {
  const items = new Map<string, KnowledgeItem>();
  for (let offset = 0; ; offset += LIST_PAGE) {
    const page = await knowledgeRepo.call("index.list", project, "all", {
      today,
      limit: LIST_PAGE,
      offset,
    });
    for (const item of page.items)
      if (item.origin === "web") items.set(item.path, item);
    if (page.items.length < LIST_PAGE || offset + LIST_PAGE >= page.total)
      return items;
  }
}

/** The URL of a web mirror's own `url:<url>#sha256=<hex>` source. */
function mirrorUrl(item: KnowledgeItem): string | null {
  for (const source of item.sources) {
    if (!source.startsWith("url:")) continue;
    const mark = source.lastIndexOf("#sha256=");
    return source.slice("url:".length, mark < 0 ? undefined : mark);
  }
  return null;
}

function pathOf(url: string): string | null {
  try {
    return webItemPath(url);
  } catch {
    return null;
  }
}

function titleOf(page: CrawledPage): string {
  const url = new URL(page.url);
  return (page.title || `${url.host}${url.pathname}`).slice(0, 200);
}

/** Text that can be stored as read: not too large, no credential. */
function storable(page: CrawledPage): boolean {
  if (new TextEncoder().encode(page.text).length > BODY_BYTES) return false;
  return findSecrets(`${titleOf(page)}\n${page.text}`).length === 0;
}

/**
 * Crawl the project's support websites and write what changed in one
 * commit. Resolves with what was written, retired and skipped.
 */
export async function crawlWebsites(
  project: string,
  over: Partial<WebsiteDeps> = {},
): Promise<WebsiteResult> {
  checkProject(project);
  const deps = bind(over);
  const today = deps.today();
  const hosts = exactHosts(await deps.hosts(project));
  const result: WebsiteResult = {
    pages: 0,
    truncated: false,
    written: 0,
    retired: 0,
    skipped: 0,
  };
  if (!hosts.length) return result;

  const before = await webItems(project, today);
  const known: string[] = [];
  for (const item of before.values())
    if (item.status !== "retired") {
      const url = mirrorUrl(item);
      if (url) known.push(url);
    }

  const pages = new Map<string, CrawledPage>();
  const gone = new Set<string>();
  let reported = 0;
  const report = async () => {
    if (result.pages - reported < PROGRESS_EVERY) return;
    reported = result.pages;
    await deps.onProgress?.(result.pages);
  };
  for await (const page of crawlHosts(hosts, {
    ...deps.crawl,
    known: [...(deps.crawl.known ?? []), ...known],
    onTruncated: () => {
      result.truncated = true;
      deps.crawl.onTruncated?.();
    },
    onMiss: (url, error, isGone) => {
      deps.crawl.onMiss?.(url, error, isGone);
      // A host skipped for its robots.txt is no page.
      if (url.endsWith("/robots.txt") && !isGone) return;
      result.pages++;
      const path = pathOf(url);
      if (isGone && path) gone.add(path);
      else result.skipped++;
    },
  })) {
    result.pages++;
    await report();
    const path = pathOf(page.url);
    if (!path || pages.has(path) || !storable(page)) {
      result.skipped++;
      continue;
    }
    pages.set(path, page);
  }

  for (let attempt = 1; ; attempt++) {
    const items = attempt === 1 ? before : await webItems(project, today);
    const changes: KnowledgeChange[] = [];
    const expected: Record<string, string | null> = {};
    let retired = 0;
    for (const [path, page] of pages) {
      // The "all" list leaves retired items out: a page that comes back
      // is read by its path, so the write expects its blob.
      const current =
        items.get(path) ??
        (await knowledgeRepo.call("index.get", project, path, today)) ??
        undefined;
      const source = `url:${page.url}#sha256=${page.hash}`;
      if (
        current &&
        current.status !== "retired" &&
        current.sources.includes(source)
      )
        continue;
      const fm: KnowledgeFrontMatter = {
        title: titleOf(page),
        kind: current?.kind ?? "answer",
        trust: "trusted",
        status: "active",
        origin: "web",
        topics: current?.topics ?? [],
        sources: [source],
        dependsOn: [`url:${page.url}`],
        validAsOf: today,
      };
      // Waiting for a person stays waiting: new text, same question.
      if (current?.status === "needs-check" && current.check) {
        fm.status = "needs-check";
        fm.check = current.check;
      }
      changes.push({ op: "put", path, fm, body: page.text });
      expected[path] = current?.blob ?? null;
    }
    for (const path of gone) {
      const current = items.get(path);
      if (!current || current.status === "retired" || pages.has(path)) continue;
      const read = await knowledgeRepo.call("read", project, path, today);
      if (!read) continue;
      const { check: _check, ...fm } = frontMatterOf(read.item);
      changes.push({
        op: "put",
        path,
        fm: { ...fm, status: "retired" },
        body: read.body,
      });
      expected[path] = read.item.blob;
      retired++;
    }
    result.written = changes.length - retired;
    result.retired = retired;
    if (!changes.length) return result;
    deps.crawl.signal?.throwIfAborted();
    try {
      await knowledgeRepo.call("write", project, changes, {
        message: retired
          ? `Import website: ${result.written} pages (${retired} retired)`
          : `Import website: ${result.written} pages`,
        author: PAT_AUTHOR,
        trailers: [PAT_TRAILER],
        expected,
      });
      return result;
    } catch (error) {
      // Someone wrote meanwhile: plan again from what is there now.
      const conflict =
        error instanceof Error && error.name === "KnowledgeConflictError";
      if (!conflict || attempt >= WRITE_ATTEMPTS) throw error;
    }
  }
}

// ── The job ─────────────────────────────────────────────────────────────

/**
 * Start the website import for `project`; resolves with the job (it runs
 * in the background). Refused (400) when the project lists no exact
 * support website, and (409) while one runs.
 */
export async function startWebsiteCrawl(
  input: { project: string; by: Author; maxPages?: number },
  over: Partial<WebsiteDeps> = {},
): Promise<KnowledgeImportJob> {
  const { project } = input;
  checkProject(project);
  const deps = bind(over);
  if (!exactHosts(await deps.hosts(project)).length)
    throw new MemoryRepoError(NO_WEBSITES_COPY, 400);
  const asked = input.maxPages;
  const maxPages =
    typeof asked === "number" && Number.isInteger(asked)
      ? Math.min(MAX_PAGES_LIMIT, Math.max(1, asked))
      : DEFAULT_MAX_PAGES;
  return startJob(
    project,
    "website",
    { by: input.by.name, maxPages },
    async (job) => {
      await knowledgeRepo.call("ensureRepo", project);
      let reported = 0;
      const result = await crawlWebsites(project, {
        ...over,
        crawl: { ...deps.crawl, maxPages, signal: job.signal },
        onProgress: async (pages) => {
          await job.progress({ done: pages - reported });
          reported = pages;
        },
      });
      await job.progress({
        trusted: result.written,
        skipped: result.skipped,
        done: result.pages - reported,
      });
      if (result.truncated) await job.markTruncated();
    },
  );
}
