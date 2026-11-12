import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteContext } from "./context";
import {
  __setMainspringRouteDepsForTest,
  handleMainspringRoutes,
} from "./mainspring";
import { __setMainspringDepsForTest } from "../mainspring";
import { piModelUnservableReason } from "../pi-model-routing";
import { __clearJsonFileCacheForTest } from "../shared/json-file-cache";

const KEY = "sk-ms-route-secret-abcd";
let scratch = "";
const saved: Record<string, string | undefined> = {};
const restores: Array<() => void> = [];
let audits: Array<Record<string, unknown>> = [];
let refreshes = 0;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "mainspring-route-test-"));
  for (const name of [
    "OPENSESSION_MODEL_PROVIDERS_CONFIG",
    "OPENSESSION_WORKSPACE_SECRETS_STORE",
  ])
    saved[name] = process.env[name];
  process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG = join(
    scratch,
    "model-providers.json",
  );
  process.env.OPENSESSION_WORKSPACE_SECRETS_STORE = join(
    scratch,
    "workspace-secrets.json",
  );
  __clearJsonFileCacheForTest();
  audits = [];
  refreshes = 0;
  restores.push(
    __setMainspringRouteDepsForTest({
      isOwner: (_ctx, person) => person === "Ada",
      refreshPicker: () => {
        refreshes++;
      },
      audit: (event) => audits.push(event),
    }),
  );
});

afterEach(() => {
  while (restores.length) restores.pop()!();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

function ctx(
  path: string,
  method: string,
  body?: unknown,
  login: string | null = "ada",
): RouteContext {
  const url = new URL(`http://example.test${path}`);
  return {
    req: new Request(url, {
      method,
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(body),
            headers: { "Content-Type": "application/json" },
          }),
    }),
    url,
    path,
    publicPrefix: "/backstage",
    authUser: login
      ? { login, name: login.charAt(0).toUpperCase() + login.slice(1) }
      : null,
  };
}

async function call(
  path: string,
  method: string,
  body?: unknown,
  login?: string | null,
): Promise<{ status: number; text: string; json: any }> {
  const res = await handleMainspringRoutes(ctx(path, method, body, login));
  if (!res) throw new Error(`no route for ${method} ${path}`);
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) };
}

describe("/api/settings/mainspring", () => {
  test("is owner only", async () => {
    expect(
      (await call("/api/settings/mainspring", "GET", undefined, null)).status,
    ).toBe(401);
    const other = await call(
      "/api/settings/mainspring",
      "GET",
      undefined,
      "bob",
    );
    expect(other.status).toBe(403);
    expect(
      await handleMainspringRoutes(ctx("/api/settings/model-providers", "GET")),
    ).toBeUndefined();
  });

  test("saves, tests and removes without ever returning the key", async () => {
    const put = await call("/api/settings/mainspring", "PUT", {
      url: "https://mainspring.example.test/v1",
      key: KEY,
      routeClaude: true,
    });
    expect(put.status).toBe(200);
    expect(put.json.mainspring).toMatchObject({
      url: "https://mainspring.example.test",
      keySet: true,
      keyHint: "abcd",
      routeClaude: true,
      fallbackDirect: false,
    });
    expect(put.text).not.toContain(KEY);
    expect(refreshes).toBe(1);
    expect(JSON.stringify(audits)).not.toContain(KEY);
    expect(audits[0]).toMatchObject({
      msg: "mainspring_settings",
      user: "Ada",
      fields: ["url", "key", "routeClaude"],
    });

    const get = await call("/api/settings/mainspring", "GET");
    expect(get.text).not.toContain(KEY);
    expect(get.json.mainspring.keyHint).toBe("abcd");

    restores.push(
      __setMainspringDepsForTest({
        fetch: async (url, init) => {
          expect(url).toBe("https://mainspring.example.test/v1/models");
          expect(new Headers(init.headers).get("authorization")).toBe(
            `Bearer ${KEY}`,
          );
          return new Response(
            JSON.stringify({ data: [{ id: "gpt-5.6-terra" }] }),
          );
        },
      }),
    );
    const tested = await call("/api/settings/mainspring/test", "POST");
    expect(tested.json.test).toEqual({ ok: true, models: 1 });
    expect(tested.json.mainspring.models).toEqual([{ id: "gpt-5.6-terra" }]);
    expect(tested.text).not.toContain(KEY);

    const removed = await call("/api/settings/mainspring/key", "DELETE");
    expect(removed.json.mainspring).toMatchObject({
      keySet: false,
      keyHint: null,
      routeClaude: false,
    });
  });

  test("a failed test reports a fixed reason", async () => {
    await call("/api/settings/mainspring", "PUT", {
      url: "https://mainspring.example.test",
      key: KEY,
    });
    restores.push(
      __setMainspringDepsForTest({
        fetch: async () => new Response(`refused ${KEY}`, { status: 401 }),
      }),
    );
    const tested = await call("/api/settings/mainspring/test", "POST");
    expect(tested.status).toBe(200);
    expect(tested.json.test).toEqual({
      ok: false,
      error: "Mainspring key was refused",
    });
    expect(tested.text).not.toContain(KEY);
  });

  test("validates the URL and the key", async () => {
    const http = await call("/api/settings/mainspring", "PUT", {
      url: "http://mainspring.example.test",
    });
    expect(http.status).toBe(400);
    expect(http.json.error).toContain("Plain http is only allowed");
    const tailnet = await call("/api/settings/mainspring", "PUT", {
      url: "http://100.100.1.2:8080",
    });
    expect(tailnet.status).toBe(200);
    const badKey = await call("/api/settings/mainspring", "PUT", {
      key: "sk-ant-api03-nope",
    });
    expect(badKey.status).toBe(400);
    expect(badKey.text).not.toContain("sk-ant-api03-nope");
    const early = await call("/api/settings/mainspring", "PUT", {
      routeClaude: true,
    });
    expect(early.status).toBe(400);
  });

  test("pi/mainspring models are servable only once Mainspring is set up", async () => {
    expect(piModelUnservableReason("pi/mainspring/gpt-5.6-terra")).toContain(
      "Mainspring is not set up",
    );
    await call("/api/settings/mainspring", "PUT", {
      url: "https://mainspring.example.test",
      key: KEY,
    });
    __clearJsonFileCacheForTest();
    expect(piModelUnservableReason("pi/mainspring/gpt-5.6-terra")).toBeNull();
  });
});
