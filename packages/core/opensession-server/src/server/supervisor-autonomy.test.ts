/**
 * Handled alone vs asked you: the events read from the inbox, the brief and
 * the lead approvals, the day's counts, the 14-day answers per lead
 * category, the "let the lead do it alone" decision and the owner's answer
 * to it, which changes the rule only through the project settings' write
 * path. Runs on the in-memory kernel store with a fake clock.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_LEAD_RULES, type LeadCategory } from "../shared/project-lead";
import { useIncidentTestKernel } from "./incidents/testing/kernel-fixture";
import type { LeadRecord } from "./leads/approvals";
import { __setLegacyEnvironmentForTest } from "./projects/legacy";
import {
  __setProjectStoreContextForTest,
  getProjectDocument,
} from "./projects/store";
import {
  AUTONOMY_NO,
  AUTONOMY_SOURCE_PREFIX,
  AUTONOMY_YES,
  PROPOSABLE,
  __setAutonomyDepsForTest,
  askedHistory,
  autonomyCandidates,
  autonomyDay,
  autonomyEvents,
  autonomyLedger,
  autonomyReport,
  handleAutonomyAnswer,
  itemCategory,
  prepareAutonomyProposal,
  proposable,
  type AutonomyLeadProject,
} from "./supervisor-autonomy";
import {
  __resetSupervisorInboxForTest,
  __setSupervisorInboxDepsForTest,
  answerSupervisorItem,
  dismissSupervisorItem,
  dismissSupervisorItems,
  listSupervisorItems,
  onSupervisorAnswer,
  postSupervisorItem,
  readSupervisorBriefView,
  type SupervisorItem,
} from "./supervisor-inbox";

useIncidentTestKernel();

const at = (iso: string) => Date.parse(iso);
const HOUR = 60 * 60 * 1000;
let clock = at("2026-07-10T12:00:00Z");
let records = new Map<string, LeadRecord[]>();
let leads: AutonomyLeadProject[] = [];
let ruleWrites: Array<{
  project: string;
  revision: number;
  category: string;
  login: string;
}> = [];
let audits: Array<Record<string, unknown>> = [];
let restoreInbox: () => void = () => {};
let restoreAutonomy: () => void = () => {};

function lead(
  project: string,
  rules: Partial<typeof DEFAULT_LEAD_RULES> = {},
  enabled = true,
): AutonomyLeadProject {
  return {
    project,
    label: project === "acme" ? "Acme" : project,
    revision: 4,
    lead: { enabled, rules: { ...DEFAULT_LEAD_RULES, ...rules } },
  };
}

beforeEach(() => {
  clock = at("2026-07-10T12:00:00Z");
  records = new Map();
  leads = [lead("acme")];
  ruleWrites = [];
  audits = [];
  restoreInbox = __setSupervisorInboxDepsForTest({
    now: () => clock,
    notify: async () => ({}),
    markDone: async () => {},
    supervisorSessionId: async () => "os-sup-ada",
    rotateSupervisor: async () => {},
    ensureWatch: async () => {},
    checkBlobGithub: async () => {},
    standingAct: async () => false,
    timeZone: () => "UTC",
  });
  restoreAutonomy = __setAutonomyDepsForTest({
    now: () => clock,
    leadProjects: async () => leads,
    records: async (project) => records.get(project) ?? [],
    leadProject: async (project) =>
      leads.find((l) => l.project === project) ?? null,
    leadOwner: async () => "Ada",
    setRule: async (project, revision, category, actor) => {
      ruleWrites.push({ project, revision, category, login: actor.login });
      return { ok: true };
    },
    audit: async (event) => {
      audits.push(event);
    },
  });
});

afterEach(() => {
  restoreAutonomy();
  restoreInbox();
  __resetSupervisorInboxForTest();
});

/** A lead's needs-you item for `category`, as deliverLeadProposal posts it. */
async function asked(
  category: string,
  subject: string,
  project = "acme",
): Promise<SupervisorItem> {
  return (
    await postSupervisorItem({
      user: "Ada",
      source: `lead:${project}`,
      project,
      kind: "needs-you",
      title: `${project}: ${category}`,
      options: ["Approve", "Not now"],
      dedupeKey: `lead:${project}:${category}:${subject}`,
    })
  ).item;
}

