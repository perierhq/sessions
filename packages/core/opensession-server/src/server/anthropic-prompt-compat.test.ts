import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  ANTHROPIC_PROMPT_COMPAT_REWRITES,
  enableAnthropicPayloadCapture,
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

  test("rewrites the system blocks and system-role messages of a payload", () => {
    const [[from0, to0], [from1, to1], [from2, to2]] =
      ANTHROPIC_PROMPT_COMPAT_REWRITES;
    const payload = {
      model: "claude-test",
      max_tokens: 1024,
      system: [
        { type: "text", text: "You are Claude Code." },
        { type: "text", text: `head\n${from0}\ntail`, cache_control: {} },
      ],
      messages: [
        { role: "user", content: "unchanged" },
        {
          role: "system",
          content: [
            { type: "text", text: from1 },
            { type: "tool_addition", tool: { name: from2 } },
          ],
        },
        { role: "system", content: from2 },
      ],
    };
    const out = rewriteAnthropicPromptPayload(payload) as any;
    expect(out).not.toBe(payload);
    expect(out.system[1]).toEqual({
      type: "text",
      text: `head\n${to0}\ntail`,
      cache_control: {},
    });
    expect(out.system[0]).toBe(payload.system[0]);
    expect(out.messages[0]).toBe(payload.messages[0]);
    expect(out.messages[1].content[0]).toEqual({ type: "text", text: to1 });
    // Only text blocks carry prompt text.
    expect(out.messages[1].content[1]).toBe(payload.messages[1].content[1]);
    expect(out.messages[2].content).toBe(to2);
    expect(out.max_tokens).toBe(1024);
    // The input is not mutated.
    expect(payload.system[1].text).toBe(`head\n${from0}\ntail`);
    expect((payload.messages[1].content as any)[0].text).toBe(from1);

    const clean = { system: [{ type: "text", text: "nothing to do" }] };
    expect(rewriteAnthropicPromptPayload(clean)).toBe(clean);
    expect(rewriteAnthropicPromptPayload({ system: from0 })).toEqual({
      system: to0,
    });
  });

  test("leaves conversation content alone, even when it quotes a FROM line", () => {
    const [[from0], [from1], [from2]] = ANTHROPIC_PROMPT_COMPAT_REWRITES;
    const image = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: from0 },
    };
    const payload = {
      system: [{ type: "text", text: "Run instructions" }],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: from0 },
            image,
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [{ type: "text", text: from1 }],
            },
            { type: "tool_result", tool_use_id: "toolu_2", content: from2 },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: from1, signature: "sig" },
            { type: "text", text: from2 },
            {
              type: "tool_use",
              id: "toolu_3",
              name: "bash",
              input: { command: from0, nested: [from1] },
            },
          ],
        },
        { role: "user", content: from2 },
      ],
    };
    const snapshot = structuredClone(payload);
    expect(rewriteAnthropicPromptPayload(payload)).toBe(payload);
    expect(payload).toEqual(snapshot);
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

describe("enableAnthropicPayloadCapture", () => {
  test("is a no-op without a directory", () => {
    const agent: { onPayload?: (p: unknown, m: unknown) => unknown } = {};
    enableAnthropicPayloadCapture(agent, undefined, "s");
    expect(agent.onPayload).toBeUndefined();
  });

  test("writes the final payload after earlier hooks and returns it", async () => {
    const { mkdtempSync, readdirSync, readFileSync, statSync } =
      await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = `${mkdtempSync(`${tmpdir()}/payload-capture-`)}/out`;
    const agent: {
      onPayload?: (p: unknown, m: unknown) => unknown | Promise<unknown>;
    } = { onPayload: (p) => ({ ...(p as object), hooked: true }) };
    enableAnthropicPayloadCapture(agent, dir, "os-1/../x");
    const out = await agent.onPayload!({ system: "s" }, {});
    expect(out).toEqual({ system: "s", hooked: true });
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^os-1_\.\._x-\d+-0\.json$/);
    expect(JSON.parse(readFileSync(`${dir}/${files[0]}`, "utf8"))).toEqual({
      system: "s",
      hooked: true,
    });
    expect(statSync(`${dir}/${files[0]}`).mode & 0o777).toBe(0o600);
  });
});
