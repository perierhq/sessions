import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { brotliCompressSync, gzipSync } from "zlib";
import { isBlockedAddress } from "./network-address";
import {
  BlockedAddressError,
  PINNED_FETCH_USER_AGENT,
  type PinnedFetchDeps,
  pinnedFetch,
  pinnedHttpRequest,
} from "./pinned-fetch";

const LOCAL = "127.0.0.1";
/** Text that compresses to several kilobytes, so a cut stream still holds
 *  whole blocks to decode. */
const TEXT = Array.from(
  { length: 20_000 },
  (_, i) => `item-${(i * 7919) % 10007}`,
).join(",");

describe("pinnedFetch", () => {
  let server: Server;
  let port = 0;
  const seen: Array<{
    method: string;
    path: string;
    host: string;
    body: string;
    type: string;
  }> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        seen.push({
          method: req.method ?? "",
          path: req.url ?? "",
          host: req.headers.host ?? "",
          body,
          type: req.headers["content-type"] ?? "",
        });
        if (req.url === "/moved") {
          res.writeHead(307, { location: "/elsewhere" });
          return res.end();
        }
        if (req.url === "/gzip") {
          res.writeHead(200, { "content-encoding": "gzip" });
          return res.end(gzipSync("y".repeat(10_000)));
        }
        if (req.url === "/gzip-text" || req.url === "/br-text") {
          const br = req.url === "/br-text";
          res.writeHead(200, { "content-encoding": br ? "br" : "gzip" });
          return res.end(br ? brotliCompressSync(TEXT) : gzipSync(TEXT));
        }
        if (req.url === "/odd-encoding") {
          res.writeHead(200, { "content-encoding": "compress" });
          return res.end("0123456789abcdef");
        }
        if (req.url === "/empty") {
          res.writeHead(204);
          return res.end();
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ method: req.method, body }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, LOCAL, resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  beforeEach(() => {
    seen.length = 0;
  });

  /** Resolves every name to the local test server and lets only it through,
   *  so the real node:http transport runs end to end. */
  function localDeps(resolve = async () => [LOCAL]): PinnedFetchDeps & {
    lookups: string[];
  } {
    const lookups: string[] = [];
    return {
      lookups,
      resolve: async (host) => {
        lookups.push(host);
        return resolve();
      },
      isBlocked: (address) => address !== LOCAL && isBlockedAddress(address),
      send: (target, init, isBlocked) =>
        pinnedHttpRequest(target, init, isBlocked),
    };
  }

  const at = (path: string) => `http://acme.example.test:${port}${path}`;

  test("sends method, headers and body, and keeps the hostname as Host", async () => {
    const deps = localDeps();
    const response = await pinnedFetch(
      at("/token"),
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", a: "b" }),
      },
      deps,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      method: "POST",
      body: "grant_type=refresh_token&a=b",
    });
    expect(seen).toEqual([
      {
        method: "POST",
        path: "/token",
        host: `acme.example.test:${port}`,
        body: "grant_type=refresh_token&a=b",
        type: "application/x-www-form-urlencoded",
      },
    ]);
    expect(deps.lookups).toEqual(["acme.example.test"]);
  });

  test("sends a default User-Agent and Accept unless the caller sets them", async () => {
    const sent: Record<string, string>[] = [];
    const deps: PinnedFetchDeps = {
      resolve: async () => [LOCAL],
      isBlocked: (address) => address !== LOCAL && isBlockedAddress(address),
      send: async (_target, init) => {
        sent.push(init.headers ?? {});
        return { status: 200, headers: new Headers(), body: new Uint8Array() };
      },
    };
    await pinnedFetch(at("/a"), {}, deps);
    await pinnedFetch(
      at("/b"),
      { headers: { "User-Agent": "custom", Accept: "application/json" } },
      deps,
    );
    expect(sent[0]["user-agent"]).toBe(PINNED_FETCH_USER_AGENT);
    expect(sent[0].accept).toBe("*/*");
    expect(sent[1]).toEqual({
      "User-Agent": "custom",
      Accept: "application/json",
    });
  });

  test("refuses a redirect by default and never requests its target", async () => {
    await expect(
      pinnedFetch(
        at("/moved"),
        { method: "POST", body: "secret" },
        localDeps(),
      ),
    ).rejects.toThrow(/Refusing to follow a redirect \(HTTP 307\)/);
    expect(seen.map((s) => s.path)).toEqual(["/moved"]);
  });

  test("returns a redirect unread with redirect: manual", async () => {
    const response = await pinnedFetch(
      at("/moved"),
      { redirect: "manual" },
      localDeps(),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/elsewhere");
    expect(seen.map((s) => s.path)).toEqual(["/moved"]);
  });

  test("a 204 has no body", async () => {
    const response = await pinnedFetch(at("/empty"), {}, localDeps());
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  test("a name resolving to a private address is refused before connecting", async () => {
    for (const answer of [
      ["10.0.0.1"],
      ["::ffff:a9fe:a9fe"],
      [LOCAL, "192.168.1.1"],
    ]) {
      await expect(
        pinnedFetch(
          at("/token"),
          {},
          localDeps(async () => answer),
        ),
      ).rejects.toBeInstanceOf(BlockedAddressError);
    }
    expect(seen).toEqual([]);
  });

  test("reserved names and other schemes are refused as policy", async () => {
    for (const url of [
      "http://localhost./",
      "http://db.internal/",
      "ftp://acme.example.test/",
    ])
      await expect(pinnedFetch(url, {}, localDeps())).rejects.toBeInstanceOf(
        BlockedAddressError,
      );
  });

  test("a body over the limit is refused", async () => {
    await expect(
      pinnedFetch(at("/big"), { maxBodyBytes: 4 }, localDeps()),
    ).rejects.toThrow(/exceeded the 4 bytes body limit/);
  });

  test("overflow: truncate keeps the status and the first bytes", async () => {
    const target = (path: string) => ({
      url: new URL(at(path)),
      host: "acme.example.test",
      addresses: [LOCAL],
    });
    const request = (path: string, maxBodyBytes: number) =>
      pinnedHttpRequest(
        target(path),
        {
          signal: AbortSignal.timeout(5_000),
          maxBodyBytes,
          overflow: "truncate",
        },
        (address) => address !== LOCAL,
      );
    const cut = await request("/big", 4);
    expect([
      cut.status,
      new TextDecoder().decode(cut.body),
      cut.truncated,
    ]).toEqual([200, '{"me', true]);
    const whole = await request("/big", 1_000);
    expect(whole.truncated).toBeUndefined();
    // An expansion past the limit keeps the first decoded bytes.
    const expanded = await request("/gzip", 100);
    expect([
      new TextDecoder().decode(expanded.body),
      expanded.truncated,
    ]).toEqual(["y".repeat(100), true]);
    // A stream cut before its first block has nothing to show yet.
    const header = await request("/gzip", 8);
    expect([header.status, header.body.length, header.truncated]).toEqual([
      200,
      0,
      true,
    ]);
    expect(
      new TextDecoder().decode((await request("/gzip", 20_000)).body),
    ).toBe("y".repeat(10_000));
  });

  test("overflow: truncate decodes as much of a cut compressed body as it can", async () => {
    for (const path of ["/gzip-text", "/br-text"]) {
      const cut = await pinnedHttpRequest(
        {
          url: new URL(at(path)),
          host: "acme.example.test",
          addresses: [LOCAL],
        },
        {
          signal: AbortSignal.timeout(5_000),
          maxBodyBytes: 2_000,
          overflow: "truncate",
        },
        (address) => address !== LOCAL,
      );
      const text = new TextDecoder().decode(cut.body);
      expect(cut.truncated).toBe(true);
      expect(text.length).toBeGreaterThan(0);
      expect(text.length).toBeLessThanOrEqual(2_000);
      expect(TEXT.startsWith(text)).toBe(true);
      expect(cut.undecodable).toBeUndefined();
    }
  });

  test("an unsupported content-encoding: raw bytes when truncating, refused otherwise", async () => {
    const request = (maxBodyBytes: number, overflow?: "truncate") =>
      pinnedHttpRequest(
        {
          url: new URL(at("/odd-encoding")),
          host: "acme.example.test",
          addresses: [LOCAL],
        },
        { signal: AbortSignal.timeout(5_000), maxBodyBytes, overflow },
        (address) => address !== LOCAL,
      );
    const under = await request(1_000, "truncate");
    expect([
      new TextDecoder().decode(under.body),
      under.truncated,
      under.undecodable,
    ]).toEqual(["0123456789abcdef", undefined, true]);
    const over = await request(4, "truncate");
    expect([
      new TextDecoder().decode(over.body),
      over.truncated,
      over.undecodable,
    ]).toEqual(["0123", true, true]);
    await expect(request(1_000)).rejects.toThrow(
      /unsupported content-encoding: compress/,
    );
  });

  test("the signal covers DNS", async () => {
    const controller = new AbortController();
    const fetching = pinnedFetch(
      at("/token"),
      { signal: controller.signal },
      localDeps(() => new Promise<string[]>(() => {})),
    );
    controller.abort(new Error("gave up"));
    await expect(fetching).rejects.toThrow("gave up");
    expect(seen).toEqual([]);
  });
});