function aloneRecord(
  itemId: string,
  category: LeadRecord["proposal"]["category"],
  claimedAt: number,
  autofix = false,
): LeadRecord {
  return {
    proposal: {
      id: `lp-${itemId}`,
      project: "acme",
      category,
      subject: itemId,
      itemId,
      itemRevision: 1,
      steps: autofix
        ? [
            {
              kind: "autofix-pr",
              ghRepo: "acme/web",
              number: 7,
              headSha: "a".repeat(40),
            },
          ]
        : [{ kind: "spawn-worker", prompt: "Fix it" }],
      createdAt: claimedAt - HOUR,
    },
    approval: {
      proposalId: `lp-${itemId}`,
      approvedBy: "Blob (lead)",
      rule: "Alone: CI repair, from the project settings",
      at: claimedAt,
      expiresAt: claimedAt + 7 * 24 * HOUR,
      state: "applied",
      updatedAt: claimedAt,
    },
  };
}

describe("the ledger", () => {
  test("counts a day's handled alone and asked you, each once, by category", async () => {
    // Ran alone under the lead's rule: its card is not an ask.
    const card = await asked("ci-repair", "pr 7");
    records.set("acme", [aloneRecord(card.id, "ci-repair", clock, true)]);
    // Asked, then the owner answered and dismissed.
    const release = await asked("public-release", "1.19.0");
    await answerSupervisorItem("Ada", release.id, "1", "owner");
    const upgrade = await asked("dependency-major", "react 20");
    // Closed by the supervisor with a reason: handled alone, not asked.
    const stale = await asked("signal-rule-change", "api latency");
    await dismissSupervisorItems("Ada", [stale.id], "same as the other one");
    // Raised by the watch, still open.
    await postSupervisorItem({
      user: "Ada",
      source: "watch",
      kind: "needs-you",
      title: "Pat is stuck",
    });
    // fyi never counts.
    await postSupervisorItem({
      user: "Ada",
      source: "lead:acme",
      kind: "fyi",
      title: "Applied",
    });
    // Yesterday's ask stays on yesterday.
    clock = at("2026-07-09T08:00:00Z");
    await asked("dependency-major", "vite 9");
    clock = at("2026-07-10T12:00:00Z");

    const view = await readSupervisorBriefView("Ada");
    const events = autonomyEvents({
      items: view.items,
      brief: {
        day: "2026-07-10",
        // The close is already counted; the other line is new.
        handled: [{ itemId: stale.id }, { itemId: upgrade.id }, {}],
      },
      leads: [{ project: "acme", records: records.get("acme")! }],
      timeZone: "UTC",
    });
    const day = autonomyDay(events, "2026-07-10");
    expect(day.handledAlone).toBe(4);
    expect(day.askedYou).toBe(3);
    expect(day.alone).toEqual({
      "lead-rule": 1,
      close: 1,
      brief: 2,
      autofixRuns: 1,
    });
    expect(day.asked.outcomes).toEqual({
      open: 2,
      answered: 1,
      dismissed: 0,
      expired: 0,
      settled: 0,
    });
    expect(day.asked.bySource).toEqual([
      { source: "lead:acme", count: 2 },
      { source: "watch", count: 1 },
    ]);
    expect(day.byCategory).toEqual([
      { category: "dependency-major", alone: 1, asked: 1 },
      { category: "ci-repair", alone: 1, asked: 0 },
      { category: "public-release", alone: 0, asked: 1 },
      { category: "signal-rule-change", alone: 1, asked: 0 },
      { category: "supervisor", alone: 1, asked: 0 },
      { category: "watch", alone: 0, asked: 1 },
    ]);
    expect(autonomyDay(events, "2026-07-09")).toMatchObject({
      handledAlone: 0,
      askedYou: 1,
    });
  });

  test("days are the owner's local days", async () => {
    clock = at("2026-07-10T23:30:00Z");
    await asked("dependency-major", "late");
    const view = await readSupervisorBriefView("Ada");
    const events = autonomyEvents({
      items: view.items,
      leads: [],
      timeZone: "Europe/Warsaw",
    });
    expect(events.map((e) => e.day)).toEqual(["2026-07-11"]);
  });

  test("a category comes from the proposal, else the dedupe key, else the source", () => {
    const item = { source: "lead:acme", dedupeKey: "lead:acme:refund:x" };
    expect(itemCategory(item)).toBe("refund");
    expect(
      itemCategory({
        source: "lead:acme",
        dedupeKey: "lead:acme:budget:2026-07",
      }),
    ).toBe("lead-budget");
    expect(itemCategory({ source: "lead:acme" })).toBe("lead");
    expect(itemCategory({ source: "watch" })).toBe("watch");
    expect(itemCategory({ source: "autonomy:acme" })).toBe("autonomy");
    expect(itemCategory(item, aloneRecord("si-1", "ci-repair", clock))).toBe(
      "ci-repair",
    );
  });

  test("autonomyLedger reads today from the inbox and the owner's leads", async () => {
    const card = await asked("ci-repair", "pr 7");
    records.set("acme", [aloneRecord(card.id, "ci-repair", clock, true)]);
    await asked("dependency-major", "react 20");
    expect(await autonomyLedger("Ada")).toEqual({
      day: "2026-07-10",
      handledAlone: 1,
      askedYou: 1,
      byCategory: [
        { category: "ci-repair", alone: 1, asked: 0 },
        { category: "dependency-major", alone: 0, asked: 1 },
      ],
    });
  });
});

