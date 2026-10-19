/**
 * POST /api/admin/github-pr-session-backfill: a dry run unless the body says
 * `apply: true`, a clamped PR lookup limit, and the admin check in the
 * handler on top of the global gate. The backfill itself is covered in
 * agents/github/pr-session-archive.test.ts; here it only records its options.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { PrSessionBackfillOptions } from "../../agents/github/pr-session-archive";
import { getConfigAsync } from "../config";
import type { RouteContext } from "./context";

const runs: PrSessionBackfillOptions[] = [];

const realArchive = await import("../../agents/github/pr-session-archive");
mock.module("../../agents/github/pr-session-archive", () => ({
  ...realArchive,
  backfillClosedPrSessions: async (options: PrSessionBackfillOptions) => {
    runs.push(options);
    return {
      dryRun: !options.apply,
      limit: options.limit,
      checkedPrs: 0,
      remainingPrs: 0,
      rateLimited: false,
      candidates: [],
      archived: [],
      skippedRunning: [],
      unknownPrs: [],
    };
  },
}));

const { handleSystemRoutes } = await import("./system");

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
  runs.length = 0;
  dir = mkdtempSync(join(tmpdir(), "os-pr-backfill-route-test-"));
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
  const path = join(dir, "signin.json");
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

const PATH = "/api/admin/github-pr-session-backfill";

function ctx(
  body?: unknown,
  authUser: RouteContext["authUser"] = null,
  method = "POST",
): RouteContext {
  const url = new URL(`http://localhost${PATH}`);
  return {
    req: new Request(url, {
      method,
      ...(body === undefined
        ? {}
        : {
            body: typeof body === "string" ? body : JSON.stringify(body),
            headers: { "content-type": "application/json" },
          }),
    }),
    url,
    path: url.pathname,
    publicPrefix: "",
    authUser,
  };
}

async function post(body?: unknown, authUser?: RouteContext["authUser"]) {
  const res = await handleSystemRoutes(ctx(body, authUser));
  return { res: res!, body: (await res!.json()) as Record<string, unknown> };
}

test("a dry run by default, whatever the body", async () => {
  await post();
  await post("not json");
  await post({});
  await post({ apply: "true" });
  await post({ apply: 1 });

  expect(runs.map((run) => run.apply)).toEqual([
    false,
    false,
    false,
    false,
    false,
  ]);
});

test("archives only when apply is exactly true", async () => {
  const { res, body } = await post({ apply: true });

  expect(res.status).toBe(200);
  expect(body.dryRun).toBe(false);
  expect(runs).toEqual([{ apply: true, limit: 200 }]);
});

test("parses and clamps the limit", async () => {
  await post({ limit: 50 });
  await post({ limit: 12.9 });
  await post({ limit: 10_000 });
  await post({ limit: 0 });
  await post({ limit: -4 });
  await post({ limit: "300" });

  expect(runs.map((run) => run.limit)).toEqual([50, 12, 500, 200, 200, 200]);
});

test("refuses a request without a session when sign-in is on", async () => {
  await requireSignIn();

  const { res } = await post({ apply: true });

  expect(res.status).toBe(401);
  expect(runs).toEqual([]);
});

test("lets a signed-in caller through when sign-in is on", async () => {
  await requireSignIn();

  const { res } = await post({}, { login: "admin", name: "Admin User" });

  expect(res.status).toBe(200);
  expect(runs).toEqual([{ apply: false, limit: 200 }]);
});

test("answers POST only", async () => {
  const res = await handleSystemRoutes(ctx(undefined, null, "GET"));
  expect(res).toBeUndefined();
  expect(runs).toEqual([]);
});
