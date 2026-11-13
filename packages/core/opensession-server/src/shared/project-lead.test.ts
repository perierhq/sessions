import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LEAD_RULES,
  LEAD_CATEGORIES,
  LEAD_STAGES,
  PINNED_ONLY_YOU,
  type LeadCategory,
  type LeadDecisionSettings,
  type LeadLevel,
  defaultLeadSettings,
  leadDecision,
  leadLevel,
  leadLevelWithin,
  leadStageWithin,
} from "./project-lead";

function settings(
  over: Partial<LeadDecisionSettings> = {},
): LeadDecisionSettings {
  return { ...defaultLeadSettings(), enabled: true, ...over };
}

const ALONE: LeadCategory[] = [
  "fix-verified",
  "ci-repair",
  "support-routine-reply",
];
const ASKS_FIRST: LeadCategory[] = [
  "signal-rule-change",
  "dependency-major",
  "ban-user",
  "rotate-key",
  "public-release",
  // Maintaining a public repository: each speaks or acts in public, and
  // contributor-ci runs an outside contributor's code in CI.
  "issue-triage",
  "contributor-ci",
  "pr-merge",
  "pr-close",
];

describe("the defaults", () => {
  test("match the ADR, the lead off and watching", () => {
    expect(defaultLeadSettings()).toEqual({
      enabled: false,
      stage: "watch",
      rules: { ...DEFAULT_LEAD_RULES },
      budgetUsdPerMonth: null,
      dailyWakeLimit: 24,
      wakeTokenLimit: 1_000_000,
    });
    const by = (level: LeadLevel) =>
      LEAD_CATEGORIES.filter((c) => DEFAULT_LEAD_RULES[c] === level);
    expect(by("alone")).toEqual(ALONE);
    expect(by("asks-first")).toEqual(ASKS_FIRST);
    expect(by("only-you")).toEqual([...PINNED_ONLY_YOU]);
  });

  test("every category has a default", () => {
    expect(Object.keys(DEFAULT_LEAD_RULES).sort()).toEqual(
      [...LEAD_CATEGORIES].sort(),
    );
  });
});

