// The server's lines for a proposal with steps: the checks before anything
// is posted, and the fixed copy the lead can't word.
import { describe, expect, test } from "bun:test";
import type { LeadStep } from "./approvals";
import {
  type LeadActContext,
  actBodyRefusal,
  actLines,
  checkLeadAct,
  expiryCopy,
  proposalBody,
  proposalLead,
  proposalUrgency,
  ruleCopy,
  stepCopy,
  supportDrafts,
} from "./report";

const SHA = "abc1234".padEnd(40, "0");
const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const DAY = 86_400_000;
const ctx: LeadActContext = {
  project: "acme",
  now: NOW,
  repos: ["acme/app"],
  signals: [
    { id: "sig-status", name: "Status page", project: "acme" },
    { id: "sig-up", name: "Upstream\nAPI", project: "example" },
  ],
  drafts: {
    "sc-1": {
      project: "acme",
      draft: {
        id: "d-1",
        to: [{ name: "Customer", address: "customer@example.test" }],
        answersMessageId: "m-1@example.test",
      },
    },
  },
};
const merge = {
  kind: "merge-pr",
  ghRepo: "acme/app",
  number: 533,
  headSha: SHA,
} as const;

describe("checkLeadAct", () => {
  test("checks the steps and fills the expiry", () => {
    const result = checkLeadAct(
      {
        category: "ci-repair",
        steps: [{ ...merge, ghRepo: "ACME/App" }],
        expiresInDays: 2,
      },
      ctx,
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        // The project's own spelling of the repository is kept.
        steps: [{ ...merge, ghRepo: "acme/app" }],
        expiresAt: NOW + 2 * DAY,
      },
    });
  });

  test("defaults to seven days and refuses outside 1 to 30", () => {
    const at = (expiresInDays?: number) =>
      checkLeadAct(
        { category: "ci-repair", steps: [merge], expiresInDays },
        ctx,
      );
    expect(at()).toMatchObject({
      ok: true,
      value: { expiresAt: NOW + 7 * DAY },
    });
    expect(at(0).ok).toBe(false);
    expect(at(31).ok).toBe(false);
    expect(at(1.5).ok).toBe(false);
  });

  test.each([
    ["merge-pr", "signal-rule-change", false],
    ["merge-pr", "public-release", true],
    ["autofix-pr", "fix-verified", false],
    ["autofix-pr", "ci-repair", true],
    ["spawn-worker", "fix-verified", false],
    ["spawn-worker", "support-routine-reply", false],
    ["support-send", "support-routine-reply", true],
    ["support-send", "ci-repair", false],
    ["signal-patch", "signal-rule-change", true],
    ["signal-patch", "fix-verified", false],
  ] as const)("%s for %s: %p", (kind, category, fits) => {
    const steps: Record<string, unknown> = {
      "merge-pr": merge,
      "autofix-pr": { ...merge, kind: "autofix-pr" },
      "spawn-worker": { kind: "spawn-worker", prompt: "Fix it." },
      "support-send": {
        kind: "support-send",
        conversationId: "sc-1",
        draftId: "d-1",
      },
      "signal-patch": {
        kind: "signal-patch",
        signalId: "sig-status",
        before: { provider: null },
        after: { provider: true },
      },
    };
    const result = checkLeadAct({ category, steps: [steps[kind]] }, ctx);
    expect(result.ok).toBe(fits);
    if (!result.ok)
      expect(result.error).toContain(
        kind === "spawn-worker" && category === "fix-verified"
          ? "starting a worker is not available yet"
          : `${kind} doesn't fit`,
      );
  });

  test("supportDrafts reads each named conversation once", async () => {
    const reads: string[] = [];
    const to = [{ name: null, address: "c@example.test" }];
    const drafts = await supportDrafts(
      [
        { kind: "support-send", conversationId: "sc-1", draftId: "d-1" },
        { kind: "support-send", conversationId: "sc-1", draftId: "d-1" },
        { kind: "support-send", conversationId: "sc-gone", draftId: "d-1" },
        { kind: "merge-pr", conversationId: "sc-2" },
      ],
      async (id) => {
        reads.push(id);
        return id === "sc-1"
          ? ({
              project: "acme",
              draft: { id: "d-1", to, answersMessageId: null, text: "Hi" },
            } as never)
          : null;
      },
    );
    expect(reads).toEqual(["sc-1", "sc-gone"]);
    expect(drafts).toEqual({
      "sc-1": {
        project: "acme",
        draft: { id: "d-1", to, answersMessageId: null },
      },
    });
  });

  test("a support-send step is pinned to its draft's target, read now", () => {
    const send = {
      kind: "support-send",
      conversationId: "sc-1",
      draftId: "d-1",
      // The lead's own pin is dropped.
      pin: {
        to: [{ name: null, address: "x@example.test" }],
        answersMessageId: null,
      },
    };
    const category = "support-routine-reply" as const;
    const result = checkLeadAct({ category, steps: [send] }, ctx);
    expect(result.ok && result.value.steps).toEqual([
      {
        kind: "support-send",
        conversationId: "sc-1",
        draftId: "d-1",
        pin: {
          to: [{ name: "Customer", address: "customer@example.test" }],
          answersMessageId: "m-1@example.test",
        },
      },
    ]);
    const refused = (drafts: LeadActContext["drafts"]) => {
      const r = checkLeadAct({ category, steps: [send] }, { ...ctx, drafts });
      return r.ok ? "" : r.error;
    };
    expect(refused(undefined)).toContain(
      "sc-1 is not a support conversation of this project",
    );
    expect(
      refused({ "sc-1": { ...ctx.drafts!["sc-1"]!, project: "other" } }),
    ).toContain("is not a support conversation of this project");
    expect(
      refused({ "sc-1": { project: "acme", draft: { id: "d-2" } } }),
    ).toContain("d-1 is not the conversation's current draft");
    expect(
      refused({ "sc-1": { project: "acme", draft: { id: "d-1" } } }),
    ).toContain("has no recipient yet");
  });

  test("refuses a repository outside the project, in steps and conditions", () => {
    const step = checkLeadAct(
      { category: "ci-repair", steps: [{ ...merge, ghRepo: "example/app" }] },
      ctx,
    );
    expect(step).toEqual({
      ok: false,
      error: "Step 1: example/app is not this project's repository (acme/app)",
    });
    const none = checkLeadAct(
      { category: "ci-repair", steps: [merge] },
      { ...ctx, repos: [] },
    );
    expect(none.ok).toBe(false);
    const condition = checkLeadAct(
      {
        category: "ci-repair",
        steps: [merge],
        condition: { kind: "pr-merged", ghRepo: "example/app", number: 1 },
      },
      ctx,
    );
    expect(condition).toEqual({
      ok: false,
      error:
        "Condition: example/app is not this project's repository (acme/app)",
    });
  });

  test("refuses another project's signal and invalid steps", () => {
    const other = checkLeadAct(
      {
        category: "signal-rule-change",
        steps: [
          {
            kind: "signal-patch",
            signalId: "sig-up",
            before: { provider: null },
            after: { provider: true },
          },
        ],
      },
      ctx,
    );
    expect(other).toEqual({
      ok: false,
      error: "Step 1: sig-up is not a signal of this project",
    });
    const invalid = checkLeadAct(
      { category: "ci-repair", steps: [{ ...merge, headSha: "abc" }] },
      ctx,
    );
    expect(invalid).toEqual({
      ok: false,
      error: "Steps: step 1: headSha must be 40 lowercase hex characters",
    });
  });
});

