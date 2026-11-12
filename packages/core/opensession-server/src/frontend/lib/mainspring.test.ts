import { describe, expect, test } from "bun:test";
import { ApiError } from "./api/request";
import {
  loadMainspring,
  maskedKey,
  modelsSummary,
  plainError,
  UnexpectedAnswerError,
  type Mainspring,
} from "./mainspring";

const settings: Mainspring = {
  url: "https://mainspring.example.test",
  keySet: true,
  keyHint: "wxyz",
  routeClaude: false,
  fallbackDirect: false,
  models: [{ id: "gpt-5.6-terra" }],
  modelsAt: "2026-11-12T10:00:00.000Z",
};

describe("loadMainspring", () => {
  test("hides the section from anyone but the owner", async () => {
    for (const status of [401, 403, 404])
      expect(
        await loadMainspring(async () => new Response("{}", { status })),
      ).toEqual({ kind: "hidden" });
  });

  test("reads the settings, and anything else as an error", async () => {
    expect(
      await loadMainspring(
        async () => new Response(JSON.stringify({ mainspring: settings })),
      ),
    ).toEqual({ kind: "ready", settings });
    expect(
      await loadMainspring(async () => new Response("{}", { status: 500 })),
    ).toEqual({ kind: "error" });
    expect(
      await loadMainspring(async () => new Response(JSON.stringify({ x: 1 }))),
    ).toEqual({ kind: "error" });
    expect(
      await loadMainspring(async () => {
        throw new Error("offline");
      }),
    ).toEqual({ kind: "error" });
  });
});

describe("copy", () => {
  test("plainError drops the field name and ends with a stop", () => {
    expect(
      plainError(new ApiError("key: a Mainspring key starts with sk-ms-", 400)),
    ).toBe("A Mainspring key starts with sk-ms-.");
    expect(
      plainError(
        new ApiError(
          "url: use https://. Plain http is only allowed for a tailnet or private address",
          400,
        ),
      ),
    ).toBe(
      "Use https://. Plain http is only allowed for a tailnet or private address.",
    );
    expect(plainError(new UnexpectedAnswerError())).toBe(
      "The server sent an unexpected answer.",
    );
    expect(plainError(new TypeError("Failed to fetch"))).toBe(
      "Couldn't reach the server. Try again.",
    );
  });

  test("the key shows only its last four, and the list a count", () => {
    expect(maskedKey("wxyz")).toBe("sk-ms-…wxyz");
    expect(maskedKey(null)).toBe("Key saved");
    expect(modelsSummary(settings)).toBe("1 model, listed Nov 12");
    expect(modelsSummary({ ...settings, modelsAt: null })).toBeNull();
  });
});
