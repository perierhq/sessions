import { describe, expect, test } from "bun:test";
import type { MainspringRecord } from "./mainspring";
import {
  buildMainspringProviderConfig,
  enableMainspringRequestHooks,
  mainspringAuditFields,
  mainspringTurnFailure,
  resolveMainspringRoute,
  withMainspringSessionMetadata,
} from "./pi-mainspring";
import { PiAttemptAccounts } from "./pi-account-walk";
import { isTransientRunError } from "./runner-shared";

const KEY = "sk-ms-test-secret-value-1234";
const BASE = "https://mainspring.example.test";

function record(over: Partial<MainspringRecord> = {}): MainspringRecord {
  return {
    url: BASE,
    keyRef: "wssec-1",
    keyHint: "1234",
    routeClaude: true,
    fallbackDirect: false,
    ...over,
  };
}

const resolveConfig = async (r?: MainspringRecord) =>
  r?.url && r.keyRef ? { baseUrl: r.url, key: KEY } : null;

function route(
  providerID: string,
  r: MainspringRecord,
  extra: Partial<Parameters<typeof resolveMainspringRoute>[0]> = {},
) {
  return resolveMainspringRoute({
    providerID,
    modelID: providerID === "openai" ? "gpt-6-sol" : "claude-sonnet-5-5",
    sessionId: "os-session-1",
    readRecord: async () => r,
    resolveConfig,
    ...extra,
  });
}

describe("resolveMainspringRoute", () => {
  test("Claude goes to Mainspring with the session id while the switch is on", async () => {
    expect(await route("anthropic", record())).toEqual({
      kind: "mainspring",
      target: { baseUrl: BASE, key: KEY, sessionId: "os-session-1" },
      fallbackDirect: false,
    });
  });

  test("Claude stays direct while the switch is off", async () => {
    expect(await route("anthropic", record({ routeClaude: false }))).toEqual({
      kind: "direct",
    });
  });

  test("other providers are never rerouted", async () => {
    expect(await route("openai", record())).toEqual({ kind: "direct" });
    expect(await route("openrouter", record())).toEqual({ kind: "direct" });
  });

  test("a strict account pin keeps its direct account; a soft pin does not", async () => {
    expect(
      await route("anthropic", record(), {
        accountId: "acct-1",
        accountStrict: true,
      }),
    ).toEqual({ kind: "direct" });
    expect(
      (await route("anthropic", record(), { accountId: "acct-1" })).kind,
    ).toBe("mainspring");
  });

  test("after the walk fell back, the turn stays direct", async () => {
    expect(
      await route("anthropic", record({ fallbackDirect: true }), {
        fellBack: true,
      }),
    ).toEqual({ kind: "direct" });
  });

  test("a missing key fails the turn unless the owner allowed the fallback", async () => {
    const noKey = record({ keyRef: undefined });
    const failed = await route("anthropic", noKey);
    expect(failed.kind).toBe("error");
    expect(
      await route("anthropic", { ...noKey, fallbackDirect: true }),
    ).toEqual({ kind: "direct" });
  });

  test("pi/mainspring always goes to Mainspring, with its cached row", async () => {
    const r = record({
      routeClaude: false,
      models: {
        at: "2026-11-12T10:00:00Z",
        models: {
          "gpt-5.6-terra": { id: "gpt-5.6-terra", contextWindow: 400_000 },
        },
      },
    });
    expect(await route("mainspring", r, { modelID: "GPT-5.6-Terra" })).toEqual({
      kind: "mainspring",
      target: {
        baseUrl: BASE,
        key: KEY,
        sessionId: "os-session-1",
        catalogRow: { id: "gpt-5.6-terra", contextWindow: 400_000 },
      },
      fallbackDirect: false,
    });
    expect((await route("mainspring", record({ url: undefined }))).kind).toBe(
      "error",
    );
  });
});

describe("buildMainspringProviderConfig", () => {
  const target = { baseUrl: BASE, key: KEY, sessionId: "os-session-1" };

  test("Claude uses the Anthropic Messages API at the bare address with pi's own metadata", () => {
    const config = buildMainspringProviderConfig({
      modelID: "claude-sonnet-5-5",
      target,
      anthropicRows: [
        {
          id: "claude-sonnet-5-5",
          name: "Claude Sonnet 5.5",
          provider: "anthropic",
          baseUrl: "https://api.anthropic.com",
          api: "anthropic-messages",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
          contextWindow: 1_000_000,
          maxTokens: 128_000,
        } as any,
      ],
    });
    expect(config.api).toBe("anthropic-messages");
    expect(config.baseUrl).toBe(BASE);
    expect(config.headers).toEqual({ "X-Session-ID": "os-session-1" });
    expect(config.models[0]).toMatchObject({
      id: "claude-sonnet-5-5",
      cost: { input: 2 },
      contextWindow: 1_000_000,
    });
    expect(config.models[0]).not.toHaveProperty("provider");
    expect(config.models[0]).not.toHaveProperty("baseUrl");
    expect(JSON.stringify(config)).not.toContain(KEY);
  });

  test("other models use Chat Completions at <base>/v1", () => {
    const config = buildMainspringProviderConfig({
      modelID: "gpt-5.6-terra",
      target: {
        ...target,
        catalogRow: { id: "gpt-5.6-terra", contextWindow: 400_000 },
      },
      anthropicRows: [],
    });
    expect(config.api).toBe("openai-completions");
    expect(config.baseUrl).toBe(`${BASE}/v1`);
    expect(config.models[0]).toMatchObject({
      id: "gpt-5.6-terra",
      contextWindow: 400_000,
    });
  });
});

