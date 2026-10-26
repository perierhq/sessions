import { describe, expect, test } from "bun:test";
import {
  type FetchedResponse,
  isBlockedAddress,
  type WebFetchDeps,
} from "../../web-fetch";
import { fetchPage, normalizedPageText, pageHash } from "./web";

const PUBLIC = "203.0.113.10";
const HOSTS = ["acme.example.test"];

/** No DNS, no sockets: every name resolves to a public test address and
 *  the transport answers from `pages` (by URL) and records each hop. */
function stubDeps(pages: Record<string, FetchedResponse>) {
  const dialled: string[] = [];
  const deps: WebFetchDeps = {
    resolve: async () => [PUBLIC],
    isBlocked: isBlockedAddress,
    request: async (target) => {
      dialled.push(target.url.toString());
      const page = pages[target.url.toString()];
      return (
        page ?? { status: 404, headers: new Headers(), body: new Uint8Array() }
      );
    },
  };
  return { deps, dialled };
}

function html(body: string): FetchedResponse {
  return {
    status: 200,
    headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
    body: new TextEncoder().encode(body),
  };
}

/** Enough prose for a page to count as readable (≥ 200 characters). */
const PROSE =
  "Exports run every night and keep thirty days of history. Pick the columns you need, choose CSV or JSON, and the file arrives by email once it is ready. Large workspaces may take an hour; the export page shows progress.";

function redirect(location: string): FetchedResponse {
  return {
    status: 302,
    headers: new Headers({ location }),
    body: new Uint8Array(),
  };
}

