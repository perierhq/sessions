import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SupportActor } from "../../shared/support";
import { __setOwnerRosterForTest } from "../incidents/owner";
import type { CreateSessionOpts } from "../session-control";
import {
  __setActionDepsForTest,
  closeConversation,
  markNotSpam,
  moveConversation,
  reopenConversation,
  setOwner,
} from "./actions";
import { proposeDraft } from "./reply";
import { __setRoutingDepsForTest } from "./routing";
import type { SupportRunSpec } from "./session-policy";
import { getConversation, updateConversation } from "./store";
import { useReplyTestbed, CITED } from "./testing/reply-testbed";

const tb = useReplyTestbed();

const AGENT: SupportActor = { kind: "agent", sessionId: "os-old" };
const ADA: SupportActor = { kind: "person", name: "Ada" };

let created: CreateSessionOpts[] = [];
let cancelled: string[] = [];
let workspaces: Array<{ repo?: string }> = [];

/** Each project's Support settings: the source ticks a connector, the
 *  target ticks none. */
const SPECS: Record<string, SupportRunSpec> = {
  acme: {
    model: "pi/anthropic/claude-sonnet-5",
    mcpServers: ["acme-crm"],
    mode: "code",
    sandbox: { ok: true, request: "daytona" },
  },
  "acme-api": {
    model: "pi/anthropic/claude-haiku-5",
    mcpServers: [],
    mode: "ask",
    sandbox: { ok: true, request: "podman" },
  },
};

beforeEach(() => {
  created = [];
  cancelled = [];
  workspaces = [];
  __setOwnerRosterForTest([
    { name: "Ada Lovelace", github: "ada" },
    { name: "Grace Hopper", github: "grace" },
  ]);
  __setRoutingDepsForTest({
    runSpec: async (project) => SPECS[project]!,
    resolveWorkspace: async (input) => {
      workspaces.push(input);
      return { workspace: { id: `ws-${input.ref.id}` } };
    },
    control: () => ({
      async createSession(opts) {
        created.push(opts);
        return {
          id: `os-new-${created.length}`,
          createdBy: "Sessions",
          createdAt: new Date().toISOString(),
        };
      },
      async deliverToSession() {
        return { status: "queued", message: "Queued" };
      },
      async cancelSession() {
        return true;
      },
    }),
  });
  __setActionDepsForTest({
    cancelSession: async (id) => {
      cancelled.push(id);
      return true;
    },
  });
});

afterEach(() => {
  __setActionDepsForTest(undefined);
  __setRoutingDepsForTest(undefined);
  __setOwnerRosterForTest(undefined);
});

async function answered() {
  const c = await tb.conversation();
  return (await updateConversation(c.id, (x) => ({
    ...x,
    sessionId: "os-old",
  })))!;
}

describe("moveConversation", () => {
  test("an agent can never move a conversation", async () => {
    const c = await answered();
    expect(
      await moveConversation(c.id, "acme-api", AGENT, "It's about the API"),
    ).toEqual({
      ok: false,
      error: "Only a person can move this conversation",
    });
    expect(cancelled).toHaveLength(0);
    expect((await getConversation(c.id))!.project).toBe("acme");
  });

  test("a person may move", async () => {
    const c = await answered();
    expect(
      await moveConversation(c.id, "acme-api", ADA, "It's about the API"),
    ).toEqual({ ok: true });
  });

  test("a move cancels the old session and starts one under the target's Support settings", async () => {
    const c = await answered();
    expect(
      await moveConversation(c.id, "acme-api", ADA, "It's about the API"),
    ).toEqual({ ok: true });
    expect(cancelled).toEqual(["os-old"]);
    expect(created).toHaveLength(1);
    const opts = created[0]!;
    expect(opts.repo).toBe("acme-api");
    // The target ticks no connector; nothing comes over from the source.
    expect(opts.mcpServers).toEqual([]);
    expect(opts.model).toBe("pi/anthropic/claude-haiku-5");
    expect(opts.sandbox).toBe("podman");
    expect(opts.mode).toBe("ask");
    expect(opts.prompt).toContain(
      "This conversation was moved to this project from another one.",
    );
    expect(workspaces[0]?.repo).toBe("acme-api");
    const moved = (await getConversation(c.id))!;
    expect(moved.project).toBe("acme-api");
    expect(moved.sessionId).toBe("os-new-1");
    expect(moved.moves).toHaveLength(1);
    expect(moved.moves[0]).toMatchObject({
      from: "acme",
      to: "acme-api",
      by: ADA,
      reason: "It's about the API",
    });
  });

  test("a move needs a reason", async () => {
    const c = await answered();
    const result = await moveConversation(c.id, "acme-api", ADA, "  ");
    expect(result.ok).toBe(false);
    expect(cancelled).toHaveLength(0);
  });

  test("the target must be another registered project", async () => {
    const c = await answered();
    expect((await moveConversation(c.id, "acme", ADA, "Why")).ok).toBe(false);
    expect((await moveConversation(c.id, "nowhere", ADA, "Why")).ok).toBe(
      false,
    );
    expect((await getConversation(c.id))!.project).toBe("acme");
  });

  test("Watch only moves without starting an agent", async () => {
    await tb.setInbox({ autonomy: "watch" });
    const c = await answered();
    expect((await moveConversation(c.id, "acme-api", ADA, "API")).ok).toBe(
      true,
    );
    expect(cancelled).toEqual(["os-old"]);
    expect(created).toHaveLength(0);
    expect((await getConversation(c.id))!.sessionId).toBeNull();
  });
});

