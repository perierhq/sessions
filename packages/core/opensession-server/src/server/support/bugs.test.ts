import { beforeEach, describe, expect, test } from "bun:test";
import type { SupportActor } from "../../shared/support";
import type { CreateSessionOpts } from "../session-control";
import {
  __setBugDepsForTest,
  approvePendingIssue,
  dismissPendingIssue,
  reportBug,
} from "./bugs";
import type { SupportRunSpec } from "./session-policy";
import { getConversation, updateConversation } from "./store";
import { useReplyTestbed } from "./testing/reply-testbed";

const tb = useReplyTestbed();

const AGENT: SupportActor = { kind: "agent", sessionId: "os-support" };

let posted: Array<{ ghRepo: string; title: string; body: string }> = [];
let created: CreateSessionOpts[] = [];
let visibility: boolean | null = false;
let spec: SupportRunSpec;
let issueCounter = 0;

beforeEach(() => {
  posted = [];
  created = [];
  visibility = false;
  issueCounter = 0;
  spec = {
    model: "pi/anthropic/claude-sonnet-5",
    mcpServers: ["acme-crm"],
    mode: "code",
    sandbox: { ok: true, request: "daytona" },
  };
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
    runSpec: async () => spec,
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

    expect(await approvePendingIssue(c.id, "Ada")).toEqual({ ok: true });
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
    expect(await dismissPendingIssue(c.id, "Ada")).toEqual({ ok: true });
    expect((await getConversation(c.id))!.pendingIssue).toBeNull();
    expect((await approvePendingIssue(c.id, "Ada")).ok).toBe(false);
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

  test("issue-and-agent with Support mode code starts a fix session that reports back", async () => {
    const c = await bugConversation("issue-and-agent");
    const result = await reportBug(c.id, SUMMARY, AGENT);
    expect(result.state).toBe("created");
    expect(created).toHaveLength(1);
    const opts = created[0]!;
    expect(opts.mode).toBe("code");
    expect(opts.repo).toBe("acme");
    expect(opts.isolatedWorktree).toBe(true);
    expect(opts.parentSessionId).toBe("os-support");
    expect(opts.reportBack).toBe(true);
    expect(opts.model).toBe(spec.model);
    expect(opts.mcpServers).toEqual(["acme-crm"]);
    expect(opts.sandbox).toBe("daytona");
    expect(opts.agentStarted).toBe(true);
    expect(opts.user).toBe("Sessions");
    expect(opts.prompt).toContain("https://github.com/acme/acme/issues/1");
    expect(opts.prompt).not.toContain("example.test");
    expect((await getConversation(c.id))!.fixSessionId).toBe("os-fix-1");
  });

  test("issue-and-agent with Support mode ask starts no session and says why", async () => {
    spec = { ...spec, mode: "ask" };
    const c = await bugConversation("issue-and-agent");
    expect((await reportBug(c.id, SUMMARY, AGENT)).state).toBe("created");
    expect(created).toHaveLength(0);
    const stored = (await getConversation(c.id))!;
    expect(stored.fixSessionId).toBeNull();
    expect(stored.events.map((e) => e.detail)).toContain(
      "Support can't change code in acme, so no fix agent started",
    );
  });

  test("an approved public issue still starts the fix agent", async () => {
    visibility = true;
    const c = await bugConversation("issue-and-agent");
    await reportBug(c.id, SUMMARY, AGENT);
    expect(created).toHaveLength(0);
    await approvePendingIssue(c.id, "Ada");
    expect(created).toHaveLength(1);
    expect(created[0]!.parentSessionId).toBe("os-support");
  });
});
