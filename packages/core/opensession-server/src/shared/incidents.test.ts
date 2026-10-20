import { describe, expect, test } from "bun:test";
import {
  INCIDENT_STATES,
  SIGNAL_STATES,
  isIncidentState,
  isOpenIncident,
  isSignalState,
  isTerminalIncidentState,
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
