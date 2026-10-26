import { afterEach, describe, expect, it, spyOn } from "bun:test";
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

  it("returns null when more than one object names a route", async () => {
    fake(
      'First {"route":"spam","reason":"a"} then {"route":"work","reason":"b"}',
    );
    expect(await classifyRoute(input())).toBeNull();
  });

  it("picks the one object that names a route among others", async () => {
    fake('Meta {"note":1} answer {"route":"work","reason":"b"}');
    expect((await classifyRoute(input()))?.route).toBe("work");
  });

  it("skips braces in prose around the answer", async () => {
    fake(
      'Think {maybe} and } stray, then {"route":"simple","reason":"r"} {end}',
    );
    expect((await classifyRoute(input()))?.route).toBe("simple");
  });

  it("skips braces and quotes inside strings", async () => {
    fake('{"route":"work","reason":"has } and { and \\" inside"}');
    const verdict = await classifyRoute(input());
    expect(verdict?.route).toBe("work");
    expect(verdict?.reason).toBe('has } and { and " inside');
  });

  it("reads a nested object as one answer", async () => {
    fake(
      '{"route":"work","reason":"r","meta":{"route":"spam","deep":{"a":[1,{"b":2}]}}}',
    );
    const verdict = await classifyRoute(input());
    expect(verdict?.route).toBe("work");
    expect(verdict?.raw.meta).toEqual({
      route: "spam",
      deep: { a: [1, { b: 2 }] },
    });
  });

  it("never logs the answer text", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      fake("Dear customer jane@example.test, no verdict here.");
      expect(await classifyRoute(input())).toBeNull();
      fake('{"route":"jane@example.test","reason":"r"}');
      expect(await classifyRoute(input())).toBeNull();
      expect(error).toHaveBeenCalledTimes(2);
      for (const args of error.mock.calls)
        expect(args.map(String).join(" ")).not.toContain("jane@example.test");
    } finally {
      error.mockRestore();
    }
  });

  it("cuts content to 8000 characters", async () => {
    const calls = fake('{"route":"spam","reason":""}');
    await classifyRoute(input("a".repeat(9000)));
    expect(calls[0]!.prompt).toBe("a".repeat(8000));
  });
});
