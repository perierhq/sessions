import { beforeEach, describe, expect, test } from "bun:test";
import type { SupportActor, SupportMessage } from "../../shared/support";
import type { Actor } from "./actor";
import type { CreateSessionOpts } from "../session-control";
import {
  __setBugDepsForTest,
  SIGN_IN_TO_CREATE,
  approvePendingIssue,
  dismissPendingIssue,
  FIXED_NOTE,
  HELD_PREPARED,
  HELD_PUBLIC,
  HELD_QUOTE,
  issueFooter,
  issueText,
  MAX_SUMMARY,
  MAX_FIX_TASK,
  MAX_TITLE,
  checkFixes,
  reportBug,
  startFixSession,
} from "./bugs";
import { personaName } from "../config";
import { getConversation, updateConversation } from "./store";
import { useReplyTestbed } from "./testing/reply-testbed";

const tb = useReplyTestbed();

const AGENT: SupportActor = { kind: "agent", sessionId: "os-support" };
/** The instance owner and another signed-in person (actorFor's shape). */
const OWNER_ACTOR: Actor = {
  name: "Ada",
  verified: true,
  isInstanceOwner: true,
};
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

/** A conversation with a support session. */
async function bugConversation(_kind?: string) {
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
  test("prepares the issue and a fix task; nothing is posted or started", async () => {
    const c = await bugConversation();
    const result = await reportBug(c.id, SUMMARY, AGENT);
    expect(result.state).toBe("prepared");
    expect(result.note).toContain("A person");
    expect(posted).toHaveLength(0);
    expect(created).toHaveLength(0);
    const stored = (await getConversation(c.id))!;
    expect(stored.issue).toBeNull();
    expect(stored.fixSessionId).toBeNull();
    const issue = stored.pendingIssue!;
    expect(issue.requestedBy).toEqual(AGENT);
    expect(issue.ghRepo).toBe("acme/acme");
    expect(issue.heldFor).toBe(HELD_PREPARED);
    expect(issue.body).not.toContain("@");
    expect(issue.body).not.toContain("example.test");
    expect(issue.body).toContain("[email removed]");
    // The footer credits the assistant persona, not a person or "Sessions".
    expect(issue.body).toEndWith(issueFooter());
    expect(issueFooter()).toBe(
      `\n\nReported by ${personaName()} from a support conversation.`,
    );
    expect(issue.title).not.toContain("Carol");
    expect(stored.fixTask?.project).toBe("acme");
    expect(stored.fixTask?.suggestedBy).toEqual(AGENT);
    expect(stored.fixTask?.text).toContain("CSV export returns 500");
    expect(stored.fixTask?.text).not.toContain("example.test");
    expect(stored.fixTask?.text).not.toContain("Carol");
    expect(stored.events.some((e) => e.kind === "issue-prepared")).toBe(true);
  });

  test("a person's click creates the prepared issue as it was stored", async () => {
    const c = await bugConversation();
    await reportBug(c.id, SUMMARY, AGENT);
    const held = (await getConversation(c.id))!;
    // A private repository: any signed-in person may create it.
    expect(await approve(c.id, GRACE)).toEqual({ ok: true });
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toBe(held.pendingIssue!.body);
    const after = (await getConversation(c.id))!;
    expect(after.pendingIssue).toBeNull();
    expect(after.issue?.number).toBe(1);
    expect(after.events.some((e) => e.kind === "issue-created")).toBe(true);
  });

  test("a private repository needs a signed-in person, and says so", async () => {
    const c = await bugConversation();
    await reportBug(c.id, SUMMARY, AGENT);
    const result = await approve(c.id, {
      name: "Guest",
      verified: false,
      isInstanceOwner: false,
    });
    expect(result).toEqual({
      ok: false,
      status: 403,
      error: SIGN_IN_TO_CREATE,
    });
    expect(posted).toHaveLength(0);
  });

  test("public or unknown visibility says so; only the owner creates it", async () => {
    for (const v of [true, null]) {
      visibility = v;
      const c = await bugConversation();
      const result = await reportBug(c.id, SUMMARY, AGENT);
      expect(result.state).toBe("prepared");
      expect((await getConversation(c.id))!.pendingIssue?.heldFor).toBe(
        HELD_PUBLIC,
      );
    }
    expect(posted).toHaveLength(0);
  });

  test("a dismissed issue is never posted", async () => {
    const c = await bugConversation();
    await reportBug(c.id, SUMMARY, AGENT);
    expect(await dismissPendingIssue(c.id, OWNER_ACTOR)).toEqual({ ok: true });
    expect((await getConversation(c.id))!.pendingIssue).toBeNull();
    expect((await approve(c.id)).ok).toBe(false);
    expect(posted).toHaveLength(0);
  });

  test("a report after the issue exists keeps it", async () => {
    const c = await bugConversation();
    await reportBug(c.id, SUMMARY, AGENT);
    await approve(c.id);
    const again = await reportBug(c.id, SUMMARY, AGENT);
    expect(again.state).toBe("created");
    expect(again.issue?.number).toBe(1);
    expect(posted).toHaveLength(1);
  });

  test("a failed create says so and keeps the prepared issue", async () => {
    __setBugDepsForTest({
      ghRepo: () => "acme/acme",
      isPublic: async () => false,
      createIssue: async () => null,
    });
    const c = await bugConversation();
    await reportBug(c.id, SUMMARY, AGENT);
    const result = await approve(c.id);
    expect(result).toMatchObject({ ok: false, status: 502 });
    const after = (await getConversation(c.id))!;
    expect(after.issue).toBeNull();
    expect(after.pendingIssue).not.toBeNull();
  });
});

