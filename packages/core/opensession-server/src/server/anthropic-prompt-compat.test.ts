import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  ANTHROPIC_PROMPT_COMPAT_REWRITES,
  enableAnthropicPromptCompat,
  rewriteAnthropicPromptPayload,
  rewriteAnthropicPromptText,
} from "./anthropic-prompt-compat";

/** pi's own default system prompt, built by the bundled pi. The builder is
 *  not part of the package's public exports, so load the module next to its
 *  entry point (the same dist tree the runtime imports). */
async function piDefaultSystemPrompt(): Promise<string> {
  const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const mod = (await import(
    new URL("./core/system-prompt.js", entry).href
  )) as {
    buildSystemPrompt: (input: { cwd: string }) => string;
  };
  return mod.buildSystemPrompt({ cwd: "/workspace/acme" });
}

describe("anthropic prompt compat rewrites", () => {
  test("the generated table is exactly the verified strings", () => {
    // Pins the exact bytes of every [from, to] pair. The pairs are generated,
    // not hand-typed, so any edit has to be a deliberate regeneration.
    expect(ANTHROPIC_PROMPT_COMPAT_REWRITES).toHaveLength(3);
    expect(
      createHash("sha256")
        .update(JSON.stringify(ANTHROPIC_PROMPT_COMPAT_REWRITES))
        .digest("hex"),
    ).toBe("3336004ed25fa882c3a48b188d65ef3e5793975d18bb4a1d75a1853984c9098d");
    expect(
      ANTHROPIC_PROMPT_COMPAT_REWRITES.map(([from, to]) => [
        from.length,
        to.length,
      ]),
    ).toEqual([
      [373, 368],
      [108, 104],
      [105, 98],
    ]);
    for (const [from, to] of ANTHROPIC_PROMPT_COMPAT_REWRITES) {
      expect(from).not.toBe(to);
      expect(to.includes(from)).toBe(false);
    }
  });

  test("every FROM line occurs in the bundled pi's default system prompt", async () => {
    // A pi upgrade that rewords these lines must fail here, not silently
    // stop rewriting.
    const prompt = await piDefaultSystemPrompt();
    for (const [from] of ANTHROPIC_PROMPT_COMPAT_REWRITES) {
      expect(prompt.includes(from), from.slice(0, 60)).toBe(true);
    }
  });

  test("rewrites the default system prompt FROM -> TO exactly", async () => {
    const prompt = await piDefaultSystemPrompt();
    const rewritten = rewriteAnthropicPromptText(prompt);
    let expected = prompt;
    for (const [from, to] of ANTHROPIC_PROMPT_COMPAT_REWRITES) {
      expect(rewriteAnthropicPromptText(from)).toBe(to);
      expect(rewriteAnthropicPromptText(`a\n${from}\nb`)).toBe(`a\n${to}\nb`);
      expect(rewritten.includes(from)).toBe(false);
      expect(rewritten.includes(to)).toBe(true);
      expected = expected.split(from).join(to);
    }
    expect(rewritten).toBe(expected);
    // Untouched text passes through unchanged.
    expect(rewriteAnthropicPromptText("ordinary prompt")).toBe(
      "ordinary prompt",
    );
  });

  test("rewrites every string in a provider payload and keeps untouched payloads", () => {
    const [[from0, to0], [from1, to1]] = ANTHROPIC_PROMPT_COMPAT_REWRITES;
    const payload = {
      model: "claude-test",
      max_tokens: 1024,
      system: [
        { type: "text", text: "You are Claude Code." },
        { type: "text", text: `head\n${from0}\ntail`, cache_control: {} },
      ],
      messages: [
        { role: "user", content: [{ type: "text", text: from1 }] },
        { role: "assistant", content: "unchanged" },
      ],
    };
    const out = rewriteAnthropicPromptPayload(payload) as typeof payload;
    expect(out).not.toBe(payload);
    expect(out.system[1].text).toBe(`head\n${to0}\ntail`);
    expect((out.messages[0].content as any)[0].text).toBe(to1);
    expect(out.messages[1].content).toBe("unchanged");
    expect(out.max_tokens).toBe(1024);
    // The input is not mutated.
    expect(payload.system[1].text).toBe(`head\n${from0}\ntail`);

    const clean = { system: [{ type: "text", text: "nothing to do" }] };
    expect(rewriteAnthropicPromptPayload(clean)).toBe(clean);
  });

  test("the agent hook runs after the existing hook and only for anthropic", async () => {
    const [[from, to]] = ANTHROPIC_PROMPT_COMPAT_REWRITES;
    const seen: unknown[] = [];
    const agent: {
      onPayload?: (payload: unknown, model: any) => unknown | Promise<unknown>;
    } = {
      onPayload: async (payload: any) => {
        seen.push(payload);
        return { ...payload, extra: true };
      },
    };
    enableAnthropicPromptCompat(agent);
    const anthropic = { provider: "anthropic", id: "claude-test" };
    expect(await agent.onPayload!({ system: from }, anthropic)).toEqual({
      system: to,
      extra: true,
    });
    expect(seen).toEqual([{ system: from }]);
    // Another provider is left alone (the base hook's result still wins).
    expect(
      await agent.onPayload!({ system: from }, { provider: "openai" }),
    ).toEqual({ system: from, extra: true });

    // Without a base hook, an untouched payload keeps pi's "no change" answer.
    const bare: {
      onPayload?: (payload: unknown, model: any) => unknown | Promise<unknown>;
    } = {};
    enableAnthropicPromptCompat(bare);
    expect(await bare.onPayload!({ system: "plain" }, anthropic)).toBe(
      undefined,
    );
    expect(await bare.onPayload!({ system: from }, anthropic)).toEqual({
      system: to,
    });
  });
});