describe("page text and hash", () => {
  test("the same page with different whitespace hashes equal", async () => {
    const url = "https://acme.example.test/export";
    const a = stubDeps({
      [url]: html(
        `<html><head><title>Export</title></head><body><p>Export as CSV from Settings.</p><p>${PROSE}</p></body></html>`,
      ),
    });
    const b = stubDeps({
      [url]: html(
        `<html>\n  <head><title>Export</title></head>\n<body>\n\n<p>Export   as CSV\n from   Settings.</p>\n<p>${PROSE.replaceAll(" ", "  ")}</p></body></html>`,
      ),
    });
    const first = await fetchPage(url, HOSTS, a.deps);
    const second = await fetchPage(url, HOSTS, b.deps);
    if ("error" in first || "error" in second) throw new Error("fetch failed");
    expect(first.title).toBe("Export");
    expect(first.text).toContain("Export as CSV from Settings.");
    expect(first.hash).toBe(second.hash);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("changed text hashes differ", () => {
    expect(pageHash("Export as CSV")).not.toBe(pageHash("Export as JSON"));
    expect(pageHash("a  b\n\nc")).toBe(pageHash(" a b c "));
  });

  test("plain text is kept as text", async () => {
    const page = await normalizedPageText(
      "line one\r\n\r\n\r\nline two  ",
      "text/plain",
    );
    expect(page.text).toBe("line one\n\nline two");
  });
});

describe("exact hosts only", () => {
  test("a subdomain of a listed host is refused", async () => {
    const { deps, dialled } = stubDeps({});
    const result = await fetchPage(
      "https://docs.acme.example.test/export",
      HOSTS,
      deps,
    );
    expect("error" in result).toBe(true);
    expect(dialled).toEqual([]);
  });

  test("a redirect to another host is refused before it is dialled", async () => {
    const { deps, dialled } = stubDeps({
      "https://acme.example.test/export": redirect(
        "https://elsewhere.example.test/export",
      ),
      "https://elsewhere.example.test/export": html("<p>other</p>"),
    });
    const result = await fetchPage(
      "https://acme.example.test/export",
      HOSTS,
      deps,
    );
    expect("error" in result).toBe(true);
    expect(dialled).toEqual(["https://acme.example.test/export"]);
  });

  test("a redirect within the host is followed", async () => {
    const { deps } = stubDeps({
      "https://acme.example.test/old": redirect("/new"),
      "https://acme.example.test/new": html(`<p>New page</p><p>${PROSE}</p>`),
    });
    const result = await fetchPage(
      "https://acme.example.test/old",
      HOSTS,
      deps,
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.url).toBe("https://acme.example.test/new");
    expect(result.text).toStartWith("New page\n");
  });

  test("a wildcard entry never matches (no wildcard crawling)", async () => {
    const { deps, dialled } = stubDeps({
      "https://docs.acme.example.test/export": html("<p>x</p>"),
    });
    const result = await fetchPage(
      "https://docs.acme.example.test/export",
      ["*.acme.example.test"],
      deps,
    );
    expect("error" in result).toBe(true);
    expect(dialled).toEqual([]);
  });

  test("an error status is an error", async () => {
    const { deps } = stubDeps({});
    const result = await fetchPage(
      "https://acme.example.test/missing",
      HOSTS,
      deps,
    );
    expect(result).toEqual({ error: expect.stringContaining("404") });
  });
});

describe("https only, checked before DNS", () => {
  function tracked(pages: Record<string, FetchedResponse>) {
    const stub = stubDeps(pages);
    const resolved: string[] = [];
    const deps: WebFetchDeps = {
      ...stub.deps,
      resolve: async (host) => {
        resolved.push(host);
        return [PUBLIC];
      },
    };
    return { deps, dialled: stub.dialled, resolved };
  }

  test("a plain http page is refused before anything is dialled", async () => {
    const { deps, dialled, resolved } = tracked({
      "http://acme.example.test/export": html(`<p>${PROSE}</p>`),
    });
    const result = await fetchPage(
      "http://acme.example.test/export",
      HOSTS,
      deps,
    );
    expect("error" in result).toBe(true);
    expect(dialled).toEqual([]);
    expect(resolved).toEqual([]);
  });

  test("a redirect from https to http is refused", async () => {
    const { deps, dialled } = tracked({
      "https://acme.example.test/export": redirect(
        "http://acme.example.test/export",
      ),
      "http://acme.example.test/export": html(`<p>${PROSE}</p>`),
    });
    const result = await fetchPage(
      "https://acme.example.test/export",
      HOSTS,
      deps,
    );
    expect("error" in result).toBe(true);
    expect(dialled).toEqual(["https://acme.example.test/export"]);
  });

  test("an off-host redirect is refused before its name is resolved", async () => {
    const { deps, resolved } = tracked({
      "https://acme.example.test/export": redirect(
        "https://elsewhere.example.test/export",
      ),
    });
    const result = await fetchPage(
      "https://acme.example.test/export",
      HOSTS,
      deps,
    );
    expect("error" in result).toBe(true);
    expect(resolved).toEqual(["acme.example.test"]);
  });
});

describe("what counts as the page's text", () => {
  const url = "https://acme.example.test/export";

  test("text is NFC-normalised, so composed and decomposed accents hash equal", async () => {
    const composed = await fetchPage(
      url,
      HOSTS,
      stubDeps({ [url]: html(`<p>Caf\u00e9 exports. ${PROSE}</p>`) }).deps,
    );
    const decomposed = await fetchPage(
      url,
      HOSTS,
      stubDeps({ [url]: html(`<p>Cafe\u0301 exports. ${PROSE}</p>`) }).deps,
    );
    if ("error" in composed || "error" in decomposed)
      throw new Error("fetch failed");
    expect(decomposed.text).toStartWith("Caf\u00e9 exports.");
    expect(decomposed.hash).toBe(composed.hash);
  });

  test("header and time elements don't count", async () => {
    const a = await fetchPage(
      url,
      HOSTS,
      stubDeps({
        [url]: html(
          `<header>Signed in as someone</header><p>${PROSE}</p><p>Updated <time>2026-10-01</time></p>`,
        ),
      }).deps,
    );
    const b = await fetchPage(
      url,
      HOSTS,
      stubDeps({
        [url]: html(
          `<header>Welcome back</header><p>${PROSE}</p><p>Updated <time>2026-10-26</time></p>`,
        ),
      }).deps,
    );
    if ("error" in a || "error" in b) throw new Error("fetch failed");
    expect(a.text).not.toContain("Signed in");
    expect(a.hash).toBe(b.hash);
  });

  test("a page with almost no readable text is an error", async () => {
    const result = await fetchPage(
      url,
      HOSTS,
      stubDeps({ [url]: html("<p>Loading…</p>") }).deps,
    );
    expect(result).toEqual({ error: expect.any(String) });
  });

  test("a page over 256 KB of text is an error", async () => {
    const result = await fetchPage(
      url,
      HOSTS,
      stubDeps({ [url]: html(`<p>${"word ".repeat(60_000)}</p>`) }).deps,
    );
    expect(result).toEqual({ error: expect.any(String) });
  });
});
