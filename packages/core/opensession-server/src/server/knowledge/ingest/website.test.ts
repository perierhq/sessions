import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { useSupportTestKernel } from "../../support/testing/kernel-fixture";
import { __setKnowledgeServiceForTest, knowledgeRepo } from "../client";
import type { RawResponse } from "../freshness/web";
import { frontMatterOf } from "../freshness/revalidate";
import { webItemPath } from "../layout";
import { KnowledgeService } from "../service";
import { __waitForJobForTest, listJobs } from "./jobs";
import {
  type CrawlDeps,
  type CrawledPage,
  crawlHosts,
  crawlWebsites,
  MAX_ROBOTS_RULES,
  MAX_SITEMAP_URLS,
  robotsAllow,
  robotsRules,
  sitemapLocs,
  startWebsiteCrawl,
  type WebsiteDeps,
} from "./website";

const kernel = useSupportTestKernel();
const TODAY = "2026-10-26";
const HOST = "help.acme.example.test";
const SITE = `https://${HOST}`;

/** An HTML page with enough text to be a page (web.ts needs 200 chars). */
function html(title: string, words = "", links: string[] = []): string {
  const anchors = links.map((l) => `<a href="${l}">link</a>`).join(" ");
  const filler = `${title} explains how Acme works for every team member. `;
  return `<html><head><title>${title}</title></head><body><h1>${title}</h1><p>${filler.repeat(5)} ${words}</p>${anchors}</body></html>`;
}

function urlset(urls: string[]): string {
  return `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls
    .map((u) => `<url><loc>${u}</loc></url>`)
    .join("")}</urlset>`;
}

function sitemapIndex(urls: string[]): string {
  return `<?xml version="1.0"?><sitemapindex>${urls
    .map((u) => `<sitemap><loc>${u}</loc></sitemap>`)
    .join("")}</sitemapindex>`;
}

type Site = Record<
  string,
  { status?: number; type?: string; body: string; redirect?: string }
>;

/** A fake web: the site map answers, anything else is a 404. Records every
 *  request with the fake clock's time. */
function fakeWeb(site: Site) {
  let now = 0;
  const requests: Array<{ url: string; at: number }> = [];
  const signals: Array<AbortSignal | undefined> = [];
  const deps: Partial<CrawlDeps> = {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    fetchRaw: async (
      url,
      _hosts,
      signal,
    ): Promise<RawResponse | { error: string }> => {
      requests.push({ url, at: now });
      signals.push(signal);
      now += 10;
      const redirect = site[url]?.redirect;
      const page = site[redirect ?? url];
      return {
        url: redirect ?? url,
        status: page ? (page.status ?? 200) : 404,
        contentType: page?.type ?? "text/html; charset=utf-8",
        body: new TextEncoder().encode(page?.body ?? "Not found"),
      };
    },
  };
  return {
    deps,
    requests,
    signals,
    urls: () => requests.map((r) => r.url),
  };
}

async function collect(
  hosts: string[],
  deps: Partial<CrawlDeps>,
): Promise<CrawledPage[]> {
  const pages: CrawledPage[] = [];
  for await (const page of crawlHosts(hosts, deps)) pages.push(page);
  return pages;
}

describe("sitemapLocs", () => {
  test("reads plain, CDATA and entity-escaped locs", () => {
    expect(
      sitemapLocs(
        `<urlset><url><loc> https://a.test/x?a=1&amp;b=2 </loc></url><url><LOC><![CDATA[ https://a.test/y ]]></LOC></url><url><loc></loc></url></urlset>`,
      ),
    ).toEqual(["https://a.test/x?a=1&b=2", "https://a.test/y"]);
  });

  test("an unclosed <loc> followed by 100k spaces ends fast", () => {
    const xml = `<urlset><loc>${" ".repeat(100_000)}`;
    const start = performance.now();
    expect(sitemapLocs(`${xml}<loc>${xml}`)).toEqual([]);
    expect(performance.now() - start).toBeLessThan(200);
  });

  test("stops at MAX_SITEMAP_URLS", () => {
    const xml = Array.from(
      { length: MAX_SITEMAP_URLS + 5 },
      (_, i) => `<loc>https://a.test/${i}</loc>`,
    ).join("");
    expect(sitemapLocs(xml)).toHaveLength(MAX_SITEMAP_URLS);
  });
});

