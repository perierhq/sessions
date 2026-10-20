import { expect, test } from "bun:test";
import type {
  IncidentProjectSettings,
  NeverWithoutYou,
} from "../../../shared/incident-response";
import type { Signal, SignalEvaluation } from "../../../shared/incidents";
import {
  FACT_LABELS,
  budgetProblem,
  evaluatePolicy,
  fullyDown,
  nightActive,
} from "./policy";
import { defaultProjectSettings } from "./project-settings";

const S = (
  over: Partial<IncidentProjectSettings> = {},
): IncidentProjectSettings => ({
  ...defaultProjectSettings("acme"),
  ...over,
});
const at = (iso: string) => Date.parse(iso);
const NOON = at("2026-10-20T10:00:00Z"); // 12:00 in Warsaw
const NIGHT = at("2026-10-20T23:30:00Z"); // 01:30 in Warsaw
const night = { start: "23:00", end: "07:00", timeZone: "Europe/Warsaw" };
const httpPrimary: Pick<Signal, "source" | "rule" | "intervalMs"> = {
  source: { kind: "http", url: "https://acme.example.test/health" },
  rule: { kind: "consecutive", failures: 3 },
};
const ev = (
  facts: NeverWithoutYou[] = [],
  over: Partial<Parameters<typeof evaluatePolicy>[0]> = {},
) =>
  evaluatePolicy({
    settings: S(),
    facts: new Set(facts),
    independence: "other-provider",
    now: NOON,
    fullyDown: false,
    ...over,
  });

