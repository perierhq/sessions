import { expect, test } from "bun:test";
import type {
  IncidentImpact,
  SignalState,
  SignalView,
} from "../../../shared/incidents";
import { clockTime } from "../time";
import {
  FIXED_BY_LABEL,
  formatSpan,
  formatUsd,
  homeSummary,
  impactFact,
  incidentFacts,
  incidentHeadline,
  joinNames,
  relativeAgo,
} from "./copy";

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

test("headlines", () => {
  expect(
    incidentHeadline({
      title: "Search",
      state: "investigating",
      primary: "failing",
    }),
  ).toBe("Search is down");
  expect(
    incidentHeadline({ title: "Search", state: "veto", primary: "slow" }),
  ).toBe("Search is slow");
  expect(
    incidentHeadline({ title: "Webhook", state: "heads-up", primary: "flaky" }),
  ).toBe("Webhook fails on and off");
  expect(
    incidentHeadline({
      title: "TLS",
      state: "heads-up",
      primary: "upcoming",
      reason: "10 days left",
    }),
  ).toBe("TLS: 10 days left");
  expect(
    incidentHeadline({
      title: "Email",
      state: "waiting-on-provider",
      primary: "external",
    }),
  ).toBe("Email has a provider problem");
  expect(
    incidentHeadline({ title: "Search", state: "resolved", primary: "ok" }),
  ).toBe("Search works again");
  expect(
    incidentHeadline({
      title: "Search",
      state: "closed-without-action",
      primary: "failing",
    }),
  ).toBe("Search is back to normal");
  expect(
    incidentHeadline({ title: "Search", state: "watching", primary: "ok" }),
  ).toBe("Search passes again");
  expect(
    incidentHeadline({
      title: "Search",
      state: "investigating",
      primary: null,
    }),
  ).toBe("Search");
});

test("facts", () => {
  expect(
    incidentFacts({
      incident: { state: "investigating", openedAt: ago(110 * 60_000) },
      sources: ["Search", "Request log"],
      now: NOW,
    }),
  ).toEqual([
    `since ${clockTime(ago(110 * 60_000))}`,
    "from Search and Request log",
  ]);
  expect(
    incidentFacts({
      incident: {
        state: "resolved",
        openedAt: ago(3 * 3_600_000),
        closedAt: ago(3_600_000),
        fixedBy: "agents",
      },
      sources: [],
      now: NOW,
    }),
  ).toEqual(["fixed by the agents", "down for 2 h"]);
  expect(
    incidentFacts({
      incident: {
        state: "resolved",
        openedAt: ago(3 * 3_600_000),
        closedAt: ago(3_600_000),
        fixedBy: "by-hand",
      },
      sources: [],
      now: NOW,
    })[0],
  ).toBe("fixed by hand");
  expect(
    incidentFacts({
      incident: {
        state: "closed-without-action",
        openedAt: ago(3 * 3_600_000),
        closedAt: ago(3_600_000),
      },
      sources: [],
      now: NOW,
    }),
  ).toEqual([`back to normal ${clockTime(ago(3_600_000))}`]);
  expect(
    incidentFacts({
      incident: {
        state: "closed-without-action",
        openedAt: ago(3 * 3_600_000),
        closedAt: ago(3_600_000),
        fixedBy: "recovered",
      },
      sources: [],
      now: NOW,
    }),
  ).toEqual([
    "recovered on its own",
    `back to normal ${clockTime(ago(3_600_000))}`,
  ]);
  const impact: IncidentImpact = {
    signalId: "sig-a",
    at: ago(0),
    count: 140,
    people: 23,
    approximate: true,
    noun: "searches failed",
    label: "the request log",
  };
  expect(
    incidentFacts({
      incident: {
        state: "investigating",
        openedAt: ago(110 * 60_000),
        impact,
      },
      sources: ["the probe"],
      now: NOW,
    }),
  ).toEqual([
    `since ${clockTime(ago(110 * 60_000))}`,
    "~140 searches failed for 23 people",
    "from the probe and the request log",
  ]);
  expect(
    impactFact({
      ...impact,
      approximate: false,
      people: undefined,
      count: 1200,
    }),
  ).toBe(`${(1200).toLocaleString()} searches failed`);
  expect(impactFact({ ...impact, people: 1 })).toBe(
    "~140 searches failed for 1 person",
  );
  expect(
    impactFact({
      ...impact,
      count: undefined,
      error: "HTTP 503 (expected 2xx)",
    }),
  ).toBeNull();
  expect(impactFact(undefined)).toBeNull();
});

