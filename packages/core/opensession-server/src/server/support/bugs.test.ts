import { beforeEach, describe, expect, test } from "bun:test";
import type { SupportActor, SupportMessage } from "../../shared/support";
import type { Actor } from "./actor";
import type { CreateSessionOpts } from "../session-control";
import {
  __setBugDepsForTest,
  approvePendingIssue,
  dismissPendingIssue,
  HELD_CAP,
  HELD_PUBLIC,
  HELD_QUOTE,
  issueText,
  MAX_SUMMARY,
  MAX_FIX_TASK,
  MAX_TITLE,
  reportBug,
  startFixSession,
} from "./bugs";
import { getConversation, updateConversation } from "./store";
import { useReplyTestbed } from "./testing/reply-testbed";

const tb = useReplyTestbed();

const AGENT: SupportActor = { kind: "agent", sessionId: "os-support" };
/** The instance owner and another signed-in person (actorFor's shape). */
const OWNER_ACTOR: Actor = { name: "Ada", verified: true, isInstanceOwner: true };
const GRACE: Actor = { name: "Grace", verified: true, isInstanceOwner: false };

/** Approves as `actor` at the conversation's current revision. */
async function approve(id: string, actor: Actor = OWNER_ACTOR) {
  const c = (await getConversation(id))!;
  return approvePendingIssue(id, actor, c.revision);
}

let posted: Array<{ ghRepo: string; title: string; body: string }> = [];
let created: CreateSessionOpts[] = [];
let visibility: boolean | null = false;
let issueCounter = 0;

beforeEach(() => {
  posted = [];
  created = [];
  visibility = false;
  issueCounter = 0;
  __setBugDepsForTest({
    ghRepo: (project) => `acme/${project}`,
    isPublic: async () => visibility,
    createIssue: async (ghRepo, issue) => {
      posted.push({ ghRepo, title: issue.title, body: issue.body });
      issueCounter++;
      return {
        number: issueCounter,
        url: `https://github.com/${ghRepo}/issues/${issueCounter}`,
        repo: ghRepo,
      };
    },
    control: () => ({
      async createSession(opts) {
        created.push(opts);
        return {
          id: `os-fix-${created.length}`,
          createdBy: "Sessions",
          createdAt: new Date().toISOString(),
        };
      },
    }),
  });
  return () => __setBugDepsForTest(undefined);
});

/** A conversation with a support session, on an inbox with `bugHandling`. */
async function bugConversation(
  bugHandling: "off" | "issue" | "issue-and-agent",
) {
  await tb.setInbox({ bugHandling });
  const c = await tb.conversation({
    text: "Export fails. Write to carol@customer.example.test or ada@example.test.",
  });
  return (await updateConversation(c.id, (x) => ({
    ...x,
    sessionId: "os-support",
  })))!;
}

const SUMMARY = {
  title: "CSV export fails for Carol",
  summary:
    "The CSV export returns 500 since Monday. The customer (carol@customer.example.test) can reproduce it.",
};

