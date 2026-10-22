import { describe, expect, test } from "bun:test";
import type { Signal } from "../../shared/incidents";
import {
  DEFAULT_RECOVERIES,
  MISSED_CHECK_IN_DETAIL,
  evaluateSignal,
  missedSlotAt,
  recoveriesFor,
  replaySignal,
  trailingPasses,
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
  test("the window excludes its start instant", () => {
    const edge = [o(300_000, "fail"), ...fails(4)];
    expect(evaluateSignal(s, edge, null, NOW).state).toBe("ok");
    expect(evaluateSignal(s, edge, null, NOW - 1).state).toBe("failing");
  });
  test("ratio fires", () => {
    const r = sig(
      { kind: "rate", windowMs: 300_000, atLeast: 5, ratio: 0.5 },
      { source: { kind: "webhook" } },
    );
    const mixed = [
      ...fails(5),
      ...Array.from({ length: 3 }, (_, i) => o(200_000 - i * 1_000, "ok")),
    ];
    expect(evaluateSignal(r, mixed, null, NOW)).toMatchObject({
      state: "failing",
      reason: "5 failures in 5 min",
    });
  });
  test("ratio hysteresis: stays failing only above half the ratio", () => {
    const r = sig(
      { kind: "rate", windowMs: 300_000, atLeast: 5, ratio: 0.5 },
      { source: { kind: "webhook" } },
    );
    const prev = evaluateSignal(r, fails(5), null, NOW);
    expect(prev.state).toBe("failing");
    const oks = (n: number) =>
      Array.from({ length: n }, (_, i) => o(200_000 - i * 1_000, "ok"));
    // 3 of 20 = 0.15, below 0.25.
    expect(evaluateSignal(r, [...fails(3), ...oks(17)], prev, NOW).state).toBe(
      "ok",
    );
    // 3 of 9 = 0.33, at least 0.25.
    expect(evaluateSignal(r, [...fails(3), ...oks(6)], prev, NOW).state).toBe(
      "failing",
    );
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
describe("threshold on a webhook", () => {
  const s = sig(
    { kind: "threshold", above: 1000, forMs: 300_000 },
    { source: { kind: "webhook" }, intervalMs: undefined },
  );
  test("needs data within forMs", () => {
    const old = [o(40 * 60_000, "ok", 2000), o(30 * 60_000, "ok", 2000)];
    expect(evaluateSignal(s, old, null, NOW).state).toBe("ok");
    const prev = evaluateSignal(s, old, null, NOW - 29 * 60_000);
    expect(prev.state).toBe("slow");
    expect(evaluateSignal(s, old, prev, NOW).state).toBe("ok");
    expect(
      evaluateSignal(
        s,
        [...old, o(20 * 60_000, "ok", 2000), o(60_000, "ok", 2000)],
        null,
        NOW,
      ).state,
    ).toBe("slow");
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
    expect(evaluateSignal(s, [o(0, "unknown")], null, NOW).state).toBe(
      "unknown",
    );
  });
  test("a rejected certificate is failing whatever the days left", () => {
    const rejected = {
      ...o(0, "fail", 200),
      detail: "Certificate rejected: ERR_TLS_CERT_ALTNAME_INVALID",
    };
    expect(
      evaluateSignal(s, [o(60_000, "ok", 200), rejected], null, NOW),
    ).toMatchObject({
      state: "failing",
      reason: "Certificate rejected: ERR_TLS_CERT_ALTNAME_INVALID",
    });
    const unreachable = { ...o(0, "fail"), detail: "Could not reach host" };
    expect(evaluateSignal(s, [unreachable], null, NOW)).toMatchObject({
      state: "failing",
      reason: "Could not reach host",
    });
  });
  test("an old reading ages", () => {
    const aged = sig(
      { kind: "deadline", warnDays: 14, failDays: 3 },
      {
        source: { kind: "expiry", target: "tls", host: "acme.example.test" },
        intervalMs: 7 * 86_400_000,
      },
    );
    expect(
      evaluateSignal(aged, [o(3 * 86_400_000, "ok", 16)], null, NOW),
    ).toMatchObject({ state: "upcoming", reason: "13 days left" });
    // 15 days left two hours ago; the newer check was refused (no value).
    expect(
      evaluateSignal(
        aged,
        [o(2 * 3_600_000, "ok", 15), { ...o(0, "unknown"), detail: "Refused" }],
        null,
        NOW,
      ),
    ).toMatchObject({ state: "ok", reason: "14.9 days left" });
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
  test("the latest of several missed slots", () => {
    const b = NOW - 195 * 60_000;
    expect(missedSlotAt(hourly, [o(195 * 60_000, "ok")], NOW)).toBe(
      b + 190 * 60_000,
    );
  });
  test("slots due inside a maintenance window are skipped", () => {
    // Baseline 135 min ago: slots due at b+70 and b+130 min.
    const b = NOW - 135 * 60_000;
    const iso = (t: number) => new Date(t).toISOString();
    const both = hb(
      { kind: "missing", everyMs: 3_600_000, graceMs: 600_000 },
      {
        maintenance: [
          { kind: "once", start: iso(b + 60 * 60_000), end: iso(NOW) },
        ],
      },
    );
    const obs = [o(135 * 60_000, "ok")];
    expect(evaluateSignal(both, obs, null, NOW + 1).state).toBe("ok");
    expect(missedSlotAt(both, obs, NOW + 1)).toBeNull();
    const latestOnly = hb(
      { kind: "missing", everyMs: 3_600_000, graceMs: 600_000 },
      {
        maintenance: [
          { kind: "once", start: iso(b + 120 * 60_000), end: iso(NOW) },
        ],
      },
    );
    expect(missedSlotAt(latestOnly, obs, NOW + 1)).toBe(b + 70 * 60_000);
    const nightly = hb(
      { kind: "missing", cron: "0 3 * * *", graceMs: 1_800_000 },
      {
        createdAt: "2026-10-01T00:00:00Z",
        maintenance: [
          {
            kind: "once",
            start: "2026-10-20T03:00:00Z",
            end: "2026-10-20T04:00:00Z",
          },
        ],
      },
    );
    const ok = {
      at: "2026-10-19T03:05:00Z",
      result: "ok" as const,
      detail: "",
    };
    expect(
      evaluateSignal(nightly, [ok], null, Date.parse("2026-10-20T04:10:00Z"))
        .state,
    ).toBe("ok");
    const older = {
      at: "2026-10-18T03:05:00Z",
      result: "ok" as const,
      detail: "",
    };
    expect(
      missedSlotAt(nightly, [older], Date.parse("2026-10-20T04:10:00Z")),
    ).toBe(Date.parse("2026-10-19T03:30:00Z"));
  });
  test("check-ins during a window still count", () => {
    const s = hb(
      { kind: "missing", everyMs: 3_600_000, graceMs: 600_000 },
      {
        maintenance: [{ kind: "once", start: ago(90 * 60_000), end: ago(0) }],
      },
    );
    expect(evaluateSignal(s, [o(30 * 60_000, "ok")], null, NOW + 1).state).toBe(
      "ok",
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
  test("cron: a signal created just before a slot owes it", () => {
    const nightly = hb(
      { kind: "missing", cron: "0 3 * * *", graceMs: 1_800_000 },
      { createdAt: "2026-10-20T02:45:00Z" },
    );
    expect(
      evaluateSignal(nightly, [], null, Date.parse("2026-10-20T03:31:00Z"))
        .state,
    ).toBe("failing");
    expect(
      evaluateSignal(
        nightly,
        [{ at: "2026-10-20T02:50:00Z", result: "ok", detail: "" }],
        null,
        Date.parse("2026-10-20T03:31:00Z"),
      ).state,
    ).toBe("ok");
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
describe("unusable data", () => {
  const s = sig({ kind: "consecutive", failures: 3 });
  const refused = (msAgo: number) => ({
    ...o(msAgo, "unknown"),
    detail: "Refused: private address",
  });
  test("only unknown observations are not ok", () => {
    expect(evaluateSignal(s, [refused(0)], null, NOW)).toMatchObject({
      state: "unknown",
      reason: "No usable data yet: Refused: private address",
    });
  });
  test("staleness counts from the latest ok or fail", () => {
    const prev = evaluateSignal(
      s,
      seq("fail", "fail", "fail"),
      null,
      NOW - 4 * 60_000,
    );
    expect(prev.state).toBe("failing");
    const obs = [
      o(6 * 60_000, "fail"),
      o(5 * 60_000, "fail"),
      o(4 * 60_000, "fail"),
      refused(3 * 60_000),
      refused(2 * 60_000),
      refused(60_000),
      refused(0),
    ];
    expect(evaluateSignal(s, obs, prev, NOW)).toMatchObject({
      state: "unknown",
      reason: "No usable data for 4 min: Refused: private address",
    });
    // Fresh enough: the rule still reads the known observations.
    expect(evaluateSignal(s, obs.slice(0, 5), prev, NOW - 60_000).state).toBe(
      "failing",
    );
  });
  test("provider signals too", () => {
    const p = sig({ kind: "consecutive", failures: 2 }, { provider: true });
    const html = (msAgo: number) => ({
      ...o(msAgo, "unknown"),
      detail: "Expected JSON, got text/html",
    });
    expect(
      evaluateSignal(
        p,
        [o(5 * 60_000, "ok"), html(2 * 60_000), html(0)],
        null,
        NOW,
      ),
    ).toMatchObject({
      state: "unknown",
      reason: "No usable data for 5 min: Expected JSON, got text/html",
    });
  });
});
describe("provider signals", () => {
  const p = sig({ kind: "consecutive", failures: 2 }, { provider: true });
  test("slow and flaky are external too", () => {
    const t = sig(
      { kind: "threshold", above: 1000, forMs: 120_000 },
      { provider: true },
    );
    expect(
      evaluateSignal(
        t,
        [o(180_000, "ok", 2000), o(60_000, "ok", 2000), o(0, "ok", 2000)],
        null,
        NOW,
      ),
    ).toMatchObject({ state: "external", reason: "Over 1000 for 2 min" });
    expect(
      evaluateSignal(
        sig({ kind: "consecutive", failures: 3 }, { provider: true }),
        seq("ok", "fail", "ok", "fail", "ok", "fail", "ok", "fail", "ok"),
        null,
        NOW,
      ),
    ).toMatchObject({ state: "external", reason: "Failing on and off" });
  });
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
  test("now inside a window with no previous evaluation", () => {
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
    expect(
      evaluateSignal(s, seq("fail", "fail", "fail"), null, NOW),
    ).toMatchObject({
      state: "unknown",
      reason: "In maintenance",
      inMaintenance: true,
      since: new Date(NOW).toISOString(),
    });
  });
  test("passes recorded during a past window still count", () => {
    const s = sig(
      { kind: "consecutive", failures: 3 },
      { maintenance: [window] },
    );
    const prev = evaluateSignal(
      s,
      [o(30 * 60_000, "fail"), o(28 * 60_000, "fail"), o(26 * 60_000, "fail")],
      null,
      NOW - 25 * 60_000,
    );
    expect(prev.state).toBe("failing");
    const obs = [
      o(30 * 60_000, "fail"),
      o(28 * 60_000, "fail"),
      o(26 * 60_000, "fail"),
      o(15 * 60_000, "ok"),
      o(10 * 60_000, "ok"),
      o(60_000, "ok"),
    ];
    expect(evaluateSignal(s, obs, prev, NOW).state).toBe("ok");
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

describe("replay performance", () => {
  test("200 observations and 20 windows replay in well under 50 ms", () => {
    const zones = ["Europe/Warsaw", "America/New_York", "Asia/Tokyo", "UTC"];
    const maintenance = Array.from({ length: 20 }, (_, i) => ({
      kind: "weekly" as const,
      days: [i % 7],
      start: "03:00",
      end: "03:30",
      timeZone: zones[i % zones.length],
    }));
    const s = sig({ kind: "consecutive", failures: 3 }, { maintenance });
    const obs = Array.from({ length: 200 }, (_, i) =>
      o((200 - i) * 60_000, i % 7 === 0 ? "fail" : "ok"),
    );
    replaySignal(s, obs, NOW);
    const started = performance.now();
    replaySignal(s, obs, NOW);
    expect(performance.now() - started).toBeLessThan(50);
  });
  test("replay matches step-by-step evaluation", () => {
    const s = sig(
      { kind: "consecutive", failures: 3 },
      {
        maintenance: [
          { kind: "once", start: ago(12 * 60_000), end: ago(8 * 60_000) },
        ],
      },
    );
    const obs = seq(
      "fail",
      "fail",
      "ok",
      "fail",
      "fail",
      "fail",
      "fail",
      "fail",
      "ok",
      "fail",
      "ok",
      "ok",
      "fail",
      "fail",
      "ok",
    );
    let prev = null;
    for (let i = 0; i < obs.length; i++)
      prev = evaluateSignal(
        s,
        obs.slice(0, i + 1),
        prev,
        Date.parse(obs[i].at),
      );
    expect(replaySignal(s, obs, NOW)).toEqual(
      evaluateSignal(s, obs, prev, NOW),
    );
  });
});

describe("recovery counts", () => {
  test("the rule's own count, else the default", () => {
    expect(recoveriesFor({ kind: "consecutive", failures: 3 })).toBe(
      DEFAULT_RECOVERIES,
    );
    expect(
      recoveriesFor({ kind: "consecutive", failures: 3, recoveries: 4 }),
    ).toBe(4);
    expect(
      recoveriesFor({
        kind: "threshold",
        above: 500,
        forMs: 60_000,
        recoveries: 3,
      }),
    ).toBe(3);
    expect(recoveriesFor({ kind: "rate", windowMs: 600_000, atLeast: 5 })).toBe(
      DEFAULT_RECOVERIES,
    );
  });
  test("passing checks in a row, as the rule counts them", () => {
    const s = sig({ kind: "consecutive", failures: 3 });
    expect(trailingPasses(s, seq("fail", "ok", "unknown", "ok"))).toBe(2);
    expect(trailingPasses(s, seq("ok", "ok", "fail"))).toBe(0);
    expect(trailingPasses(s, [])).toBe(0);
    // Another lane says nothing about the signal itself.
    expect(
      trailingPasses(s, [
        ...seq("fail", "ok"),
        { ...o(0, "ok"), lane: "proof" },
      ]),
    ).toBe(1);
    // A threshold rule recovers under its threshold, whatever the result.
    const t = sig({ kind: "threshold", above: 500, forMs: 300_000 });
    expect(
      trailingPasses(t, [
        o(180_000, "ok", 900),
        o(120_000, "ok", 300),
        o(60_000, "ok", 400),
      ]),
    ).toBe(2);
    expect(trailingPasses(t, [o(60_000, "ok", 300), o(0, "fail")])).toBe(0);
  });
});
