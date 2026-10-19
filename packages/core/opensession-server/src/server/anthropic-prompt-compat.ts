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

function rewriteDeep(value: unknown): unknown {
  if (typeof value === "string") return rewriteAnthropicPromptText(value);
  if (Array.isArray(value)) return value.map(rewriteDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value))
      out[key] = rewriteDeep(item);
    return out;
  }
  return value;
}

/** Rewrite every string in a provider request payload (system blocks,
 *  mid-conversation system messages, message text). Returns the same object
 *  when no rewrite applies, so an untouched request is passed through as is. */
export function rewriteAnthropicPromptPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") {
    return typeof payload === "string"
      ? rewriteAnthropicPromptText(payload)
      : payload;
  }
  let raw: string;
  try {
    raw = JSON.stringify(payload);
  } catch {
    return payload;
  }
  if (!ANTHROPIC_PROMPT_COMPAT_REWRITES.some(([from]) => raw.includes(from)))
    return payload;
  return rewriteDeep(payload);
}

/** Whether a pi provider id is the Anthropic provider this applies to. */
function isAnthropicProvider(provider: unknown): boolean {
  return provider === "anthropic";
}

/**
 * Install the payload rewrite on a pi agent's provider-request hook, after
 * whatever hook is already there (pi's own extension hook, other runner
 * patches). Same seam as enableOpenaiFastMode and enableXaiProxyPayload.
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