describe("asking less", () => {
  async function answeredTimes(
    category: string,
    answers: string[],
    project = "acme",
  ) {
    for (const [i, answer] of answers.entries()) {
      const item = await asked(category, `${category} ${i}`, project);
      clock += HOUR;
      await answerSupervisorItem("Ada", item.id, answer, "owner");
    }
  }

  async function candidates() {
    const view = await readSupervisorBriefView("Ada");
    const history = askedHistory(
      autonomyEvents({ items: view.items, leads: [], timeZone: "UTC" }),
      clock - 14 * 24 * HOUR,
    );
    return { history, candidates: autonomyCandidates(history, leads) };
  }

  test("three approvals and nothing else make a candidate", async () => {
    await answeredTimes("dependency-major", ["1", "1"]);
    expect((await candidates()).candidates).toEqual([]);
    await answeredTimes("dependency-major", ["1"]);
    const { history, candidates: found } = await candidates();
    expect(history).toEqual([
      {
        project: "acme",
        category: "dependency-major",
        asked: 3,
        approved: 3,
        declined: 0,
        other: 0,
        unanswered: 0,
      },
    ]);
    expect(found).toEqual([{ ...history[0]!, label: "Acme" }]);
  });

  test("a decline, a recorded answer or the window leave it alone", async () => {
    await answeredTimes("dependency-major", ["1", "1", "1", "2"]);
    expect((await candidates()).candidates).toEqual([]);

    __resetSupervisorInboxForTest();
    clock = at("2026-07-10T12:00:00Z");
    // Answers the supervisor recorded are not the owner's.
    for (const i of [1, 2, 3]) {
      const item = await asked("public-release", `r${i}`);
      await answerSupervisorItem("Ada", item.id, "1", "supervisor");
    }
    expect((await candidates()).candidates).toEqual([]);
  });

  test("three approvals and one dismissal make no candidate", async () => {
    await answeredTimes("dependency-major", ["1", "1", "1"]);
    const dismissed = await asked("dependency-major", "dismissed");
    await dismissSupervisorItem("Ada", dismissed.id);
    const { history, candidates: found } = await candidates();
    expect(history[0]).toMatchObject({
      asked: 4,
      approved: 3,
      declined: 0,
      other: 0,
      unanswered: 1,
    });
    expect(found).toEqual([]);
  });

  test("a still open item blocks it too", async () => {
    await answeredTimes("public-release", ["1", "1", "1"]);
    await asked("public-release", "still open");
    expect((await candidates()).candidates).toEqual([]);
  });

  test("only allowlisted categories are ever proposed", () => {
    expect([...PROPOSABLE].sort()).toEqual([
      "ci-repair",
      "dependency-major",
      "public-release",
      "signal-rule-change",
    ]);
    // A category added later is not proposable until it is allowlisted.
    const made = "deploy-production" as unknown as LeadCategory;
    const rules = { ...DEFAULT_LEAD_RULES, [made]: "asks-first" };
    expect(proposable(made, { rules })).toBe(false);
    const history = [
      {
        project: "acme",
        category: made,
        asked: 5,
        approved: 5,
        declined: 0,
        other: 0,
        unanswered: 0,
      },
    ];
    expect(
      autonomyCandidates(history, [
        { ...lead("acme"), lead: { enabled: true, rules } },
      ]),
    ).toEqual([]);
  });

  test("never for pinned, identity or customer-facing categories, a rule not asks first, or a lead that is off", async () => {
    leads = [
      lead("acme", {
        "ban-user": "asks-first",
        "support-routine-reply": "asks-first",
        "ci-repair": "alone",
      }),
    ];
    for (const category of [
      "refund",
      "ban-user",
      "rotate-key",
      "support-routine-reply",
      "ci-repair",
    ])
      await answeredTimes(category, ["1", "1", "1"]);
    expect((await candidates()).candidates).toEqual([]);

    await answeredTimes("dependency-major", ["1", "1", "1"]);
    expect((await candidates()).candidates).toHaveLength(1);
    leads = [lead("acme", {}, false)];
    expect((await candidates()).candidates).toEqual([]);
  });

  test("prepare raises one decision, once, with no push of its own", async () => {
    await answeredTimes("dependency-major", ["1", "1", "1"]);
    await answeredTimes("public-release", ["1", "1", "1", "1"]);
    const id = await prepareAutonomyProposal("Ada");
    expect(id).toBeTruthy();
    const open = await listSupervisorItems("Ada", { state: "open" });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      id,
      source: `${AUTONOMY_SOURCE_PREFIX}acme`,
      kind: "needs-you",
      title: "Acme: let the lead do public releases alone from now on?",
      options: [AUTONOMY_YES, AUTONOMY_NO],
      dedupeKey: "autonomy:acme:public-release",
    });
    expect(open[0]!.urgency).toBeUndefined();
    expect(open[0]!.body).toContain("all 4 times");
    expect(audits).toEqual([
      expect.objectContaining({
        kind: "autonomy_proposed",
        category: "public-release",
      }),
    ]);
    // One at a time.
    expect(await prepareAutonomyProposal("Ada")).toBeNull();
    // Kept asking: never raised again; the next candidate comes up.
    await answerSupervisorItem("Ada", id!, AUTONOMY_NO, "owner");
    const next = await prepareAutonomyProposal("Ada");
    expect(
      (await listSupervisorItems("Ada", { state: "open" }))[0],
    ).toMatchObject({ id: next, dedupeKey: "autonomy:acme:dependency-major" });
    await answerSupervisorItem("Ada", next!, AUTONOMY_NO, "owner");
    expect(await prepareAutonomyProposal("Ada")).toBeNull();
  });

  test("autonomy_report lists the days, the answers and the candidates", async () => {
    await answeredTimes("dependency-major", ["1", "1", "1"]);
    const report = await autonomyReport("Ada", 2);
    expect(report).toContain("2026-07-10: handled alone 0, asked you 3.");
    expect(report).toContain("2026-07-09: handled alone 0, asked you 0.");
    expect(report).toContain("- Asked: 3 answered. By source: lead:acme 3.");
    expect(report).toContain(
      "- acme dependency-major (rule: asks-first): asked 3; approved 3, declined 0, other 0, no owner answer 0",
    );
    expect(report).toContain("- acme dependency-major: approved 3 of 3.");
    expect(await autonomyReport("Ada", 99)).toContain("2026-06-27");
  });
});

