import { describe, expect, test } from "bun:test";
import type { IncidentState } from "../../shared/incidents";
import {
  type PrReadinessSource,
  assessPrMergeReadiness,
} from "../pr-merge-readiness";
import {
  type ConditionDeps,
  type ConditionPr,
  type LeadCondition,
  checkCondition,
  conditionDepsWith,
  describeCondition,
} from "./conditions";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

function pr(over: Partial<ConditionPr> = {}): ConditionPr {
  return {
    state: "OPEN",
    headSha: SHA,
    checks: [
      { name: "test", outcome: "passing", required: true },
      { name: "lint", outcome: "passing", required: true },
      { name: "preview", outcome: "failing", required: false },
    ],
    missingRequired: [],
    rulesReadable: true,
    ...over,
  };
}

function deps(
  read: ConditionPr | Error,
  incident: IncidentState | null | Error = "investigating",
): ConditionDeps {
  return {
    readPr: async () => {
      if (read instanceof Error) throw read;
      return read;
    },
    incidentState: async () => {
      if (incident instanceof Error) throw incident;
      return incident;
    },
  };
}

const merged: LeadCondition = {
  kind: "pr-merged",
  ghRepo: "acme/app",
  number: 556,
};
const green: LeadCondition = {
  kind: "checks-green",
  ghRepo: "acme/app",
  number: 556,
  headSha: SHA,
};
const resolved: LeadCondition = { kind: "incident-resolved", id: "inc_1" };

describe("pr-merged", () => {
  test("met when the PR is merged", async () => {
    expect(await checkCondition(merged, deps(pr({ state: "MERGED" })))).toEqual(
      { status: "met" },
    );
  });

  test("not met while open or after closing", async () => {
    expect(await checkCondition(merged, deps(pr()))).toEqual({
      status: "not-met",
      reason: "PR #556 in acme/app is not merged yet",
    });
    expect(await checkCondition(merged, deps(pr({ state: "CLOSED" })))).toEqual(
      {
        status: "not-met",
        reason: "PR #556 in acme/app was closed without merging",
      },
    );
  });

  test("an API error is unknown, never met", async () => {
    expect(
      await checkCondition(merged, deps(new Error("API rate limit exceeded"))),
    ).toEqual({ status: "unknown", reason: "API rate limit exceeded" });
  });
});

describe("checks-green", () => {
  test("met when every required check passed at the pinned head", async () => {
    expect(await checkCondition(green, deps(pr()))).toEqual({ status: "met" });
  });

  test("not met once the head moved", async () => {
    expect(
      await checkCondition(green, deps(pr({ headSha: OTHER_SHA }))),
    ).toEqual({
      status: "not-met",
      reason: "PR #556 in acme/app has new commits since it was approved",
    });
  });

  test("pending and missing required checks are not met", async () => {
    const running = pr({
      checks: [
        { name: "test", outcome: "pending", required: true },
        { name: "lint", outcome: "passing", required: true },
      ],
      missingRequired: ["deploy"],
    });
    expect(await checkCondition(green, deps(running))).toEqual({
      status: "not-met",
      reason: "Checks still running on PR #556 in acme/app: test, deploy",
    });
  });

  test("a failed required check is not met and named", async () => {
    const failed = pr({
      checks: [
        { name: "test", outcome: "failing", required: true },
        { name: "lint", outcome: "pending", required: true },
      ],
    });
    expect(await checkCondition(green, deps(failed))).toEqual({
      status: "not-met",
      reason: "Checks failed on PR #556 in acme/app: test",
    });
  });

  test("without readable rules every check that ran counts", async () => {
    expect(
      await checkCondition(green, deps(pr({ rulesReadable: false }))),
    ).toEqual({
      status: "not-met",
      reason: "Checks failed on PR #556 in acme/app: preview",
    });
  });

  test("no checks at all is not met", async () => {
    expect(await checkCondition(green, deps(pr({ checks: [] })))).toEqual({
      status: "not-met",
      reason: "No checks have run on PR #556 in acme/app",
    });
  });

  test("skipped or neutral required checks count as satisfied", async () => {
    const mixed = pr({
      checks: [
        { name: "test", outcome: "passing", required: true },
        { name: "deploy", outcome: "skipped", required: true },
      ],
    });
    expect(await checkCondition(green, deps(mixed))).toEqual({ status: "met" });
  });

  test("all required checks skipped or neutral is met", async () => {
    const skipped = pr({
      checks: [
        { name: "test", outcome: "skipped", required: true },
        { name: "lint", outcome: "skipped", required: true },
        { name: "preview", outcome: "failing", required: false },
      ],
    });
    expect(await checkCondition(green, deps(skipped))).toEqual({
      status: "met",
    });
  });

  test("an empty pinned head is not met", async () => {
    expect(
      await checkCondition(
        { ...green, headSha: "" },
        deps(pr({ headSha: "" })),
      ),
    ).toEqual({
      status: "not-met",
      reason: "No commit is pinned for PR #556 in acme/app",
    });
  });

  test("a closed PR is not met", async () => {
    expect(await checkCondition(green, deps(pr({ state: "CLOSED" })))).toEqual({
      status: "not-met",
      reason: "PR #556 in acme/app is closed",
    });
  });

  test("an API error is unknown", async () => {
    expect(await checkCondition(green, deps(new Error("timeout")))).toEqual({
      status: "unknown",
      reason: "timeout",
    });
  });
});

