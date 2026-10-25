import { afterEach, describe, expect, it } from "bun:test";
import {
  __setRouteClassifierOneShotForTest,
  classifyRoute,
  ROUTE_CLASSIFIER_MODEL,
} from "./route-classifier";

const ROUTES = ["spam", "simple", "work"] as const;

function input(content = "hello") {
  return {
    content,
    system: "Route it.",
    contract: "Respond with ONLY JSON.",
    routes: ROUTES,
    label: "test-router",
  };
}

type Call = { prompt: string; system: string; model: string; label: string };

function fake(answer: string | null | Error): Call[] {
  const calls: Call[] = [];
  __setRouteClassifierOneShotForTest(async (prompt, opts) => {
    calls.push({ prompt, ...opts });
    if (answer instanceof Error) throw answer;
    return answer;
  });
  return calls;
}

afterEach(() => __setRouteClassifierOneShotForTest(null));

describe("classifyRoute", () => {
  it("returns the route, reason and raw object from valid JSON", async () => {
    const calls = fake('{"route":"simple","reason":"one question","x":1}');
    const verdict = await classifyRoute(input());
    expect(verdict).toEqual({
      route: "simple",
      reason: "one question",
      raw: { route: "simple", reason: "one question", x: 1 },
    });
    expect(calls[0]!.system).toBe("Route it.\n\nRespond with ONLY JSON.");
    expect(calls[0]!.model).toBe(ROUTE_CLASSIFIER_MODEL);
    expect(calls[0]!.label).toBe("test-router");
  });

  it("finds JSON inside prose, including nested arrays", async () => {
    fake('Sure: {"route":"work","reason":"bug","topics":["refund"]} done');
    const verdict = await classifyRoute(input());
    expect(verdict?.route).toBe("work");
    expect(verdict?.raw.topics).toEqual(["refund"]);
  });

  it("uses the model the caller names", async () => {
    const calls = fake('{"route":"spam","reason":""}');
    await classifyRoute({ ...input(), model: "other-model" });
    expect(calls[0]!.model).toBe("other-model");
  });

  it("returns null for a route outside the list", async () => {
    fake('{"route":"full","reason":"r"}');
    expect(await classifyRoute(input())).toBeNull();
  });

  it("returns null when the one-shot gives nothing", async () => {
    fake(null);
    expect(await classifyRoute(input())).toBeNull();
  });

  it("returns null when the answer has no JSON", async () => {
    fake("I cannot classify this.");
    expect(await classifyRoute(input())).toBeNull();
  });

  it("returns null when the one-shot throws", async () => {
    fake(new Error("timeout"));
    expect(await classifyRoute(input())).toBeNull();
  });

  it("cuts content to 8000 characters", async () => {
    const calls = fake('{"route":"spam","reason":""}');
    await classifyRoute(input("a".repeat(9000)));
    expect(calls[0]!.prompt).toBe("a".repeat(8000));
  });
});
