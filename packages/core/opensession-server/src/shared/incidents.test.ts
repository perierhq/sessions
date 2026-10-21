import { describe, expect, test } from "bun:test";
import {
  IMPACT_PLACEHOLDERS,
  INCIDENT_STATES,
  SIGNAL_STATES,
  isIncidentState,
  isOpenIncident,
  isSignalState,
  isTerminalIncidentState,
  stripIntervalMs,
} from "./incidents";

describe("incident wire types", () => {
  test("lists the spec's states in order", () => {
    expect([...SIGNAL_STATES]).toEqual([
      "ok",
      "slow",
      "failing",
      "flaky",
      "upcoming",
      "external",
      "unknown",
    ]);
    expect([...INCIDENT_STATES]).toEqual([
      "heads-up",
      "investigating",
      "fix-ready",
      "veto",
      "deploying",
      "watching",
      "resolved",
      "needs-you",
      "paused",
      "waiting-on-provider",
      "rolled-back",
      "closed-without-action",
    ]);
  });
  test("guards", () => {
    expect(isSignalState("flaky")).toBe(true);
    expect(isSignalState("down")).toBe(false);
    expect(isIncidentState("veto")).toBe(true);
    expect(isIncidentState("fix ready")).toBe(false);
    expect(isTerminalIncidentState("resolved")).toBe(true);
    expect(isTerminalIncidentState("rolled-back")).toBe(false);
    expect(isOpenIncident({ state: "closed-without-action" })).toBe(false);
    expect(isOpenIncident({ state: "waiting-on-provider" })).toBe(true);
  });
});

test("stripIntervalMs per source", () => {
  expect(
    stripIntervalMs({
      source: { kind: "http", url: "https://acme.example.test" },
      rule: { kind: "consecutive", failures: 3 },
      intervalMs: 120_000,
    }),
  ).toBe(120_000);
  expect(
    stripIntervalMs({
      source: { kind: "http", url: "https://acme.example.test" },
      rule: { kind: "consecutive", failures: 3 },
    }),
  ).toBe(60_000);
  expect(
    stripIntervalMs({
      source: { kind: "heartbeat" },
      rule: { kind: "missing", everyMs: 86_400_000, graceMs: 0 },
    }),
  ).toBe(86_400_000);
  expect(
    stripIntervalMs({
      source: { kind: "heartbeat" },
      rule: { kind: "missing", cron: "0 3 * * *", graceMs: 0 },
    }),
  ).toBe(3_600_000);
  expect(
    stripIntervalMs({
      source: { kind: "webhook" },
      rule: { kind: "rate", windowMs: 300_000, atLeast: 5 },
    }),
  ).toBe(60_000);
});

test("impact URLs know four placeholders", () => {
  expect([...IMPACT_PLACEHOLDERS]).toEqual([
    "since",
    "sinceMs",
    "until",
    "untilMs",
  ]);
});