describe("a person edits the prepared issue before creating it", () => {
  test("the edited title and body are scrubbed again and keep one footer", async () => {
    const c = await bugConversation();
    await reportBug(c.id, SUMMARY, AGENT);
    const seen = (await getConversation(c.id))!;
    const result = await approvePendingIssue(c.id, OWNER_ACTOR, seen.revision, {
      title: "Export fails for carol@customer.example.test",
      body: `Carol's export returns 500. Mail carol@customer.example.test.${"\n\nReported from a support conversation in Sessions."}`,
    });
    expect(result).toEqual({ ok: true });
    expect(posted).toHaveLength(1);
    expect(posted[0]!.title).not.toContain("example.test");
    expect(posted[0]!.body).not.toContain("example.test");
    expect(posted[0]!.body).not.toContain("Carol");
    expect(posted[0]!.body).toContain("export returns 500");
    expect(posted[0]!.body.split("from a support conversation").length).toBe(2);
    // The legacy footer is replaced by the persona's.
    expect(posted[0]!.body).toEndWith(issueFooter());
  });

  test("an edit that keeps the persona footer still ends with exactly one", async () => {
    const c = await bugConversation();
    await reportBug(c.id, SUMMARY, AGENT);
    const seen = (await getConversation(c.id))!;
    const result = await approvePendingIssue(c.id, OWNER_ACTOR, seen.revision, {
      body: `The export returns 500.${issueFooter()}`,
    });
    expect(result).toEqual({ ok: true });
    expect(posted[0]!.body).toBe(`The export returns 500.${issueFooter()}`);
  });

  test("a footer naming an earlier persona is replaced, not kept", async () => {
    const c = await bugConversation();
    await reportBug(c.id, SUMMARY, AGENT);
    const seen = (await getConversation(c.id))!;
    // Prepared before the persona was renamed, edited after.
    const result = await approvePendingIssue(c.id, OWNER_ACTOR, seen.revision, {
      body: "The export returns 500.\n\nReported by Old Name from a support conversation.\n",
    });
    expect(result).toEqual({ ok: true });
    expect(posted[0]!.body).toBe(`The export returns 500.${issueFooter()}`);
  });

  test("only the edited part changes; the rest stays as prepared", async () => {
    const c = await bugConversation();
    await reportBug(c.id, SUMMARY, AGENT);
    const seen = (await getConversation(c.id))!;
    await approvePendingIssue(c.id, OWNER_ACTOR, seen.revision, {
      title: "Export returns 500",
    });
    expect(posted[0]!.title).toBe("Export returns 500");
    expect(posted[0]!.body).toBe(seen.pendingIssue!.body);
  });

  test("an empty or too long edit is refused and nothing is posted", async () => {
    const c = await bugConversation();
    await reportBug(c.id, SUMMARY, AGENT);
    const seen = (await getConversation(c.id))!;
    for (const edit of [
      { title: "   " },
      { body: "  " },
      { title: "x".repeat(MAX_TITLE + 1) },
      { body: "x".repeat(MAX_SUMMARY + 1) },
    ])
      expect(
        await approvePendingIssue(c.id, OWNER_ACTOR, seen.revision, edit),
      ).toMatchObject({ ok: false, status: 400 });
    expect(posted).toHaveLength(0);
  });
});

