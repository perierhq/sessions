import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

type PiCatalogModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

/** Published limits and USD/MTok pricing for releases newer than pi's
 *  builtin catalog. */
const RELEASE_METADATA: Record<
  string,
  Pick<PiCatalogModel, "name" | "cost" | "contextWindow" | "maxTokens"> &
    Partial<Pick<PiCatalogModel, "thinkingLevelMap" | "compat">>
> = {
  // https://platform.claude.com/docs/en/models/opus-5-5/overview
  "claude-opus-5-5": {
    name: "Claude Opus 5.5",
    cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  // https://platform.claude.com/docs/en/models/sonnet-5-5/overview
  "claude-sonnet-5-5": {
    name: "Claude Sonnet 5.5",
    cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  // https://platform.claude.com/docs/en/models/haiku-5-5/overview
  // Prompts over 100K input tokens bill the whole request at the higher tier.
  "claude-haiku-5-5": {
    name: "Claude Haiku 5.5",
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
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    // All five effort levels, adaptive thinking only (pi clamps xhigh and
    // max away without an explicit map).
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
    compat: {
      supportsMidConvoEffort: true,
      supportsMidConvoSystemMessages: true,
      supportsMidConvoToolChanges: true,
      forceAdaptiveThinking: true,
      supportsTemperature: false,
      supportsStrictTools: true,
    },
  },
};

type PriceUpdates = Record<string, Partial<PiCatalogModel["cost"]>>;

/** Price changes newer than pi's builtin catalog, applied over its rows.
 *  Empty while the bundled catalog is current; add an entry (with the date of
 *  the published change) when Anthropic reprices ahead of a pi release. */
const PRICE_UPDATES: PriceUpdates = {};

/**
 * The Anthropic catalog pi-runtime-binding registers on pi's builtin
 * provider: pi's builtin models passed through (ids, cost tables, context
 * windows, compat) with newer published price changes applied, plus release
 * metadata for known newer models. Unknown ids retain the conservative
 * zero-cost subscription fallback.
 */
export function buildPiAnthropicModels(
  builtin: readonly PiCatalogModel[],
  ensureModelId?: string,
  /** Test seam: the price corrections to apply (defaults to PRICE_UPDATES). */
  priceUpdates: PriceUpdates = PRICE_UPDATES,
): PiCatalogModel[] {
  const models = builtin.map((m) => {
    const price = priceUpdates[m.id];
    return price ? { ...m, cost: { ...m.cost, ...price } } : { ...m };
  });
  if (ensureModelId && !models.some((m) => m.id === ensureModelId)) {
    models.push({
      id: ensureModelId,
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      reasoning: true,
      input: ["text", "image"],
      ...(RELEASE_METADATA[ensureModelId] ?? {
        name: ensureModelId,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 32_000,
      }),
    } as PiCatalogModel);
  }
  return models;
}