describe("reportBug", () => {
  test("off: nothing is posted", async () => {
    const c = await bugConversation("off");
    const result = await reportBug(c.id, SUMMARY, AGENT);
    expect(result.state).toBe("off");
    expect(posted).toHaveLength(0);
    expect((await getConversation(c.id))!.issue).toBeNull();
  });

  test("private repository: the agent's issue is created without addresses or the name", async () => {
    const c = await bugConversation("issue");
    const result = await reportBug(c.id, SUMMARY, AGENT);
    expect(result.state).toBe("created");
    expect(result.issue).toEqual({
      url: "https://github.com/acme/acme/issues/1",
      number: 1,
    });
    expect(posted).toHaveLength(1);
    expect(posted[0]!.ghRepo).toBe("acme/acme");
    expect(posted[0]!.body).not.toContain("@");
    expect(posted[0]!.body).not.toContain("example.test");
    expect(posted[0]!.body).toContain("[email removed]");
    expect(posted[0]!.body).toEndWith(
      "\n\nReported from a support conversation in Sessions.",
    );
    expect(posted[0]!.title).not.toContain("Carol");
    expect(posted[0]!.body).not.toContain("Carol");
    const stored = (await getConversation(c.id))!;
    expect(stored.issue).toEqual({
      repo: "acme/acme",
      number: 1,
      url: "https://github.com/acme/acme/issues/1",
    });
    expect(stored.events.some((e) => e.kind === "issue-created")).toBe(true);
    // Plain issue mode: no fix agent.
    expect(created).toHaveLength(0);
  });

  test("public repository: held for a person, nothing posted until approved", async () => {
    visibility = true;
    const c = await bugConversation("issue");
    const result = await reportBug(c.id, SUMMARY, AGENT);
    expect(result.state).toBe("held");
    expect(result.note).toBe("Waiting for a person: the repository is public");
    expect(posted).toHaveLength(0);
    const held = (await getConversation(c.id))!;
    expect(held.pendingIssue?.requestedBy).toEqual(AGENT);
    expect(held.pendingIssue?.body).not.toContain("example.test");
    expect(held.pendingIssue?.ghRepo).toBe("acme/acme");
    expect(held.pendingIssue?.heldFor).toBe(HELD_PUBLIC);

    expect(await approve(c.id)).toEqual({ ok: true });
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toBe(held.pendingIssue!.body);
    const approved = (await getConversation(c.id))!;
    expect(approved.pendingIssue).toBeNull();
    expect(approved.issue?.number).toBe(1);
  });

  test("unknown visibility counts as public", async () => {
    visibility = null;
    const c = await bugConversation("issue");
    expect((await reportBug(c.id, SUMMARY, AGENT)).state).toBe("held");
    expect(posted).toHaveLength(0);
  });

  test("a dismissed issue is never posted", async () => {
    visibility = true;
    const c = await bugConversation("issue");
    await reportBug(c.id, SUMMARY, AGENT);
    expect(await dismissPendingIssue(c.id, OWNER_ACTOR)).toEqual({ ok: true });
    expect((await getConversation(c.id))!.pendingIssue).toBeNull();
    expect((await approve(c.id)).ok).toBe(false);
    expect(posted).toHaveLength(0);
  });

  test("a second report keeps the first issue", async () => {
    const c = await bugConversation("issue");
    await reportBug(c.id, SUMMARY, AGENT);
    const again = await reportBug(c.id, SUMMARY, AGENT);
    expect(again.state).toBe("created");
    expect(again.issue?.number).toBe(1);
    expect(posted).toHaveLength(1);
  });

  test("a failed post says so", async () => {
    __setBugDepsForTest({
      ghRepo: () => "acme/acme",
      isPublic: async () => false,
      createIssue: async () => null,
    });
    const c = await bugConversation("issue");
    const result = await reportBug(c.id, SUMMARY, AGENT);
    expect(result.state).toBe("failed");
    expect((await getConversation(c.id))!.issue).toBeNull();
  });

  test("issue-and-agent: the issue is posted and a fix task is suggested; nothing starts", async () => {
    const c = await bugConversation("issue-and-agent");
    const result = await reportBug(c.id, SUMMARY, AGENT);
    expect(result.state).toBe("created");
    expect(result.note).toContain("A person can start a fix session");
    expect(created).toHaveLength(0);
    const stored = (await getConversation(c.id))!;
    expect(stored.fixSessionId).toBeNull();
    expect(stored.fixTask?.project).toBe("acme");
    expect(stored.fixTask?.suggestedBy).toEqual(AGENT);
    expect(stored.fixTask?.text).toContain("CSV export returns 500");
    expect(stored.fixTask?.text).toContain("acme");
    expect(stored.fixTask?.text).not.toContain("example.test");
    expect(stored.fixTask?.text).not.toContain("Carol");
  });

  test("issue only: no fix task", async () => {
    const c = await bugConversation("issue");
    await reportBug(c.id, SUMMARY, AGENT);
    expect((await getConversation(c.id))!.fixTask ?? null).toBeNull();
  });

  test("a held issue still suggests the fix task", async () => {
    visibility = true;
    const c = await bugConversation("issue-and-agent");
    expect((await reportBug(c.id, SUMMARY, AGENT)).state).toBe("held");
    expect((await getConversation(c.id))!.fixTask?.text).toContain("CSV");
    expect(created).toHaveLength(0);
  });
});