describe("request hooks", () => {
  test("metadata.user_id rides on Mainspring's Anthropic payloads only", async () => {
    const agent: {
      onPayload?: (payload: unknown, model: any) => unknown;
      streamFunction?: (model: any, context: any, options?: any) => unknown;
    } = {};
    enableMainspringRequestHooks(agent, {
      sessionId: "os-session-1",
      onResponse: () => {},
    });
    expect(
      await agent.onPayload!(
        { model: "claude-sonnet-5-5", metadata: { other: 1 } },
        { provider: "mainspring", api: "anthropic-messages" },
      ),
    ).toEqual({
      model: "claude-sonnet-5-5",
      metadata: { other: 1, user_id: "os-session-1" },
    });
    expect(
      await agent.onPayload!(
        { model: "x" },
        { provider: "mainspring", api: "openai-completions" },
      ),
    ).toBeUndefined();
    expect(
      await agent.onPayload!(
        { model: "x" },
        { provider: "anthropic", api: "anthropic-messages" },
      ),
    ).toBeUndefined();
    expect(withMainspringSessionMetadata(null, "s")).toBeNull();
  });

  test("the response fetch reports Mainspring's headers for its own requests", async () => {
    const seen: unknown[] = [];
    let usedFetch: any;
    const agent = {
      streamFunction: (_model: any, _context: any, options?: any) => {
        usedFetch = options?.fetch;
        return "stream";
      },
    };
    enableMainspringRequestHooks(agent, {
      sessionId: "s",
      onResponse: (snapshot) => seen.push(snapshot),
    });
    agent.streamFunction({ provider: "anthropic" }, {}, {});
    expect(usedFetch).toBeUndefined();
    agent.streamFunction(
      { provider: "mainspring" },
      {},
      {
        fetch: async () =>
          new Response("{}", {
            status: 429,
            headers: { "retry-after": "60", "x-mainspring-account": "a" },
          }),
      },
    );
    await usedFetch("https://example.test");
    expect(seen).toEqual([
      expect.objectContaining({ httpStatus: 429, account: "a" }),
    ]);
  });
});

describe("failure mapping", () => {
  test("429 is a usage limit with the fixed resting copy", () => {
    const resetAt = Date.parse("2026-11-12T13:30:00Z");
    expect(
      mainspringTurnFailure({
        message: '429 {"error":{"type":"rate_limit_error"}}',
        snapshot: { httpStatus: 429, resetAt },
        modelID: "claude-sonnet-5-5",
      }),
    ).toEqual({
      failure: { kind: "resting", resetAt },
      text: "Every Claude account in Mainspring is resting until Nov 12, 1:30pm (UTC).",
      usageLimit: true,
    });
  });

  test("401 needs the owner: neither a usage limit nor transient", () => {
    const mapped = mainspringTurnFailure({
      message: '401 {"error":{"type":"authentication_error"}}',
      snapshot: { httpStatus: 401 },
      modelID: "claude-sonnet-5-5",
    })!;
    expect(mapped.text).toStartWith("Mainspring key was refused");
    expect(mapped.usageLimit).toBe(false);
    expect(isTransientRunError(mapped.text)).toBe(false);
  });

  test("502/503 is a retryable provider error", () => {
    for (const status of [502, 503]) {
      const mapped = mainspringTurnFailure({
        message: `${status} upstream`,
        snapshot: { httpStatus: status },
        modelID: "claude-sonnet-5-5",
      })!;
      expect(mapped.usageLimit).toBe(false);
      expect(isTransientRunError(mapped.text)).toBe(true);
    }
  });

  test("the account walk classifies a Mainspring turn from its answer", () => {
    const accounts = new PiAttemptAccounts({
      walk: { excluded: new Set(), rotate: false },
      providerID: "anthropic",
      modelID: "claude-sonnet-5-5",
      opts: {},
      accountUser: undefined,
      affinity: "s",
      claudeSessionKey: "s",
      speed: "standard" as any,
      auditBase: {},
    });
    accounts.viaMainspring = true;
    accounts.mainspring = { httpStatus: 429 };
    expect(accounts.isUsageLimit("429 rate_limit_error")).toBe(true);
    accounts.mainspring = { httpStatus: 401 };
    expect(accounts.isUsageLimit("401 authentication_error")).toBe(false);
    // Nothing local to rotate to or bench.
    expect(accounts.next()).toBeUndefined();
  });

  test("the audit carries who served the turn, never the key", () => {
    const fields = mainspringAuditFields({
      httpStatus: 200,
      account: "alex@example.test",
      provider: "claude",
      limits: [{ label: "5 hours", left: 62 }],
    });
    expect(fields).toEqual({
      via: "mainspring",
      mainspring_account: "alex@example.test",
      mainspring_provider: "claude",
      mainspring_limits: [{ label: "5 hours", left: 62 }],
    });
  });
});
