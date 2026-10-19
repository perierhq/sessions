import { afterEach, describe, expect, test } from "bun:test";
import {
  __resetPiSdkCacheForTest,
  createPiRuntimeBinding,
  prewarmPiSdk,
  type CreatePiRuntimeBindingInput,
} from "./pi-runtime-binding";
import type { ClaudeAccount } from "./claude-accounts";
import type { CodexAccount } from "./codex-accounts";

const oauth: CodexAccount = {
  id: "oauth-1",
  name: "OAuth one",
  kind: "home",
  value: "/unused",
  createdAt: "2026-01-01T00:00:00.000Z",
};
const apiKey: CodexAccount = {
  ...oauth,
  id: "key-1",
  name: "Key one",
  kind: "api_key",
  value: "sk-test",
};
const claude: ClaudeAccount = {
  id: "claude-1",
  name: "Claude one",
  token: "sk-ant-oat01-test-token",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function harness(
  options: {
    account?: CodexAccount;
    transport?: "inprocess" | "bridge" | "native";
    refuseModels?: boolean;
    claudePick?: ClaudeAccount | { error: string };
  } = {},
) {
  const calls: Array<[string, ...any[]]> = [];
  const models = new Map<string, any>();
  const builtin = (provider: string, id: string) =>
    models.set(`${provider}/${id}`, { provider, id });
  if (options.account?.kind === "home") builtin("openai-codex", "gpt-test");
  if (options.account?.kind === "api_key") builtin("openai", "gpt-test");
  builtin("anthropic", "claude-test");
  builtin("wafer", "wafer-test");
  const runtime = {
    getModel(provider: string, id: string) {
      return models.get(`${provider}/${id}`);
    },
    getModels(provider: string) {
      return [...models.values()].filter(
        (model) => model.provider === provider,
      );
    },
    registerProvider(provider: string, config: any) {
      calls.push(["registerProvider", provider, config]);
      if (!options.refuseModels)
        for (const model of config.models || []) builtin(provider, model.id);
    },
    registerNativeProvider(provider: any) {
      calls.push(["registerNativeProvider", provider]);
      if (!options.refuseModels)
        for (const model of provider.models || [])
          builtin("anthropic", model.id);
    },
    async setRuntimeApiKey(provider: string, key: string) {
      calls.push(["setRuntimeApiKey", provider, key]);
    },
  };
  const sdk = {
    ModelRuntime: {
      async create(config: any) {
        calls.push(["create", config]);
        return runtime;
      },
    },
  } as any;
  const deps = {
    loadSdk: async () => {
      calls.push(["loadSdk"]);
      return sdk;
    },
    readOpenaiAccounts: () => {
      calls.push(["readOpenaiAccounts"]);
      return [];
    },
    pickOpenaiAccount: (
      _model: string,
      _accounts: any,
      _affinity: string,
      out: { reason?: string },
    ) => {
      calls.push(["pickOpenaiAccount"]);
      out.reason = "strict pin";
      return options.account!;
    },
    buildSeededOpenaiAuth: () => ({
      seeded: {
        openai: {
          type: "oauth" as const,
          access: "access",
          refresh: "no-refresh",
          expires: 2_000_000,
        },
      },
    }),
    anthropicTransport: () => options.transport || ("inprocess" as const),
    pickClaudeAccount: (modelID: string, pick: any) => {
      calls.push(["pickClaudeAccount", modelID, pick]);
      return options.claudePick ?? claude;
    },
    buildAnthropicProvider: (input: any) => {
      calls.push(["buildAnthropicProvider", input]);
      return { id: "anthropic", models: input.builtinModels as any };
    },
    ensureAnthropicBridge: () => {
      calls.push(["ensureAnthropicBridge"]);
      return { url: "http://bridge", key: "bridge-key" };
    },
    buildThirdPartyProviderPlan: (input: any) => {
      calls.push(["buildThirdPartyProviderPlan", input]);
      return { config: { api: "openai-completions" } };
    },
    now: () => 1_000_000,
  };
  return { calls, runtime, deps };
}

function input(
  providerID: string,
  modelID: string,
  h: ReturnType<typeof harness>,
  extra: Partial<CreatePiRuntimeBindingInput> = {},
): CreatePiRuntimeBindingInput {
  return {
    providerID,
    modelID,
    affinityKey: "session",
    unifiedSessionId: "os-session",
    excludedOpenaiAccountIds: new Set(),
    dependencies: h.deps as any,
    ...extra,
  };
}

afterEach(() => __resetPiSdkCacheForTest());

describe("createPiRuntimeBinding", () => {
  test("is import-inert and invokes no injected SDK, config, or account effects before factory call", () => {
    const h = harness({ account: oauth });
    expect(h.calls).toEqual([]);
    expect((globalThis as any).__piSdkPromise).toBeUndefined();
  });

  test("seeds ChatGPT OAuth before runtime creation and returns rotation evidence", async () => {
    const h = harness({ account: oauth });
    const evidence: any[] = [];
    const binding = await createPiRuntimeBinding(
      input("openai", "gpt-test", h, {
        accountId: oauth.id,
        accountStrict: true,
        onAccountEvidence: (value) => evidence.push(value),
      }),
    );
    expect(binding.model.provider).toBe("openai-codex");
    expect(binding.model.id).toBe("gpt-test");
    expect(binding.usesOpenaiOAuth).toBe(true);
    expect(binding.pickedOpenai).toBe(oauth);
    const create = h.calls.find(([name]) => name === "create")!;
    expect(await create[1].credentials.read("openai-codex")).toMatchObject({
      type: "oauth",
      access: "access",
    });
    expect(evidence.at(-1)).toMatchObject({
      pickedOpenai: oauth,
      sidelineableOpenai: oauth,
      openaiPickReason: "strict pin",
    });
  });

  test("asks for a Pro $500 account on ultrafast Astra turns and reports the login's plan", async () => {
    const plans: Array<string | undefined> = [];
    const access = `h.${Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_plan_type: "promax" },
      }),
    ).toString("base64url")}.s`;
    const bind = async (modelID: string, speed: "fast" | "ultrafast") => {
      const h = harness({ account: oauth });
      h.deps.pickOpenaiAccount = ((...args: any[]) => {
        plans.push(args[8]);
        return oauth;
      }) as any;
      h.deps.buildSeededOpenaiAuth = () => ({
        seeded: {
          openai: {
            type: "oauth" as const,
            access,
            refresh: "no-refresh",
            expires: 2_000_000,
          },
        },
      });
      return createPiRuntimeBinding(input("openai", modelID, h, { speed }));
    };
    expect((await bind("gpt-6-astra", "ultrafast")).openaiPlan).toBe("promax");
    await bind("gpt-6.1-sol", "ultrafast");
    await bind("gpt-6-astra", "fast");
    expect(plans).toEqual(["promax", undefined, undefined]);
  });

  test("binds an OpenAI API key to the standard provider without credential seeding", async () => {
    const h = harness({ account: apiKey });
    const binding = await createPiRuntimeBinding(
      input("openai", "gpt-test", h),
    );
    expect(binding.usesOpenaiOAuth).toBe(false);
    expect(h.calls).toContainEqual(["setRuntimeApiKey", "openai", "sk-test"]);
    const create = h.calls.find(([name]) => name === "create")!;
    expect(await create[1].credentials.read("openai-codex")).toBeUndefined();
  });

  for (const account of [oauth, apiKey]) {
    test(`registers fallback metadata for an uncatalogued model on ${account.kind} accounts`, async () => {
      const h = harness({ account });
      const binding = await createPiRuntimeBinding(
        input("openai", "gpt-future", h),
      );
      const provider = account.kind === "home" ? "openai-codex" : "openai";
      expect(binding.model.provider).toBe(provider);
      expect(binding.usesOpenaiOAuth).toBe(account.kind === "home");
      const registration = h.calls.find(
        ([name]) => name === "registerProvider",
      );
      expect(registration?.[1]).toBe(provider);
      expect(registration?.[2].models).toEqual([
        expect.objectContaining({
          id: "gpt-future",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 272_000,
          maxTokens: 128_000,
          thinkingLevelMap: { xhigh: "xhigh", max: "max", minimal: "low" },
        }),
      ]);
    });
  }

  test("the bundled Pi catalog prices GPT-6.1 Sol and Luna for both account types", async () => {
    for (const account of [oauth, apiKey]) {
      for (const modelID of ["gpt-6.1-sol", "gpt-6-luna"]) {
        const h = harness({ account });
        h.deps.loadSdk = prewarmPiSdk;
        const binding = await createPiRuntimeBinding(
          input("openai", modelID, h),
        );
        expect(binding.model.id).toBe(modelID);
        expect(binding.model.api).toBe(
          account.kind === "home"
            ? "openai-codex-responses"
            : "openai-responses",
        );
        expect(binding.model.contextWindow).toBe(272_000);
        expect(binding.model.maxTokens).toBe(128_000);
        expect(binding.model.thinkingLevelMap?.max).toBe("max");
        expect(binding.model.cost.input).toBe(
          modelID === "gpt-6.1-sol" ? 2 : 0.1,
        );
        expect(binding.model.cost.tiers?.[0].inputTokensAbove).toBe(272_000);
      }
    }
  });

  test("registers Anthropic in-process before looking up the model", async () => {
    const h = harness({ transport: "inprocess" });
    await createPiRuntimeBinding(input("anthropic", "claude-test", h));
    expect(h.calls.map(([name]) => name)).toEqual([
      "loadSdk",
      "create",
      "buildAnthropicProvider",
      "registerNativeProvider",
    ]);
  });

  test("registers Anthropic bridge routing and key in current order", async () => {
    const h = harness({ transport: "bridge" });
    await createPiRuntimeBinding(input("anthropic", "claude-test", h));
    expect(h.calls.map(([name]) => name)).toEqual([
      "loadSdk",
      "create",
      "ensureAnthropicBridge",
      "registerProvider",
      "setRuntimeApiKey",
    ]);
    expect(h.calls.at(-1)).toEqual([
      "setRuntimeApiKey",
      "anthropic",
      "bridge-key",
    ]);
  });

  test("registers Opus 5.5 metadata on the HTTP bridge without bypassing it", async () => {
    const h = harness({ transport: "bridge" });
    await createPiRuntimeBinding(input("anthropic", "claude-opus-5-5", h));
    const registration = h.calls.find(
      ([name, , config]) => name === "registerProvider" && config.models,
    );
    expect(registration?.[2].models).toEqual([
      expect.objectContaining({
        id: "claude-opus-5-5",
        baseUrl: "http://bridge",
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
      }),
    ]);
  });

  test("native Anthropic picks a pool account before the runtime and seeds its token", async () => {
    const h = harness({ transport: "native" });
    const evidence: any[] = [];
    const loaded: any[] = [];
    const binding = await createPiRuntimeBinding(
      input("anthropic", "claude-test", h, {
        accountUser: "ada",
        accountId: claude.id,
        accountStrict: true,
        usageCredits: true,
        onAccountEvidence: (value) => evidence.push(value),
        beforeRuntimeLoad: (value) => {
          loaded.push(value);
        },
      }),
    );
    // The pick (and its evidence) lands before pi is imported, so a failure
    // anywhere later can still rotate off the account.
    expect(h.calls.map(([name]) => name)).toEqual([
      "pickClaudeAccount",
      "loadSdk",
      "create",
    ]);
    expect(h.calls[0]).toEqual([
      "pickClaudeAccount",
      "claude-test",
      {
        user: "ada",
        accountId: claude.id,
        accountStrict: true,
        usageCredits: true,
        excludeIds: undefined,
      },
    ]);
    expect(evidence).toEqual([
      { pickedClaude: claude, sidelineableClaude: claude },
    ]);
    expect(loaded).toEqual([
      { pickedClaude: claude, sidelineableClaude: claude },
    ]);
    // pi's builtin provider and catalog: no SDK provider, no bridge, no
    // process-wide runtime key.
    expect(binding.model as unknown).toEqual({
      provider: "anthropic",
      id: "claude-test",
    });
    expect(binding.usesNativeAnthropic).toBe(true);
    expect(binding.pickedClaude).toBe(claude);
    const create = h.calls.find(([name]) => name === "create")!;
    expect(await create[1].credentials.read("anthropic")).toEqual({
      type: "api_key",
      key: claude.token,
      env: { PI_CACHE_RETENTION: "long" },
    });
    expect(create[1].modelsPath).toBeNull();
  });

  test("native Anthropic skips accounts this turn's walk already burned", async () => {
    const h = harness({ transport: "native" });
    await createPiRuntimeBinding(
      input("anthropic", "claude-test", h, {
        excludedOpenaiAccountIds: new Set(["claude-0"]),
      }),
    );
    expect(h.calls[0][2].excludeIds).toEqual(["claude-0"]);
  });

  test("native Anthropic surfaces the pool refusal verbatim before loading pi", async () => {
    const refusal =
      "no usable Claude account in the pool (all exhausted or sidelined)";
    const h = harness({ transport: "native", claudePick: { error: refusal } });
    const evidence: any[] = [];
    let thrown: any;
    try {
      await createPiRuntimeBinding(
        input("anthropic", "claude-test", h, {
          onAccountEvidence: (value) => evidence.push(value),
        }),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.message).toBe(refusal);
    // No provider flag: the runner's classifier decides from the wording
    // (an empty pool is a config error, not exhaustion).
    expect(thrown?.usageLimitExhausted).toBeUndefined();
    expect(evidence).toEqual([]);
    expect(h.calls.map(([name]) => name)).toEqual(["pickClaudeAccount"]);
  });

  test("native Anthropic registers release metadata only for a model pi does not know", async () => {
    const h = harness({ transport: "native" });
    const binding = await createPiRuntimeBinding(
      input("anthropic", "claude-opus-5-5", h),
    );
    expect(binding.model.id).toBe("claude-opus-5-5");
    const registration = h.calls.find(([name]) => name === "registerProvider");
    expect(registration?.[1]).toBe("anthropic");
    // pi's builtin provider keeps its own base URL and auth: only models.
    expect(Object.keys(registration?.[2])).toEqual(["models"]);
    // The builtin catalog rides along, with the new id appended.
    expect(registration?.[2].models).toEqual([
      { provider: "anthropic", id: "claude-test" },
      expect.objectContaining({
        id: "claude-opus-5-5",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        contextWindow: 1_000_000,
        cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
      }),
    ]);
    expect(h.calls.some(([name]) => name === "setRuntimeApiKey")).toBe(false);
    expect(h.calls.some(([name]) => name === "registerNativeProvider")).toBe(
      false,
    );
  });

  test("native Anthropic applies the in-process path's price corrections to a builtin row", async () => {
    const h = harness({ transport: "native" });
    const stale = {
      provider: "anthropic",
      id: "claude-sonnet-5-5",
      api: "anthropic-messages",
      cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    };
    // Serve the stale builtin row the way pi's catalog ships it, and the
    // registered catalog once there is one.
    const getModels = h.runtime.getModels.bind(h.runtime);
    const getModel = h.runtime.getModel.bind(h.runtime);
    let registered: any[] | undefined;
    h.runtime.getModels = (provider: string) =>
      registered ??
      (provider === "anthropic" ? [...getModels(provider), stale] : []);
    h.runtime.getModel = (provider: string, id: string) =>
      registered?.find((model) => model.id === id) ??
      (id === stale.id ? stale : getModel(provider, id));
    const register = h.runtime.registerProvider;
    h.runtime.registerProvider = (provider: string, config: any) => {
      register(provider, config);
      registered = config.models;
    };

    const binding = await createPiRuntimeBinding(
      input("anthropic", "claude-sonnet-5-5", h),
    );
    // Sonnet 5.5 cache reads are $0.10/MTok, not the catalog's $0.20.
    expect(binding.model.cost).toEqual({
      input: 2,
      output: 10,
      cacheRead: 0.1,
      cacheWrite: 2.5,
    });
    const registrations = h.calls.filter(
      ([name]) => name === "registerProvider",
    );
    expect(registrations).toHaveLength(1);
    expect(Object.keys(registrations[0][2])).toEqual(["models"]);
    // The rest of the catalog is passed through unchanged.
    expect(registrations[0][2].models.map((model: any) => model.id)).toEqual([
      "claude-test",
      "claude-sonnet-5-5",
    ]);
  });

  test("native Anthropic requests reach pi's provider with the pool token and a 1h cache", async () => {
    // The real pi SDK, with fetch captured: no network.
    const previousEnvKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-from-the-environment";
    try {
      for (const modelID of [
        "claude-haiku-5-5",
        "claude-sonnet-5-5",
        "claude-future-9",
      ]) {
        const h = harness({ transport: "native" });
        h.deps.loadSdk = prewarmPiSdk;
        const binding = await createPiRuntimeBinding(
          input("anthropic", modelID, h),
        );
        expect(binding.model.provider).toBe("anthropic");
        expect(binding.model.api).toBe("anthropic-messages");
        if (modelID === "claude-sonnet-5-5") {
          // The corrected price reaches the model pi-ai prices usage from.
          expect(binding.model.cost.cacheRead).toBe(0.1);
          expect(
            binding.runtime.getModel("anthropic", modelID)?.cost.cacheRead,
          ).toBe(0.1);
        }
        const requests: Array<{ headers: Headers; body: any }> = [];
        const fetch = async (_url: unknown, init: any) => {
          requests.push({
            headers: new Headers(init.headers),
            body: JSON.parse(init.body),
          });
          return new Response(
            JSON.stringify({
              type: "error",
              error: { type: "invalid_request_error", message: "captured" },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        };
        const result = await binding.runtime
          .streamSimple(
            binding.model,
            {
              systemPrompt: "Run instructions",
              messages: [{ role: "user", content: "hi", timestamp: 1 }],
            } as any,
            { fetch, sessionId: "pi-session" } as any,
          )
          .result();
        expect(result.stopReason).toBe("error");
        expect(requests).toHaveLength(1);
        const [{ headers, body }] = requests;
        expect(headers.get("authorization")).toBe(`Bearer ${claude.token}`);
        expect(headers.get("x-api-key")).toBeNull();
        expect(headers.get("anthropic-beta")).toContain("oauth-2025-04-20");
        expect(body.model).toBe(modelID);
        expect(body.system.at(-1)).toEqual({
          type: "text",
          text: "Run instructions",
          cache_control: { type: "ephemeral", ttl: "1h" },
        });
      }
    } finally {
      if (previousEnvKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousEnvKey;
    }
  });

  test("binds a configured third-party provider plan then its key", async () => {
    const h = harness();
    await createPiRuntimeBinding(
      input("wafer", "wafer-test", h, {
        configuredProvider: {
          apiKey: "wafer-key",
          baseURL: "https://wafer.test",
        },
      }),
    );
    expect(h.calls.map(([name]) => name)).toEqual([
      "loadSdk",
      "create",
      "buildThirdPartyProviderPlan",
      "registerProvider",
      "setRuntimeApiKey",
    ]);
    expect(h.calls.at(-1)).toEqual(["setRuntimeApiKey", "wafer", "wafer-key"]);
  });

  test("preserves the unknown-model error after fallback registration fails", async () => {
    const h = harness({ account: apiKey, refuseModels: true });
    await expect(
      createPiRuntimeBinding(input("openai", "future-model", h)),
    ).rejects.toThrow(
      'Unknown OpenAI API model "future-model" (could not register it with pi)',
    );
  });
});

describe("prewarmPiSdk", () => {
  test("reuses the process cache and reset permits replacement", async () => {
    const first = Promise.resolve({ marker: "first" });
    (globalThis as any).__piSdkPromise = first;
    expect(prewarmPiSdk()).toBe(first as any);
    expect(prewarmPiSdk()).toBe(first as any);
    __resetPiSdkCacheForTest();
    const second = Promise.resolve({ marker: "second" });
    (globalThis as any).__piSdkPromise = second;
    expect(prewarmPiSdk()).toBe(second as any);
  });
});
