/**
 * The `web_search` tool. Pi has no web search of its own, so the tool makes
 * a separate, short request to a connected provider's small model with that
 * provider's server-side search tool injected into the request payload, and
 * returns a short written answer with Markdown links to its sources.
 *
 * - The side request runs on pi's runtime (`completeSimple`) through the same
 *   per-turn account binding a turn uses (pi-runtime-binding.ts), so a Claude
 *   search is a native Anthropic request on a Claude pool account. It runs
 *   where the turn's engine runs, never inside a Sandbox, so it needs no
 *   Sandbox egress.
 * - The server tool goes in through pi's `onPayload` hook, the payload seam
 *   pi-session-setup.ts uses for the turn's own requests. The side request
 *   carries only that server tool; the turn's `web_search` function tool is
 *   never in it, so the two names cannot collide.
 * - Anthropic: `web_search_20260318` with dynamic filtering (Claude filters
 *   results in server-side code execution before they reach its context;
 *   needs Claude 4.6 or newer, older models call the tool directly), and
 *   `pause_turn` continuations. OpenAI (Codex and API key accounts): the
 *   Responses `web_search` tool.
 * - Which provider: Settings (web-search-setting.ts). Automatic tries the
 *   session's provider first, then the others; a specific provider is strict.
 *
 * The helpers here are pure and unit-tested with a mocked runtime; the
 * binding and audit wiring is in makePiWebSearch.
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WebSearchSetting } from "./web-search-setting";

/** Latest Anthropic server web-search tool version (dynamic filtering on by
 *  default, and `response_inclusion`). */
export const ANTHROPIC_WEB_SEARCH_TYPE = "web_search_20260318";
/** Cap on the provider's own search loop, so one call cannot spend a plan. */
export const MAX_SEARCH_USES = 5;
/** Findings are capped so a search cannot flood the turn's context. */
export const MAX_FINDINGS_CHARS = 8_000;
/** Follow-up requests after `stop_reason: "pause_turn"`. */
export const MAX_PAUSE_CONTINUATIONS = 3;
/** Output budget for one side request. */
const SEARCH_MAX_TOKENS = 8_192;

export const WEB_SEARCH_TOOL = "web_search";

/** Providers whose server-side search the tool can use, in Automatic order. */
export type SearchProviderId = "anthropic" | "openai";
export const SEARCH_PROVIDERS: readonly SearchProviderId[] = [
  "anthropic",
  "openai",
];
export const SEARCH_PROVIDER_LABELS: Record<SearchProviderId, string> = {
  anthropic: "Claude",
  openai: "OpenAI",
};

/** The system prompt of the side request. */
export const WEB_SEARCH_SYSTEM = [
  "You are a web research helper. Search the web for the user's query and write a short, factual answer.",
  "Cite sources as labeled Markdown links to their URLs, e.g. [Source title](https://example.com/page), next to the fact each supports.",
  "Do not add citation markers of any other kind.",
  "Be concise: a few sentences or short bullets, only what the query asks for. If the search finds nothing useful, say so plainly.",
].join("\n");

