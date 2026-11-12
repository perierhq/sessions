import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_RESPONSE_BYTES,
  __resetMainspringPoolCacheForTest,
  __setMainspringDepsForTest,
  classifyMainspringFailure,
  isRefusedAddress,
  isRefusedHostName,
  mainspringClaudePool,
  readClaudePool,
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
    for (const metadata of [
      "http://[fe80::1]",
      "http://[fd00:ec2::254]",
      "https://metadata.google.internal",
      "http://metadata",
      "https://instance-data.ec2.internal",
    ])
      expect(validateMainspringUrl(metadata)).toEqual({
        error: "url: link-local and cloud metadata addresses are not allowed",
      });
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
      resolve: async () => ["203.0.113.10"],
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
      resolve: async () => ["203.0.113.10"],
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
      resolve: async () => ["203.0.113.10"],
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
      resolve: async () => ["203.0.113.10"],
      fetch: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    expect(await testMainspring()).toEqual({
      ok: false,
      error: "Couldn't reach Mainspring at https://mainspring.example.test",
    });
  });

  test("a redirect and an oversized list are refused", async () => {
    await saveMainspringSettings({
      url: "https://mainspring.example.test",
      key: KEY,
    });
    restore = __setMainspringDepsForTest({
      resolve: async () => ["203.0.113.10"],
      fetch: async () =>
        new Response(null, { status: 301, headers: { location: "/x" } }),
    });
    expect((await testMainspring()).ok).toBe(false);
    restore();
    restore = __setMainspringDepsForTest({
      resolve: async () => ["203.0.113.10"],
      fetch: async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: "claude-sonnet-5-5", pad: "x".repeat(MAX_RESPONSE_BYTES) },
            ],
          }),
        ),
    });
    expect(await testMainspring()).toEqual({
      ok: false,
      error: "Mainspring listed no models",
    });
  });

  test("a URL change drops the cached list", async () => {
    await saveMainspringSettings({
      url: "https://mainspring.example.test",
      key: KEY,
    });
    restore = __setMainspringDepsForTest({
      resolve: async () => ["203.0.113.10"],
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
      resolve: async () => ["203.0.113.10"],
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

  const CONFIG = { baseUrl: "https://mainspring.example.test", key: KEY };

  test("refuses a host that resolves to a link-local or metadata address, before sending", async () => {
    for (const address of ["169.254.169.254", "fd00:ec2::254", "fe80::1"]) {
      let sent = false;
      restore?.();
      restore = __setMainspringDepsForTest({
        resolve: async () => ["203.0.113.10", address],
        fetch: async () => {
          sent = true;
          return new Response("{}");
        },
      });
      await expect(
        mainspringFetch("/v1/pool", {}, { config: CONFIG }),
      ).rejects.toThrow(`link-local or metadata address ${address}`);
      expect(sent).toBe(false);
    }
    await expect(
      mainspringFetch(
        "/v1/pool",
        {},
        { config: { ...CONFIG, baseUrl: "http://metadata.google.internal" } },
      ),
    ).rejects.toThrow("cloud metadata");
  });

  test("private and tailnet addresses stay allowed; only the checked ones are dialled", async () => {
    let dialled: string[] = [];
    restore = __setMainspringDepsForTest({
      resolve: async () => ["192.168.1.20", "100.101.102.103"],
      fetch: async (_url, init, _timeout, addresses) => {
        expect(init.redirect).toBe("manual");
        dialled = addresses;
        return new Response("{}");
      },
    });
    await mainspringFetch("/v1/pool", {}, { config: CONFIG });
    expect(dialled).toEqual(["192.168.1.20", "100.101.102.103"]);
  });

  test("a redirect is an error, never followed", async () => {
    restore = __setMainspringDepsForTest({
      resolve: async () => ["203.0.113.10"],
      fetch: async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/" },
        }),
    });
    await expect(
      mainspringFetch("/v1/models", {}, { config: CONFIG }),
    ).rejects.toThrow("redirect (302)");
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
    expect(classifyMainspringFailure("fetch failed")).toEqual({
      kind: "unavailable",
    });
    for (const message of [
      "connect ECONNREFUSED 10.0.0.2:8080",
      "Connection error.",
      "Request timed out.",
      "ETIMEDOUT",
    ])
      expect(classifyMainspringFailure(message)).toEqual({
        kind: "unavailable",
      });
    for (const status of [500, 504, 529])
      expect(
        classifyMainspringFailure("upstream", { httpStatus: status }),
      ).toEqual({ kind: "unavailable", status });
    expect(classifyMainspringFailure("the model refused")).toBeNull();
    expect(
      classifyMainspringFailure("400 bad request", { httpStatus: 200 }),
    ).toBeNull();
  });
});

