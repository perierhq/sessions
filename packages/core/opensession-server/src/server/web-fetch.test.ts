/**
 * The web-fetch pieces worth pinning: the address guard, HTML extraction, and
 * the cache/handle contract that keeps a long page out of the transcript.
 *
 * The guard gets the most attention because it is the part that fails
 * dangerously rather than visibly: the caller is a model acting on text it
 * read somewhere, so a URL is an untrusted input, and a redirect is a second
 * untrusted input the first one chose.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const DIR = mkdtempSync(join(tmpdir(), "web-fetch-"));
const PREV = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = DIR;

const {
  assertFetchableUrl,
  decodeEntities,
  fetchChecked,
  fetchWeb,
  htmlToText,
  isBlockedAddress,
  pinnedLookup,
  pinnedRequest,
  readFetched,
  resolveFetchTarget,
} = await import("./web-fetch");
type WebFetchDeps = import("./web-fetch").WebFetchDeps;
type FetchedResponse = import("./web-fetch").FetchedResponse;

/** A documentation address (TEST-NET-3): public as far as the guard knows. */
const PUBLIC = "203.0.113.10";

beforeEach(() => {
  process.env.OPENSESSION_STATE_DIR = DIR;
});

afterAll(() => {
  if (PREV === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = PREV;
  rmSync(DIR, { recursive: true, force: true });
});

describe("isBlockedAddress", () => {
  test("blocks the address ranges an SSRF actually aims at", () => {
    for (const ip of [
      "127.0.0.1",
      "0.0.0.0",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "100.64.0.1", // CGNAT / tailnet
      "100.127.255.255",
      "224.0.0.1",
      "::1",
      "fe80::1",
      "fd00::1",
      "::ffff:127.0.0.1", // v4-mapped loopback
      "::ffff:7f00:1", // the same, as new URL() spells it
      "::ffff:a9fe:a9fe", // v4-mapped metadata
      "::7f00:1", // v4-compatible loopback
      "64:ff9b::a9fe:a9fe", // NAT64 metadata
      "2002:7f00:1::1", // 6to4 loopback
    ]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });

  test("allows ordinary public addresses", () => {
    for (const ip of [
      "8.8.8.8",
      "1.1.1.1",
      "140.82.121.4",
      "172.32.0.1",
      "100.63.255.255",
      "2606:4700::1111",
      "::ffff:8.8.8.8",
    ]) {
      expect(isBlockedAddress(ip)).toBe(false);
    }
  });

  test("the 172.16/12 boundary is not off by one", () => {
    expect(isBlockedAddress("172.15.255.255")).toBe(false);
    expect(isBlockedAddress("172.16.0.0")).toBe(true);
    expect(isBlockedAddress("172.31.255.255")).toBe(true);
    expect(isBlockedAddress("172.32.0.0")).toBe(false);
  });
});

describe("assertFetchableUrl", () => {
  test("refuses a non-http scheme", async () => {
    await expect(assertFetchableUrl("file:///etc/passwd")).rejects.toThrow(
      /http/i,
    );
    await expect(assertFetchableUrl("ftp://example.com")).rejects.toThrow(
      /http/i,
    );
  });

  test("refuses a literal private address without needing DNS", async () => {
    await expect(
      assertFetchableUrl("http://127.0.0.1:3850/api/sessions"),
    ).rejects.toThrow(/private/i);
    await expect(
      assertFetchableUrl("http://169.254.169.254/latest/meta-data/"),
    ).rejects.toThrow(/private/i);
    for (const url of [
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:a9fe:a9fe]/latest/meta-data/",
      "http://[::7f00:1]/",
      "http://[64:ff9b::7f00:1]/",
      "http://[2002:a9fe:a9fe::]/",
    ]) {
      await expect(assertFetchableUrl(url)).rejects.toThrow(/private/i);
    }
    await expect(assertFetchableUrl("http://[::1]/")).rejects.toThrow(
      /private/i,
    );
  });

  test("refuses reserved private NAMES, which never resolve publicly", async () => {
    for (const url of [
      "http://localhost:3850/",
      "http://foo.localhost/",
      "http://db.internal/",
      "http://router.home.arpa/",
    ]) {
      await expect(assertFetchableUrl(url)).rejects.toThrow(/private/i);
    }
  });

  test("rejects a malformed URL rather than guessing at one", async () => {
    await expect(assertFetchableUrl("not a url")).rejects.toThrow(/not a url/i);
  });
});

describe("htmlToText", () => {
  test("drops chrome and script content, keeps prose", async () => {
    const { text } = await htmlToText(
      `<html><head><style>body{color:red}</style></head><body>
			 <nav>Home About Contact</nav>
			 <script>window.tracking = 1</script>
			 <p>The actual sentence.</p>
			 <footer>Copyright</footer></body></html>`,
    );
    expect(text).toContain("The actual sentence.");
    expect(text).not.toContain("window.tracking");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("Home About Contact");
    expect(text).not.toContain("Copyright");
  });

  test("reads the title", async () => {
    const { title } = await htmlToText(
      "<html><head><title>  A Page  </title></head><body>x</body></html>",
    );
    expect(title).toBe("A Page");
  });

  test("block elements become line breaks, so paragraphs do not run together", async () => {
    const { text } = await htmlToText("<p>First.</p><p>Second.</p>");
    expect(text).toBe("First.\nSecond.");
  });

  test("collapses runaway whitespace instead of shipping it as tokens", async () => {
    const { text } = await htmlToText("<p>a</p>\n\n\n\n\n<p>b</p>");
    expect(text).not.toMatch(/\n{3,}/);
  });
});

describe("decodeEntities", () => {
  test("named, decimal and hex entities", () => {
    expect(decodeEntities("a &amp; b")).toBe("a & b");
    expect(decodeEntities("&lt;tag&gt;")).toBe("<tag>");
    expect(decodeEntities("&#65;&#x42;")).toBe("AB");
    expect(decodeEntities("&nbsp;")).toBe(" ");
  });

  test("leaves an unknown entity alone rather than mangling it", () => {
    expect(decodeEntities("&notarealentity;")).toBe("&notarealentity;");
  });
});

describe("fetch → handle → read", () => {
  /** A local server would be blocked by the address guard (correctly), so the
   *  cache/handle contract is exercised through an injected resolver and
   *  transport. */
  function stubDeps(
    respond: () => FetchedResponse,
  ): WebFetchDeps & { calls: () => number } {
    let calls = 0;
    return {
      resolve: async () => [PUBLIC],
      isBlocked: isBlockedAddress,
      request: async () => {
        calls += 1;
        return respond();
      },
      calls: () => calls,
    };
  }

  function ok(body: string, contentType: string): FetchedResponse {
    return {
      status: 200,
      headers: new Headers({ "content-type": contentType }),
      body: new TextEncoder().encode(body),
    };
  }

  async function withStubbedFetch<T>(
    body: string,
    contentType: string,
    fn: (deps: WebFetchDeps) => Promise<T>,
  ): Promise<T> {
    return fn(stubDeps(() => ok(body, contentType)));
  }

  const LONG = `<html><head><title>Docs</title></head><body><p>${"filler ".repeat(2000)}</p><p>The needle is here.</p></body></html>`;

  test("returns a bounded head plus a handle, not the whole page", async () => {
    const page = await withStubbedFetch(LONG, "text/html", (deps) =>
      fetchWeb(
        "https://example.com/docs",
        { refresh: true, headChars: 500 },
        deps,
      ),
    );
    expect(page.head.length).toBe(500);
    expect(page.truncated).toBe(true);
    expect(page.chars).toBeGreaterThan(5000);
    expect(page.title).toBe("Docs");
    expect(page.handle).toMatch(/^web_[0-9a-f]{16}$/);
  });

  test("read_page finds a passage the head never showed", async () => {
    const page = await withStubbedFetch(LONG, "text/html", (deps) =>
      fetchWeb(
        "https://example.com/docs2",
        { refresh: true, headChars: 300 },
        deps,
      ),
    );
    expect(page.head).not.toContain("needle");
    const slice = readFetched(page.handle, { find: "needle" });
    expect(slice.matches).toBe(1);
    expect(slice.text).toContain("The needle is here.");
  });

  test("a search that misses says so instead of returning the page", () => {
    const handle = "web_0000000000000000";
    expect(() => readFetched(handle)).toThrow(/expired|never fetched/i);
  });

  test("offset reads walk the body without re-fetching", async () => {
    const page = await withStubbedFetch(
      "0123456789".repeat(100),
      "text/plain",
      (deps) =>
        fetchWeb(
          "https://example.com/plain",
          { refresh: true, headChars: 200 },
          deps,
        ),
    );
    const slice = readFetched(page.handle, { offset: 500, limit: 200 });
    expect(slice.offset).toBe(500);
    expect(slice.text.length).toBe(200);
    expect(slice.truncated).toBe(true);
  });

  test("a second fetch of the same URL is served from disk", async () => {
    const deps = stubDeps(() => ok("<p>cached body</p>", "text/html"));
    await fetchWeb("https://example.com/cacheme", { refresh: true }, deps);
    await fetchWeb("https://example.com/cacheme", {}, deps);
    expect(deps.calls()).toBe(1);
  });

  test("raw mode keeps the markup, text mode strips it", async () => {
    const raw = await withStubbedFetch("<p>hi</p>", "text/html", (deps) =>
      fetchWeb("https://example.com/raw", { refresh: true, mode: "raw" }, deps),
    );
    expect(raw.head).toContain("<p>");
    const text = await withStubbedFetch("<p>hi</p>", "text/html", (deps) =>
      fetchWeb(
        "https://example.com/text",
        { refresh: true, mode: "text" },
        deps,
      ),
    );
    expect(text.head).not.toContain("<p>");
    expect(text.head).toContain("hi");
  });
});

describe("DNS answers are checked and pinned", () => {
  const LOCAL = "127.0.0.1";
  /** Lets the local test server through and nothing else private, so the
   *  real node:http transport can be exercised end to end. */
  const allowOnlyLocal = (address: string) =>
    address !== LOCAL && isBlockedAddress(address);

  let server: ReturnType<typeof Bun.serve>;
  const hosts: string[] = [];
  beforeAll(() => {
    server = Bun.serve({
      hostname: LOCAL,
      port: 0,
      fetch(req) {
        hosts.push(req.headers.get("host") ?? "");
        const url = new URL(req.url);
        if (url.pathname === "/hop")
          return new Response(null, {
            status: 302,
            headers: {
              location: `http://second.example.test:${server.port}/end`,
            },
          });
        return new Response(`reached ${url.pathname}`, {
          headers: { "content-type": "text/plain" },
        });
      },
    });
  });
  afterAll(() => server.stop(true));
  beforeEach(() => {
    hosts.length = 0;
  });

  /** A resolver that answers from a script, one answer per call per host. */
  function scripted(answers: Record<string, string[][]>) {
    const asked: string[] = [];
    const resolve = async (hostname: string) => {
      asked.push(hostname);
      const queue = answers[hostname];
      if (!queue?.length) throw new Error(`unexpected lookup ${hostname}`);
      return queue.length > 1 ? queue.shift()! : queue[0]!;
    };
    return { resolve, asked };
  }

  test("a hostname that resolves to a private address is refused", async () => {
    for (const answer of [
      ["10.0.0.5"],
      ["169.254.169.254"],
      ["::ffff:7f00:1"],
      [PUBLIC, "192.168.1.1"],
    ]) {
      const { resolve } = scripted({ "acme.example.test": [answer] });
      await expect(
        fetchChecked("http://acme.example.test/", undefined, {
          resolve,
          isBlocked: isBlockedAddress,
          request: () => {
            throw new Error("must not connect");
          },
        }),
      ).rejects.toThrow(/private address/);
    }
  });

  test("the connection dials the checked address and never resolves again", async () => {
    // A rebinding resolver: the first answer passes the check, a later one
    // would point somewhere else. Only one lookup may happen per hop.
    const { resolve, asked } = scripted({
      "acme.example.test": [[LOCAL], ["10.9.9.9"]],
    });
    const { response, finalUrl } = await fetchChecked(
      `http://acme.example.test:${server.port}/page`,
      undefined,
      { resolve, isBlocked: allowOnlyLocal, request: pinnedRequest },
    );
    expect(new TextDecoder().decode(response.body)).toBe("reached /page");
    expect(asked).toEqual(["acme.example.test"]);
    expect(hosts).toEqual([`acme.example.test:${server.port}`]);
    expect(finalUrl).toBe(`http://acme.example.test:${server.port}/page`);
  });

  test("every redirect hop is resolved, checked and pinned", async () => {
    const { resolve, asked } = scripted({
      "first.example.test": [[LOCAL]],
      "second.example.test": [[LOCAL]],
    });
    const { response } = await fetchChecked(
      `http://first.example.test:${server.port}/hop`,
      undefined,
      { resolve, isBlocked: allowOnlyLocal, request: pinnedRequest },
    );
    expect(new TextDecoder().decode(response.body)).toBe("reached /end");
    expect(asked).toEqual(["first.example.test", "second.example.test"]);
    expect(hosts).toEqual([
      `first.example.test:${server.port}`,
      `second.example.test:${server.port}`,
    ]);
  });

  test("a redirect hop that resolves privately is refused", async () => {
    const { resolve } = scripted({
      "first.example.test": [[LOCAL]],
      "second.example.test": [["169.254.169.254"]],
    });
    await expect(
      fetchChecked(`http://first.example.test:${server.port}/hop`, undefined, {
        resolve,
        isBlocked: allowOnlyLocal,
        request: pinnedRequest,
      }),
    ).rejects.toThrow(/private address 169\.254\.169\.254/);
    expect(hosts).toEqual([`first.example.test:${server.port}`]);
  });

  test("resolveFetchTarget returns the checked addresses to dial", async () => {
    const target = await resolveFetchTarget("https://acme.example.test/x", {
      resolve: async () => [PUBLIC, "2606:4700::1111"],
      isBlocked: isBlockedAddress,
    });
    expect(target.host).toBe("acme.example.test");
    expect(target.addresses).toEqual([PUBLIC, "2606:4700::1111"]);
  });

  test("the pinned lookup answers only with checked addresses", () => {
    const lookup = pinnedLookup(
      { host: "acme.example.test", addresses: [PUBLIC, "2606:4700::1111"] },
      isBlockedAddress,
    );
    const answer = (hostname: string, options: object) =>
      new Promise<unknown>((resolve) =>
        lookup(hostname, options, (error, address, family) =>
          resolve(error ? `error: ${error.message}` : { address, family }),
        ),
      );
    return Promise.all([
      expect(answer("acme.example.test", { all: true })).resolves.toEqual({
        address: [
          { address: PUBLIC, family: 4 },
          { address: "2606:4700::1111", family: 6 },
        ],
        family: undefined,
      }),
      expect(answer("acme.example.test", { family: 6 })).resolves.toEqual({
        address: "2606:4700::1111",
        family: 6,
      }),
      expect(answer("other.example.test", {})).resolves.toMatch(/error/),
      expect(
        new Promise((resolve) =>
          pinnedLookup(
            { host: "acme.example.test", addresses: ["10.0.0.1"] },
            isBlockedAddress,
          )("acme.example.test", {}, (error) => resolve(error?.message)),
        ),
      ).resolves.toMatch(/private address/),
    ]);
  });
});
