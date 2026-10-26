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
        "<html><head><title>Export</title></head><body><p>Export as CSV from Settings.</p></body></html>",
      ),
    });
    const b = stubDeps({
      [url]: html(
        "<html>\n  <head><title>Export</title></head>\n<body>\n\n<p>Export   as CSV\n from   Settings.</p>\n</body></html>",
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
      "https://acme.example.test/new": html("<p>New page</p>"),
    });
    const result = await fetchPage(
      "https://acme.example.test/old",
      HOSTS,
      deps,
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.url).toBe("https://acme.example.test/new");
    expect(result.text).toBe("New page");
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
