// The structured `act` of a lead's item: built from the recorded proposal,
// matched to the item's revision, with the body's server lines as an exact
// suffix, and one approvals read per project.
import { describe, expect, test } from "bun:test";
import type { SupervisorItem } from "../supervisor-inbox";
import type { LeadRecord } from "./approvals";
import { itemAct, recordForItem, withItemActs } from "./item-acts";
import { actLines, proposalBody } from "./report";

const SHA = "abc1234".padEnd(40, "0");
const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const DAY = 86_400_000;
const EXPIRES = NOW + 7 * DAY;

const merge = {
  kind: "merge-pr",
  ghRepo: "acme/app",
  number: 533,
  headSha: SHA,
  method: "squash",
} as const;
const patch = {
  kind: "signal-patch",
  signalId: "sig-status",
  before: { rule: { kind: "consecutive", failures: 3 } },
  after: { rule: { kind: "consecutive", failures: 8 } },
} as const;
const merged = { kind: "pr-merged", ghRepo: "acme/app", number: 556 } as const;

function record(
  overrides: Partial<LeadRecord["proposal"]> = {},
  approval?: Partial<NonNullable<LeadRecord["approval"]>>,
): LeadRecord {
  const proposal: LeadRecord["proposal"] = {
    id: "lp-1",
    project: "acme",
    category: "fix-verified",
    subject: "PR 533",
    itemId: "si-1",
    itemRevision: NOW,
    steps: [merge],
    condition: merged,
    expiresAt: EXPIRES,
    createdAt: NOW,
    ...overrides,
  };
  return approval
    ? {
        proposal,
        approval: {
          proposalId: proposal.id,
          approvedBy: "Ada",
          login: "ada",
          at: NOW + 1000,
          condition: proposal.condition,
          expiresAt: EXPIRES,
          state: "waiting",
          updatedAt: NOW + 1000,
          ...approval,
        },
      }
    : { proposal };
}

const lead = "Merge it once the fix lands.\n\nRule: test.";

function item(overrides: Partial<SupervisorItem> = {}): SupervisorItem {
  const r = record();
  return {
    id: "si-1",
    user: "Ada",
    project: "acme",
    source: "lead:acme",
    kind: "needs-you",
    title: "acme: Merge a verified fix",
    body: `${lead}\n\n${actLines({
      steps: r.proposal.steps,
      condition: merged,
      expiresAt: EXPIRES,
      signalNames: {},
    })}`,
    options: ["Approve", "Not now"],
    createdAt: NOW,
    updatedAt: NOW,
    state: "open",
    ...overrides,
  };
}

describe("recordForItem", () => {
  test("an open item takes the unapproved proposal at its revision", () => {
    expect(recordForItem(item(), [record()])).toBeDefined();
    expect(
      recordForItem(item({ updatedAt: NOW + 5 }), [record()]),
    ).toBeUndefined();
  });

  test("voided and other items' proposals never count", () => {
    expect(
      recordForItem(item(), [record({ voidedAt: NOW, voidReason: "x" })]),
    ).toBeUndefined();
    expect(recordForItem(item(), [record({ itemId: "si-2" })])).toBe(undefined);
  });

  test("only the newest proposal for the item counts", () => {
    const older = record({ id: "lp-0" });
    const newer = record({ voidedAt: NOW, voidReason: "expired" });
    expect(recordForItem(item(), [newer, older])).toBeUndefined();
  });

  test("a closed item takes its approved proposal, never a void one", () => {
    const answered = item({ state: "answered", updatedAt: NOW + 1000 });
    expect(recordForItem(answered, [record()])).toBeUndefined();
    expect(recordForItem(answered, [record({}, {})])).toBeDefined();
    expect(
      recordForItem(answered, [record({}, { state: "void" })]),
    ).toBeUndefined();
  });

  test("an open item reopened after an approval shows nothing old", () => {
    expect(
      recordForItem(item({ updatedAt: NOW + 9 }), [
        record({}, { state: "applied" }),
      ]),
    ).toBeUndefined();
  });
});

