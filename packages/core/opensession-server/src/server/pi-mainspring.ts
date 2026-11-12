/**
 * Pi turns through Mainspring (mainspring.ts, docs/setup/mainspring.md).
 *
 * Two kinds of turn go to Mainspring:
 * - `pi/mainspring/<model>`: any model Mainspring serves. Claude models use
 *   its Anthropic Messages endpoint (`<base>/v1/messages`), everything else
 *   its OpenAI Chat Completions endpoint (`<base>/v1/chat/completions`).
 * - `pi/anthropic/<model>` while the owner has "Route Claude through
 *   Mainspring" on. The local Claude account walk and OAuth binding are
 *   skipped: Mainspring picks the account.
 *
 * Every request carries the session id as `X-Session-ID` (a provider header)
 * and, on the Anthropic endpoint, as `metadata.user_id`, so Mainspring keeps
 * the session on one account and its prompt cache stays warm.
 *
 * A strict account pin (a fixed-subscription session) keeps its direct
 * account: the person chose that subscription, and Mainspring cannot honour
 * the pin. Without "Fall back to direct accounts" a failure through
 * Mainspring ends the turn; it never moves to the local accounts silently.
 */
import type { AnthropicRateLimitSnapshot } from "./anthropic-rate-limit";
import type { FetchLike } from "./anthropic-rate-limit";
import {
  FALLBACK_CONTEXT_WINDOW,
  FALLBACK_MAX_TOKENS,
  type ProviderCatalogModel,
} from "./model-providers";
import {
  MAINSPRING_PROVIDER,
  classifyMainspringFailure,
  isClaudeModelId,
  mainspringConfig,
  mainspringFailureText,
  readMainspringRecord,
  readMainspringResponse,
  type MainspringFailure,
  type MainspringRecord,
  type MainspringResponseSnapshot,
} from "./mainspring";

export { MAINSPRING_PROVIDER };

/** What a runtime binding needs to send a turn to Mainspring. */
export interface MainspringTarget {
  /** The address without `/v1`. */
  baseUrl: string;
  key: string;
  /** Session affinity: `X-Session-ID` and `metadata.user_id`. */
  sessionId: string;
  /** Mainspring's cached `/v1/models` row for the model, if listed. */
  catalogRow?: ProviderCatalogModel;
}

/** Where a turn's provider requests go. */
export type MainspringRoute =
  | { kind: "direct" }
  | { kind: "mainspring"; target: MainspringTarget; fallbackDirect: boolean }
  | { kind: "error"; message: string };

/**
 * Decide the route for one attempt. `fellBack` is the walk's "this turn
 * already moved to the direct accounts".
 */
export async function resolveMainspringRoute(input: {
  providerID: string;
  modelID: string;
  sessionId: string;
  accountId?: string;
  accountStrict?: boolean;
  fellBack?: boolean;
  /** Test seams. */
  readRecord?: () => Promise<MainspringRecord>;
  resolveConfig?: typeof mainspringConfig;
}): Promise<MainspringRoute> {
  const explicit = input.providerID === MAINSPRING_PROVIDER;
  if (!explicit && input.providerID !== "anthropic") return { kind: "direct" };
  const record = await (input.readRecord ?? readMainspringRecord)().catch(
    () => undefined,
  );
  if (!explicit) {
    if (!record?.routeClaude || input.fellBack) return { kind: "direct" };
    if (input.accountStrict && input.accountId) return { kind: "direct" };
  }
  const config = record
    ? await (input.resolveConfig ?? mainspringConfig)(record).catch(() => null)
    : null;
  if (!config) {
    if (!explicit && record?.fallbackDirect) return { kind: "direct" };
    return {
      kind: "error",
      message: explicit
        ? "Mainspring is not set up. Add its address and a key under Settings, Providers, Mainspring."
        : "Claude is routed through Mainspring, but Mainspring has no usable key. Paste a key under Settings, Providers, Mainspring.",
    };
  }
  const catalogRow = record?.models?.models
    ? (record.models.models[input.modelID] ??
      Object.values(record.models.models).find(
        (row) => row.id.toLowerCase() === input.modelID.toLowerCase(),
      ))
    : undefined;
  return {
    kind: "mainspring",
    target: {
      baseUrl: config.baseUrl,
      key: config.key,
      sessionId: input.sessionId,
      ...(catalogRow ? { catalogRow } : {}),
    },
    fallbackDirect: !explicit && record?.fallbackDirect === true,
  };
}

