import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getConfigAsync } from "../config";
import type { RouteContext } from "./context";
import {
  __deadLettersCachesForTest,
  adminDiagnosticsDenied,
  deadLettersSnapshot,
  handleSystemRoutes,
} from "./system";

describe("dead letters snapshot cache", () => {
  test("serves the retained snapshot when a later refresh fails", async () => {
    __deadLettersCachesForTest().clear();
    let calls = 0;
    let fail = false;
    const load = () => {
      calls += 1;
      if (fail) throw new Error("actor unavailable");
      return { totals: { outbox: 1 }, page: calls };
    };
    const first = await deadLettersSnapshot(100, 0, load);
    expect(first).toEqual({ totals: { outbox: 1 }, page: 1 });

    // Expire the TTL, then make the actor fail: the last good snapshot is
    // served instead of propagating the error.
    const entry = __deadLettersCachesForTest().get("100:0")!;
    entry.at -= 10_000;
    fail = true;
    await expect(deadLettersSnapshot(100, 0, load)).resolves.toEqual({
      totals: { outbox: 1 },
      page: 1,
    });
  });

  test("keys snapshots by pagination arguments", async () => {
    __deadLettersCachesForTest().clear();
    const load = (_limit: number, offset: number) => ({ offset });
    await expect(deadLettersSnapshot(100, 0, load)).resolves.toEqual({
      offset: 0,
    });
    await expect(deadLettersSnapshot(100, 50, load)).resolves.toEqual({
      offset: 50,
    });
  });

  test("single-flights concurrent refreshes and rate-limits failures", async () => {
    __deadLettersCachesForTest().clear();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const load = () => {
      calls += 1;
      return gate.then(() => ({ call: calls }));
    };
    const a = deadLettersSnapshot(10, 0, load);
    const b = deadLettersSnapshot(10, 0, load);
    release();
    await Promise.all([a, b]);
    expect(calls).toBe(1);

    // A failing refresh with no retained value throws but blocks immediate
    // retry hammering until the TTL window passes.
    await expect(
      deadLettersSnapshot(20, 0, () => {
        throw new Error("down");
      }),
    ).rejects.toThrow("down");
    const atAfterFailure = __deadLettersCachesForTest().get("20:0")!.at;
    await expect(
      deadLettersSnapshot(20, 0, () => ({ recovered: true })),
    ).rejects.toThrow("down");
    expect(__deadLettersCachesForTest().get("20:0")!.at).toBe(atAfterFailure);

    // After the failure window a refresh succeeds again.
    const entry = __deadLettersCachesForTest().get("20:0")!;
    entry.at -= 10_000;
    await expect(
      deadLettersSnapshot(20, 0, () => ({ recovered: true })),
    ).resolves.toEqual({ recovered: true });
  });
});

