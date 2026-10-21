import { expect, test } from "bun:test";
import type {
  SignalState,
  SignalView,
  StripResponse,
} from "../../../shared/incidents";
import { clockTime } from "../time";
import {
  everyPhrase,
  formatSignalValue,
  laneKindFor,
  latestValue,
  miniRange,
  ruleCaption,
  signalCaption,
  sortSignals,
  stripRefreshMs,
} from "./signal-summary";

const NOW = Date.parse("2026-10-20T12:31:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const sig = (over: Partial<SignalView> = {}): SignalView => ({
  id: "sig-a",
  name: "Search",
  project: "acme",
  enabled: true,
  severity: "major",
  source: { kind: "http", url: "https://acme.example.test" },
  intervalMs: 120_000,
  rule: { kind: "consecutive", failures: 3 },
  createdBy: "Ada",
  createdAt: ago(86_400_000),
  updatedAt: ago(86_400_000),
  evaluation: null,
  ...over,
});
const ev = (state: SignalState, reason = "Passing") => ({
  signalId: "sig-a",
  state,
  reason,
  since: ago(0),
  at: ago(0),
  inMaintenance: false,
});

test("lane kinds follow the rule", () => {
  expect(laneKindFor({ rule: { kind: "consecutive", failures: 3 } })).toBe(
    "passfail",
  );
  expect(laneKindFor({ rule: { kind: "threshold", above: 1, forMs: 1 } })).toBe(
    "value",
  );
  expect(laneKindFor({ rule: { kind: "rate", windowMs: 1, atLeast: 1 } })).toBe(
    "events",
  );
  expect(laneKindFor({ rule: { kind: "missing", graceMs: 0 } })).toBe("runs");
  expect(
    laneKindFor({ rule: { kind: "deadline", warnDays: 14, failDays: 3 } }),
  ).toBe("days");
});

test("every phrases", () => {
  expect(everyPhrase(60_000)).toBe("every minute");
  expect(everyPhrase(120_000)).toBe("every 2 min");
  expect(everyPhrase(3_600_000)).toBe("every hour");
  expect(everyPhrase(6 * 3_600_000)).toBe("every 6 h");
  expect(everyPhrase(86_400_000)).toBe("every day");
});

test("rule captions", () => {
  expect(ruleCaption(sig())).toBe("3 failures in a row");
  expect(
    ruleCaption(sig({ rule: { kind: "rate", windowMs: 300_000, atLeast: 5 } })),
  ).toBe("5 in 5 min");
  expect(
    ruleCaption(
      sig({ rule: { kind: "missing", everyMs: 60_000, graceMs: 0 } }),
    ),
  ).toBe("missed check-in");
  expect(
    ruleCaption(
      sig({ rule: { kind: "missing", everyMs: 60_000, graceMs: 1_800_000 } }),
    ),
  ).toBe("missed after 30 min grace");
  expect(
    ruleCaption(sig({ rule: { kind: "deadline", warnDays: 14, failDays: 3 } })),
  ).toBe("warn at 14 days, fail at 3");
});