describe("robots.txt", () => {
  test("matches wildcards and $ without regular expressions", () => {
    const rules = robotsRules(
      "User-agent: *\nDisallow: /*.pdf$\nDisallow: /private*/keys\nAllow: /private-ok/keys\nDisallow: /a*b*c\n",
    );
    expect(robotsAllow(rules, "/files/guide.pdf")).toBe(false);
    expect(robotsAllow(rules, "/files/guide.pdf?x")).toBe(true);
    expect(robotsAllow(rules, "/private-x/keys/1")).toBe(false);
    expect(robotsAllow(rules, "/private-ok/keys")).toBe(true);
    expect(robotsAllow(rules, "/axxbyyc")).toBe(false);
    expect(robotsAllow(rules, "/axxcyyb")).toBe(true);
    expect(robotsAllow(rules, "/export")).toBe(true);
  });

  test("a pathological pattern matches in linear time", () => {
    const rules = robotsRules(
      `User-agent: *\nDisallow: /${"*a".repeat(200)}*b\n`,
    );
    const start = performance.now();
    expect(robotsAllow(rules, `/${"a".repeat(50_000)}`)).toBe(true);
    expect(performance.now() - start).toBeLessThan(200);
  });

  test("keeps at most MAX_ROBOTS_RULES rules", () => {
    const lines = Array.from(
      { length: MAX_ROBOTS_RULES + 50 },
      (_, i) => `Disallow: /p${i}`,
    );
    expect(robotsRules(`User-agent: *\n${lines.join("\n")}`)).toHaveLength(
      MAX_ROBOTS_RULES,
    );
  });
});