describe("leadDecision", () => {
  test("watch makes every alone action a proposal", () => {
    for (const c of ALONE)
      expect(leadDecision(settings(), c)).toEqual({
        level: "alone",
        effective: "ask",
        rule: "Watch: every action is a proposal, from the project settings",
      });
  });

  test("coordinate acts only for workers and pull requests", () => {
    const s = settings({ stage: "coordinate" });
    expect(leadDecision(s, "fix-verified")).toEqual({
      level: "alone",
      effective: "act",
      rule: "Coordinate: Fixes verified by a second agent as a worker and a pull request; merging stays with the existing loops, from the project settings",
    });
    expect(leadDecision(s, "ci-repair").effective).toBe("act");
    expect(leadDecision(s, "support-routine-reply")).toEqual({
      level: "alone",
      effective: "ask",
      rule: "Coordinate: only workers and pull requests run alone, from the project settings",
    });
  });

  test("act follows the rules", () => {
    const s = settings({ stage: "act" });
    for (const c of ALONE)
      expect(leadDecision(s, c)).toMatchObject({
        level: "alone",
        effective: "act",
      });
    expect(leadDecision(s, "support-routine-reply").rule).toBe(
      "Alone: Routine support replies, from the project settings",
    );
  });

  test("asks first asks and only you prepares, at every stage", () => {
    for (const stage of LEAD_STAGES) {
      for (const c of ASKS_FIRST)
        expect(leadDecision(settings({ stage }), c)).toMatchObject({
          level: "asks-first",
          effective: "ask",
        });
      for (const c of PINNED_ONLY_YOU)
        expect(leadDecision(settings({ stage }), c)).toMatchObject({
          level: "only-you",
          effective: "prepare",
        });
    }
    expect(leadDecision(settings(), "rotate-key").rule).toBe(
      "Asks first: Rotating keys, from the project settings",
    );
    expect(leadDecision(settings(), "refund").rule).toBe(
      "Only you: Refunds, always",
    );
  });

  test("a category lowered to alone acts; one raised to only you prepares", () => {
    const s = settings({
      stage: "act",
      rules: {
        ...DEFAULT_LEAD_RULES,
        "dependency-major": "alone",
        "ci-repair": "only-you",
      },
    });
    expect(leadDecision(s, "dependency-major")).toEqual({
      level: "alone",
      effective: "act",
      rule: "Alone: Major dependency upgrades, from the project settings",
    });
    expect(leadDecision(s, "ci-repair")).toEqual({
      level: "only-you",
      effective: "prepare",
      rule: "Only you: CI repair, from the project settings",
    });
  });

  test("pinned categories stay only you whatever is stored", () => {
    const s = settings({
      stage: "act",
      rules: { ...DEFAULT_LEAD_RULES, refund: "alone", contract: "asks-first" },
    });
    expect(leadDecision(s, "refund").effective).toBe("prepare");
    expect(leadDecision(s, "contract").effective).toBe("prepare");
    expect(leadLevel(s.rules, "refund")).toBe("only-you");
  });

  test("a missing or unknown stored level reads as the default", () => {
    const rules = { "ci-repair": "sometimes" } as unknown as Partial<
      Record<LeadCategory, LeadLevel>
    >;
    expect(leadLevel(rules, "ci-repair")).toBe("alone");
    expect(leadLevel({}, "ban-user")).toBe("asks-first");
  });

  test("the kill switch and a lead that is off make alone a proposal", () => {
    const paused = settings({ stage: "act", agentsPaused: true });
    expect(leadDecision(paused, "ci-repair")).toEqual({
      level: "alone",
      effective: "ask",
      rule: "Kill switch, from the project settings",
    });
    expect(leadDecision(paused, "refund").effective).toBe("prepare");
    const off = settings({ stage: "act", enabled: false });
    expect(leadDecision(off, "ci-repair")).toEqual({
      level: "alone",
      effective: "ask",
      rule: "Lead off, from the project settings",
    });
  });

  test("every decision names its rule", () => {
    for (const stage of LEAD_STAGES)
      for (const c of LEAD_CATEGORIES)
        for (const s of [
          settings({ stage }),
          settings({ stage, agentsPaused: true }),
          settings({ stage, enabled: false }),
        ])
          expect(leadDecision(s, c).rule.length).toBeGreaterThan(10);
  });
});

describe("maintenance categories", () => {
  const MAINTENANCE: LeadCategory[] = [
    "issue-triage",
    "contributor-ci",
    "pr-merge",
    "pr-close",
  ];

  test("ask first at every stage by default, and are never pinned", () => {
    for (const category of MAINTENANCE) {
      expect(PINNED_ONLY_YOU as readonly string[]).not.toContain(category);
      for (const stage of LEAD_STAGES)
        expect(leadDecision(settings({ stage }), category).effective).toBe(
          "ask",
        );
    }
  });

  test("the owner may let them run alone at the act stage, never at coordinate", () => {
    const rules = Object.fromEntries(
      MAINTENANCE.map((c) => [c, "alone"]),
    ) as Partial<Record<LeadCategory, LeadLevel>>;
    for (const category of MAINTENANCE) {
      expect(
        leadDecision(settings({ stage: "act", rules }), category).effective,
      ).toBe("act");
      expect(
        leadDecision(settings({ stage: "coordinate", rules }), category)
          .effective,
      ).toBe("ask");
    }
  });
});

describe("ordering", () => {
  test("levels from most room to least", () => {
    expect(leadLevelWithin("only-you", "alone")).toBe(true);
    expect(leadLevelWithin("asks-first", "asks-first")).toBe(true);
    expect(leadLevelWithin("alone", "asks-first")).toBe(false);
  });

  test("stages from least room to most", () => {
    expect(leadStageWithin("watch", "act")).toBe(true);
    expect(leadStageWithin("act", "coordinate")).toBe(false);
  });
});
