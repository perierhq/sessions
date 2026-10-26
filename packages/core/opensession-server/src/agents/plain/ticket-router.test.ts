import { afterEach, describe, expect, it } from "bun:test";
import { __setRouteClassifierOneShotForTest } from "../../server/route-classifier";
import { classifyTicketRoute } from "./ticket-router";

function fake(answer: string | null): { prompt: string; label: string }[] {
  const calls: { prompt: string; label: string }[] = [];
  __setRouteClassifierOneShotForTest(async (prompt, opts) => {
    calls.push({ prompt, label: opts.label });
    return answer;
  });
  return calls;
}

afterEach(() => __setRouteClassifierOneShotForTest(null));

describe("classifyTicketRoute", () => {
  it("maps spam, basic and full", async () => {
    for (const route of ["spam", "basic", "full"] as const) {
      const calls = fake(`{"route":"${route}","reason":"because"}`);
      expect(await classifyTicketRoute("Ticket body")).toEqual({
        route,
        reason: "because",
      });
      expect(calls[0]!.prompt).toBe(
        "Classify this support ticket:\n\nTicket body",
      );
      expect(calls[0]!.label).toBe("ticket-router");
    }
  });

  it("counts the prefix inside the 8000-character cap", async () => {
    const calls = fake('{"route":"full","reason":"r"}');
    await classifyTicketRoute("a".repeat(9000));
    expect(calls[0]!.prompt.length).toBe(8000);
    expect(calls[0]!.prompt).toStartWith(
      "Classify this support ticket:\n\naaa",
    );
  });

  it("returns null for a support route it does not know", async () => {
    fake('{"route":"simple","reason":"r"}');
    expect(await classifyTicketRoute("Ticket body")).toBeNull();
  });
});