test("captions and values per kind", () => {
  expect(signalCaption(sig())).toBe("Check · every 2 min");
  expect(
    signalCaption(
      sig({
        intervalMs: 60_000,
        rule: { kind: "threshold", above: 1500, forMs: 300_000 },
      }),
    ),
  ).toBe("Check · every minute · slow above 1.5 s for 5 min");
  expect(
    signalCaption(
      sig({
        source: { kind: "heartbeat" },
        intervalMs: undefined,
        rule: { kind: "missing", cron: "0 3 * * *", graceMs: 1_800_000 },
      }),
    ),
  ).toBe("Check-in · daily at 03:00");
  expect(
    signalCaption(
      sig({
        source: { kind: "heartbeat" },
        rule: { kind: "missing", cron: "*/5 * * * *", graceMs: 0 },
      }),
    ),
  ).toBe("Check-in · */5 * * * *");
  expect(
    signalCaption(
      sig({
        source: { kind: "heartbeat" },
        rule: { kind: "missing", everyMs: 3_600_000, graceMs: 0 },
      }),
    ),
  ).toBe("Check-in · every hour");
  expect(
    signalCaption(
      sig({
        source: { kind: "webhook" },
        rule: { kind: "rate", windowMs: 300_000, atLeast: 5 },
      }),
    ),
  ).toBe("Webhook · 5 in 5 min");
  expect(
    signalCaption(
      sig({
        source: { kind: "expiry", target: "tls", host: "acme.example.test" },
        rule: { kind: "deadline", warnDays: 14, failDays: 3 },
      }),
    ),
  ).toBe("Certificate · acme.example.test");
  expect(formatSignalValue(sig(), 412)).toBe("412 ms");
  expect(formatSignalValue(sig(), 3500)).toBe("3.5 s");
  expect(formatSignalValue(sig(), 2000)).toBe("2 s");
  expect(
    formatSignalValue(
      sig({
        source: {
          kind: "http",
          url: "https://acme.example.test",
          json: { value: "$.queue" },
        },
      }),
      1200,
    ),
  ).toBe((1200).toLocaleString());
  const expiry = sig({
    source: { kind: "expiry", target: "tls", host: "x.example.test" },
    rule: { kind: "deadline", warnDays: 14, failDays: 3 },
  });
  expect(formatSignalValue(expiry, 1.7)).toBe("1 day");
  expect(
    latestValue(
      sig({
        evaluation: ev("ok"),
        lastObservation: {
          at: ago(60_000),
          result: "ok",
          value: 412,
          detail: "",
        },
      }),
      undefined,
      NOW,
    ),
  ).toEqual({ text: "412 ms", tone: "fg" });
  expect(latestValue(sig({ evaluation: ev("ok") }), undefined, NOW)).toEqual({
    text: "ok",
    tone: "fg",
  });
  expect(latestValue(sig({ evaluation: ev("flaky") }), undefined, NOW)).toEqual(
    { text: "flaky", tone: "yellow" },
  );
  expect(
    latestValue(sig({ evaluation: ev("failing") }), undefined, NOW),
  ).toEqual({ text: "failing", tone: "red" });
  expect(latestValue(sig(), undefined, NOW)).toEqual({
    text: "no data",
    tone: "faint",
  });
  expect(
    latestValue(
      {
        ...expiry,
        evaluation: ev("ok"),
        lastObservation: { at: ago(0), result: "ok", value: 62.4, detail: "" },
      },
      undefined,
      NOW,
    ).text,
  ).toBe("62 days");
  const webhook = sig({
    source: { kind: "webhook" },
    rule: { kind: "rate", windowMs: 300_000, atLeast: 5 },
    evaluation: ev("ok"),
  });
  // SAFETY: latestValue reads lanes[].bars[].result and count only.
  const strip = {
    lanes: [
      {
        id: "sig-a",
        signalId: "sig-a",
        label: "x",
        bars: [
          { start: ago(0), end: ago(0), result: "fail", count: 2 },
          { start: ago(0), end: ago(0), result: null, count: 0 },
        ],
      },
    ],
    markers: [],
    from: ago(3_600_000),
    to: ago(0),
    bucketMs: 60_000,
  } as StripResponse;
  expect(latestValue(webhook, strip, NOW).text).toBe("2 in 1 h");
  expect(latestValue(webhook, undefined, NOW).text).toBe("0 in 1 h");
  expect(
    latestValue(sig({ evaluation: ev("ok"), enabled: false }), undefined, NOW),
  ).toEqual({ text: "off", tone: "faint" });
  const heartbeat = sig({
    source: { kind: "heartbeat" },
    rule: { kind: "missing", everyMs: 3_600_000, graceMs: 0 },
    evaluation: ev("ok"),
  });
  expect(latestValue(heartbeat, undefined, NOW)).toEqual({
    text: "no check-in yet",
    tone: "faint",
  });
  expect(
    latestValue(
      {
        ...heartbeat,
        lastObservation: { at: ago(3_600_000), result: "ok", detail: "" },
      },
      undefined,
      NOW,
    ).text,
  ).toBe(`ran ${clockTime(ago(3_600_000))}`);
  expect(
    latestValue(
      {
        ...heartbeat,
        lastObservation: { at: ago(3 * 86_400_000), result: "ok", detail: "" },
      },
      undefined,
      NOW,
    ).text,
  ).not.toContain(":");
});

test("problems first, then by name", () => {
  const list = sortSignals([
    sig({ name: "b", evaluation: ev("ok") }),
    sig({ name: "a", evaluation: ev("ok") }),
    sig({ name: "z", evaluation: ev("failing") }),
    sig({ name: "y", evaluation: null }),
  ]);
  expect(list.map((s) => s.name)).toEqual(["z", "y", "a", "b"]);
});

test("mini range", () => {
  expect(miniRange(sig(), NOW)).toEqual({
    from: ago(40 * 120_000),
    to: ago(0),
  });
  expect(
    miniRange(
      sig({
        source: { kind: "webhook" },
        rule: { kind: "rate", windowMs: 300_000, atLeast: 5 },
      }),
      NOW,
    ).from,
  ).toBe(ago(3_600_000));
});

test("strip refresh", () => {
  expect(stripRefreshMs(undefined)).toBe(60_000);
});