describe("startFixSession", () => {
  const ADA_PERSON = { name: "Ada", login: "ada" };

  async function suggested() {
    const c = await bugConversation("issue-and-agent");
    await reportBug(c.id, SUMMARY, AGENT);
    return (await getConversation(c.id))!;
  }

  test("a person starts a normal code session as themselves with the edited task", async () => {
    const c = await suggested();
    const result = await startFixSession(
      c.id,
      ADA_PERSON,
      c.revision,
      "Fix the CSV export 500. Edited by Ada.",
    );
    expect(result).toEqual({ ok: true, sessionId: "os-fix-1" });
    expect(created).toHaveLength(1);
    const opts = created[0]!;
    expect(opts.mode).toBe("code");
    expect(opts.repo).toBe("acme");
    expect(opts.user).toBe("Ada");
    expect(opts.createdByLogin).toBe("ada");
    // A normal interactive session: the person's own defaults, no support
    // scope, no parent, no report-back, no workspace of the conversation.
    expect(opts.model).toBeUndefined();
    expect(opts.mcpServers).toBeUndefined();
    expect(opts.sandbox).toBeUndefined();
    expect(opts.parentSessionId).toBeUndefined();
    expect(opts.reportBack).toBeUndefined();
    expect(opts.workspaceId).toBeUndefined();
    expect(opts.automationDescendantPolicy).toBeUndefined();
    expect(opts.agentStarted).toBeUndefined();
    expect(opts.prompt).toContain("Fix the CSV export 500. Edited by Ada.");
    expect(opts.prompt).toContain("customer email");
    expect(opts.prompt).toContain("https://github.com/acme/acme/issues/1");
    const stored = (await getConversation(c.id))!;
    expect(stored.fixSessionId).toBe("os-fix-1");
    expect(stored.events.at(-1)?.kind).toBe("fix-session-started");
    expect(stored.events.at(-1)?.actor).toEqual({
      kind: "person",
      name: "Ada",
      login: "ada",
    });
  });

  test("works without a support session and without a suggestion", async () => {
    const c = await tb.conversation();
    expect(c.sessionId).toBeNull();
    const result = await startFixSession(c.id, ADA_PERSON, c.revision, "Fix it");
    expect(result.ok).toBe(true);
    expect(created[0]!.parentSessionId).toBeUndefined();
  });

  test("needs the revision the person saw, a task, and no fix session yet", async () => {
    const c = await suggested();
    const stale = await startFixSession(c.id, ADA_PERSON, c.revision - 1, "Fix");
    expect(stale).toMatchObject({ ok: false, status: 409 });
    const empty = await startFixSession(c.id, ADA_PERSON, c.revision, "  ");
    expect(empty).toMatchObject({ ok: false, status: 400 });
    expect(created).toHaveLength(0);
    await startFixSession(c.id, ADA_PERSON, c.revision, "Fix");
    const now = (await getConversation(c.id))!;
    const again = await startFixSession(c.id, ADA_PERSON, now.revision, "Fix");
    expect(again).toMatchObject({ ok: false, status: 409 });
    expect(created).toHaveLength(1);
  });

  test("a task over the size limit is refused", async () => {
    const c = await suggested();
    const result = await startFixSession(
      c.id,
      ADA_PERSON,
      c.revision,
      "x".repeat(MAX_FIX_TASK + 1),
    );
    expect(result).toMatchObject({ ok: false, status: 400 });
  });
});

describe("report_bug input", () => {
  test("a 200k title and summary are cut first, and fast", async () => {
    const c = await bugConversation("issue");
    const huge = "carol@customer.example.test Carol ".repeat(6_000);
    expect(huge.length).toBeGreaterThan(200_000);
    const started = performance.now();
    const result = await reportBug(c.id, { title: huge, summary: huge }, AGENT);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(result.state).toBe("created");
    expect(posted[0]!.title.length).toBeLessThanOrEqual(MAX_TITLE);
    expect(posted[0]!.body.length).toBeLessThanOrEqual(MAX_SUMMARY + 100);
    expect(posted[0]!.body).not.toContain("example.test");
  });
});

describe("issueText scrubbing", () => {
  async function scrubbed(summary: string, extra: Partial<SupportMessage> = {}) {
    const c = await bugConversation("issue");
    const withPeople = (await updateConversation(c.id, (x) => ({
      ...x,
      customer: { name: "Zoë Ångström", address: "zoe.angstrom@customer.example.test" },
      messages: x.messages.map((m) => ({
        ...m,
        from: { name: "Zoë Ångström", address: "zoe.angstrom@customer.example.test" },
        cc: [
          { name: "Bo Ek", address: "bo@partner.example.test" },
          { name: "Acme help", address: "help@acme.example.test" },
        ],
        replyTo: [{ name: "Ölaf Brandt", address: "ops@billing.example.test" }],
        ...extra,
      })),
    })))!;
    return issueText(
      withPeople,
      { title: "Export fails", summary },
      "help@acme.example.test",
    ).body;
  }

  test("obfuscated and encoded addresses go", async () => {
    for (const form of [
      "carol at customer dot example dot test",
      "carol [at] customer.example.test",
      "carol (at) customer (dot) example (dot) test",
      "carol＠customer.example.test",
      "carol%40customer.example.test",
      "carol @ customer.example.test",
    ]) {
      const body = await scrubbed(`Mail ${form} about it.`);
      expect(body).not.toContain("carol");
      expect(body).not.toContain("customer");
    }
  });

  test("participants' names, accents folded, and their address parts go", async () => {
    const body = await scrubbed(
      "Zoe Angstrom and Olaf (cc Bo) say zoe.angstrom and customer.example.test fail in acme; ops is fine.",
    );
    expect(body).not.toMatch(/zoe|angstrom|olaf/i);
    expect(body).not.toContain("customer.example.test");
    // Parts under three letters, plain words and our own name stay.
    expect(body).toContain("Bo");
    expect(body).toContain("acme");
    expect(body).toContain("fail");
  });

  test("phone numbers go, dates and versions stay", async () => {
    const body = await scrubbed(
      "Call +48 601 234 567 or (555) 123-4567. Broken since 2026-10-25 in 10.2.1.",
    );
    expect(body).not.toContain("601 234 567");
    expect(body).not.toContain("123-4567");
    expect(body).toContain("2026-10-25");
    expect(body).toContain("10.2.1");
  });

  test("mentions and issue references are neutralized", async () => {
    const body = await scrubbed("Ping @octocat about #12.");
    expect(body).toContain("`@octocat`");
    expect(body).toContain("`#12`");
  });
});

