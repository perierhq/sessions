import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __setMainspringDepsForTest,
  classifyMainspringFailure,
  getMainspringSettings,
  mainspringConfig,
  mainspringFailureText,
  mainspringFetch,
  mainspringPickerModels,
  readMainspringRecord,
  readMainspringRecordSync,
  readMainspringResponse,
  removeMainspringKey,
  saveMainspringSettings,
  testMainspring,
  validateMainspringPatch,
  validateMainspringUrl,
} from "./mainspring";
import { modelProviders, setModelProvider } from "./model-providers";
import { __clearJsonFileCacheForTest } from "./shared/json-file-cache";

const KEY = "sk-ms-test-secret-value-1234";
let scratch = "";
const saved: Record<string, string | undefined> = {};
let restore: (() => void) | undefined;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "mainspring-test-"));
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
});

afterEach(() => {
  restore?.();
  restore = undefined;
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

function modelsResponse() {
  return new Response(
    JSON.stringify({
      object: "list",
      data: [
        {
          id: "claude-sonnet-5-5",
          object: "model",
          owned_by: "claude",
          name: "Claude Sonnet 5.5",
          context_length: 1_000_000,
          max_output_tokens: 128_000,
          efforts: ["low", "medium", "high", "xhigh", "max"],
        },
        { id: "gpt-5.6-terra", object: "model", owned_by: "codex" },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("validateMainspringUrl", () => {
  test("accepts https anywhere and strips /v1 and trailing slashes", () => {
    expect(
      validateMainspringUrl("https://mainspring.example.test/v1/"),
    ).toEqual({ url: "https://mainspring.example.test" });
    expect(validateMainspringUrl("https://example.test/gateway/")).toEqual({
      url: "https://example.test/gateway",
    });
  });

  test("allows plain http only for tailnet, private or loopback hosts", () => {
    for (const ok of [
      "http://mainspring.tailnet-name.ts.net",
      "http://100.100.10.20:8080",
      "http://192.168.1.5",
      "http://10.0.0.2",
      "http://localhost:3000",
      "http://mainspring.lan",
    ])
      expect("url" in validateMainspringUrl(ok)).toBe(true);
    for (const bad of ["http://mainspring.example.test", "http://8.8.8.8"])
      expect(validateMainspringUrl(bad)).toEqual({
        error:
          "url: use https://. Plain http is only allowed for a tailnet or private address",
      });
  });

  test("refuses other schemes, credentials, queries and link-local", () => {
    expect(validateMainspringUrl("ftp://example.test")).toEqual({
      error: "url: use https://",
    });
    expect(
      "error" in validateMainspringUrl(`https://user:${KEY}@example.test`),
    ).toBe(true);
    expect("error" in validateMainspringUrl("https://example.test/?k=1")).toBe(
      true,
    );
    expect("error" in validateMainspringUrl("http://169.254.169.254")).toBe(
      true,
    );
    expect("error" in validateMainspringUrl("not a url")).toBe(true);
    expect("error" in validateMainspringUrl("")).toBe(true);
  });
});

describe("validateMainspringPatch", () => {
  test("checks the key's prefix and strips pasted whitespace", () => {
    expect(validateMainspringPatch({ key: " sk-ms-ab\ncd " })).toEqual({
      key: "sk-ms-abcd",
    });
    expect(validateMainspringPatch({ key: "sk-ant-oat01-x" })).toEqual({
      error: "key: a Mainspring key starts with sk-ms-",
    });
    expect(validateMainspringPatch({ key: "  " })).toEqual({
      error: "key: paste a key",
    });
  });

  test("checks switches and the URL", () => {
    expect(validateMainspringPatch({ routeClaude: "yes" })).toEqual({
      error: "routeClaude: must be true or false",
    });
    expect(
      validateMainspringPatch({
        url: "https://mainspring.example.test/v1",
        routeClaude: true,
        fallbackDirect: false,
      }),
    ).toEqual({
      url: "https://mainspring.example.test",
      routeClaude: true,
      fallbackDirect: false,
    });
    expect(validateMainspringPatch(null)).toEqual({
      error: "body: expected a JSON object",
    });
  });
});

describe("settings", () => {
  test("stores the key as a workspace secret: the file and the view hold only its ref and last four", async () => {
    const result = await saveMainspringSettings({
      url: "https://mainspring.example.test",
      key: KEY,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.settings).toEqual({
      url: "https://mainspring.example.test",
      keySet: true,
      keyHint: "1234",
      routeClaude: false,
      fallbackDirect: false,
      models: [],
      modelsAt: null,
    });
    const file = readFileSync(
      process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG!,
      "utf8",
    );
    expect(file).not.toContain(KEY);
    expect(
      statSync(process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG!).mode & 0o777,
    ).toBe(0o600);
    expect(JSON.stringify(await getMainspringSettings())).not.toContain(KEY);
    expect(
      readFileSync(process.env.OPENSESSION_WORKSPACE_SECRETS_STORE!, "utf8"),
    ).toContain(KEY);
    expect(await mainspringConfig()).toEqual({
      baseUrl: "https://mainspring.example.test",
      key: KEY,
    });
  });

  test("keeps the rest of model-providers.json and the generic providers", async () => {
    setModelProvider("openrouter", { apiKey: "sk-or-test" });
    await saveMainspringSettings({
      url: "https://mainspring.example.test",
      key: KEY,
    });
    __clearJsonFileCacheForTest();
    expect(modelProviders().openrouter?.apiKey).toBe("sk-or-test");
    // "mainspring" is not a generic provider id.
    expect(() => setModelProvider("mainspring", { apiKey: "x" })).toThrow(
      "has its own settings",
    );
  });

  test("routing Claude needs a URL and a key", async () => {
    expect(await saveMainspringSettings({ routeClaude: true })).toEqual({
      ok: false,
      status: 400,
      error: "routeClaude: add Mainspring's address and a key first",
    });
    const ok = await saveMainspringSettings({
      url: "https://mainspring.example.test",
      key: KEY,
      routeClaude: true,
    });
    expect(ok.ok && ok.settings.routeClaude).toBe(true);
  });

  test("a new host needs the key again", async () => {
    await saveMainspringSettings({
      url: "https://mainspring.example.test",
      key: KEY,
    });
    expect(
      await saveMainspringSettings({ url: "https://other.example.test" }),
    ).toEqual({
      ok: false,
      status: 400,
      error: "key: paste the key again for the new address",
    });
    // The same host with another path keeps the key.
    const same = await saveMainspringSettings({
      url: "https://mainspring.example.test/gateway",
    });
    expect(same.ok).toBe(true);
  });

  test("removing the key deletes the secret and turns routing off", async () => {
    await saveMainspringSettings({
      url: "https://mainspring.example.test",
      key: KEY,
      routeClaude: true,
    });
    const view = await removeMainspringKey();
    expect(view.keySet).toBe(false);
    expect(view.keyHint).toBeNull();
    expect(view.routeClaude).toBe(false);
    expect(
      readFileSync(process.env.OPENSESSION_WORKSPACE_SECRETS_STORE!, "utf8"),
    ).not.toContain(KEY);
    expect(await mainspringConfig()).toBeNull();
  });
});

describe("testMainspring", () => {
  test("lists /v1/models with the key in the Authorization header and caches the list", async () => {
    await saveMainspringSettings({
      url: "https://mainspring.example.test",
      key: KEY,
    });
    const calls: Array<{ url: string; headers: Headers }> = [];
    restore = __setMainspringDepsForTest({
      fetch: async (url, init) => {
        calls.push({ url, headers: new Headers(init.headers) });
        return modelsResponse();
      },
      now: () => Date.parse("2026-11-12T10:00:00Z"),
    });
    const result = await testMainspring();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.models).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://mainspring.example.test/v1/models");
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(result.settings.models.map((m) => m.id)).toEqual([
      "claude-sonnet-5-5",
      "gpt-5.6-terra",
    ]);
    expect(result.settings.modelsAt).toBe("2026-11-12T10:00:00.000Z");
    expect(JSON.stringify(result)).not.toContain(KEY);
    __clearJsonFileCacheForTest();
    const record = readMainspringRecordSync();
    expect(record.models?.models["claude-sonnet-5-5"]?.contextWindow).toBe(
      1_000_000,
    );
    expect(mainspringPickerModels(record)).toEqual([
      "pi/mainspring/claude-sonnet-5-5",
      "pi/mainspring/gpt-5.6-terra",
    ]);
  });

  test("while Claude is routed, Claude models stay pi/anthropic in the picker", async () => {
    await saveMainspringSettings({
      url: "https://mainspring.example.test",
      key: KEY,
      routeClaude: true,
    });
    restore = __setMainspringDepsForTest({
      fetch: async () => modelsResponse(),
    });
    await testMainspring();
    __clearJsonFileCacheForTest();
    expect(mainspringPickerModels()).toEqual(["pi/mainspring/gpt-5.6-terra"]);
  });

  test("a refused key reads as such, never echoing the body", async () => {
    await saveMainspringSettings({
      url: "https://mainspring.example.test",
      key: KEY,
    });
    restore = __setMainspringDepsForTest({
      fetch: async () =>
        new Response(`{"error":{"message":"bad key ${KEY}"}}`, {
          status: 401,
        }),
    });
    const result = await testMainspring();
    expect(result).toEqual({ ok: false, error: "Mainspring key was refused" });
  });

  test("an unreachable address and an unset key say so", async () => {
    expect(await testMainspring()).toEqual({
      ok: false,
      error: "Add Mainspring's address first",
    });
    await saveMainspringSettings({ url: "https://mainspring.example.test" });
    expect(await testMainspring()).toEqual({
      ok: false,
      error: "Paste a key first",
    });
    await saveMainspringSettings({ key: KEY });
    restore = __setMainspringDepsForTest({
      fetch: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    expect(await testMainspring()).toEqual({
      ok: false,
      error: "Couldn't reach Mainspring at https://mainspring.example.test",
    });
  });

  test("a URL change drops the cached list", async () => {
    await saveMainspringSettings({
      url: "https://mainspring.example.test",
      key: KEY,
    });
    restore = __setMainspringDepsForTest({
      fetch: async () => modelsResponse(),
    });
    await testMainspring();
    await saveMainspringSettings({
      url: "https://mainspring.example.test/other",
    });
    expect((await readMainspringRecord()).models).toBeUndefined();
  });
});

describe("mainspringFetch", () => {
  test("sends the key only as a Bearer header to <base>/v1/<path>", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    restore = __setMainspringDepsForTest({
      fetch: async (url, init) => {
        calls.push({ url, headers: new Headers(init.headers) });
        return new Response("{}");
      },
    });
    await mainspringFetch(
      "pool",
      {},
      { config: { baseUrl: "https://mainspring.example.test", key: KEY } },
    );
    expect(calls[0]!.url).toBe("https://mainspring.example.test/v1/pool");
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${KEY}`);
  });

  test("throws when Mainspring is not set up", async () => {
    await expect(mainspringFetch("/v1/pool")).rejects.toThrow(
      "Mainspring is not set up",
    );
  });
});

describe("responses and failures", () => {
  const now = Date.parse("2026-11-12T10:00:00Z");

  test("reads the served-by headers and Retry-After", () => {
    expect(
      readMainspringResponse(
        200,
        new Headers({
          "X-Mainspring-Account": "alex@example.test",
          "X-Mainspring-Provider": "claude",
          "X-Mainspring-Limits":
            '[{"label":"5 hours","left":62,"resets_at":1794366000000}]',
          "X-Mainspring-Moved-From": "sam@example.test",
          "X-Mainspring-Moved-Reason": "5-hour limit hit",
        }),
        now,
      ),
    ).toEqual({
      httpStatus: 200,
      account: "alex@example.test",
      provider: "claude",
      limits: [{ label: "5 hours", left: 62, resetsAt: 1794366000000 }],
      movedFrom: "sam@example.test",
      movedReason: "5-hour limit hit",
    });
    expect(
      readMainspringResponse(429, { "retry-after": "3600" }, now).resetAt,
    ).toBe(now + 3_600_000);
    // Garbage limits and far-off resets are dropped.
    expect(
      readMainspringResponse(
        429,
        { "retry-after": String(60 * 24 * 3600), "x-mainspring-limits": "{" },
        now,
      ),
    ).toEqual({ httpStatus: 429 });
  });

  test("429 is resting with Retry-After as the reset, in Claude's reset format", () => {
    const failure = classifyMainspringFailure(
      '429 {"type":"error","error":{"type":"rate_limit_error","message":"every Claude account is resting"}}',
      { httpStatus: 429, resetAt: Date.parse("2026-11-12T13:30:00Z") },
    );
    expect(failure).toEqual({
      kind: "resting",
      resetAt: Date.parse("2026-11-12T13:30:00Z"),
    });
    expect(mainspringFailureText(failure!, "claude-sonnet-5-5")).toBe(
      "Every Claude account in Mainspring is resting until Nov 12, 1:30pm (UTC).",
    );
  });

  test("a daily cap 429, a 401 and a 502/503 each have their own kind", () => {
    expect(
      classifyMainspringFailure("429 daily token cap reached", {
        httpStatus: 429,
      }),
    ).toEqual({ kind: "cap" });
    expect(classifyMainspringFailure("401 invalid api key")).toEqual({
      kind: "refused",
    });
    expect(
      classifyMainspringFailure("upstream failed", { httpStatus: 503 }),
    ).toEqual({ kind: "unavailable", status: 503 });
    expect(classifyMainspringFailure("502 Bad Gateway")).toEqual({
      kind: "unavailable",
      status: 502,
    });
    expect(classifyMainspringFailure("fetch failed")).toBeNull();
    expect(
      classifyMainspringFailure("400 bad request", { httpStatus: 200 }),
    ).toBeNull();
  });
});
