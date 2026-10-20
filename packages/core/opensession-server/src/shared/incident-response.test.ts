import { describe, expect, test } from "bun:test";
import {
  ACTION_KINDS,
  ACTION_PLACEHOLDERS,
  ACTION_TEMPLATES,
  AUTONOMY_LEVELS,
  DEFAULT_BUDGET,
  DEFAULT_MAX_ROUNDS,
  DEFAULT_NEVER_WITHOUT_YOU,
  DEFAULT_VETO_MS,
  DEFAULT_WATCH_MS,
  OWNER_DECISIONS,
  describeIndependence,
  describeWorkspace,
  formatVetoRemaining,
} from "./incident-response";

describe("incident response wire types", () => {
  test("defaults are the spec's", () => {
    expect([...AUTONOMY_LEVELS]).toEqual([
      "watch",
      "propose",
      "deploy-after-veto",
      "deploy-right-away",
    ]);
    expect([...ACTION_KINDS]).toEqual([
      "rollback",
      "deploy",
      "pause",
      "run-once",
    ]);
    expect(DEFAULT_NEVER_WITHOUT_YOU).toEqual([
      "costs-money",
      "needs-secret",
      "migration",
      "outside-scope",
    ]);
    expect([DEFAULT_VETO_MS, DEFAULT_WATCH_MS, DEFAULT_MAX_ROUNDS]).toEqual([
      600_000, 600_000, 2,
    ]);
    expect(DEFAULT_BUDGET).toEqual({ perIncidentUsd: 20, perMonthUsd: 200 });
  });
  test("veto countdown is m:ss, rounded up, never negative", () => {
    expect(formatVetoRemaining(600_000)).toBe("10:00");
    expect(formatVetoRemaining(59_001)).toBe("1:00");
    expect(formatVetoRemaining(59_000)).toBe("0:59");
    expect(formatVetoRemaining(1)).toBe("0:01");
    expect(formatVetoRemaining(-5_000)).toBe("0:00");
  });
  test("independence and workspace copy", () => {
    expect(describeIndependence("same-provider")).toBe(
      "Verifier · same provider, different model",
    );
    expect(
      describeWorkspace({ kind: "host", user: "opensession-incident" }),
    ).toBe("Runs on this server, not in a sandbox");
    expect(describeWorkspace({ kind: "sandbox", provider: "daytona" })).toBe(
      "Runs in the daytona sandbox",
    );
  });
  test("decisions include the manual rollback; templates are shared", () => {
    expect(OWNER_DECISIONS).toContain("roll-back");
    expect(ACTION_TEMPLATES["docker-compose"].rollback?.command).toBe(
      "IMAGE_TAG={{previousRef}} docker compose up -d",
    );
    expect([...ACTION_PLACEHOLDERS]).toEqual([
      "ref",
      "previousRef",
      "incident",
      "project",
    ]);
  });
});