/** The anthropic-catalog row shape the binding passes in. */
interface AnthropicRow {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  cost?: unknown;
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: unknown;
  compat?: unknown;
}

/**
 * The provider registration for one Mainspring model: Anthropic Messages at
 * the bare address for Claude (the Anthropic SDK appends `/v1/messages`),
 * OpenAI Chat Completions at `<base>/v1` for everything else. A Claude model
 * keeps pi's own metadata (pricing, limits, thinking ladder, compat) when pi
 * or our release table knows it; Mainspring's `/v1/models` row fills the
 * rest, then the conservative fallbacks.
 */
export function buildMainspringProviderConfig(input: {
  modelID: string;
  target: MainspringTarget;
  /** pi's Anthropic rows (buildPiAnthropicModels) for Claude models. */
  anthropicRows: readonly AnthropicRow[];
}) {
  const { modelID, target } = input;
  const row = target.catalogRow;
  const headers = { "X-Session-ID": target.sessionId };
  if (isClaudeModelId(modelID)) {
    const known = input.anthropicRows.find((m) => m.id === modelID);
    const { id: _id, ...rest } = (known ?? {}) as AnthropicRow &
      Record<string, unknown>;
    delete rest.provider;
    delete rest.baseUrl;
    delete rest.api;
    delete rest.headers;
    return {
      name: "Mainspring",
      api: "anthropic-messages" as const,
      baseUrl: target.baseUrl,
      headers,
      models: [
        {
          ...rest,
          id: modelID,
          name: known?.name ?? row?.name ?? modelID,
          reasoning: known?.reasoning ?? row?.reasoning ?? true,
          input: known?.input ?? row?.input ?? ["text", "image"],
          cost: known?.cost ?? {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
          contextWindow:
            known?.contextWindow ??
            row?.contextWindow ??
            FALLBACK_CONTEXT_WINDOW,
          maxTokens: known?.maxTokens ?? row?.maxTokens ?? FALLBACK_MAX_TOKENS,
        },
      ],
    };
  }
  return {
    name: "Mainspring",
    api: "openai-completions" as const,
    baseUrl: `${target.baseUrl}/v1`,
    headers,
    models: [
      {
        id: modelID,
        name: row?.name ?? modelID,
        reasoning: row?.reasoning ?? true,
        thinkingLevelMap: {},
        input: row?.input ?? ["text"],
        cost: row?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: row?.contextWindow ?? FALLBACK_CONTEXT_WINDOW,
        maxTokens: row?.maxTokens ?? FALLBACK_MAX_TOKENS,
      },
    ],
  };
}

type StreamFunction = (
  model: any,
  context: any,
  options?: any,
) => unknown | Promise<unknown>;

/** Set `metadata.user_id` on an Anthropic Messages payload (one with
 *  `messages` and no OpenAI-only fields). Other payloads pass unchanged. */
export function withMainspringSessionMetadata(
  payload: unknown,
  sessionId: string,
): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return payload;
  const body = payload as Record<string, unknown>;
  const metadata =
    body.metadata && typeof body.metadata === "object"
      ? (body.metadata as Record<string, unknown>)
      : {};
  return { ...body, metadata: { ...metadata, user_id: sessionId } };
}

