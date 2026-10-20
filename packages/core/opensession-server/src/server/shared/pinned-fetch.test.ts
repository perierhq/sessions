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
import { isBlockedAddress } from "./network-address";
import {
  BlockedAddressError,
  PINNED_FETCH_USER_AGENT,
  type PinnedFetchDeps,
  pinnedFetch,
  pinnedHttpRequest,
} from "./pinned-fetch";

const LOCAL = "127.0.0.1";

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