describe("address policy", () => {
  test("refuses link-local and metadata, allows private and tailnet", () => {
    for (const ip of [
      "169.254.169.254",
      "169.254.0.1",
      "100.100.100.200",
      "fe80::1",
      "fd00:ec2::254",
      "::ffff:169.254.169.254",
    ])
      expect(isRefusedAddress(ip)).toBe(true);
    for (const ip of [
      "10.0.0.2",
      "192.168.1.2",
      "100.101.1.2",
      "127.0.0.1",
      "::1",
      "fd00::1",
    ])
      expect(isRefusedAddress(ip)).toBe(false);
    for (const name of [
      "metadata.google.internal",
      "metadata",
      "METADATA.Google.Internal.",
      "instance-data.ec2.internal",
    ])
      expect(isRefusedHostName(name)).toBe(true);
    for (const name of [
      "mainspring.internal",
      "metadata.example.test",
      "mainspring.local",
    ])
      expect(isRefusedHostName(name)).toBe(false);
  });
});

describe("pool", () => {
  const NOW = Date.parse("2026-11-12T10:00:00Z");
  const account = (status: string, extra: Record<string, unknown> = {}) => ({
    label: `${status}@example.test`,
    status,
    sessions: 0,
    windows: [],
    ...extra,
  });
  const body = (accounts: unknown[], extra: Record<string, unknown> = {}) => ({
    now: NOW,
    groups: [
      { provider: "codex", accounts: [account("cooling")] },
      { provider: "claude", accounts, ...extra },
    ],
  });

  test("resting only when every Claude account is cooling, benched or needs a sign-in", () => {
    expect(
      readClaudePool(body([account("cooling"), account("next")]), NOW),
    ).toEqual({ resting: false });
    expect(readClaudePool(body([account("active")]), NOW)).toEqual({
      resting: false,
    });
    expect(
      readClaudePool(
        body([
          account("cooling", { cool_until: NOW + 3_600_000 }),
          account("benched", {
            windows: [
              { label: "5 hours", left: 0, resets_at: NOW + 1_800_000 },
            ],
          }),
          account("needs_sign_in"),
        ]),
        NOW,
      ),
    ).toEqual({ resting: true, retryAt: NOW + 1_800_000 });
    expect(readClaudePool(body([account("needs_sign_in")]), NOW)).toEqual({
      resting: true,
    });
  });

  test("the soonest reset is moved onto this clock, past ones ignored", () => {
    // Mainspring's clock runs a minute ahead.
    expect(
      readClaudePool(
        {
          now: NOW + 60_000,
          groups: [
            {
              provider: "claude",
              back_at: NOW + 60_000 + 600_000,
              accounts: [account("cooling", { cool_until: NOW - 1 })],
            },
          ],
        },
        NOW,
      ),
    ).toEqual({ resting: true, retryAt: NOW + 600_000 });
  });

  test("no Claude group, or no accounts, can't tell", () => {
    expect(readClaudePool({ groups: [] }, NOW)).toBeNull();
    expect(readClaudePool(body([]), NOW)).toBeNull();
    expect(readClaudePool("nope", NOW)).toBeNull();
  });

  test("reads GET /v1/pool once a minute; a 404 (sharing off) can't tell", async () => {
    await saveMainspringSettings({
      url: "https://mainspring.example.test",
      key: KEY,
    });
    const record = await readMainspringRecord();
    let calls = 0;
    let answer: Response = new Response(
      JSON.stringify(body([account("benched")])),
    );
    restore = __setMainspringDepsForTest({
      resolve: async () => ["203.0.113.10"],
      fetch: async (url, init) => {
        calls++;
        expect(url).toBe("https://mainspring.example.test/v1/pool");
        expect(new Headers(init.headers).get("authorization")).toBe(
          `Bearer ${KEY}`,
        );
        return answer;
      },
    });
    __resetMainspringPoolCacheForTest();
    expect(await mainspringClaudePool(record, NOW)).toEqual({ resting: true });
    expect(await mainspringClaudePool(record, NOW + 59_000)).toEqual({
      resting: true,
    });
    expect(calls).toBe(1);
    answer = new Response('{"error":{}}', { status: 404 });
    expect(await mainspringClaudePool(record, NOW + 61_000)).toBeNull();
    expect(calls).toBe(2);
    answer = new Response("x".repeat(MAX_RESPONSE_BYTES + 1));
    expect(await mainspringClaudePool(record, NOW + 200_000)).toBeNull();
    __resetMainspringPoolCacheForTest();
  });
});

describe("the real dialer", () => {
  test("never follows a redirect and caps the body", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/v1/models")
          return new Response(null, {
            status: 302,
            headers: { location: "http://127.0.0.1:1/v1/models" },
          });
        if (path === "/v1/pool")
          return new Response("x".repeat(MAX_RESPONSE_BYTES + 10));
        return Response.json({ auth: request.headers.get("authorization") });
      },
    });
    try {
      const config = { baseUrl: `http://127.0.0.1:${server.port}`, key: KEY };
      await expect(
        mainspringFetch("/v1/models", {}, { config }),
      ).rejects.toThrow("redirect (302)");
      await expect(
        mainspringFetch("/v1/pool", {}, { config }),
      ).rejects.toThrow();
      const ok = await mainspringFetch("/v1/echo", {}, { config });
      expect(await ok.json()).toEqual({ auth: `Bearer ${KEY}` });
    } finally {
      server.stop(true);
    }
  });
});