describe("memory diagnostics routes", () => {
  const ENV_KEYS = [
    "OPENSESSION_CONFIG",
    "OPENSESSION_STATE_DIR",
    "OPENSESSION_GITHUB_AUTH_STORE",
    "OPENSESSION_WEB_SESSIONS_STORE",
  ] as const;
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "os-memory-routes-test-"));
    for (const k of ENV_KEYS) delete process.env[k];
    // Missing config: sign-in off.
    process.env.OPENSESSION_CONFIG = join(dir, "config.json");
    process.env.OPENSESSION_STATE_DIR = join(dir, "state");
    process.env.OPENSESSION_GITHUB_AUTH_STORE = join(dir, "github-auth.json");
    process.env.OPENSESSION_WEB_SESSIONS_STORE = join(dir, "web-sessions.json");
    await getConfigAsync();
  });

  afterEach(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
    await getConfigAsync();
    rmSync(dir, { recursive: true, force: true });
  });

  /** userPrAuth + a client id makes webAuthRequired() true. */
  async function requireSignIn(): Promise<void> {
    const path = join(
      dir,
      `signin-${Math.random().toString(36).slice(2)}.json`,
    );
    writeFileSync(
      path,
      JSON.stringify({
        integrations: {
          github: { userPrAuth: true, oauthClientId: "test-client-id" },
        },
      }),
    );
    process.env.OPENSESSION_CONFIG = path;
    await getConfigAsync();
  }

  function ctx(
    method: string,
    pathname: string,
    authUser: RouteContext["authUser"] = null,
  ): RouteContext {
    const url = new URL(`http://localhost${pathname}`);
    return {
      req: new Request(url, { method }),
      url,
      path: url.pathname,
      publicPrefix: "",
      authUser,
    };
  }

  const admin = { login: "admin", name: "Admin User" };

  function snapshotFiles(): string[] {
    const diagnostics = join(dir, "state", "diagnostics");
    return existsSync(diagnostics) ? readdirSync(diagnostics) : [];
  }

  test("GET /api/admin/memory reports process, heap and collections", async () => {
    const res = await handleSystemRoutes(ctx("GET", "/api/admin/memory"));
    expect(res?.status).toBe(200);
    expect(res?.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res!.json()) as Record<string, any>;
    expect(body.pid).toBe(process.pid);
    expect(typeof body.uptimeSec).toBe("number");
    expect(typeof body.bunVersion).toBe("string");
    for (const key of ["rss", "heapUsed", "heapTotal", "external"])
      expect(typeof body.memoryUsage[key]).toBe("number");
    expect(typeof body.heap.heapSize).toBe("number");
    expect(Array.isArray(body.heap.topObjectTypes)).toBe(true);
    expect(Array.isArray(body.collections)).toBe(true);
    for (const c of body.collections) {
      expect(typeof c.name).toBe("string");
      expect(typeof c.size).toBe("number");
    }
  });

  test("both routes refuse a request without a session when sign-in is on", async () => {
    await requireSignIn();
    const report = await handleSystemRoutes(ctx("GET", "/api/admin/memory"));
    expect(report?.status).toBe(401);
    const snapshot = await handleSystemRoutes(
      ctx("POST", "/api/admin/memory/heap-snapshot"),
    );
    expect(snapshot?.status).toBe(401);
    expect(snapshotFiles()).toEqual([]);
  });

  test("a signed-in caller gets the report when sign-in is on", async () => {
    await requireSignIn();
    const res = await handleSystemRoutes(
      ctx("GET", "/api/admin/memory", admin),
    );
    expect(res?.status).toBe(200);
  });

  test("the snapshot route only answers POST", async () => {
    expect(
      await handleSystemRoutes(ctx("GET", "/api/admin/memory/heap-snapshot")),
    ).toBeUndefined();
  });

  test("POST /api/admin/memory/heap-snapshot writes a 0600 file under the state dir", async () => {
    await requireSignIn();
    const res = await handleSystemRoutes(
      ctx("POST", "/api/admin/memory/heap-snapshot", admin),
    );
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as {
      ok: boolean;
      path: string;
      bytes: number;
      durationMs: number;
    };
    expect(body.ok).toBe(true);
    expect(body.path.startsWith(join(dir, "state", "diagnostics") + "/")).toBe(
      true,
    );
    expect(body.bytes).toBeGreaterThan(0);
    expect(statSync(body.path).mode & 0o777).toBe(0o600);
    expect(snapshotFiles()).toHaveLength(1);
  }, 60_000);

  test("adminDiagnosticsDenied only lets a session through when sign-in is on", () => {
    const anonymous = ctx("GET", "/api/admin/memory");
    expect(adminDiagnosticsDenied(anonymous, () => false)).toBeUndefined();
    expect(adminDiagnosticsDenied(anonymous, () => true)?.status).toBe(401);
    expect(
      adminDiagnosticsDenied(
        ctx("GET", "/api/admin/memory", admin),
        () => true,
      ),
    ).toBeUndefined();
  });
});