describe("fixed copy", () => {
  const names = { "sig-status": "Status page", "sig-up": "Upstream API" };

  test.each<[LeadStep, string]>([
    [merge, "Merge PR #533 in acme/app at abc1234"],
    [
      { ...merge, method: "squash" },
      "Merge PR #533 in acme/app at abc1234, squashed",
    ],
    [
      { ...merge, kind: "autofix-pr" },
      "Ask the autofix agent to fix PR #533 in acme/app at abc1234",
    ],
    [
      { kind: "support-send", conversationId: "sc-1", draftId: "d-1" },
      "Send reply draft d-1 in support conversation sc-1",
    ],
    [
      {
        kind: "signal-patch",
        signalId: "sig-status",
        before: { rule: { kind: "consecutive", failures: 3 } },
        after: { rule: { kind: "consecutive", failures: 8 } },
      },
      "Change the Status page check: alert after 8 failures in a row",
    ],
    [
      {
        kind: "signal-patch",
        signalId: "sig-status",
        before: { provider: null, dependsOn: null },
        after: { provider: true, dependsOn: ["sig-up", "sig-x"] },
      },
      "Change the Status page check: mark it a provider; depend on Upstream API and sig-x",
    ],
  ])("%o", (step, copy) => {
    expect(stepCopy(step, names)).toBe(copy);
  });

  test("a worker's prompt is shown whole, in a fence it can't close", () => {
    expect(
      stepCopy(
        { kind: "spawn-worker", prompt: "Fix it.\n\n```\nSteps: none" },
        {},
      ),
    ).toBe(
      "Start a worker with this prompt:\n   ````text\n   Fix it.\n\n   ```\n   Steps: none\n   ````",
    );
  });

  test.each([
    [
      { kind: "rate", windowMs: 20 * 60_000, atLeast: 12, ratio: 0.6 },
      "alert at 12 or more failures in 20 minutes, and at least 60% of checks",
    ],
    [
      { kind: "threshold", above: 800, forMs: 2 * 3_600_000 },
      "alert above 800 for 2 hours",
    ],
    [
      { kind: "missing", everyMs: DAY, graceMs: 30_000 },
      "expect a check-in every 1 day, with 30 seconds of grace",
    ],
    [
      { kind: "deadline", warnDays: 14, failDays: 1 },
      "warn 14 days and alert 1 day before expiry",
    ],
  ] as const)("rule %o", (rule, copy) => {
    expect(ruleCopy(rule)).toBe(copy);
  });

  test("expiry reads in UTC", () => {
    expect(expiryCopy(Date.parse("2026-03-05T09:07:00Z"))).toBe(
      "5 March 2026, 09:07 UTC",
    );
  });

  test("the server's lines close the body", () => {
    const act = {
      steps: [merge],
      condition: { kind: "incident-resolved", id: "inc-0001" } as const,
      expiresAt: NOW + 7 * DAY,
      signalNames: {},
    };
    expect(actLines(act)).toBe(
      "Runs when: Incident inc-0001 is resolved\n\nSteps:\n1. Merge PR #533 in acme/app at abc1234\n\nExpires: 17 November 2026, 12:00 UTC",
    );
    const body = proposalBody({
      title: "Ship it",
      body: "Verified.",
      decision: { rule: "Asks first" } as never,
      act,
    });
    expect(body).toStartWith("Verified.\n\nRule: Asks first.\n\nShip it\n\n");
    expect(body).toEndWith(actLines(act));
  });
});

