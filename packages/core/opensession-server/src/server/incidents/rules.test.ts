import { describe, expect, test } from "bun:test";
import type { Signal } from "../../shared/incidents";
import { evaluateSignal } from "./rules";

const NOW = Date.parse("2026-10-20T10:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const o = (
  msAgo: number,
  result: "ok" | "fail" | "unknown",
  value?: number,
) => ({
  at: ago(msAgo),
  result,
  value,
  detail: "",
});
const sig = (rule: Signal["rule"], over: Partial<Signal> = {}): Signal => ({
  id: "sig-1",
  name: "Search",
  project: "acme",
  enabled: true,
  source: { kind: "http", url: "https://acme.example.test/search" },
  intervalMs: 60_000,
  rule,
  severity: "major",
  createdBy: "Ada",
  createdAt: ago(86_400_000),
  updatedAt: ago(86_400_000),
  ...over,
});
const seq = (...r: Array<"ok" | "fail" | "unknown">) =>
  r.map((x, i) => o((r.length - i) * 60_000, x));

describe("consecutive", () => {
  const s = sig({ kind: "consecutive", failures: 3 });
  test("opens on the third failure", () => {
    expect(evaluateSignal(s, seq("ok", "fail", "fail"), null, NOW).state).toBe(
      "ok",
    );
    const e = evaluateSignal(s, seq("ok", "fail", "fail", "fail"), null, NOW);
    expect(e).toMatchObject({
      state: "failing",
      reason: "3 failures in a row",
    });
  });
  test("unknown does not break a streak", () => {
    expect(
      evaluateSignal(s, seq("fail", "unknown", "fail", "fail"), null, NOW)
        .state,
    ).toBe("failing");
  });
  test("hysteresis: one ok is not a recovery, two are", () => {
    const prev = evaluateSignal(
      s,
      seq("fail", "fail", "fail"),
      null,
      NOW - 120_000,
    );
    expect(
      evaluateSignal(s, seq("fail", "fail", "fail", "ok"), prev, NOW).state,
    ).toBe("failing");
    expect(
      evaluateSignal(s, seq("fail", "fail", "fail", "ok", "ok"), prev, NOW)
        .state,
    ).toBe("ok");
  });
  test("since is kept while the state holds", () => {
    const prev = {
      ...evaluateSignal(s, seq("fail", "fail", "fail"), null, NOW),
      since: ago(600_000),
    };
    expect(
      evaluateSignal(s, seq("fail", "fail", "fail", "fail"), prev, NOW).since,
    ).toBe(ago(600_000));
  });
  test("lane observations are ignored", () => {
    const lanes = seq("fail", "fail", "fail").map((x) => ({
      ...x,
      lane: "API",
    }));
    expect(evaluateSignal(s, [...seq("ok"), ...lanes], null, NOW).state).toBe(
      "ok",
    );
  });
});
describe("rate", () => {
  const s = sig(
    { kind: "rate", windowMs: 300_000, atLeast: 5 },
    { source: { kind: "webhook" } },
  );
  const fails = (n: number) =>
    Array.from({ length: n }, (_, i) => o(250_000 - i * 10_000, "fail"));
  test("fires at atLeast within the window", () => {
    expect(evaluateSignal(s, fails(4), null, NOW).state).toBe("ok");
    expect(evaluateSignal(s, fails(5), null, NOW).state).toBe("failing");
    expect(
      evaluateSignal(s, [o(400_000, "fail"), ...fails(4)], null, NOW).state,
    ).toBe("ok");
    expect(evaluateSignal(s, [], null, NOW).state).toBe("ok");
  });
  test("recovers below half", () => {
    const prev = evaluateSignal(s, fails(5), null, NOW);
    expect(evaluateSignal(s, fails(3), prev, NOW).state).toBe("failing");
    expect(evaluateSignal(s, fails(2), prev, NOW).state).toBe("ok");
  });
  test("ratio", () => {
    const r = sig({ kind: "rate", windowMs: 300_000, atLeast: 5, ratio: 0.5 });
    const mixed = [
      ...fails(5),
      ...Array.from({ length: 15 }, (_, i) => o(200_000 - i * 1_000, "ok")),
    ];
    expect(evaluateSignal(r, mixed, null, NOW).state).toBe("ok");
  });
});
describe("threshold", () => {
  const s = sig({
    kind: "threshold",
    above: 1000,
    forMs: 300_000,
    failingAbove: 5000,
  });
  test("slow only after the duration", () => {
    expect(
      evaluateSignal(
        s,
        [
          o(360_000, "ok", 1200),
          o(240_000, "ok", 1500),
          o(120_000, "ok", 1300),
          o(0, "ok", 1100),
        ],
        null,
        NOW,
      ),
    ).toMatchObject({ state: "slow", reason: "Over 1000 for 5 min" });
    expect(
      evaluateSignal(
        s,
        [o(360_000, "ok", 200), o(240_000, "ok", 1500), o(0, "ok", 1100)],
        null,
        NOW,
      ).state,
    ).toBe("ok");
  });
  test("failingAbove and failed requests", () => {
    expect(
      evaluateSignal(
        s,
        [o(360_000, "fail"), o(180_000, "ok", 9000), o(0, "ok", 6000)],
        null,
        NOW,
      ).state,
    ).toBe("failing");
  });
  test("hysteresis keeps slow until two clean observations", () => {
    const over = [
      o(360_000, "ok", 1200),
      o(240_000, "ok", 1500),
      o(180_000, "ok", 1300),
    ];
    const prev = evaluateSignal(s, over, null, NOW - 60_000);
    expect(prev.state).toBe("slow");
    expect(
      evaluateSignal(s, [...over, o(60_000, "ok", 200)], prev, NOW).state,
    ).toBe("slow");
    expect(
      evaluateSignal(
        s,
        [...over, o(60_000, "ok", 200), o(0, "ok", 300)],
        prev,
        NOW,
      ).state,
    ).toBe("ok");
  });
});
describe("deadline", () => {
  const s = sig(
    { kind: "deadline", warnDays: 14, failDays: 3 },
    { source: { kind: "expiry", target: "tls", host: "acme.example.test" } },
  );
  test("days left", () => {
    expect(evaluateSignal(s, [o(0, "ok", 20)], null, NOW).state).toBe("ok");
    expect(evaluateSignal(s, [o(0, "ok", 10)], null, NOW)).toMatchObject({
      state: "upcoming",
      reason: "10 days left",
    });
    expect(evaluateSignal(s, [o(0, "fail", 2)], null, NOW).state).toBe(
      "failing",
    );
    expect(evaluateSignal(s, [o(0, "fail")], null, NOW).state).toBe("unknown");
  });
});