test("an incident opened on another day names the day", () => {
  const facts = incidentFacts({
    incident: { state: "investigating", openedAt: ago(3 * 86_400_000) },
    sources: [],
    now: NOW,
  });
  expect(facts).toHaveLength(1);
  expect(facts[0]).toStartWith("since ");
  expect(facts[0]).not.toBe(`since ${clockTime(ago(3 * 86_400_000))}`);
});

test("home summary", () => {
  const signals = [
    sig({ evaluation: ev("ok") }),
    sig({
      id: "sig-b",
      name: "Webhook",
      evaluation: ev("flaky", "Failing on and off"),
    }),
    sig({ id: "sig-c", enabled: false, evaluation: ev("failing") }),
  ];
  expect(
    homeSummary({
      signals,
      lastClosed: { closedAt: ago(2 * 86_400_000), fixedBy: "agents" },
      now: NOW,
    }),
  ).toEqual({
    tone: "yellow",
    headline: "1 green, 1 flaky",
    sentence:
      "Webhook: failing on and off. The last incident was fixed by the agents 2 days ago",
  });
  expect(homeSummary({ signals: [], now: NOW })).toEqual({
    tone: "faint",
    headline: "No signals yet",
    sentence: "",
  });
  expect(
    homeSummary({
      signals: [
        sig({ evaluation: ev("ok") }),
        sig({ id: "b", evaluation: ev("ok") }),
        sig({ id: "c", name: "Api", evaluation: ev("failing", "HTTP 503") }),
        sig({ id: "d", evaluation: null }),
      ],
      lastClosed: { closedAt: ago(30 * 60_000) },
      now: NOW,
    }),
  ).toEqual({
    tone: "red",
    headline: "2 green, 1 failing, 1 with no data",
    sentence: "Api: HTTP 503. The last incident was closed 30 min ago",
  });
  expect(
    homeSummary({
      signals: [sig({ evaluation: ev("ok") })],
      lastClosed: {
        closedAt: ago(3 * 3_600_000),
        fixedBy: "provider-recovered",
      },
      now: NOW,
    }).sentence,
  ).toBe("The last incident was resolved when the provider recovered 3 h ago");
});

test("formatters", () => {
  expect(formatSpan(50 * 60_000)).toBe("50 min");
  expect(formatSpan(92 * 60_000, true)).toBe("1 h 32 min");
  expect(formatSpan(120 * 60_000, true)).toBe("2 h");
  expect(formatSpan(26 * 3_600_000)).toBe("26 h");
  expect(formatSpan(3 * 86_400_000)).toBe("3 days");
  expect(formatSpan(1 * 86_400_000 + 49 * 3_600_000)).toBe("3 days");
  expect(formatUsd(3.8)).toBe("$3.80");
  expect(formatUsd(0)).toBe("$0.00");
  expect(formatUsd(20, { whole: true })).toBe("$20");
  expect(formatUsd(20.5, { whole: true })).toBe("$20.50");
  expect(formatUsd(10000, { whole: true })).toBe("$10,000");
  expect(formatUsd(1234.5)).toBe("$1,234.50");
  expect(formatUsd(-3.8)).toBe("-$3.80");
  expect(joinNames([])).toBe("");
  expect(joinNames(["A"])).toBe("A");
  expect(joinNames(["A", "B"])).toBe("A and B");
  expect(joinNames(["A", "B", "C"])).toBe("A, B and C");
  expect(relativeAgo(ago(10_000), NOW)).toBe("just now");
  expect(relativeAgo(ago(5 * 60_000), NOW)).toBe("5 min ago");
  expect(relativeAgo(ago(3 * 3_600_000), NOW)).toBe("3 h ago");
  expect(relativeAgo(ago(86_400_000), NOW)).toBe("1 day ago");
  expect(relativeAgo(ago(2 * 86_400_000), NOW)).toBe("2 days ago");
  expect(FIXED_BY_LABEL).toEqual({
    agents: "Agents",
    "agents-with-you": "Agents with you",
    "by-hand": "By hand",
    "provider-recovered": "Provider recovered",
    recovered: "Recovered on its own",
  });
});
