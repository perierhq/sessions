import { expect, test } from "bun:test";
import type { IncidentResponse } from "../../../shared/incident-response";
import type {
  IncidentSummary,
  SignalView,
  StripResponse,
} from "../../../shared/incidents";
import {
  headsUps,
  miniBars,
  pastIncidentRow,
  pastIncidents,
  showMoreCount,
  signalTarget,
} from "./home";

const NOW = Date.parse("2026-10-20T12:31:00Z");
const inc = (over: Partial<IncidentSummary>) =>
  // SAFETY: the helpers under test read only the incident fields set here.
  ({
    id: "i",
    title: "Search down",
    project: "acme",
    state: "resolved",
    signalIds: ["sig-a"],
    openedAt: "2026-10-20T08:00:00Z",
    closedAt: "2026-10-20T10:00:00Z",
    ...over,
  }) as IncidentSummary;

const costed = (costUsd: number) =>
  // SAFETY: pastIncidentRow reads only the response's costUsd.
  ({ costUsd }) as IncidentResponse;

const sig = (over: Partial<SignalView>) =>
  // SAFETY: the helpers under test read only id, name, source, rule and
  // intervalMs.
  ({
    id: "sig-a",
    name: "Search",
    enabled: true,
    source: { kind: "http", url: "https://example.test/" },
    rule: { kind: "consecutive", failures: 3 },
    intervalMs: 120_000,
    evaluation: null,
    ...over,
  }) as SignalView;

test("past rows", () => {
  expect(
    pastIncidentRow(inc({ fixedBy: "agents", response: costed(3.8) }), NOW),
  ).toEqual({
    title: "Search down",
    fixedBy: "Agents · 2 h",
    cost: "$3.80",
    date: new Intl.DateTimeFormat(undefined, {
      day: "numeric",
      month: "short",
    }).format(new Date("2026-10-20T08:00:00Z")),
  });
  expect(
    pastIncidentRow(
      inc({
        fixedBy: "by-hand",
        openedAt: "2026-08-20T00:00:00Z",
        closedAt: "2026-08-21T00:00:00Z",
      }),
      NOW,
    ),
  ).toMatchObject({ fixedBy: "By hand · 24 h", cost: "—" });
  expect(
    pastIncidentRow(
      inc({
        openedAt: "2025-06-03T10:00:00Z",
        closedAt: "2025-06-03T10:50:00Z",
      }),
      NOW,
    ),
  ).toMatchObject({ fixedBy: "Fixed · 50 min" });
  expect(
    pastIncidentRow(
      inc({
        openedAt: "2025-06-03T10:00:00Z",
        closedAt: "2025-06-03T10:50:00Z",
      }),
      NOW,
    ).date,
  ).toContain("2025");
});

test("a past row without a close time says Fixed alone", () => {
  expect(
    pastIncidentRow(inc({ closedAt: undefined, fixedBy: "agents" }), NOW)
      .fixedBy,
  ).toBe("Agents");
});

test("only resolved incidents are past incidents, newest first", () => {
  expect(
    pastIncidents([
      inc({ id: "a", openedAt: "2026-10-01T00:00:00Z" }),
      inc({ id: "b", state: "closed-without-action" }),
      inc({ id: "c", openedAt: "2026-10-09T00:00:00Z" }),
      inc({ id: "d", state: "investigating" }),
    ]).map((i) => i.id),
  ).toEqual(["c", "a"]);
});

test("heads-ups are open heads-up incidents, newest first", () => {
  expect(
    headsUps([
      inc({ id: "a", state: "heads-up", openedAt: "2026-10-01T00:00:00Z" }),
      inc({ id: "b", state: "investigating" }),
      inc({ id: "c", state: "heads-up", openedAt: "2026-10-09T00:00:00Z" }),
      inc({ id: "d", state: "closed-without-action" }),
    ]).map((i) => i.id),
  ).toEqual(["c", "a"]);
});

test("a signal row opens its newest open incident, else the editor", () => {
  const open = [
    inc({
      id: "x",
      state: "investigating",
      signalIds: ["sig-a"],
      openedAt: "2026-10-20T08:00:00Z",
    }),
    inc({
      id: "y",
      state: "heads-up",
      signalIds: ["sig-z", "sig-a"],
      openedAt: "2026-10-20T09:00:00Z",
    }),
    inc({ id: "z", state: "resolved", signalIds: ["sig-b"] }),
  ];
  expect(signalTarget({ id: "sig-a" }, open)).toEqual({
    kind: "incident",
    id: "y",
  });
  expect(signalTarget({ id: "sig-b" }, open)).toEqual({
    kind: "edit",
  });
});

test("Show more counts the next page at most", () => {
  expect(showMoreCount(45, 20)).toBe(20);
  expect(showMoreCount(45, 40)).toBe(5);
  expect(showMoreCount(20, 20)).toBe(0);
});

const httpSignal = sig({});

test("mini bars: loading draws the final number of empty bars", () => {
  const bars = miniBars(httpSignal, undefined);
  expect(bars).toHaveLength(40);
  expect(bars.every((bar) => bar.tone === "empty")).toBe(true);
  const hook = sig({
    source: { kind: "webhook" },
    rule: { kind: "rate", atLeast: 3, windowMs: 600_000 },
  });
  expect(miniBars(hook, undefined)).toHaveLength(60);
});

test("mini bars: an expiry signal draws nothing", () => {
  const cert = sig({
    source: { kind: "expiry", target: "tls", host: "example.test" },
    rule: { kind: "deadline", warnDays: 14, failDays: 3 },
  });
  expect(miniBars(cert, undefined)).toEqual([]);
});

test("mini bars: the strip's first lane, passed and failed", () => {
  const strip: StripResponse = {
    from: "2026-10-20T11:11:00Z",
    to: "2026-10-20T12:31:00Z",
    bucketMs: 120_000,
    markers: [],
    lanes: [
      {
        id: "sig-a",
        signalId: "sig-a",
        label: "Search",
        bars: [
          {
            start: "2026-10-20T12:27:00Z",
            end: "2026-10-20T12:29:00Z",
            result: "ok",
            count: 1,
          },
          {
            start: "2026-10-20T12:29:00Z",
            end: "2026-10-20T12:31:00Z",
            result: "fail",
            count: 1,
          },
        ],
      },
    ],
  };
  expect(miniBars(httpSignal, strip).map((bar) => bar.tone)).toEqual([
    "ok",
    "fail",
  ]);
});