describe("incident-resolved", () => {
  test("met when resolved", async () => {
    expect(await checkCondition(resolved, deps(pr(), "resolved"))).toEqual({
      status: "met",
    });
  });

  test("not met while open, closed without action or missing", async () => {
    expect(await checkCondition(resolved, deps(pr(), "investigating"))).toEqual(
      { status: "not-met", reason: "Incident inc_1 is still open" },
    );
    expect(
      await checkCondition(resolved, deps(pr(), "closed-without-action")),
    ).toEqual({
      status: "not-met",
      reason: "Incident inc_1 was closed without action",
    });
    expect(await checkCondition(resolved, deps(pr(), null))).toEqual({
      status: "not-met",
      reason: "Incident inc_1 was not found",
    });
  });

  test("a store error is unknown", async () => {
    expect(
      await checkCondition(resolved, deps(pr(), new Error("worker down"))),
    ).toEqual({ status: "unknown", reason: "worker down" });
  });
});

describe("conditionDepsWith", () => {
  const source: PrReadinessSource = {
    repoId: "app",
    ghRepo: "acme/app",
    number: 556,
    title: "Fix",
    url: "https://example.test/pr/556",
    author: "octo",
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    headRefName: "fix",
    headRefOid: SHA,
    mergeable: "UNKNOWN",
    mergeStateStatus: "BLOCKED",
    reviewDecision: "",
    checks: [
      { name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "deploy", status: "COMPLETED", conclusion: "NEUTRAL" },
      { name: "lint", status: "IN_PROGRESS", conclusion: "" },
      { name: "preview", status: "COMPLETED", conclusion: "FAILURE" },
    ],
    latestReviews: [],
    reviewRequests: [],
    rules: {
      requiredChecks: ["test", "deploy", "e2e"],
      requiredApprovals: 0,
      strictUpToDate: false,
    },
  };

  test("maps the verdict to the condition view", async () => {
    const targets: unknown[] = [];
    const d = conditionDepsWith(async (target) => {
      targets.push(target);
      return assessPrMergeReadiness(source);
    });
    const read = await d.readPr("acme/app", 556);
    expect(targets).toEqual([
      { repoId: "acme/app", ghRepo: "acme/app", number: 556 },
    ]);
    expect({
      ...read,
      checks: [...read.checks].sort((a, b) => a.name.localeCompare(b.name)),
    }).toEqual({
      state: "OPEN",
      headSha: SHA,
      checks: [
        { name: "deploy", outcome: "skipped", required: true },
        { name: "lint", outcome: "pending", required: false },
        { name: "preview", outcome: "failing", required: false },
        { name: "test", outcome: "passing", required: true },
      ],
      missingRequired: ["e2e"],
      rulesReadable: true,
    });
  });
});

describe("describeCondition", () => {
  test("fixed owner-facing copy", () => {
    expect(describeCondition(merged)).toBe("PR #556 in acme/app is merged");
    expect(describeCondition(green)).toBe(
      "Checks pass on PR #556 in acme/app at aaaaaaa",
    );
    expect(describeCondition(resolved)).toBe("Incident inc_1 is resolved");
  });
});