describe("setOwner", () => {
  test("sets a roster member as owner", async () => {
    const c = await tb.conversation();
    expect(await setOwner(c.id, "grace", "Ada")).toEqual({ ok: true });
    expect((await getConversation(c.id))!.owner).toBe("Grace");
  });

  test("a name not on the roster is refused", async () => {
    const c = await tb.conversation();
    const result = await setOwner(c.id, "Mallory", "Ada");
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect((await getConversation(c.id))!.owner).toBeNull();
  });
});

describe("close, reopen and not spam", () => {
  test("closing sets closedAt and marks the mail handled", async () => {
    const c = await tb.conversation();
    expect(await closeConversation(c.id, ADA)).toEqual({ ok: true });
    const closed = (await getConversation(c.id))!;
    expect(closed.status).toBe("closed");
    expect(closed.closedAt).not.toBeNull();
    expect(tb.adapter().marks).toEqual([
      { conversationId: c.id, state: "handled" },
    ]);
  });

  test("closing stops the agent, a veto window and a waiting retry; the agent can't send after", async () => {
    const c = await tb.conversation();
    const draft = (at: string, state: "veto" | "sending") => ({
      id: `sd_${state}`,
      text: "We fixed it.",
      author: AGENT,
      createdAt: at,
      state,
      rule: "test",
      vetoDeadline:
        state === "veto" ? new Date(Date.now() + 60_000).toISOString() : null,
      attempts: state === "sending" ? 1 : 0,
      nextAttemptAt:
        state === "sending"
          ? new Date(Date.now() + 60_000).toISOString()
          : null,
      lastError: state === "sending" ? "busy" : null,
      messageId: `<${state}@acme.example.test>`,
      decidedBy: ADA,
      attemptStartedAt: null,
    });
    await updateConversation(c.id, (x) => ({
      ...x,
      sessionId: "os-old",
      fixSessionId: "os-fix",
      draft: draft(new Date().toISOString(), "veto"),
    }));
    expect(await closeConversation(c.id, ADA)).toEqual({ ok: true });
    // The support session stops; a person's fix session is theirs.
    expect(cancelled).toEqual(["os-old"]);
    const closed = (await getConversation(c.id))!;
    expect(closed.draft?.state).toBe("needs-person");
    expect(closed.events.some((e) => e.kind === "closed")).toBe(true);

    // A retry a person once decided is dropped too.
    await reopenConversation(c.id, ADA);
    await updateConversation(c.id, (x) => ({
      ...x,
      draft: draft(new Date().toISOString(), "sending"),
    }));
    await closeConversation(c.id, ADA);
    expect((await getConversation(c.id))!.draft?.state).toBe("discarded");

    // The agent's next draft waits for a person.
    const late = await proposeDraft(
      c.id,
      "One more thing",
      AGENT,
      undefined,
      CITED,
    );
    expect(late.ok && late.draft.state).toBe("needs-person");
  });

  test("reopening clears closedAt", async () => {
    const c = await tb.conversation();
    await closeConversation(c.id, ADA);
    expect(await reopenConversation(c.id, ADA)).toEqual({ ok: true });
    const open = (await getConversation(c.id))!;
    expect(open.status).toBe("open");
    expect(open.closedAt).toBeNull();
  });

  test("not spam reopens it as work and starts the agent without triage", async () => {
    const c = await tb.conversation({ triage: { route: "spam" } });
    await updateConversation(c.id, (x) => ({
      ...x,
      status: "spam",
      closedAt: new Date().toISOString(),
    }));
    expect(await markNotSpam(c.id, "Ada")).toEqual({ ok: true });
    const open = (await getConversation(c.id))!;
    expect(open.status).toBe("open");
    expect(open.closedAt).toBeNull();
    expect(open.triage?.route).toBe("work");
    expect(open.sessionId).toBe("os-new-1");
    expect(created[0]!.repo).toBe("acme");
  });

  test("not spam on a conversation that isn't spam changes nothing", async () => {
    const c = await tb.conversation();
    expect((await markNotSpam(c.id, "Ada")).ok).toBe(false);
    expect(created).toHaveLength(0);
  });
});
