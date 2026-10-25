import { afterEach, describe, expect, it } from "bun:test";
import { __setRouteClassifierOneShotForTest } from "../route-classifier";
import { EMAIL_TRIAGE_PROMPT, triageMessage } from "./triage";

const NOW = "2026-10-25T12:00:00.000Z";
const MAIL = {
  subject: "Export fails",
  text: "My export at acme fails with an error.",
  from: "customer@example.test",
  now: NOW,
};

function fake(answer: string | null): { prompt: string; system: string }[] {
  const calls: { prompt: string; system: string }[] = [];
  __setRouteClassifierOneShotForTest(async (prompt, opts) => {
    calls.push({ prompt, system: opts.system });
    return answer;
  });
  return calls;
}

afterEach(() => __setRouteClassifierOneShotForTest(null));

describe("triageMessage", () => {
  it("keeps known topics and drops unknown ones", async () => {
    fake(
      '{"route":"simple","reason":"r","topics":["refund","nonsense"],"bug":false}',
    );
    expect(await triageMessage(MAIL)).toEqual({
      route: "simple",
      reason: "r",
      topics: ["refund"],
      bug: false,
      at: NOW,
    });
  });

  it("reads missing topics as none", async () => {
    fake('{"route":"work","reason":"r","bug":true}');
    const verdict = await triageMessage(MAIL);
    expect(verdict.topics).toEqual([]);
    expect(verdict.bug).toBe(true);
  });

  it("reads topics that are not a list as unknown", async () => {
    fake('{"route":"work","reason":"r","topics":"refund","bug":false}');
    expect((await triageMessage(MAIL)).topics).toBeNull();
  });

  it("treats a classifier failure as work with unknown topics", async () => {
    fake(null);
    expect(await triageMessage(MAIL)).toEqual({
      route: "work",
      reason: "Triage failed, treated as work",
      topics: null,
      bug: false,
      at: NOW,
      failed: true,
    });
  });

  it("wraps the email as untrusted data and appends the contract", async () => {
    const calls = fake('{"route":"spam","reason":"r","topics":[],"bug":false}');
    await triageMessage(MAIL);
    const { prompt, system } = calls[0]!;
    expect(prompt).toContain("untrusted data");
    expect(prompt).toContain(
      "<email>\nFrom: customer@example.test\nSubject: Export fails\n\nMy export at acme fails with an error.\n</email>",
    );
    expect(system.startsWith(EMAIL_TRIAGE_PROMPT)).toBe(true);
    expect(system).toEndWith(
      'Respond with ONLY a JSON object: {"route": "spam" | "simple" | "work", "reason": "<one short sentence>", "topics": [...], "bug": true | false}',
    );
  });

  it("keeps the closing wrapper on a long email", async () => {
    const calls = fake('{"route":"work","reason":"r","topics":[],"bug":false}');
    await triageMessage({ ...MAIL, text: "x".repeat(20_000) });
    expect(calls[0]!.prompt.length).toBeLessThanOrEqual(8000);
    expect(calls[0]!.prompt).toEndWith("\n</email>");
  });
});