describe("the owner's answer", () => {
  async function proposal(): Promise<SupervisorItem> {
    for (const i of [1, 2, 3]) {
      const item = await asked("dependency-major", `d${i}`);
      await answerSupervisorItem("Ada", item.id, "1", "owner");
    }
    const id = await prepareAutonomyProposal("Ada");
    return (await listSupervisorItems("Ada", { state: "open" })).find(
      (item) => item.id === id,
    )!;
  }

  test("only the owner's own Yes, signed in to the revision, changes the rule", async () => {
    const item = await proposal();
    const answered = { ...item, state: "answered" as const };
    expect(
      await handleAutonomyAnswer(answered, AUTONOMY_YES, "supervisor", {
        login: "ada",
        revision: item.updatedAt,
      }),
    ).toMatchObject({ changed: false });
    expect(
      await handleAutonomyAnswer(answered, AUTONOMY_YES, "owner", {
        revision: item.updatedAt,
      }),
    ).toMatchObject({ changed: false });
    expect(
      await handleAutonomyAnswer(answered, AUTONOMY_YES, "owner", {
        login: "ada",
      }),
    ).toMatchObject({ changed: false });
    expect(
      await handleAutonomyAnswer(answered, AUTONOMY_NO, "owner", {
        login: "ada",
        revision: item.updatedAt,
      }),
    ).toMatchObject({ changed: false });
    expect(
      await handleAutonomyAnswer(
        { ...answered, user: "Grace" },
        AUTONOMY_YES,
        "owner",
        { login: "ada", revision: item.updatedAt },
      ),
    ).toMatchObject({ changed: false });
    expect(ruleWrites).toEqual([]);

    expect(
      await handleAutonomyAnswer(answered, AUTONOMY_YES, "owner", {
        login: "ada",
        revision: item.updatedAt,
      }),
    ).toEqual({ changed: true });
    expect(ruleWrites).toEqual([
      {
        project: "acme",
        revision: 4,
        category: "dependency-major",
        login: "ada",
      },
    ]);
    const fyi = await listSupervisorItems("Ada", { kind: "fyi" });
    expect(fyi).toHaveLength(1);
    expect(fyi[0]).toMatchObject({
      source: "autonomy:acme",
      title: "Acme lead now does major dependency upgrades alone.",
      body: "Change it back in Settings, Acme, Lead.",
    });
    // The open fyi holds back no further proposal.
    await answerSupervisorItem("Ada", item.id, AUTONOMY_NO, "owner");
    for (const i of [1, 2, 3]) {
      const next = await asked("public-release", `p${i}`);
      await answerSupervisorItem("Ada", next.id, "1", "owner");
    }
    expect(await prepareAutonomyProposal("Ada")).toBeTruthy();
  });

  test("only the server posts an autonomy dedupe key", async () => {
    for (const source of ["supervisor", "watch", "lead:acme"])
      await expect(
        postSupervisorItem({
          user: "Ada",
          source,
          kind: "needs-you",
          title: "Let the lead do it alone?",
          options: [AUTONOMY_YES, AUTONOMY_NO],
          dedupeKey: "autonomy:acme:dependency-major",
        }),
      ).rejects.toThrow("reserved");
    expect(await listSupervisorItems("Ada", {})).toEqual([]);
  });

  test("a rule that moved since, or a pinned category, changes nothing", async () => {
    const item = await proposal();
    leads = [lead("acme", { "dependency-major": "only-you" })];
    expect(
      await handleAutonomyAnswer(item, AUTONOMY_YES, "owner", {
        login: "ada",
        revision: item.updatedAt,
      }),
    ).toMatchObject({ changed: false });
    const forged = { ...item, dedupeKey: "autonomy:acme:refund" };
    leads = [lead("acme")];
    expect(
      await handleAutonomyAnswer(forged, AUTONOMY_YES, "owner", {
        login: "ada",
        revision: item.updatedAt,
      }),
    ).toMatchObject({ changed: false });
    expect(ruleWrites).toEqual([]);
  });

  test("a refused write is told to the owner", async () => {
    const restore = __setAutonomyDepsForTest({
      now: () => clock,
      leadProjects: async () => leads,
      records: async () => [],
      leadProject: async () => leads[0]!,
      leadOwner: async () => "Ada",
      setRule: async () => ({ ok: false, error: "Settings changed" }),
      audit: async () => {},
    });
    try {
      const item = await proposal();
      expect(
        await handleAutonomyAnswer(item, AUTONOMY_YES, "owner", {
          login: "ada",
          revision: item.updatedAt,
        }),
      ).toEqual({ changed: false, reason: "Settings changed" });
      const fyi = (await listSupervisorItems("Ada", { kind: "fyi" }))[0];
      expect(fyi).toMatchObject({
        title: "Couldn't let the lead do major dependency upgrades alone",
      });
    } finally {
      restore();
    }
  });

  test("answering through the inbox reaches the handler", async () => {
    const item = await proposal();
    const off = onSupervisorAnswer(AUTONOMY_SOURCE_PREFIX, async (...args) => {
      await handleAutonomyAnswer(...args);
    });
    try {
      await answerSupervisorItem("Ada", item.id, "1", "owner", {
        login: "ada",
        revision: item.updatedAt,
      });
    } finally {
      off();
    }
    expect(ruleWrites).toHaveLength(1);
  });
});