/**
 * Install the request hooks on a pi agent for a Mainspring-bound turn:
 * `metadata.user_id` on every Anthropic Messages payload, and a fetch that
 * reads Mainspring's headers off every response, failed ones included (pi's
 * error text drops them, and its onResponse hook never sees a failure).
 * Another provider's requests pass through untouched.
 */
export function enableMainspringRequestHooks(
  agent: {
    onPayload?: (payload: unknown, model: any) => unknown | Promise<unknown>;
    streamFunction?: StreamFunction;
  },
  input: {
    sessionId: string;
    onResponse: (snapshot: MainspringResponseSnapshot) => void;
  },
): void {
  const isMainspring = (model: unknown) =>
    (model as { provider?: unknown } | undefined)?.provider ===
    MAINSPRING_PROVIDER;
  const baseOnPayload = agent.onPayload;
  agent.onPayload = async (payload, model) => {
    const transformed = await baseOnPayload?.(payload, model);
    if (
      !isMainspring(model) ||
      (model as { api?: unknown }).api !== "anthropic-messages"
    )
      return transformed;
    return withMainspringSessionMetadata(
      transformed ?? payload,
      input.sessionId,
    );
  };
  const base = agent.streamFunction;
  if (typeof base !== "function") return;
  agent.streamFunction = (model, context, options) => {
    if (!isMainspring(model)) return base(model, context, options);
    const inner = (options as { fetch?: FetchLike } | undefined)?.fetch;
    return base(model, context, {
      ...options,
      fetch: mainspringResponseFetch(inner, input.onResponse),
    });
  };
}

/** A fetch that records Mainspring's headers before handing the response
 *  back unchanged. */
export function mainspringResponseFetch(
  inner: FetchLike | undefined,
  record: (snapshot: MainspringResponseSnapshot) => void,
): FetchLike {
  return async (input, init) => {
    const response = await (inner ?? (globalThis.fetch as FetchLike))(
      input,
      init,
    );
    try {
      record(readMainspringResponse(response.status, response.headers));
    } catch {}
    return response;
  };
}

/** The served-by fields a turn's audit closer carries. Never the key. */
export function mainspringAuditFields(
  snapshot: MainspringResponseSnapshot | undefined,
): Record<string, unknown> {
  if (!snapshot) return {};
  return {
    via: MAINSPRING_PROVIDER,
    ...(snapshot.account ? { mainspring_account: snapshot.account } : {}),
    ...(snapshot.provider ? { mainspring_provider: snapshot.provider } : {}),
    ...(snapshot.limits ? { mainspring_limits: snapshot.limits } : {}),
    ...(snapshot.movedFrom
      ? {
          mainspring_moved_from: snapshot.movedFrom,
          mainspring_moved_reason: snapshot.movedReason,
        }
      : {}),
  };
}

/** The rate-limit snapshot shape the account walk keeps, for a 429 from
 *  Mainspring (its reset is `Retry-After`). */
export function mainspringRateLimit(
  snapshot: MainspringResponseSnapshot,
): AnthropicRateLimitSnapshot {
  return {
    httpStatus: snapshot.httpStatus,
    ...(snapshot.resetAt !== undefined ? { resetAt: snapshot.resetAt } : {}),
  };
}

/**
 * A failed Mainspring turn, mapped: the classified failure, its fixed text,
 * and whether it is a usage limit (429). A 401 is not a usage limit and not
 * transient: the session needs the owner. A 502/503 keeps its status in the
 * text, which the fallback walk reads as a transient provider error.
 */
export function mainspringTurnFailure(input: {
  message: string;
  snapshot: MainspringResponseSnapshot | undefined;
  modelID: string;
}): { failure: MainspringFailure; text: string; usageLimit: boolean } | null {
  const failure = classifyMainspringFailure(input.message, input.snapshot);
  if (!failure) return null;
  return {
    failure,
    text: mainspringFailureText(failure, input.modelID),
    usageLimit: failure.kind === "resting" || failure.kind === "cap",
  };
}