describe("crawlHosts", () => {
  test("crawls the sitemap's pages on the listed host only", async () => {
    const web = fakeWeb({
      [`${SITE}/sitemap.xml`]: {
        type: "application/xml",
        body: sitemapIndex([
          `${SITE}/sitemap-docs.xml`,
          "https://evil.example.test/sitemap.xml",
        ]),
      },
      [`${SITE}/sitemap-docs.xml`]: {
        type: "application/xml",
        body: urlset([
          `${SITE}/export`,
          `${SITE}/billing`,
          "https://evil.example.test/steal",
          "https://docs.acme.example.test/other",
          `http://${HOST}/plain`,
        ]),
      },
      [`${SITE}/export`]: { body: html("Exporting") },
      [`${SITE}/billing`]: { body: html("Billing") },
    });
    const pages = await collect([HOST, "*.acme.example.test"], web.deps);
    expect(pages.map((p) => p.url).sort()).toEqual([
      `${SITE}/billing`,
      `${SITE}/export`,
    ]);
    expect(pages[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(pages.find((p) => p.url.endsWith("/export"))!.title).toBe(
      "Exporting",
    );
    // Nothing off the listed host is ever requested, the wildcard included.
    for (const url of web.urls()) expect(new URL(url).host).toBe(HOST);
  });

  test("a wildcard entry is never crawled", async () => {
    const web = fakeWeb({});
    const pages = await collect(["*.acme.example.test"], web.deps);
    expect(pages).toEqual([]);
    expect(web.requests).toEqual([]);
  });

  test("honours robots.txt Disallow for every agent", async () => {
    const web = fakeWeb({
      [`${SITE}/robots.txt`]: {
        type: "text/plain",
        body: "User-agent: other\nDisallow: /\n\nUser-agent: *\nDisallow: /private\n",
      },
      [`${SITE}/sitemap.xml`]: {
        type: "application/xml",
        body: urlset([`${SITE}/export`, `${SITE}/private/keys`]),
      },
      [`${SITE}/export`]: { body: html("Exporting") },
      [`${SITE}/private/keys`]: { body: html("Private") },
    });
    const pages = await collect([HOST], web.deps);
    expect(pages.map((p) => p.url)).toEqual([`${SITE}/export`]);
    expect(web.urls()).not.toContain(`${SITE}/private/keys`);
  });

  test("stops at maxPages: the 201st page is not fetched", async () => {
    const urls = Array.from({ length: 250 }, (_, i) => `${SITE}/p${i + 1}`);
    const site: Site = {
      [`${SITE}/sitemap.xml`]: { type: "text/xml", body: urlset(urls) },
    };
    for (const url of urls) site[url] = { body: html(url) };
    const web = fakeWeb(site);
    let truncated = 0;
    const pages = await collect([HOST], {
      ...web.deps,
      onTruncated: () => void truncated++,
    });
    expect(pages).toHaveLength(200);
    expect(truncated).toBeGreaterThan(0);
    expect(web.urls()).toContain(`${SITE}/p200`);
    expect(web.urls()).not.toContain(`${SITE}/p201`);
  });

  test("without a sitemap, follows same-host links from / to depth 3", async () => {
    const web = fakeWeb({
      [`${SITE}/`]: {
        body: html("Home", "", ["/a", "https://evil.example.test/x", "#top"]),
      },
      [`${SITE}/a`]: { body: html("A", "", ["b"]) },
      [`${SITE}/b`]: { body: html("B", "", [`${SITE}/c`]) },
      [`${SITE}/c`]: { body: html("C", "", [`${SITE}/d`]) },
      [`${SITE}/d`]: { body: html("D") },
    });
    const pages = await collect([HOST], web.deps);
    expect(pages.map((p) => p.url)).toEqual([
      `${SITE}/`,
      `${SITE}/a`,
      `${SITE}/b`,
      `${SITE}/c`,
    ]);
    expect(web.urls()).not.toContain(`${SITE}/d`);
    expect(web.urls()).not.toContain("https://evil.example.test/x");
  });

  test("waits a second between requests to one host", async () => {
    const web = fakeWeb({
      [`${SITE}/sitemap.xml`]: {
        type: "application/xml",
        body: urlset([`${SITE}/a`, `${SITE}/b`]),
      },
      [`${SITE}/a`]: { body: html("A") },
      [`${SITE}/b`]: { body: html("B") },
    });
    await collect([HOST], web.deps);
    expect(web.requests.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < web.requests.length; i++)
      expect(
        web.requests[i]!.at - web.requests[i - 1]!.at,
      ).toBeGreaterThanOrEqual(1000);
  });

  test("a site within maxPages is not cut short", async () => {
    const web = fakeWeb({
      [`${SITE}/sitemap.xml`]: {
        type: "application/xml",
        body: urlset([`${SITE}/a`]),
      },
      [`${SITE}/a`]: { body: html("A") },
    });
    let truncated = 0;
    await collect([HOST], { ...web.deps, onTruncated: () => void truncated++ });
    expect(truncated).toBe(0);
  });

  test("stops when cancelled", async () => {
    const ac = new AbortController();
    const web = fakeWeb({
      [`${SITE}/sitemap.xml`]: {
        type: "application/xml",
        body: urlset([`${SITE}/a`, `${SITE}/b`]),
      },
      [`${SITE}/a`]: { body: html("A") },
      [`${SITE}/b`]: { body: html("B") },
    });
    const seen: string[] = [];
    const run = (async () => {
      for await (const page of crawlHosts([HOST], {
        ...web.deps,
        signal: ac.signal,
      })) {
        seen.push(page.url);
        ac.abort();
      }
    })();
    await expect(run).rejects.toThrow();
    expect(seen).toEqual([`${SITE}/a`]);
    expect(web.urls()).not.toContain(`${SITE}/b`);
  });

  test("hands the cancel signal to every request", async () => {
    const ac = new AbortController();
    const web = fakeWeb({
      [`${SITE}/sitemap.xml`]: {
        type: "application/xml",
        body: urlset([`${SITE}/a`]),
      },
      [`${SITE}/a`]: { body: html("A") },
    });
    await collect([HOST], { ...web.deps, signal: ac.signal });
    expect(web.signals.length).toBeGreaterThan(0);
    for (const signal of web.signals) expect(signal).toBe(ac.signal);
  });

  test("stops at its deadline and says it was cut", async () => {
    const urls = Array.from({ length: 10 }, (_, i) => `${SITE}/p${i + 1}`);
    const site: Site = {
      [`${SITE}/sitemap.xml`]: { type: "application/xml", body: urlset(urls) },
    };
    for (const url of urls) site[url] = { body: html(url) };
    const web = fakeWeb(site);
    let cut = 0;
    const pages = await collect([HOST], {
      ...web.deps,
      deadlineMs: 4_500,
      onTruncated: () => cut++,
    });
    expect(pages.length).toBeGreaterThan(0);
    expect(pages.length).toBeLessThan(10);
    expect(cut).toBe(1);
  });

  test("a page that answers 404 is reported gone", async () => {
    const web = fakeWeb({
      [`${SITE}/sitemap.xml`]: {
        type: "application/xml",
        body: urlset([`${SITE}/gone`]),
      },
    });
    const gone: string[] = [];
    await collect([HOST], {
      ...web.deps,
      onMiss: (url, _error, isGone) => {
        if (isGone) gone.push(url);
      },
    });
    expect(gone).toEqual([`${SITE}/gone`]);
  });
});

describe("crawlWebsites", () => {
  let service: KnowledgeService;

  beforeEach(async () => {
    service = new KnowledgeService({ base: join(kernel.root(), "memory") });
    __setKnowledgeServiceForTest(service);
    await knowledgeRepo.call("ensureRepo", "acme");
  });

  afterEach(() => {
    __setKnowledgeServiceForTest(null);
    service.close();
  });

  const commits = async () =>
    (await knowledgeRepo.call("history", "acme", undefined, 100)).length;

  function deps(site: Site): Partial<WebsiteDeps> {
    return {
      today: () => TODAY,
      hosts: async () => [HOST, "*.acme.example.test"],
      crawl: fakeWeb(site).deps,
    };
  }

  const pages: Site = {
    [`${SITE}/sitemap.xml`]: {
      type: "application/xml",
      body: urlset([`${SITE}/export`, `${SITE}/billing`]),
    },
    [`${SITE}/export`]: { body: html("Exporting") },
    [`${SITE}/billing`]: { body: html("Billing") },
  };

  test("mirrors pages as trusted web items, and a rerun changes nothing", async () => {
    const first = await crawlWebsites("acme", deps(pages));
    expect(first).toMatchObject({ written: 2, retired: 0, skipped: 0 });
    const read = await knowledgeRepo.call(
      "read",
      "acme",
      webItemPath(`${SITE}/export`),
      TODAY,
    );
    expect(read!.item).toMatchObject({
      title: "Exporting",
      kind: "answer",
      trust: "trusted",
      status: "active",
      origin: "web",
      validAsOf: TODAY,
      dependsOn: [`url:${SITE}/export`],
    });
    expect(read!.item.sources).toHaveLength(1);
    expect(read!.item.sources[0]).toMatch(
      new RegExp(`^url:${SITE}/export#sha256=[0-9a-f]{64}$`),
    );
    expect(read!.body).toContain("Exporting explains how Acme works");
    const history = await knowledgeRepo.call("history", "acme", undefined, 1);
    expect(history[0]!.author).toBe("Pat");

    const before = await commits();
    const second = await crawlWebsites("acme", deps(pages));
    expect(second).toMatchObject({ written: 0, retired: 0 });
    expect(await commits()).toBe(before);
  });

  test("a page now answering 404 is retired, its text kept", async () => {
    await crawlWebsites("acme", deps(pages));
    const { [`${SITE}/billing`]: _gone, ...rest } = pages;
    const result = await crawlWebsites("acme", deps(rest));
    expect(result).toMatchObject({ written: 0, retired: 1 });
    const read = await knowledgeRepo.call(
      "read",
      "acme",
      webItemPath(`${SITE}/billing`),
      TODAY,
    );
    expect(read!.item.status).toBe("retired");
    expect(read!.body).toContain("Billing explains");
  });

  test("a retired page that comes back is active again", async () => {
    await crawlWebsites("acme", deps(pages));
    const { [`${SITE}/billing`]: _gone, ...rest } = pages;
    await crawlWebsites("acme", deps(rest));
    const result = await crawlWebsites("acme", deps(pages));
    expect(result).toMatchObject({ written: 1, retired: 0 });
    const read = await knowledgeRepo.call(
      "read",
      "acme",
      webItemPath(`${SITE}/billing`),
      TODAY,
    );
    expect(read!.item.status).toBe("active");
    expect(read!.body).toContain("Billing explains");
  });

  test("a page dropped from the sitemap is checked and retired when gone", async () => {
    await crawlWebsites("acme", deps(pages));
    const result = await crawlWebsites(
      "acme",
      deps({
        ...pages,
        [`${SITE}/sitemap.xml`]: {
          type: "application/xml",
          body: urlset([`${SITE}/export`]),
        },
        [`${SITE}/billing`]: { status: 410, body: "Gone" },
      }),
    );
    expect(result.retired).toBe(1);
  });

  test("a changed page is rewritten with its new hash", async () => {
    await crawlWebsites("acme", deps(pages));
    const path = webItemPath(`${SITE}/export`);
    const before = await knowledgeRepo.call("read", "acme", path, TODAY);
    const result = await crawlWebsites(
      "acme",
      deps({
        ...pages,
        [`${SITE}/export`]: { body: html("Exporting", "Now also as JSON.") },
      }),
    );
    expect(result.written).toBe(1);
    const after = await knowledgeRepo.call("read", "acme", path, TODAY);
    expect(after!.item.sources[0]).not.toBe(before!.item.sources[0]);
    expect(after!.body).toContain("Now also as JSON.");
  });

  test("a page holding a credential is skipped, never stored", async () => {
    const result = await crawlWebsites(
      "acme",
      deps({
        ...pages,
        [`${SITE}/billing`]: {
          body: html("Billing", "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB"),
        },
      }),
    );
    expect(result).toMatchObject({ written: 1, skipped: 1 });
    expect(
      await knowledgeRepo.call(
        "read",
        "acme",
        webItemPath(`${SITE}/billing`),
        TODAY,
      ),
    ).toBeNull();
  });

  test("the job records what it wrote", async () => {
    const job = await startWebsiteCrawl(
      { project: "acme", by: { name: "Ada" } },
      deps(pages),
    );
    expect(job.kind).toBe("website");
    await __waitForJobForTest(job.id);
    const [done] = await listJobs("acme");
    expect(done).toMatchObject({
      kind: "website",
      state: "done",
      created: { trusted: 2, reference: 0, suggestions: 0, skipped: 0 },
    });
  });

  test("a job cut at maxPages is marked truncated", async () => {
    const job = await startWebsiteCrawl(
      { project: "acme", by: { name: "Ada" }, maxPages: 1 },
      deps(pages),
    );
    await __waitForJobForTest(job.id);
    const [done] = await listJobs("acme");
    expect(done).toMatchObject({
      state: "done",
      truncated: true,
      created: { trusted: 1 },
    });
  });

  test("a known page that now redirects to another page retires its old path", async () => {
    await crawlWebsites("acme", deps(pages));
    const result = await crawlWebsites(
      "acme",
      deps({
        [`${SITE}/sitemap.xml`]: {
          type: "application/xml",
          body: urlset([`${SITE}/export`]),
        },
        [`${SITE}/export`]: { body: html("Exporting") },
        [`${SITE}/billing`]: { redirect: `${SITE}/plans`, body: "" },
        [`${SITE}/plans`]: { body: html("Plans and billing") },
      }),
    );
    expect(result).toMatchObject({ written: 1, retired: 1 });
    expect(
      (
        await knowledgeRepo.call(
          "read",
          "acme",
          webItemPath(`${SITE}/billing`),
          TODAY,
        )
      )?.item.status,
    ).toBe("retired");
    expect(
      (
        await knowledgeRepo.call(
          "read",
          "acme",
          webItemPath(`${SITE}/plans`),
          TODAY,
        )
      )?.item.status,
    ).toBe("active");
  });

  test("a mirrored page that now holds a credential flips to needs-check, text kept", async () => {
    await crawlWebsites("acme", deps(pages));
    const path = webItemPath(`${SITE}/billing`);
    const before = (await knowledgeRepo.call("read", "acme", path, TODAY))!;
    const result = await crawlWebsites(
      "acme",
      deps({
        ...pages,
        [`${SITE}/billing`]: {
          body: html("Billing", "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB"),
        },
      }),
    );
    expect(result).toMatchObject({ written: 0, skipped: 1 });
    const after = (await knowledgeRepo.call("read", "acme", path, TODAY))!;
    expect(after.item.status).toBe("needs-check");
    expect(after.item.check?.reason).toContain("credential");
    expect(after.body).toBe(before.body);
  });

  test("a mirror a person edited last is never overwritten", async () => {
    await crawlWebsites("acme", deps(pages));
    const path = webItemPath(`${SITE}/export`);
    const current = (await knowledgeRepo.call("read", "acme", path, TODAY))!;
    await knowledgeRepo.call(
      "write",
      "acme",
      [
        {
          op: "put",
          path,
          fm: frontMatterOf(current.item),
          body: `${current.body}\n\nAda's note.`,
        },
      ],
      {
        message: "Ada's edit",
        author: { name: "Ada" },
        expected: { [path]: current.item.blob },
      },
    );
    const result = await crawlWebsites(
      "acme",
      deps({
        ...pages,
        [`${SITE}/export`]: { body: html("Exporting", "Now also as JSON.") },
      }),
    );
    expect(result).toMatchObject({ written: 0, skipped: 1 });
    const after = (await knowledgeRepo.call("read", "acme", path, TODAY))!;
    expect(after.body).toContain("Ada's note.");
    expect(after.body).not.toContain("JSON");
  });

  test("refuses to start without an exact support website", async () => {
    await expect(
      startWebsiteCrawl(
        { project: "acme", by: { name: "Ada" } },
        { ...deps(pages), hosts: async () => ["*.acme.example.test"] },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});
