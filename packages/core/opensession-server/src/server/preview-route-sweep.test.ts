import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getConfigAsync } from "./config";

/**
 * Caddy outlives the gateway. A Portal route whose service stopped before a
 * restart stayed in Caddy for good, proxying to a closed port, because only
 * routes in the process-local cache were ever deleted. The sweep removes the
 * ones nothing owns, through the admin API, and keeps every route a Portal
 * or Sandbox still needs.
 */

const ENV_KEYS = ["OPENSESSION_CONFIG", "PREVIEW_HOST"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

const servers = new Map<string, unknown>();
const requests: string[] = [];
let caddy: ReturnType<typeof Bun.serve>;
let root: string;

beforeAll(async () => {
  caddy = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const key = path.split("/").pop() ?? "";
      requests.push(`${req.method} ${key}`);
      if (req.method === "GET" && key === "servers")
        return Response.json(Object.fromEntries(servers));
      if (req.method === "GET")
        return servers.has(key)
          ? Response.json(servers.get(key))
          : new Response("unknown", { status: 404 });
      if (req.method === "PUT") {
        servers.set(key, await req.json());
        return new Response("");
      }
      if (req.method === "DELETE") {
        servers.delete(key);
        return new Response("");
      }
      return new Response("nope", { status: 405 });
    },
  });
  root = mkdtempSync(join(tmpdir(), "acme-portal-route-sweep-"));
  writeFileSync(
    join(root, "config.json"),
    JSON.stringify({
      repos: {},
      server: {
        caddyAdmin: `http://127.0.0.1:${caddy.port}`,
        previewHost: "portals.example.test",
      },
    }),
  );
  process.env.OPENSESSION_CONFIG = join(root, "config.json");
  process.env.PREVIEW_HOST = "portals.example.test";
  await getConfigAsync();
});

afterAll(() => {
  caddy.stop(true);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
});

describe("stale Portal route sweep", () => {
  test("removes abandoned routes after a grace period and keeps owned ones", async () => {
    const {
      ensureAuthenticatedPortalRoute,
      previewServerConfig,
      sweepStalePortalRoutes,
    } = await import("./preview");
    const route = (httpsPort: number, upstream: number) =>
      previewServerConfig(
        httpsPort,
        `127.0.0.1:${upstream}`,
        "portals.example.test",
      );
    servers.clear();
    // Abandoned host Portal: nothing listens, no Portal record.
    servers.set("preview_10001", route(10001, 4001));
    // A host service that is up: its status check adopts the route.
    servers.set("preview_9100", route(9100, 3100));
    // A sleeping host Portal: its record still wants the route.
    servers.set("preview_9200", route(9200, 3200));
    // A sleeping Sandbox keeps its allocation and its URL.
    servers.set("preview_20001", route(20001, 41001));
    // A Sandbox that was torn down without its route.
    servers.set("preview_20002", route(20002, 41002));
    // Not a Portal at all.
    servers.set("srv0", { listen: ["127.0.0.1:443"] });
    // Registered by this process just now.
    expect(await ensureAuthenticatedPortalRoute(20003, "127.0.0.1:41003")).toBe(
      "https://portals.example.test:20003",
    );

    let now = 1_000_000;
    const deps = {
      now: () => now,
      isListening: async (port: number) => port === 3100,
      hostPortalOwned: async (sourcePort: number) => sourcePort === 3200,
      sandboxAllocated: (httpsPort: number) => httpsPort === 20001,
    };
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      // First sighting starts the grace period.
      expect(await sweepStalePortalRoutes(deps)).toEqual({ removed: [] });
      now += 5 * 60_000;
      expect(await sweepStalePortalRoutes(deps)).toEqual({ removed: [] });
      now += 6 * 60_000;
      const { removed } = await sweepStalePortalRoutes(deps);
      expect(removed.sort()).toEqual([10001, 20002]);
    } finally {
      log.mockRestore();
    }
    expect([...servers.keys()].sort()).toEqual([
      "preview_20001",
      "preview_20003",
      "preview_9100",
      "preview_9200",
      "srv0",
    ]);
    expect(requests.filter((r) => r.startsWith("DELETE")).sort()).toEqual([
      "DELETE preview_10001",
      "DELETE preview_20002",
    ]);
  });

  test("a route whose service comes back before the grace ends is kept", async () => {
    const { previewServerConfig, sweepStalePortalRoutes } =
      await import("./preview");
    servers.clear();
    servers.set(
      "preview_10004",
      previewServerConfig(10004, "127.0.0.1:4004", "portals.example.test"),
    );
    let now = 5_000_000;
    let up = false;
    const deps = {
      now: () => now,
      isListening: async () => up,
      hostPortalOwned: async () => false,
      sandboxAllocated: () => false,
    };
    await sweepStalePortalRoutes(deps);
    up = true;
    now += 11 * 60_000;
    await sweepStalePortalRoutes(deps);
    up = false;
    now += 1 * 60_000;
    // Down again: the grace starts over.
    expect(await sweepStalePortalRoutes(deps)).toEqual({ removed: [] });
    expect(servers.has("preview_10004")).toBe(true);
  });

  test("finds the app upstream, not the sign-in check", async () => {
    const { previewServerConfig, portalRouteUpstreamPort } =
      await import("./preview");
    expect(
      portalRouteUpstreamPort(
        previewServerConfig(10005, "127.0.0.1:4005", "portals.example.test"),
      ),
    ).toBe(4005);
    expect(portalRouteUpstreamPort({ listen: [":1"] })).toBeNull();
  });
});
