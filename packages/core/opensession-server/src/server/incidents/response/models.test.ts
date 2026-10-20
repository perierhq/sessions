import { expect, test } from "bun:test";
import {
  canonicalModelId,
  chooseRoleModels,
  independenceBetween,
  sameModel,
} from "./models";

const candidates = [
  { id: "pi/anthropic/claude-opus-5-5", label: "Opus 5.5" },
  { id: "pi/anthropic/claude-fable-5-1", label: "Fable 5.1" },
  { id: "pi/openai/gpt-6.1-sol", label: "GPT-6.1 Sol" },
];
const providerOf = (id: string) => id.split("/")[1];
const base = {
  candidates,
  providerOf,
  defaultModel: "pi/anthropic/claude-opus-5-5",
};

test("default: verifier on another provider", () => {
  expect(
    chooseRoleModels({
      ...base,
      configuredProviders: new Set(["anthropic", "openai"]),
    }),
  ).toEqual({
    investigator: {
      model: "pi/anthropic/claude-opus-5-5",
      provider: "anthropic",
      label: "Opus 5.5",
    },
    verifier: {
      model: "pi/openai/gpt-6.1-sol",
      provider: "openai",
      label: "GPT-6.1 Sol",
      independence: "other-provider",
    },
  });
});
test("one provider: same provider, different model", () => {
  expect(
    chooseRoleModels({ ...base, configuredProviders: new Set(["anthropic"]) }),
  ).toMatchObject({
    verifier: {
      model: "pi/anthropic/claude-fable-5-1",
      independence: "same-provider",
    },
  });
});
test("one model: same model, never an error", () => {
  expect(
    chooseRoleModels({
      ...base,
      candidates: candidates.slice(0, 1),
      configuredProviders: new Set(["anthropic"]),
    }),
  ).toMatchObject({
    verifier: {
      model: "pi/anthropic/claude-opus-5-5",
      independence: "same-model",
    },
  });
});
test("explicit choices and unconfigured providers", () => {
  expect(
    chooseRoleModels({
      ...base,
      investigatorModel: "pi/openai/gpt-6.1-sol",
      verifierModel: "pi/openai/gpt-6.1-sol",
      configuredProviders: new Set(["anthropic", "openai"]),
    }),
  ).toMatchObject({ verifier: { independence: "same-model" } });
  expect(
    chooseRoleModels({ ...base, configuredProviders: new Set(["openai"]) }),
  ).toEqual({
    error: "No model provider is configured for incident agents",
  });
  expect(
    chooseRoleModels({
      ...base,
      verifierModel: "pi/xai/grok-5",
      configuredProviders: new Set(["anthropic"]),
    }),
  ).toEqual({ error: "The verifier model's provider is not configured" });
});
test("independence compares provider, then id", () => {
  expect(
    independenceBetween(
      { model: "a/x", provider: "a" },
      { model: "b/y", provider: "b" },
    ),
  ).toBe("other-provider");
  expect(
    independenceBetween(
      { model: "a/x", provider: "a" },
      { model: "a/y", provider: "a" },
    ),
  ).toBe("same-provider");
  expect(
    independenceBetween(
      { model: "a/x", provider: "a" },
      { model: "a/x", provider: "a" },
    ),
  ).toBe("same-model");
});
test("dated, variant and Bedrock ids name the same model", () => {
  for (const [a, b] of [
    ["claude-sonnet-4-5-20250929", "pi/anthropic/claude-sonnet-4-5"],
    ["pi/anthropic/claude-sonnet-4-5@20250929", "claude-sonnet-4-5"],
    ["pi/openrouter/anthropic/claude-sonnet-4-5:thinking", "claude-sonnet-4-5"],
    [
      "pi/bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      "pi/anthropic/claude-sonnet-4-5",
    ],
    ["pi/bedrock/anthropic.claude-sonnet-4-5-v2:0", "claude-sonnet-4-5"],
    ["gpt-6.1-sol-2026-08-01", "pi/openai/gpt-6.1-sol"],
    ["claude-sonnet-4-5-latest", "claude-sonnet-4-5"],
  ])
    expect([a, b, sameModel(a, b)]).toEqual([a, b, true]);
  expect(sameModel("claude-sonnet-4-5", "claude-sonnet-4-6")).toBe(false);
  expect(sameModel("claude-opus-4-1", "claude-opus-4")).toBe(false);
});
test("aliases and routed ids name the same model", () => {
  expect(canonicalModelId("opus")).toBe("pi/anthropic/claude-opus-5-5");
  expect(canonicalModelId("claude-opus-5-5")).toBe(
    "pi/anthropic/claude-opus-5-5",
  );
  expect(sameModel("opus", "pi/anthropic/claude-opus-5-5")).toBe(true);
  expect(
    sameModel(
      "pi/openrouter/anthropic/claude-opus-5-5",
      "pi/anthropic/claude-opus-5-5",
    ),
  ).toBe(true);
  expect(sameModel("opus", "pi/openai/gpt-6.1-sol")).toBe(false);
  expect(
    independenceBetween(
      { model: "opus", provider: "anthropic" },
      { model: "pi/anthropic/claude-opus-5-5", provider: "anthropic" },
    ),
  ).toBe("same-model");
  expect(
    independenceBetween(
      {
        model: "pi/openrouter/anthropic/claude-opus-5-5",
        provider: "openrouter",
      },
      { model: "pi/anthropic/claude-opus-5-5", provider: "anthropic" },
    ),
  ).toBe("same-model");
});
test("the default verifier is never the same model through another provider", () => {
  expect(
    chooseRoleModels({
      ...base,
      candidates: [
        candidates[0],
        { id: "pi/openrouter/anthropic/claude-opus-5-5", label: "Opus via OR" },
        candidates[1],
      ],
      providerOf,
      configuredProviders: new Set(["anthropic", "openrouter"]),
    }),
  ).toMatchObject({
    verifier: {
      model: "pi/anthropic/claude-fable-5-1",
      independence: "same-provider",
    },
  });
});
