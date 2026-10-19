import { describe, expect, test } from "bun:test";
import {
  enableAnthropicRateLimitCapture,
  formatAnthropicReset,
  readAnthropicRateLimit,
  type AnthropicRateLimitSnapshot,
} from "./anthropic-rate-limit";
import { describeUsageLimitReset, usageLimitResetAt } from "./runner-shared";

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

describe("readAnthropicRateLimit", () => {
  test("reads the unified status and the reset in Unix seconds", () => {
    const reset = NOW + 3 * HOUR;
    expect(
      readAnthropicRateLimit(
        429,
        new Headers({
          "anthropic-ratelimit-unified-status": "rejected",
          "anthropic-ratelimit-unified-reset": String(reset / 1000),
          "retry-after": "60",
        }),
        NOW,
      ),
    ).toEqual({ httpStatus: 429, unifiedStatus: "rejected", resetAt: reset });
    // Plain header records, any case, also work.
    expect(
      readAnthropicRateLimit(
        200,
        { "Anthropic-RateLimit-Unified-Status": " Allowed_Warning " },
        NOW,
      ),
    ).toEqual({ httpStatus: 200, unifiedStatus: "allowed_warning" });
  });

  test("falls back to retry-after when there is no unified reset", () => {
    expect(
      readAnthropicRateLimit(429, new Headers({ "retry-after": "120" }), NOW),
    ).toEqual({ httpStatus: 429, resetAt: NOW + 120_000 });
    const at = new Date(NOW + 2 * HOUR).toUTCString();
    expect(
      readAnthropicRateLimit(429, new Headers({ "retry-after": at }), NOW)
        .resetAt,
    ).toBe(NOW + 2 * HOUR);
  });

  test("ignores a reset in the past or more than 14 days out", () => {
    for (const reset of [NOW - HOUR, NOW + 15 * 24 * HOUR]) {
      expect(
        readAnthropicRateLimit(
          429,
          new Headers({
            "anthropic-ratelimit-unified-status": "rejected",
            "anthropic-ratelimit-unified-reset": String(reset / 1000),
          }),
          NOW,
        ),
      ).toEqual({ httpStatus: 429, unifiedStatus: "rejected" });
    }
    expect(readAnthropicRateLimit(500, new Headers(), NOW)).toEqual({
      httpStatus: 500,
    });
  });

  test("falls back to retry-after when the unified reset is out of range", () => {
    for (const reset of [NOW - HOUR, NOW + 15 * 24 * HOUR]) {
      expect(
        readAnthropicRateLimit(
          429,
          new Headers({
            "anthropic-ratelimit-unified-status": "rejected",
            "anthropic-ratelimit-unified-reset": String(reset / 1000),
            "retry-after": "90",
          }),
          NOW,
        ),
      ).toEqual({
        httpStatus: 429,
        unifiedStatus: "rejected",
        resetAt: NOW + 90_000,
      });
    }
  });
});

test("formatAnthropicReset reads back through the limit-message parsers", () => {
  const at = Date.UTC(2026, 9, 22, 9, 30);
  const text = formatAnthropicReset(at);
  expect(text).toBe("Oct 22, 9:30am (UTC)");
  const message = `limit reached · resets ${text}`;
  expect(describeUsageLimitReset(message)).toBe(text);
  expect(usageLimitResetAt(message, NOW)).toBe(at);
  expect(formatAnthropicReset(Date.UTC(2026, 9, 22, 15))).toBe(
    "Oct 22, 3pm (UTC)",
  );
  expect(formatAnthropicReset(Date.UTC(2026, 9, 22, 0, 5))).toBe(
    "Oct 22, 12:05am (UTC)",
  );
});

describe("enableAnthropicRateLimitCapture", () => {
  test("wraps each Anthropic request's fetch and records every response", async () => {
    const seen: AnthropicRateLimitSnapshot[] = [];
    const calls: Array<{ provider: string; options: any }> = [];
    const agent: { streamFunction?: any } = {
      streamFunction: async (model: any, _context: any, options: any) => {
        calls.push({ provider: model.provider, options });
        return options?.fetch?.("https://api.anthropic.com/v1/messages");
      },
    };
    enableAnthropicRateLimitCapture(agent, (snapshot) => seen.push(snapshot));
    const inner = async () =>
      new Response("{}", {
        status: 429,
        headers: { "anthropic-ratelimit-unified-status": "allowed" },
      });
    const response = await agent.streamFunction(
      { provider: "anthropic" },
      {},
      { fetch: inner, sessionId: "s" },
    );
    // The response is handed back unchanged.
    expect(response.status).toBe(429);
    expect(seen).toEqual([{ httpStatus: 429, unifiedStatus: "allowed" }]);
    expect(calls[0].options.sessionId).toBe("s");
    expect(calls[0].options.fetch).not.toBe(inner);

    // Another provider's request is passed through as is.
    const other = { fetch: inner };
    await agent.streamFunction({ provider: "openai" }, {}, other);
    expect(calls[1].options).toBe(other);
    expect(seen).toHaveLength(1);
  });

  test("leaves an agent without a stream function alone", () => {
    const agent: { streamFunction?: any } = {};
    enableAnthropicRateLimitCapture(agent, () => {});
    expect(agent.streamFunction).toBeUndefined();
  });
});