describe("the it's fixed note", () => {
  let prState: "OPEN" | "MERGED" | "CLOSED" | null = null;
  let issueState: "open" | "closed" | "completed" | null = "open";
  beforeEach(() => {
    prState = null;
    issueState = "open";
  });
  function withState() {
    __setBugDepsForTest({
      ghRepo: (project) => `acme/${project}`,
      isPublic: async () => false,
      createIssue: async (ghRepo) => ({
        number: 7,
        url: `https://github.com/${ghRepo}/issues/7`,
        repo: ghRepo,
      }),
      control: () => ({
        async createSession() {
          return {
            id: "os-fix-1",
            createdBy: "Ada",
            createdAt: new Date().toISOString(),
          };
        },
      }),
      fixSession: async () => ({
        prUrl: "https://github.com/acme/acme/pull/9",
        prState,
      }),
      issueState: async () => issueState,
    });
  }

  test("a merged fix pull request prepares a note that waits for a person", async () => {
    withState();
    await tb.setInbox({ autonomy: "routine", vetoMs: null });
    const c = await bugConversation();
    await reportBug(c.id, SUMMARY, AGENT);
    const seen = (await getConversation(c.id))!;
    const started = await startFixSession(
      c.id,
      { name: "Ada" },
      seen.revision,
      "Fix it",
    );
    expect(started.ok).toBe(true);
    expect(await checkFixes(Date.now())).toBe(0);
    prState = "MERGED";
    expect(await checkFixes(Date.now())).toBe(1);
    const after = (await getConversation(c.id))!;
    expect(after.fixedNote).toMatchObject({
      because: "pr-merged",
      url: "https://github.com/acme/acme/pull/9",
    });
    expect(after.draft).toMatchObject({
      purpose: "fixed-note",
      state: "needs-person",
      rule: FIXED_NOTE,
    });
    expect(after.fixedNote!.draftId).toBe(after.draft!.id);
    expect(tb.fixture().sent).toHaveLength(0);
    // Once per conversation.
    expect(await checkFixes(Date.now())).toBe(0);
  });

  test("a closed issue prepares the note; a live draft keeps it aside", async () => {
    withState();
    const c = await bugConversation();
    await reportBug(c.id, SUMMARY, AGENT);
    await approve(c.id);
    await updateConversation(c.id, (x) => ({
      ...x,
      status: "closed",
      closedAt: new Date().toISOString(),
    }));
    // Closed as not planned: no "it's fixed" note.
    issueState = "closed";
    expect(await checkFixes(Date.now())).toBe(0);
    expect((await getConversation(c.id))!.fixedNote ?? null).toBeNull();
    issueState = "completed";
    expect(await checkFixes(Date.now())).toBe(1);
    const after = (await getConversation(c.id))!;
    expect(after.status).toBe("open");
    expect(after.fixedNote?.because).toBe("issue-closed");
    expect(after.draft?.purpose).toBe("fixed-note");
  });
});

describe("startFixSession", () => {
  const ADA_PERSON = { name: "Ada", login: "ada" };

  async function suggested() {
    const c = await bugConversation();
    await reportBug(c.id, SUMMARY, AGENT);
    // The person created the prepared issue first.
    await approve(c.id);
    created = [];
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
    const result = await startFixSession(
      c.id,
      ADA_PERSON,
      c.revision,
      "Fix it",
    );
    expect(result.ok).toBe(true);
    expect(created[0]!.parentSessionId).toBeUndefined();
  });

  test("needs the revision the person saw, a task, and no fix session yet", async () => {
    const c = await suggested();
    const stale = await startFixSession(
      c.id,
      ADA_PERSON,
      c.revision - 1,
      "Fix",
    );
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
    expect(result.state).toBe("prepared");
    await approve(c.id);
    expect(posted[0]!.title.length).toBeLessThanOrEqual(MAX_TITLE);
    expect(posted[0]!.body.length).toBeLessThanOrEqual(MAX_SUMMARY + 100);
    expect(posted[0]!.body).not.toContain("example.test");
  });
});

describe("issueText scrubbing", () => {
  async function scrubbed(
    summary: string,
    extra: Partial<SupportMessage> = {},
  ) {
    const c = await bugConversation("issue");
    const withPeople = (await updateConversation(c.id, (x) => ({
      ...x,
      customer: {
        name: "Zoë Ångström",
        address: "zoe.angstrom@customer.example.test",
      },
      messages: x.messages.map((m) => ({
        ...m,
        from: {
          name: "Zoë Ångström",
          address: "zoe.angstrom@customer.example.test",
        },
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
    expect(result.state).toBe("prepared");
    expect((await getConversation(c.id))!.pendingIssue?.heldFor).toBe(
      HELD_QUOTE,
    );
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
});

test("bug copy has no semicolons or em dashes", () => {
  for (const text of [FIXED_NOTE, HELD_PREPARED, HELD_PUBLIC, HELD_QUOTE]) {
    expect(text).not.toContain(";");
    expect(text).not.toContain("\u2014");
  }
});
