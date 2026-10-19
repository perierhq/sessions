import { describe, expect, test } from "bun:test";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { buildPiAnthropicModels } from "./pi-anthropic-models";

type PiCatalogModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

const model = {
  id: "claude-sonnet-5",
  name: "Claude Sonnet 5",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  contextWindow: 200_000,
  maxTokens: 64_000,
} as unknown as PiCatalogModel;

describe("buildPiAnthropicModels", () => {
  test("carries the builtin catalog through untouched and appends a zero-cost fallback", () => {
    const out = buildPiAnthropicModels([model], "claude-brand-new-9");
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      id: "claude-sonnet-5",
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      contextWindow: 200_000,
    });
    expect(out[1]).toMatchObject({
      id: "claude-brand-new-9",
      provider: "anthropic",
      api: "anthropic-messages",
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 32_000,
    });
  });

  test("registers Opus 5.5 with its published limits and pricing", () => {
    const [opus] = buildPiAnthropicModels([], "claude-opus-5-5");
    expect(opus).toMatchObject({
      id: "claude-opus-5-5",
      name: "Claude Opus 5.5",
      reasoning: true,
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    });
    expect(buildPiAnthropicModels([opus!], "claude-opus-5-5")).toHaveLength(1);
  });

  test("registers Sonnet 5.5 with its published limits and pricing", () => {
    const [sonnet] = buildPiAnthropicModels([], "claude-sonnet-5-5");
    expect(sonnet).toMatchObject({
      id: "claude-sonnet-5-5",
      name: "Claude Sonnet 5.5",
      reasoning: true,
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
    });
  });

  test("applies the halved Sonnet 5.5 cache-read price over the builtin row", () => {
    const builtin = {
      ...model,
      id: "claude-sonnet-5-5",
      cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    } as PiCatalogModel;
    const [sonnet] = buildPiAnthropicModels([builtin], "claude-sonnet-5-5");
    expect(sonnet!.cost).toEqual({
      input: 2,
      output: 10,
      cacheRead: 0.1,
      cacheWrite: 2.5,
    });
    expect(builtin.cost.cacheRead).toBe(0.2);
  });

  test("registers Haiku 5.5 with tiered pricing and every effort level", () => {
    const [haiku] = buildPiAnthropicModels([], "claude-haiku-5-5");
    expect(haiku).toMatchObject({
      id: "claude-haiku-5-5",
      name: "Claude Haiku 5.5",
      reasoning: true,
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      cost: {
        input: 0.1,
        output: 0.5,
        cacheRead: 0.01,
        cacheWrite: 0.125,
        tiers: [
          {
            inputTokensAbove: 100_000,
            input: 0.5,
            output: 2.5,
            cacheRead: 0.05,
            cacheWrite: 0.625,
          },
        ],
      },
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    });
  });

  test("does not duplicate a model the catalog already has", () => {
    expect(buildPiAnthropicModels([model], "claude-sonnet-5")).toHaveLength(1);
  });
});