describe("the settings write path", () => {
  beforeEach(() => {
    __setLegacyEnvironmentForTest({
      projects: () => ["acme"],
      sandbox: () => ({ perRepo: {} }),
      automations: async () => [],
      mcpServers: async () => [],
      webSearch: async () => "auto",
      defaultReviewServers: async () => [],
    });
    __setProjectStoreContextForTest({
      projectExists: (id) => id === "acme",
      leadAuthority: (login) => login === "ada",
    });
    restoreAutonomy();
    restoreAutonomy = __setAutonomyDepsForTest({
      now: () => clock,
      leadProjects: async () => leads,
      records: async () => [],
      leadOwner: async () => "Ada",
      audit: async () => {},
    });
  });

  afterEach(() => {
    __setLegacyEnvironmentForTest(undefined);
    __setProjectStoreContextForTest(undefined);
  });

  test("the lead's owner loosens the rule; anyone else is refused", async () => {
    const item = await (async () => {
      for (const i of [1, 2, 3]) {
        const a = await asked("dependency-major", `d${i}`);
        await answerSupervisorItem("Ada", a.id, "1", "owner");
      }
      const id = await prepareAutonomyProposal("Ada");
      return (await listSupervisorItems("Ada")).find((i) => i.id === id)!;
    })();
    expect(
      await handleAutonomyAnswer(item, AUTONOMY_YES, "owner", {
        login: "mallory",
        revision: item.updatedAt,
      }),
    ).toMatchObject({ changed: false });
    expect(
      (await getProjectDocument("acme")).lead.rules["dependency-major"],
    ).toBe("asks-first");

    expect(
      await handleAutonomyAnswer(item, AUTONOMY_YES, "owner", {
        login: "ada",
        revision: item.updatedAt,
      }),
    ).toEqual({ changed: true });
    expect(
      (await getProjectDocument("acme")).lead.rules["dependency-major"],
    ).toBe("alone");
  });
});
