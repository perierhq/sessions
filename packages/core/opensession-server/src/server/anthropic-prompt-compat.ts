/**
 * Prompt compatibility for pi's own Anthropic provider when it runs on a
 * Claude subscription token (the "native" anthropicTransport).
 *
 * Subscription requests reword three lines of pi's built-in "Pi
 * documentation" prompt section. The rewrite is exact-match on whole lines
 * of pi's stock text: anthropic-prompt-compat.test.ts asserts every FROM
 * line still occurs in the bundled pi's default system prompt, so a pi
 * upgrade that changes them fails a test instead of silently skipping the
 * rewrite.
 *
 * The strings are generated, not hand-typed: edit them only by regenerating
 * from a verified source and re-running the test.
 */

/** [from, to] pairs, applied in order to every string they occur in. */
export const ANTHROPIC_PROMPT_COMPAT_REWRITES: ReadonlyArray<
  readonly [from: string, to: string]
> = [
  [
    "- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)",
    "- When asked about: extensions, themes, skills, prompt templates, TUI components, keybindings, SDK integrations, custom providers, adding models, and pi packages (docs/extensions.md, examples/extensions/, docs/themes.md, docs/skills.md, docs/prompt-templates.md, docs/tui.md, docs/keybindings.md, docs/sdk.md, docs/custom-provider.md, docs/models.md, docs/packages.md)",
  ],
  [
    "- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing",
    "- When working on pi topics, read the docs and examples, and follow cross-references before implementing",
  ],
  [
    "- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)",
    "- Read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)",
  ],
];

/** Apply every rewrite to one string. Returns the input when nothing matched. */
export function rewriteAnthropicPromptText(text: string): string {
  let out = text;
  for (const [from, to] of ANTHROPIC_PROMPT_COMPAT_REWRITES) {
    if (out.includes(from)) out = out.split(from).join(to);
  }
  return out;
}

/** Rewrite the text blocks of a system prompt or system-message body.
 *  Accepts the string and the block-array shapes; returns the input when
 *  nothing changed. Only `type: "text"` blocks are read: tool additions and
 *  removals in a mid-conversation system message carry no prompt text. */
function rewriteSystemContent(content: unknown): unknown {
  if (typeof content === "string") return rewriteAnthropicPromptText(content);
  if (!Array.isArray(content)) return content;
  let changed = false;
  const out = content.map((block) => {
    if (
      !block ||
      typeof block !== "object" ||
      (block as { type?: unknown }).type !== "text" ||
      typeof (block as { text?: unknown }).text !== "string"
    )
      return block;
    const text = (block as { text: string }).text;
    const next = rewriteAnthropicPromptText(text);
    if (next === text) return block;
    changed = true;
    return { ...(block as object), text: next };
  });
  return changed ? out : content;
}

/**
 * Rewrite a provider request payload. Only the prompt carries pi's stock
 * text, so only the request's `system` field and system-role messages (pi's
 * mid-conversation system updates) are read. User and assistant turns are
 * never touched: signed thinking blocks, tool_use input, tool_result content
 * and images must reach Anthropic byte for byte, and are not scanned either.
 * Returns the same object when no rewrite applies, so an untouched request is
 * passed through as is.
 */
export function rewriteAnthropicPromptPayload(payload: unknown): unknown {
  if (typeof payload === "string") return rewriteAnthropicPromptText(payload);
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return payload;
  const request = payload as { system?: unknown; messages?: unknown };
  let out: Record<string, unknown> | undefined;
  if (request.system !== undefined) {
    const system = rewriteSystemContent(request.system);
    if (system !== request.system) out = { ...request, system };
  }
  if (Array.isArray(request.messages)) {
    let changed = false;
    const messages = request.messages.map((message) => {
      if (
        !message ||
        typeof message !== "object" ||
        (message as { role?: unknown }).role !== "system"
      )
        return message;
      const content = (message as { content?: unknown }).content;
      const next = rewriteSystemContent(content);
      if (next === content) return message;
      changed = true;
      return { ...(message as object), content: next };
    });
    if (changed) out = { ...(out ?? request), messages };
  }
  return out ?? payload;
}

/** Whether a pi provider id is the Anthropic provider this applies to. */
function isAnthropicProvider(provider: unknown): boolean {
  return provider === "anthropic";
}

/**
 * Install the payload rewrite on a pi agent's provider-request hook, after
 * whatever hook is already there (pi's own extension hook, other runner
 * patches). Same seam as enableOpenaiFastMode and enableXaiProxyPayload.
 *
 * pi's compaction and branch-summary calls do not pass through this hook:
 * they call the agent's stream function directly, without agent.onPayload
 * (pi-coding-agent core/agent-session.js, _runDefaultCompaction). That is
 * acceptable because those requests carry none of the rewritten lines. Their
 * system prompt is pi's own SUMMARIZATION_SYSTEM_PROMPT, and the conversation
 * reaches them as serialized user, assistant and tool-result text, with the
 * session's system prompt and system messages left out
 * (core/compaction/utils.js, serializeConversation).
 */
export function enableAnthropicPromptCompat<TModel>(agent: {
  onPayload?: (payload: unknown, model: TModel) => unknown | Promise<unknown>;
}): void {
  const baseOnPayload = agent.onPayload;
  agent.onPayload = async (payload, model) => {
    const transformed = await baseOnPayload?.(payload, model);
    const finalPayload = transformed ?? payload;
    const provider = (model as { provider?: unknown } | undefined)?.provider;
    if (!isAnthropicProvider(provider)) return transformed;
    const rewritten = rewriteAnthropicPromptPayload(finalPayload);
    return rewritten === finalPayload ? transformed : rewritten;
  };
}

/**
 * Diagnostics only: when `dir` is set, write each request body the agent is
 * about to send (after every earlier onPayload hook) to `dir` as JSON, one
 * file per request. Runs after the existing hook and returns its result
 * unchanged. Failures to write are logged and never break the request.
 */
export function enableAnthropicPayloadCapture<TModel>(
  agent: {
    onPayload?: (payload: unknown, model: TModel) => unknown | Promise<unknown>;
  },
  dir: string | undefined,
  label: string,
): void {
  if (!dir) return;
  const previous = agent.onPayload;
  let n = 0;
  agent.onPayload = async (payload, model) => {
    const next = previous ? await previous(payload, model) : payload;
    try {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const safe = label.replace(/[^A-Za-z0-9._-]/g, "_");
      const file = `${dir}/${safe}-${Date.now()}-${n++}.json`;
      writeFileSync(file, JSON.stringify(next ?? payload), { mode: 0o600 });
    } catch (e) {
      console.warn(
        `[anthropic-payload-capture] not written: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return next;
  };
}