export function buildSearchRequest(query: string): string {
  return `Search the web and answer, with Markdown links to your sources: ${query}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Whether an Anthropic model can run the search tool's dynamic filtering
 * (Claude 4.6 and newer). Parsed from the id: `claude-<family>-<major>-<minor>`
 * or `claude-<major>-<minor>-<family>`; a date suffix is not a minor version.
 * An id without a readable version is treated as new.
 */
export function anthropicSupportsDynamicFiltering(modelId: string): boolean {
  const match = modelId
    .toLowerCase()
    .match(/^claude-(?:[a-z]+-)*?(\d+)(?:[-.](\d{1,2}))?(?=-|$)/);
  if (!match) return true;
  const major = Number(match[1]);
  const minor = match[2] === undefined ? 0 : Number(match[2]);
  return major > 4 || (major === 4 && minor >= 6);
}

/** The server-side search tool for a pi model API, or null when it has none. */
export function webSearchServerTool(
  api: string | undefined,
  modelId: string,
  opts: { direct?: boolean } = {},
): Record<string, unknown> | null {
  if (api === "anthropic-messages") {
    return {
      type: ANTHROPIC_WEB_SEARCH_TYPE,
      name: WEB_SEARCH_TOOL,
      max_uses: MAX_SEARCH_USES,
      // Only the answer's text is read, so the raw result blocks stay out.
      response_inclusion: "excluded",
      ...(opts.direct || !anthropicSupportsDynamicFiltering(modelId)
        ? { allowed_callers: ["direct"] }
        : {}),
    };
  }
  if (api === "openai-responses" || api === "openai-codex-responses")
    return { type: "web_search" };
  return null;
}

/**
 * Shape a side-request payload: the server tool is its only tool, and a
 * `pause_turn` continuation appends the paused assistant turn unchanged
 * (and its code execution container, when there is one).
 */
export function injectWebSearchTool(
  payload: unknown,
  tool: Record<string, unknown>,
  paused?: { content: unknown[]; container?: string },
): unknown {
  if (!isRecord(payload)) return payload;
  const { tool_choice: _choice, ...rest } = payload;
  const out: Record<string, unknown> = { ...rest, tools: [tool] };
  if (paused) {
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    out.messages = [
      ...messages,
      { role: "assistant", content: paused.content },
    ];
    if (paused.container) out.container = paused.container;
  }
  return out;
}

/** Rebuilds one Anthropic response's raw content blocks from its stream
 *  events, the way the SDK accumulates a message. */
export class AnthropicResponseCollector {
  blocks: Array<Record<string, unknown>> = [];
  stopReason: string | undefined;
  searches = 0;
  container: string | undefined;
  private byIndex = new Map<number, Record<string, unknown>>();
  private json = new Map<number, string>();

  onEvent(event: unknown): void {
    if (!isRecord(event)) return;
    const index = typeof event.index === "number" ? event.index : -1;
    if (event.type === "message_start" && isRecord(event.message)) {
      this.readContainer(event.message.container);
      this.readUsage(event.message.usage);
    } else if (
      event.type === "content_block_start" &&
      isRecord(event.content_block)
    ) {
      const block = structuredClone(event.content_block);
      this.blocks.push(block);
      this.byIndex.set(index, block);
    } else if (event.type === "content_block_delta" && isRecord(event.delta)) {
      const block = this.byIndex.get(index);
      const delta = event.delta;
      if (!block) return;
      if (delta.type === "text_delta" && typeof delta.text === "string")
        block.text = `${block.text ?? ""}${delta.text}`;
      else if (delta.type === "citations_delta" && delta.citation)
        block.citations = [
          ...(Array.isArray(block.citations) ? block.citations : []),
          delta.citation,
        ];
      else if (
        delta.type === "thinking_delta" &&
        typeof delta.thinking === "string"
      )
        block.thinking = `${block.thinking ?? ""}${delta.thinking}`;
      else if (
        delta.type === "signature_delta" &&
        typeof delta.signature === "string"
      )
        block.signature = `${block.signature ?? ""}${delta.signature}`;
      else if (
        delta.type === "input_json_delta" &&
        typeof delta.partial_json === "string"
      )
        this.json.set(
          index,
          `${this.json.get(index) ?? ""}${delta.partial_json}`,
        );
    } else if (event.type === "content_block_stop") {
      const block = this.byIndex.get(index);
      const raw = this.json.get(index);
      if (block && raw) {
        try {
          block.input = JSON.parse(raw);
        } catch {
          // Leave the start event's input as it was.
        }
      }
      this.byIndex.delete(index);
      this.json.delete(index);
    } else if (event.type === "message_delta") {
      if (isRecord(event.delta)) {
        if (typeof event.delta.stop_reason === "string")
          this.stopReason = event.delta.stop_reason;
        this.readContainer(event.delta.container);
      }
      this.readUsage(event.usage);
    }
  }

  private readContainer(container: unknown): void {
    if (isRecord(container) && typeof container.id === "string")
      this.container = container.id;
  }

  private readUsage(usage: unknown): void {
    if (!isRecord(usage) || !isRecord(usage.server_tool_use)) return;
    const n = usage.server_tool_use.web_search_requests;
    if (typeof n === "number" && n > this.searches) this.searches = n;
  }
}

const MARKDOWN_LINK = /\]\(https?:\/\//;
const MAX_LISTED_SOURCES = 8;

/**
 * The answer in a response's raw blocks: the text after the last
 * non-text block (the narration before a search is not the answer), else
 * all text. Server tool calls, search results and code execution blocks are
 * read only for source URLs, listed when the text has no links of its own.
 */
export function findingsFromBlocks(
  blocks: ReadonlyArray<Record<string, unknown>>,
): string {
  const textOf = (list: ReadonlyArray<Record<string, unknown>>) =>
    list
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("")
      .trim();
  let last = -1;
  blocks.forEach((block, i) => {
    if (block.type !== "text") last = i;
  });
  const text = textOf(blocks.slice(last + 1)) || textOf(blocks);
  if (!text || MARKDOWN_LINK.test(text)) return text;
  const sources = new Map<string, string>();
  const add = (url: unknown, title: unknown) => {
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) return;
    if (!sources.has(url))
      sources.set(url, typeof title === "string" && title ? title : url);
  };
  for (const block of blocks) {
    if (block.type === "text" && Array.isArray(block.citations))
      for (const c of block.citations) if (isRecord(c)) add(c.url, c.title);
    if (block.type === "web_search_tool_result" && Array.isArray(block.content))
      for (const r of block.content) if (isRecord(r)) add(r.url, r.title);
  }
  if (!sources.size) return text;
  const list = [...sources]
    .slice(0, MAX_LISTED_SOURCES)
    .map(([url, title]) => `- [${title.replace(/[[\]]/g, "")}](${url})`);
  return `${text}\n\nSources:\n${list.join("\n")}`;
}

/** Trim findings to the cap, with a note when truncated. */
export function formatFindings(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return trimmed.length <= MAX_FINDINGS_CHARS
    ? trimmed
    : `${trimmed.slice(0, MAX_FINDINGS_CHARS).trimEnd()}\n\n[Findings truncated.]`;
}

/** The pi model fields a side request reads. */
export interface SearchModel {
  id: string;
  api: string;
  provider: string;
}

interface AssistantLike {
  content?: ReadonlyArray<{ type: string; text?: string }>;
  stopReason?: string;
  errorMessage?: string;
}

/** The slice of pi's ModelRuntime a search needs. */
export interface SearchRuntime {
  completeSimple(
    model: any,
    context: {
      systemPrompt?: string;
      messages: Array<{ role: "user"; content: string; timestamp: number }>;
    },
    options?: {
      signal?: AbortSignal;
      maxTokens?: number;
      onPayload?: (payload: unknown, model: any) => unknown | Promise<unknown>;
      onProviderStreamEvent?: (
        data: unknown,
        model: any,
      ) => void | Promise<void>;
    },
  ): Promise<AssistantLike>;
}

export type SearchAttemptResult =
  | { ok: true; text: string; searches: number; continuations: number }
  | { ok: false; error: string; searches: number };

const piText = (message: AssistantLike) =>
  (message.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("")
    .trim();

/**
 * One provider's search: the side request, its `pause_turn` continuations
 * (Anthropic, up to MAX_PAUSE_CONTINUATIONS, then whatever exists), and one
 * retry with direct calls when the API asks for `allowed_callers`.
 */
export async function searchWithModel(input: {
  runtime: SearchRuntime;
  model: SearchModel;
  query: string;
  signal: AbortSignal;
  /** Extra payload transform applied first (the Anthropic prompt rewrite). */
  basePayload?: (payload: unknown) => unknown;
}): Promise<SearchAttemptResult> {
  const { runtime, model, query, signal } = input;
  const anthropic = model.api === "anthropic-messages";
  let direct = false;
  let retriedDirect = false;
  let searches = 0;
  let continuations = 0;
  const paused: Array<Record<string, unknown>> = [];
  let container: string | undefined;
  let fallbackText = "";
  for (;;) {
    const tool = webSearchServerTool(model.api, model.id, { direct });
    if (!tool)
      return { ok: false, error: `${model.api} has no web search`, searches };
    const collector = new AnthropicResponseCollector();
    const continuation = paused.length
      ? { content: [...paused], container }
      : undefined;
    const message = await runtime.completeSimple(
      model,
      {
        systemPrompt: WEB_SEARCH_SYSTEM,
        messages: [
          {
            role: "user",
            content: buildSearchRequest(query),
            timestamp: Date.now(),
          },
        ],
      },
      {
        signal,
        maxTokens: SEARCH_MAX_TOKENS,
        onPayload: (payload) =>
          injectWebSearchTool(
            input.basePayload ? input.basePayload(payload) : payload,
            tool,
            continuation,
          ),
        ...(anthropic
          ? { onProviderStreamEvent: (event) => collector.onEvent(event) }
          : {}),
      },
    );
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      const error = message.errorMessage || "the request failed";
      if (
        anthropic &&
        !direct &&
        !retriedDirect &&
        !signal.aborted &&
        /allowed_callers/.test(error)
      ) {
        direct = true;
        retriedDirect = true;
        continue;
      }
      return { ok: false, error, searches };
    }
    searches += collector.searches;
    if (!anthropic)
      return { ok: true, text: piText(message), searches, continuations };
    if (!collector.blocks.length) fallbackText = piText(message);
    paused.push(...collector.blocks);
    container = collector.container ?? container;
    if (
      collector.stopReason === "pause_turn" &&
      continuations < MAX_PAUSE_CONTINUATIONS &&
      !signal.aborted
    ) {
      continuations++;
      continue;
    }
    const text = findingsFromBlocks(paused) || fallbackText;
    return { ok: true, text, searches, continuations };
  }
}

/** The providers one call may use, in order, and whether the choice is
 *  strict. Automatic: the session's own provider first, then the others,
 *  falling through on failure. A specific provider: only it, and a failure
 *  is an error, never a silent fallback. Off: none. */
export function resolveSearchProviders(
  sessionProvider: string | undefined,
  setting: WebSearchSetting,
): { providers: SearchProviderId[]; strict: boolean } {
  if (setting === "off") return { providers: [], strict: false };
  if (setting !== "auto") return { providers: [setting], strict: true };
  const own = SEARCH_PROVIDERS.find((p) => p === sessionProvider);
  return {
    providers: own
      ? [own, ...SEARCH_PROVIDERS.filter((p) => p !== own)]
      : [...SEARCH_PROVIDERS],
    strict: false,
  };
}

/** Try the providers in order; throw a tool error when none found anything. */
export async function runWebSearch(
  providers: readonly SearchProviderId[],
  strict: boolean,
  attempt: (provider: SearchProviderId) => Promise<SearchAttemptResult>,
): Promise<string> {
  if (!providers.length)
    throw new Error(
      "No connected provider can search the web. Connect Claude or OpenAI in Settings, or fetch a known URL instead.",
    );
  const errors: string[] = [];
  for (const provider of providers) {
    const label = SEARCH_PROVIDER_LABELS[provider];
    let result: SearchAttemptResult;
    try {
      result = await attempt(provider);
    } catch (error) {
      result = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        searches: 0,
      };
    }
    if (result.ok) {
      const findings = formatFindings(result.text);
      if (findings) return findings;
      errors.push(`${label}: returned no findings`);
    } else {
      errors.push(`${label}: ${result.error}`);
    }
    if (strict) {
      throw new Error(
        `The web search provider chosen in Settings (${label}) could not search: ${errors[0]!.slice(label.length + 2)}. Choose another provider in Settings, or fetch a known URL instead.`,
      );
    }
  }
  throw new Error(
    `Web search failed on every provider (${errors.join("; ")}). Try again later, or fetch a known URL instead.`,
  );
}

/** Whether a run gets the tool: not when Settings turns it off or the run's
 *  policy denies it (the incident verifier). */
export function webSearchEnabled(
  setting: WebSearchSetting,
  disables: Record<string, false>,
): boolean {
  return setting !== "off" && !(WEB_SEARCH_TOOL in disables);
}

const DESCRIPTION =
  "Search the public web through one of the connected AI providers and get back a short written answer with Markdown links to its sources. Use it for current, public facts; to read a page whose URL you already know, fetch it instead.";

/** The pi tool. `search` resolves the provider and makes the side request. */
export function createWebSearchTool(deps: {
  search: (query: string, signal: AbortSignal) => Promise<string>;
}): ToolDefinition<any, any, any> {
  return {
    name: WEB_SEARCH_TOOL,
    label: "Web search",
    description: DESCRIPTION,
    promptGuidelines: [
      "Use web_search for current or public facts you cannot find in the workspace (releases, docs, errors, prices). When you already have a URL, fetch it with a command instead of searching.",
    ],
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "What to search the web for, in natural language. Narrow by site or date in the text when it matters.",
        },
      },
      required: ["query"],
    } as any,
    async execute(_toolCallId, params, signal) {
      const query = String((params as { query?: unknown })?.query ?? "").trim();
      if (!query) throw new Error("A search query is required.");
      const findings = await deps.search(
        query,
        signal ?? new AbortController().signal,
      );
      return {
        content: [{ type: "text" as const, text: findings }],
        details: {},
      };
    },
  };
}

/** The small model a provider searches with: Haiku for Claude, the
 *  configured Haiku fallback tier for OpenAI. */
export function webSearchModelId(
  provider: SearchProviderId,
  openaiSmallModel: string | undefined,
): string {
  if (provider === "anthropic") return "claude-haiku-5-5";
  return openaiSmallModel?.replace(/^pi\/openai\//, "") || "gpt-6-luna";
}

/** What a provider binding gives one search: pi's runtime bound to an
 *  account, the model, and the account label for the audit. */
export interface WebSearchBinding {
  runtime: SearchRuntime;
  model: SearchModel;
  /** Native Anthropic on a Claude pool token: the payload gets the same
   *  prompt rewrite as the turn's own requests. */
  usesNativeAnthropic: boolean;
  account?: string;
}

/**
 * The `search` a run's tool calls: resolve the providers from the setting,
 * bind each in turn (the same account picking a turn uses) and make the side
 * request. Every attempt is audited with the provider, the account and the
 * number of searches it used; the query text is never recorded.
 */
export function makePiWebSearch(input: {
  setting: WebSearchSetting;
  sessionProvider: string | undefined;
  modelFor: (provider: SearchProviderId) => string;
  bind: (
    provider: SearchProviderId,
    modelId: string,
  ) => Promise<WebSearchBinding>;
  rewritePayload?: (payload: unknown) => unknown;
  onAudit: (event: Record<string, unknown>) => void;
  now?: () => number;
}): (query: string, signal: AbortSignal) => Promise<string> {
  const now = input.now ?? Date.now;
  return (query, signal) => {
    const { providers, strict } = resolveSearchProviders(
      input.sessionProvider,
      input.setting,
    );
    return runWebSearch(providers, strict, async (provider) => {
      const started = now();
      const modelId = input.modelFor(provider);
      let account: string | undefined;
      let result: SearchAttemptResult;
      try {
        const binding = await input.bind(provider, modelId);
        account = binding.account;
        result = await searchWithModel({
          runtime: binding.runtime,
          model: binding.model,
          query,
          signal,
          ...(binding.usesNativeAnthropic && input.rewritePayload
            ? { basePayload: input.rewritePayload }
            : {}),
        });
      } catch (error) {
        result = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          searches: 0,
        };
      }
      input.onAudit({
        msg: "web_search",
        provider,
        model: modelId,
        ...(account ? { account } : {}),
        searches: result.searches,
        ...(result.ok ? { continuations: result.continuations } : {}),
        ok: result.ok && !!result.text.trim(),
        ms: now() - started,
        query_bytes: Buffer.byteLength(query, "utf8"),
        ...(result.ok ? {} : { error: result.error.slice(0, 300) }),
      });
      return result;
    });
  };
}
