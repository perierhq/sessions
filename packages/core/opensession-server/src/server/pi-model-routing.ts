import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  FALLBACK_CONTEXT_WINDOW,
  FALLBACK_MAX_TOKENS,
  configuredProviderCatalog,
  modelProviders,
  piProviderCatalog,
  type ModelProviderConfig,
  type PiProviderCatalog,
} from "./model-providers";
import { getDefaultModel, toPiModel } from "./models";
import { XAI_OAUTH_PROVIDER } from "./xai-provider-id";

/** The extension-registration config shape ModelRuntime.registerProvider
 *  accepts (ProviderConfigInput — not re-exported by the package index). */
export type PiProviderConfigInput = Parameters<
  ModelRuntime["registerProvider"]
>[1];

export const PI_MODEL_PREFIX = "pi/";

/** Split `pi/<provider>/<model>` (model may itself contain slashes). */
export function parsePiModel(
  model: string,
): { providerID: string; modelID: string } | null {
  if (!model.startsWith(PI_MODEL_PREFIX)) return null;
  const rest = model.slice(PI_MODEL_PREFIX.length);
  const sep = rest.indexOf("/");
  if (sep <= 0 || sep === rest.length - 1) return null;
  return { providerID: rest.slice(0, sep), modelID: rest.slice(sep + 1) };
}

/** Resolve a Pi model id (or a legacy id) to the provider/model pair that
 * executes the turn. */
export function resolvePiRoutedModel(model: string): PiResolvedModel | null {
  const concrete = toPiModel(model);
  return concrete ? parsePiModel(concrete) : null;
}

/** Explain why a model id could not be resolved to a Pi model. */
export function piModelResolutionError(model: string): string {
  return `Not a pi model id: "${model}" (expected pi/<provider>/<model>)`;
}

/** Providers whose accounts come from their own pools, not a configured
 *  API key. */
const ACCOUNT_POOL_PROVIDERS = new Set([
  "anthropic",
  "openai",
  XAI_OAUTH_PROVIDER,
]);

/** Why this instance can't serve `model` (not a Pi model, or a provider with
 *  no credentials configured), or null when it can. The Pi runner refuses a
 *  turn on this; run start and automatic notices check it first. */
export function piModelUnservableReason(model: string): string | null {
  const parsed = resolvePiRoutedModel(model);
  if (!parsed) return piModelResolutionError(model);
  if (ACCOUNT_POOL_PROVIDERS.has(parsed.providerID)) return null;
  if (modelProviders()[parsed.providerID]?.apiKey) return null;
  return (
    `The Pi engine has no credentials for provider "${parsed.providerID}" ` +
    `(got "${model}"). Configure that model provider first.`
  );
}

/** Whether a session's model (the instance default when it names none)
 *  can run here. */
export function sessionModelRunnable(session: { model?: string }): boolean {
  const model = session.model || getDefaultModel();
  return !!model && piModelUnservableReason(model) === null;
}

export interface PiResolvedModel {
  providerID: string;
  modelID: string;
}

/**
 * Registration plan for a third-party (non-anthropic/openai) provider — the
 * pure half of the runner's provider branch, exported for tests.
 *
 * Model metadata comes from Pi's built-in provider catalog when Pi knows the
 * provider (Cerebras, Moonshot, xAI, and others). piProviderCatalog supplies a
 * provider Pi does not know (Wafer) and models newer than its bundled snapshot
 * (GLM-5.3 on OpenRouter). The operator's config adds a third layer: a
 * declared `api` makes a slug unknown to both catalogs runnable as a plain
 * OpenAI-compatible provider at its `baseURL`, and its catalog rows (inline,
 * file, or discovered) override the other layers per model id. A provider in
 * no catalog fails clearly rather than guessing a protocol. A model id in none
 * of them gets a conservative fallback entry: zero cost because unknown
 * pricing must under-report, plus safe window and output floors. It inherits
 * the provider's API and base URL, so catalog lag never blocks a run.
 */
export function buildPiThirdPartyProviderPlan(input: {
  providerID: string;
  modelID: string;
  apiKey: string;
  baseURL?: string;
  /** The provider's stored config beyond the key and base URL. */
  configured?: ModelProviderConfig;
  /** Model ids pi's built-in catalog holds for this provider (may be empty). */
  builtinModelIds: readonly string[];
}): { config: PiProviderConfigInput } | { error: string } {
  const ours = piProviderCatalog(input.providerID);
  const custom = configuredProviderCatalog(input.providerID, input.configured);
  const builtin = new Set(input.builtinModelIds);
  const declared = !!input.configured?.api;
  if (!ours && !builtin.size && !declared) {
    return {
      error:
        `Provider "${input.providerID}" is in neither Pi's built-in catalog nor ours, ` +
        "so the Pi engine cannot guess its protocol. Set its api to openai-completions " +
        "with a base URL, or configure a supported provider for this model.",
    };
  }
  if (declared && !input.baseURL) {
    return {
      error: `Provider "${input.providerID}" declares an api but no base URL. Set its base URL first.`,
    };
  }
  const configuredRow = custom?.models.find((m) => m.id === input.modelID);
  const builtinKnown = builtin.has(input.modelID) && !configuredRow;
  const catalogKnown =
    !!configuredRow || !!ours?.models.some((m) => m.id === input.modelID);
  // Registering `models` REPLACES the provider's model list in Pi's extension
  // layer. Preserve Pi's full built-in list when it already knows the selected
  // model and the operator pinned nothing for it. Otherwise the table carries
  // our rows, the configured rows on top (same id wins), and a conservative
  // fallback row when the selected model is in none of them.
  const table = new Map<string, PiProviderCatalog["models"][number]>();
  for (const m of ours?.models ?? []) table.set(m.id, m);
  for (const m of custom?.models ?? []) table.set(m.id, m);
  const models = builtinKnown
    ? []
    : [
        ...table.values(),
        ...(catalogKnown
          ? []
          : [
              {
                id: input.modelID,
                name: input.modelID,
                reasoning: true,
                input: ["text"] as Array<"text" | "image">,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: FALLBACK_CONTEXT_WINDOW,
                maxTokens: FALLBACK_MAX_TOKENS,
              },
            ]),
      ];
  const api = custom?.api ?? ours?.api;
  const name = input.configured?.name || ours?.name;
  return {
    config: {
      apiKey: input.apiKey,
      ...(api && (declared || ours) ? { api } : {}),
      ...(name && (declared || ours) ? { name } : {}),
      ...(input.baseURL
        ? { baseUrl: input.baseURL }
        : ours
          ? { baseUrl: ours.baseUrl }
          : {}),
      ...(models.length ? { models } : {}),
    },
  };
}