test("default: deploy after the veto window", () => {
  expect(ev()).toEqual({
    kind: "act",
    after: "veto",
    vetoMs: 600_000,
    rule: "Deploy after veto, from the project settings",
  });
});
test("a spend spike: pausing a worker acts, raising a budget asks", () => {
  expect(ev([]).kind).toBe("act");
  expect(ev(["costs-money"])).toEqual({
    kind: "ask",
    reason: "This change costs money, so it needs you",
    rule: "Never without you: costs money, from the project settings",
  });
  expect(
    ev(["needs-secret", "costs-money"]).kind === "ask" &&
      ev(["needs-secret", "costs-money"]),
  ).toMatchObject({
    reason: "This change costs money and needs a secret, so it needs you",
  });
  expect(
    evaluatePolicy({
      settings: S({ neverWithoutYou: [] }),
      facts: new Set(["costs-money"]),
      independence: "other-provider",
      now: NOON,
      fullyDown: false,
    }).kind,
  ).toBe("act");
});
test("three labels read as a list", () => {
  expect(ev(["migration", "costs-money", "outside-scope"])).toMatchObject({
    reason:
      "This change costs money, runs a migration and goes outside its scope, so it needs you",
    rule: "Never without you: costs money, runs a migration and goes outside its scope, from the project settings",
  });
  expect(FACT_LABELS["not-reversible"]).toBe("can't be undone");
});
test("kill switch, watch, propose, right away, same model", () => {
  expect(
    evaluatePolicy({
      settings: S({ agentsPaused: true }),
      facts: new Set(),
      independence: "other-provider",
      now: NOON,
      fullyDown: false,
    }),
  ).toEqual({
    kind: "ask",
    reason: "Agents are paused for acme",
    rule: "Kill switch, from the project settings",
  });
  expect(ev([], { settings: S({ autonomy: "watch" }) })).toEqual({
    kind: "watch",
    rule: "Watch, from the project settings",
  });
  expect(ev([], { settings: S({ autonomy: "propose" }) })).toEqual({
    kind: "ask",
    reason: "Verified and ready. Waiting for you",
    rule: "Propose, from the project settings",
  });
  expect(ev([], { settings: S({ autonomy: "deploy-right-away" }) })).toEqual({
    kind: "act",
    after: "now",
    vetoMs: 0,
    rule: "Deploy right away, from the project settings",
  });
  expect(ev([], { independence: "same-model" })).toEqual({
    kind: "ask",
    reason:
      "The verifier ran on the same model as the investigator, so it needs you",
    rule: "Independent verification needs a second model",
  });
});
test("night rule drops to propose unless fully down", () => {
  expect(ev([], { settings: S({ night }), now: NIGHT })).toEqual({
    kind: "ask",
    reason: "Verified and ready. Waiting for you",
    rule: "Night rule: Propose between 23:00 and 07:00, from the project settings",
  });
  expect(
    ev([], { settings: S({ night }), now: NIGHT, fullyDown: true }).kind,
  ).toBe("act");
  expect(ev([], { settings: S({ night }), now: NOON }).kind).toBe("act");
  expect(nightActive(night, NIGHT)).toBe(true);
  expect(nightActive(undefined, NIGHT)).toBe(false);
});
test("fully down needs every own signal failing and three straight failures", () => {
  const evals = new Map([
    ["sig-a", { signalId: "sig-a", state: "failing" } as SignalEvaluation],
  ]);
  const obs = (r: Array<"ok" | "fail">) =>
    r.map((result, i) => ({
      at: new Date(NOON - (r.length - i) * 60_000).toISOString(),
      result,
      detail: "",
    }));
  expect(
    fullyDown({
      ownSignalIds: ["sig-a"],
      evaluations: evals,
      now: NOON,
      primary: httpPrimary,
      primaryRecent: obs(["ok", "fail", "fail", "fail"]),
    }),
  ).toBe(true);
  expect(
    fullyDown({
      ownSignalIds: ["sig-a"],
      evaluations: evals,
      now: NOON,
      primary: httpPrimary,
      primaryRecent: obs(["fail", "ok", "fail"]),
    }),
  ).toBe(false);
  expect(
    fullyDown({
      ownSignalIds: ["sig-a"],
      evaluations: evals,
      now: NOON,
      primary: httpPrimary,
      primaryRecent: obs(["fail", "fail"]),
    }),
  ).toBe(false);
  expect(
    fullyDown({
      ownSignalIds: ["sig-a", "sig-b"],
      evaluations: evals,
      now: NOON,
      primary: httpPrimary,
      primaryRecent: obs(["fail", "fail", "fail"]),
    }),
  ).toBe(true);
  evals.set("sig-b", { signalId: "sig-b", state: "slow" } as SignalEvaluation);
  expect(
    fullyDown({
      ownSignalIds: ["sig-a", "sig-b"],
      evaluations: evals,
      now: NOON,
      primary: httpPrimary,
      primaryRecent: obs(["fail", "fail", "fail"]),
    }),
  ).toBe(false);
});
test("side lanes do not count toward fully down", () => {
  const evals = new Map([
    ["sig-a", { signalId: "sig-a", state: "failing" } as SignalEvaluation],
  ]);
  const recent = [
    { at: "2026-10-20T09:57:00.000Z", result: "fail" as const, detail: "" },
    { at: "2026-10-20T09:58:00.000Z", result: "fail" as const, detail: "" },
    {
      at: "2026-10-20T09:59:00.000Z",
      result: "fail" as const,
      detail: "",
      lane: "eu",
    },
    { at: "2026-10-20T09:59:30.000Z", result: "ok" as const, detail: "" },
  ];
  expect(
    fullyDown({
      ownSignalIds: ["sig-a"],
      evaluations: evals,
      now: NOON,
      primary: httpPrimary,
      primaryRecent: recent,
    }),
  ).toBe(false);
});
test("budgets", () => {
  const budget = { perIncidentUsd: 20, perMonthUsd: 200 };
  expect(
    budgetProblem({ incidentCostUsd: 19.99, monthCostUsd: 50, budget }),
  ).toBeNull();
  expect(
    budgetProblem({ incidentCostUsd: 20, monthCostUsd: 50, budget }),
  ).toEqual({
    scope: "incident",
    reason: "Agents stopped at the $20 budget for this incident",
    rule: "Budget: $20 per incident, from the project settings",
  });
  expect(
    budgetProblem({ incidentCostUsd: 3, monthCostUsd: 200, budget })?.scope,
  ).toBe("month");
  expect(
    budgetProblem({
      incidentCostUsd: 3,
      monthCostUsd: 300,
      budget: { perIncidentUsd: 12.5, perMonthUsd: 250.5 },
    }),
  ).toEqual({
    scope: "month",
    reason: "Agents stopped at the $250.5 monthly budget",
    rule: "Budget: $250.5 per month, from the project settings",
  });
});
test("fully down needs a fresh observation; a missing heartbeat is down", () => {
  const evals = new Map([
    ["sig-a", { signalId: "sig-a", state: "failing" } as SignalEvaluation],
  ]);
  const stale = ["fail", "fail", "fail"].map((result, i) => ({
    at: new Date(NOON - (13 - i) * 60_000).toISOString(),
    result: result as "fail",
    detail: "",
  }));
  expect(
    fullyDown({
      ownSignalIds: ["sig-a"],
      evaluations: evals,
      now: NOON,
      primary: httpPrimary,
      primaryRecent: stale,
    }),
  ).toBe(false);
  const heartbeat: Pick<Signal, "source" | "rule" | "intervalMs"> = {
    source: { kind: "heartbeat" },
    rule: { kind: "missing", everyMs: 3_600_000, graceMs: 0 },
  };
  expect(
    fullyDown({
      ownSignalIds: ["sig-a"],
      evaluations: evals,
      now: NOON,
      primary: heartbeat,
      primaryRecent: [],
    }),
  ).toBe(true);
  // A check-in that reported a failure is not missing: three are needed.
  expect(
    fullyDown({
      ownSignalIds: ["sig-a"],
      evaluations: evals,
      now: NOON,
      primary: heartbeat,
      primaryRecent: [
        {
          at: new Date(NOON - 60_000).toISOString(),
          result: "fail",
          detail: "Exit 1",
        },
      ],
    }),
  ).toBe(false);
});
test("the night rule fails closed when its time zone cannot be resolved", () => {
  expect(
    nightActive(
      { start: "23:00", end: "07:00", timeZone: "Mars/Olympus" },
      NOON,
    ),
  ).toBe(true);
});
test("the kill switch wins over watch", () => {
  expect(
    ev([], { settings: S({ agentsPaused: true, autonomy: "watch" }) }),
  ).toMatchObject({
    kind: "ask",
    rule: "Kill switch, from the project settings",
  });
});
test("both budgets over: the incident cap is named; NaN never passes", () => {
  const budget = { perIncidentUsd: 20, perMonthUsd: 200 };
  expect(
    budgetProblem({ incidentCostUsd: 25, monthCostUsd: 250, budget })?.scope,
  ).toBe("incident");
  expect(
    budgetProblem({ incidentCostUsd: Number.NaN, monthCostUsd: 0, budget })
      ?.scope,
  ).toBe("incident");
  expect(
    budgetProblem({ incidentCostUsd: 0, monthCostUsd: Number.NaN, budget })
      ?.scope,
  ).toBe("month");
});