describe("itemAct", () => {
  test("steps, condition and expiry in the body's copy, and the suffix", () => {
    const act = itemAct(item(), record(), {});
    expect(act).toEqual({
      steps: ["Merge PR #533 in acme/app at abc1234, squashed"],
      runsWhen: "PR #556 in acme/app is merged",
      expiresAt: EXPIRES,
      state: "proposed",
      bodySuffix: item().body.slice(lead.length),
    });
    expect(item().body.slice(0, -act.bodySuffix!.length)).toBe(lead);
  });

  test("the suffix matches the body report.ts writes", () => {
    const r = record({ steps: [merge, patch], condition: undefined });
    const body = proposalBody({
      title: "Raise the check",
      body: "Raise it to 8.",
      decision: { rule: "test" } as never,
      act: {
        steps: r.proposal.steps,
        expiresAt: EXPIRES,
        signalNames: { "sig-status": "Status page" },
      },
    });
    const act = itemAct(item({ body }), r, { "sig-status": "Status page" });
    expect(act.steps[1]).toBe(
      "Change the Status page check: alert after 8 failures in a row",
    );
    expect(act.runsWhen).toBeUndefined();
    expect(body.endsWith(act.bodySuffix!)).toBe(true);
    expect(body.slice(0, -act.bodySuffix!.length)).not.toContain("Steps:");
  });

  test("no suffix when the body doesn't end with the server's lines", () => {
    const act = itemAct(item({ body: `${item().body}\n\nMore` }), record(), {});
    expect(act.bodySuffix).toBeUndefined();
    // A renamed signal changes the copy, so the old body no longer matches.
    const r = record({ steps: [patch] });
    const body = `x\n\n${actLines({
      steps: [patch],
      condition: merged,
      expiresAt: EXPIRES,
      signalNames: { "sig-status": "Old name" },
    })}`;
    expect(
      itemAct(item({ body }), r, { "sig-status": "New" }).bodySuffix,
    ).toBeUndefined();
  });

  test("an approval shows its state and its own expiry", () => {
    const answered = item({ state: "answered", updatedAt: NOW + 1000 });
    const cases = [
      ["waiting", "Waiting for PR #556 in acme/app to merge"],
      ["ready", "Ready to apply"],
      ["applying", "Applying"],
      ["applied", "Applied"],
      ["failed", "Failed"],
      ["partial", "Partly applied"],
    ] as const;
    for (const [state, line] of cases) {
      const act = itemAct(
        answered,
        record({}, { state, expiresAt: EXPIRES - DAY }),
        {},
      );
      expect(act.state).toBe(state);
      expect(act.stateLine).toBe(line);
      expect(act.expiresAt).toBe(EXPIRES - DAY);
    }
    const checks = itemAct(
      answered,
      record(
        {
          condition: {
            kind: "checks-green",
            ghRepo: "acme/app",
            number: 533,
            headSha: SHA,
          },
        },
        {
          condition: {
            kind: "checks-green",
            ghRepo: "acme/app",
            number: 533,
            headSha: SHA,
          },
        },
      ),
      {},
    );
    expect(checks.stateLine).toBe(
      "Waiting for checks to pass on PR #533 in acme/app at abc1234",
    );
  });
});

describe("withItemActs", () => {
  test("every item carries its revision; lead items their act", async () => {
    const reads: string[] = [];
    let signalReads = 0;
    const items = [
      item(),
      item({ id: "si-2", body: "no steps", updatedAt: NOW + 1 }),
      item({ id: "si-3", source: "supervisor", project: undefined }),
      item({ id: "si-4", source: "lead:other", kind: "fyi" }),
      item({ id: "si-5", source: "lead:beta", project: "beta" }),
    ];
    const shown = await withItemActs(items, {
      async listForProject(project) {
        reads.push(project);
        return project === "acme"
          ? [record(), record({ id: "lp-2", itemId: "si-2" })]
          : [];
      },
      async listSignals() {
        signalReads++;
        return [];
      },
    });
    expect(reads.sort()).toEqual(["acme", "beta"]);
    expect(signalReads).toBe(0);
    expect(shown.map((i) => i.revision)).toEqual(items.map((i) => i.updatedAt));
    expect(shown[0]!.act?.state).toBe("proposed");
    // si-2's proposal was recorded at another revision.
    expect(shown.slice(1).every((i) => i.act === undefined)).toBe(true);
  });

  test("signals are read once, only for a signal step", async () => {
    let signalReads = 0;
    const r = record({ steps: [patch] });
    const shown = await withItemActs([item(), item({ id: "si-9" })], {
      async listForProject() {
        return [r, record({ id: "lp-9", itemId: "si-9", steps: [patch] })];
      },
      async listSignals() {
        signalReads++;
        return [{ id: "sig-status", name: "Status page" }];
      },
    });
    expect(signalReads).toBe(1);
    expect(shown[0]!.act?.steps[0]).toStartWith("Change the Status page check");
  });

  test("a project that can't be read leaves its items without act", async () => {
    const shown = await withItemActs([item()], {
      async listForProject() {
        throw new Error("catalog down");
      },
      async listSignals() {
        return [];
      },
    });
    expect(shown[0]!.act).toBeUndefined();
    expect(shown[0]!.revision).toBe(NOW);
  });
});