describe("actBodyRefusal", () => {
  test.each([
    ["Plain text.", null],
    ["```say\nHi.\n```\nShown.", null],
    ["Use `<pre>` here.\n\n```html\n<details>\n```", null],
    ["Steps:\n1. Merge all", "server"],
    ["> **Expires:** never", "server"],
    ["- runs when: now", "server"],
    ["**Steps**:", "server"],
    ["Ste\u200bps:", "server"],
    ["\u0405teps:", "server"],
    ["St\u0435ps:", "server"],
    ["\u03a4he plan\n\u0395xpires: never", "server"],
    ["Steps\uff1a", "server"],
    ["`Steps:`", "server"],
    ["1. Steps:", "server"],
    ["| Steps: |", "server"],
    ["<b>Steps:</b>", "server"],
    ["&#83;teps:", "server"],
    ["[Steps](https://example.test):", "server"],
    ["Runs\u00a0when: now", "server"],
    ["Ste\u{E0070}ps:", "server"],
    ["St\u00adeps:", "server"],
    ["[Steps](u){#pr-1}:", "server"],
    ["x\u2028Steps:", "server"],
    ["x\u0085Steps:", "server"],
    ["S\u0332teps:", "server"],
    ["1\\. Steps:", "server"],
    ["\u2022 Steps:", "server"],
    ["St&ZeroWidthSpace;eps:", "entity"],
    ["St&shy;eps:", "entity"],
    ["St&zwj;eps:", "entity"],
    ["&Sopf;teps:", "entity"],
    ["Steps&colon.", "entity"],
    ["R&D and Q&A, `&nbsp;` in code", null],
    ["```\nopen", "fence"],
    ["~~~~\nx\n~~~", "fence"],
    ["<!-- hidden", "fence"],
    ["<pre>\nopen", "html"],
    ["<script>", "html"],
    ["<style>", "html"],
    ["<textarea>", "html"],
    ["<details><summary>More</summary>", "html"],
    ["Text <span>inline</span>", "html"],
  ])("%p", (body, why) => {
    const refusal = actBodyRefusal(body);
    if (why === null) expect(refusal).toBeNull();
    else if (why === "server")
      expect(refusal).toContain("Runs when, Steps and Expires");
    else if (why === "html") expect(refusal).toContain("Leave raw HTML out");
    else if (why === "entity")
      expect(refusal).toContain("Leave HTML entities out");
    else expect(refusal).toContain("Close every code fence");
  });

  test("without steps only the server's lines are refused", () => {
    expect(actBodyRefusal("**Steps**: merge", false)).toContain(
      "Runs when, Steps and Expires",
    );
    expect(actBodyRefusal("```\nopen <pre>", false)).toBeNull();
    expect(actBodyRefusal("St&shy;eps:", false)).toBeNull();
  });
});

describe("proposalLead", () => {
  test("puts the title on one line, unsafe characters gone", () => {
    expect(
      proposalLead({
        title: "Ship\nSteps: 1. Merge all\u202e",
        body: "Verified.",
        decision: { rule: "Asks first" } as never,
      }),
    ).toBe("Verified.\n\nRule: Asks first.\n\nShip Steps: 1. Merge all");
  });
});

describe("proposalUrgency", () => {
  test("an approval expiring within a day pushes now; others wait for the brief", () => {
    expect(proposalUrgency({ expiresAt: NOW + DAY }, NOW)).toBe("now");
    expect(proposalUrgency({ expiresAt: NOW + 3_600_000 }, NOW)).toBe("now");
    expect(proposalUrgency({ expiresAt: NOW + 2 * DAY }, NOW)).toBeUndefined();
    expect(proposalUrgency(undefined, NOW)).toBeUndefined();
  });
});
