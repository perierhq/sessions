import { describe, expect, test } from "bun:test";
import type { Signal } from "../../shared/incidents";
import {
  MISSED_CHECK_IN_DETAIL,
  evaluateSignal,
  missedSlotAt,
  replaySignal,
} from "./rules";

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
    // A webhook source: the newest observation is over three minutes old,
    // which would make a polled source stale.
    const r = sig(
      { kind: "rate", windowMs: 300_000, atLeast: 5, ratio: 0.5 },
      { source: { kind: "webhook" } },
    );
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

describe("missing heartbeat", () => {
  const hb = (rule: Signal["rule"], over: Partial<Signal> = {}) =>
    sig(rule, {
      source: { kind: "heartbeat" },
      intervalMs: undefined,
      ...over,
    });
  const hourly = hb({ kind: "missing", everyMs: 3_600_000, graceMs: 600_000 });
  test("interval", () => {
    expect(
      evaluateSignal(hourly, [o(65 * 60_000, "ok")], null, NOW).state,
    ).toBe("ok");
    expect(
      evaluateSignal(hourly, [o(71 * 60_000, "ok")], null, NOW),
    ).toMatchObject({
      state: "failing",
      reason: `No check-in since ${ago(71 * 60_000)}`,
    });
    expect(
      evaluateSignal({ ...hourly, createdAt: ago(30 * 60_000) }, [], null, NOW)
        .state,
    ).toBe("ok");
    expect(evaluateSignal(hourly, [o(60_000, "fail")], null, NOW).reason).toBe(
      "Last check-in reported a failure",
    );
    expect(missedSlotAt(hourly, [o(71 * 60_000, "ok")], NOW)).toBe(
      NOW - 71 * 60_000 + 70 * 60_000,
    );
  });
  test("a synthetic missed check-in is not a reported failure", () => {
    const missed = {
      at: ago(60_000),
      result: "fail" as const,
      detail: MISSED_CHECK_IN_DETAIL,
    };
    expect(
      evaluateSignal(hourly, [o(71 * 60_000, "ok"), missed], null, NOW).reason,
    ).toBe(`No check-in since ${ago(71 * 60_000)}`);
    expect(missedSlotAt(hourly, [o(60_000, "fail")], NOW)).toBeNull();
    expect(missedSlotAt(hourly, [o(30 * 60_000, "ok")], NOW)).toBeNull();
  });
  test("cron, with grace and a fresh signal", () => {
    const nightly = hb(
      { kind: "missing", cron: "0 3 * * *", graceMs: 1_800_000 },
      { createdAt: "2026-10-01T00:00:00Z" },
    );
    const at = (iso: string) => Date.parse(iso);
    const ok = (iso: string) => ({
      at: iso,
      result: "ok" as const,
      detail: "",
    });
    expect(
      evaluateSignal(
        nightly,
        [ok("2026-10-19T03:05:00Z")],
        null,
        at("2026-10-20T03:31:00Z"),
      ).state,
    ).toBe("failing");
    expect(
      evaluateSignal(
        nightly,
        [ok("2026-10-20T03:02:00Z")],
        null,
        at("2026-10-20T03:31:00Z"),
      ).state,
    ).toBe("ok");
    expect(
      evaluateSignal(
        nightly,
        [ok("2026-10-19T03:05:00Z")],
        null,
        at("2026-10-20T03:20:00Z"),
      ).state,
    ).toBe("ok");
    expect(
      evaluateSignal(
        { ...nightly, createdAt: "2026-10-20T03:10:00Z" },
        [],
        null,
        at("2026-10-20T03:31:00Z"),
      ).state,
    ).toBe("ok");
    expect(
      missedSlotAt(
        nightly,
        [ok("2026-10-19T03:05:00Z")],
        at("2026-10-20T03:31:00Z"),
      ),
    ).toBe(at("2026-10-20T03:30:00Z"));
  });
});
describe("flaky", () => {
  const s = sig({ kind: "consecutive", failures: 3 });
  const alternating = seq(
    "ok",
    "fail",
    "ok",
    "fail",
    "ok",
    "fail",
    "ok",
    "fail",
    "ok",
    "fail",
  );
  test("on and off under the open rule is flaky", () => {
    expect(evaluateSignal(s, alternating, null, NOW)).toMatchObject({
      state: "flaky",
      reason: "Failing on and off",
    });
  });
  test("clears after ten clean observations, not nine", () => {
    const prev = evaluateSignal(s, alternating, null, NOW);
    expect(
      evaluateSignal(
        s,
        [...alternating, ...Array(9).fill(o(0, "ok"))],
        prev,
        NOW,
      ).state,
    ).toBe("flaky");
    expect(
      evaluateSignal(
        s,
        [...alternating, ...Array(10).fill(o(0, "ok"))],
        prev,
        NOW,
      ).state,
    ).toBe("ok");
  });
  test("deadline rules are never flaky", () => {
    const d = sig(
      { kind: "deadline", warnDays: 14, failDays: 3 },
      { source: { kind: "expiry", target: "tls", host: "acme.example.test" } },
    );
    expect(
      evaluateSignal(d, [...alternating, o(0, "ok", 30)], null, NOW).state,
    ).toBe("ok");
  });
});
describe("staleness", () => {
  test("polled sources go unknown, pushed sources do not", () => {
    const s = sig({ kind: "consecutive", failures: 3 });
    expect(evaluateSignal(s, [o(4 * 60_000, "ok")], null, NOW)).toMatchObject({
      state: "unknown",
      reason: "No data for 4 min",
    });
    expect(evaluateSignal(s, [], null, NOW)).toMatchObject({
      state: "unknown",
      reason: "No data yet",
    });
    const w = sig(
      { kind: "rate", windowMs: 300_000, atLeast: 5 },
      { source: { kind: "webhook" }, intervalMs: undefined },
    );
    expect(evaluateSignal(w, [], null, NOW).state).toBe("ok");
  });
});
describe("provider signals", () => {
  const p = sig({ kind: "consecutive", failures: 2 }, { provider: true });
  test("a provider problem is external and keeps hysteresis", () => {
    const prev = evaluateSignal(p, seq("fail", "fail"), null, NOW);
    expect(prev.state).toBe("external");
    expect(evaluateSignal(p, seq("fail", "fail", "ok"), prev, NOW).state).toBe(
      "external",
    );
  });
});
describe("maintenance", () => {
  const window = {
    kind: "once" as const,
    start: ago(20 * 60_000),
    end: ago(5 * 60_000),
  };
  test("now inside a window: state frozen, flagged", () => {
    const s = sig(
      { kind: "consecutive", failures: 3 },
      {
        maintenance: [
          {
            kind: "once",
            start: ago(60_000),
            end: new Date(NOW + 60_000).toISOString(),
          },
        ],
      },
    );
    const prev = {
      ...evaluateSignal(s, seq("ok"), null, NOW - 120_000),
      state: "ok" as const,
    };
    expect(
      evaluateSignal(s, seq("fail", "fail", "fail"), prev, NOW),
    ).toMatchObject({
      state: "ok",
      inMaintenance: true,
    });
  });
  test("failures recorded during a past window do not count", () => {
    const s = sig(
      { kind: "consecutive", failures: 3 },
      { maintenance: [window] },
    );
    const obs = [
      o(15 * 60_000, "fail"),
      o(10 * 60_000, "fail"),
      o(8 * 60_000, "fail"),
      o(60_000, "fail"),
    ];
    expect(evaluateSignal(s, obs, null, NOW).state).toBe("ok");
  });
});
describe("maintenance and staleness", () => {
  test("checks taken during a window still count as data", () => {
    const s = sig(
      { kind: "consecutive", failures: 3 },
      {
        maintenance: [
          { kind: "once", start: ago(30 * 60_000), end: ago(60_000) },
        ],
      },
    );
    const obs = [
      o(4 * 60_000, "fail"),
      o(3 * 60_000, "fail"),
      o(2 * 60_000, "fail"),
    ];
    expect(evaluateSignal(s, obs, null, NOW)).toMatchObject({
      state: "ok",
      inMaintenance: false,
    });
  });
});
describe("replay", () => {
  test("honours hysteresis where a cold evaluation would not", () => {
    const s = sig({ kind: "consecutive", failures: 3 });
    const obs = seq("fail", "fail", "fail", "ok");
    expect(evaluateSignal(s, obs, null, NOW).state).toBe("ok");
    expect(replaySignal(s, obs, NOW).state).toBe("failing");
  });
});