describe("holds and refusals", () => {
  const QUOTED =
    "the export button on the reports page spins forever and then shows a blank page with no error";

  test("a summary that quotes the customer waits for a person, even in a private repository", async () => {
    const c = await bugConversation("issue");
    await updateConversation(c.id, (x) => ({
      ...x,
      messages: x.messages.map((m) => ({
        ...m,
        text: `Hi, ${QUOTED}. Please help.`,
      })),
    }));
    const result = await reportBug(
      c.id,
      { title: "Export spins", summary: `Customer says: ${QUOTED}.` },
      AGENT,
    );
    expect(result.state).toBe("held");
    expect(result.note).toBe(HELD_QUOTE);
    expect(posted).toHaveLength(0);
    // A private repository's held issue: any signed-in person may approve.
    expect(await approve(c.id, GRACE)).toEqual({ ok: true });
    expect(posted).toHaveLength(1);
  });

  test("no second report while one waits, nor after a dismissal", async () => {
    visibility = true;
    const c = await bugConversation("issue");
    await reportBug(c.id, SUMMARY, AGENT);
    const again = await reportBug(c.id, SUMMARY, AGENT);
    expect(again.state).toBe("failed");
    expect(again.note).toContain("already waiting");
    await dismissPendingIssue(c.id, OWNER_ACTOR);
    const after = await reportBug(c.id, SUMMARY, AGENT);
    expect(after.state).toBe("failed");
    expect(after.note).toContain("dismissed");
    expect((await getConversation(c.id))!.pendingIssue).toBeNull();
  });

  test("approval needs the revision the person saw", async () => {
    visibility = true;
    const c = await bugConversation("issue");
    await reportBug(c.id, SUMMARY, AGENT);
    const seen = (await getConversation(c.id))!.revision;
    await updateConversation(c.id, (x) => ({ ...x, owner: "Grace" }));
    const stale = await approvePendingIssue(c.id, OWNER_ACTOR, seen);
    expect(stale.ok).toBe(false);
    expect("status" in stale && stale.status).toBe(409);
    expect(posted).toHaveLength(0);
  });

  test("only the instance owner may approve an issue for a public repository", async () => {
    visibility = true;
    const c = await bugConversation("issue");
    await reportBug(c.id, SUMMARY, AGENT);
    const refused = await approve(c.id, GRACE);
    expect(refused.ok).toBe(false);
    expect("status" in refused && refused.status).toBe(403);
    expect(posted).toHaveLength(0);
    // Unknown visibility at approval counts as public too.
    visibility = null;
    const unknown = await approve(c.id, GRACE);
    expect("status" in unknown && unknown.status).toBe(403);
    expect(await approve(c.id, OWNER_ACTOR)).toEqual({ ok: true });
  });

  test("approval posts to the repository it was held for", async () => {
    visibility = true;
    const c = await bugConversation("issue");
    await reportBug(c.id, SUMMARY, AGENT);
    await updateConversation(c.id, (x) => ({ ...x, project: "acme-api" }));
    await approve(c.id);
    expect(posted[0]!.ghRepo).toBe("acme/acme");
  });

  for (const limits of [
    { issuesPerInboxPerDay: 5, issuesPerRepoPerDay: 2 },
    { issuesPerInboxPerDay: 2, issuesPerRepoPerDay: 5 },
  ])
    test(`over the daily cap an issue waits for a person (${JSON.stringify(limits)})`, async () => {
      __setBugDepsForTest({
        ghRepo: (project) => `acme/${project}`,
        isPublic: async () => false,
        createIssue: async (ghRepo, issue) => {
          posted.push({ ghRepo, title: issue.title, body: issue.body });
          return {
            number: posted.length,
            url: `https://github.com/${ghRepo}/issues/${posted.length}`,
            repo: ghRepo,
          };
        },
        limits,
      });
      const results = [];
      for (let i = 0; i < 3; i++) {
        const c = await bugConversation("issue");
        results.push(await reportBug(c.id, SUMMARY, AGENT));
      }
      expect(results.map((r) => r.state)).toEqual([
        "created",
        "created",
        "held",
      ]);
      expect(results[2]!.note).toBe(HELD_CAP);
      expect(posted).toHaveLength(2);
    });
});
