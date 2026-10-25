import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SupportConversationView } from "../../shared/support";
import { __setOwnerRosterForTest } from "../incidents/owner";
import { __setActionDepsForTest } from "../support/actions";
import { __setBugDepsForTest } from "../support/bugs";
import { __setRoutingDepsForTest } from "../support/routing";
import { getConversation, updateConversation } from "../support/store";
import { useReplyTestbed } from "../support/testing/reply-testbed";
import type { RouteContext } from "./context";
import { routeHandlers } from "./index";
import { handleSupportActionRoutes } from "./support-actions";

const tb = useReplyTestbed();

// Ada is the first roster member, so the instance owner.
const ADA = { login: "ada", name: "Ada Lovelace" };
const GRACE = { login: "grace", name: "Grace Hopper" };
// The built-in automation principal (isAutomationPrincipal).
const AUTOMATION = {
  login: "automation",
  name: "Automation",
  automation: true,
};

let posted = 0;

beforeEach(() => {
  posted = 0;
  __setOwnerRosterForTest([
    { name: "Ada Lovelace", github: "ada" },
    { name: "Grace Hopper", github: "grace" },
  ]);
  __setRoutingDepsForTest({
    runSpec: async () => ({
      model: "pi/anthropic/claude-sonnet-5",
      mcpServers: [],
      mode: "ask",
      sandbox: { ok: true, request: "daytona" },
    }),
    resolveWorkspace: async (input) => ({
      workspace: { id: `ws-${input.ref.id}` },
    }),
    control: () => ({
      async createSession() {
        return {
          id: "os-new",
          createdBy: "Sessions",
          createdAt: new Date().toISOString(),
        };
      },
      async deliverToSession() {
        return { status: "queued", message: "Queued" };
      },
    }),
  });
  __setActionDepsForTest({ cancelSession: async () => true });
  __setBugDepsForTest({
    ghRepo: () => "acme/acme",
    isPublic: async () => true,
    createIssue: async () => {
      posted++;
      return {
        number: 7,
        url: "https://github.com/acme/acme/issues/7",
        repo: "acme/acme",
      };
    },
  });
});

afterEach(() => {
  __setBugDepsForTest(undefined);
  __setActionDepsForTest(undefined);
  __setRoutingDepsForTest(undefined);
  __setOwnerRosterForTest(undefined);
});

async function call(
  path: string,
  body?: unknown,
  auth: RouteContext["authUser"] | null = ADA,
): Promise<Response> {
  const url = new URL(`http://localhost${path}`);
  const res = await handleSupportActionRoutes({
    req: new Request(url, {
      method: "POST",
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(body),
            headers: { "Content-Type": "application/json" },
          }),
    }),
    url,
    path: url.pathname,
    publicPrefix: "/backstage",
    authUser: auth ?? undefined,
  });
  if (!res) throw new Error(`POST ${path} was not handled`);
  return res;
}

const base = (id: string) => `/api/support/conversations/${id}`;

describe("support action routes", () => {
  test("are registered", () => {
    expect(routeHandlers).toContain(handleSupportActionRoutes);
  });

  test("need a signed-in person", async () => {
    const c = await tb.conversation();
    for (const auth of [null, AUTOMATION]) {
      for (const [action, body] of [
        ["move", { project: "acme-api", reason: "API" }],
        ["owner", { owner: "grace" }],
        ["close", undefined],
        ["reopen", undefined],
        ["not-spam", undefined],
        ["issue/approve", undefined],
        ["issue/dismiss", undefined],
      ] as const) {
        const res = await call(`${base(c.id)}/${action}`, body, auth);
        expect(res.status).toBe(401);
      }
    }
    const stored = (await getConversation(c.id))!;
    expect(stored.project).toBe("acme");
    expect(stored.status).toBe("open");
  });

  test("other paths are left to other handlers", async () => {
    const url = new URL("http://localhost/api/support/conversations/x/reply");
    expect(
      await handleSupportActionRoutes({
        req: new Request(url, { method: "POST" }),
        url,
        path: url.pathname,
        publicPrefix: "/backstage",
        authUser: ADA,
      }),
    ).toBeUndefined();
  });

  test("move answers with the conversation, and needs a reason", async () => {
    const c = await tb.conversation();
    expect(
      (await call(`${base(c.id)}/move`, { project: "acme-api" })).status,
    ).toBe(400);
    const res = await call(`${base(c.id)}/move`, {
      project: "acme-api",
      reason: "It's about the API",
    });
    expect(res.status).toBe(200);
    const view = (await res.json()) as SupportConversationView;
    expect(view.conversation.project).toBe("acme-api");
    expect(view.conversation.moves[0]?.by).toEqual({
      kind: "person",
      name: "Ada",
      login: "ada",
    });
  });

  test("owner, close and reopen", async () => {
    const c = await tb.conversation();
    const owner = await call(`${base(c.id)}/owner`, { owner: "grace" });
    expect(owner.status).toBe(200);
    expect(
      ((await owner.json()) as SupportConversationView).conversation.owner,
    ).toBe("Grace");
    expect(
      (await call(`${base(c.id)}/owner`, { owner: "Mallory" })).status,
    ).toBe(400);
    const closed = await call(`${base(c.id)}/close`);
    expect(closed.status).toBe(200);
    expect(
      ((await closed.json()) as SupportConversationView).conversation.status,
    ).toBe("closed");
    const reopened = await call(`${base(c.id)}/reopen`);
    expect(reopened.status).toBe(200);
    expect(
      ((await reopened.json()) as SupportConversationView).conversation.status,
    ).toBe("open");
  });

  test("not spam", async () => {
    const c = await tb.conversation({ triage: { route: "spam" } });
    await updateConversation(c.id, (x) => ({ ...x, status: "spam" }));
    const res = await call(`${base(c.id)}/not-spam`);
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as SupportConversationView).conversation.status,
    ).toBe("open");
  });

  test("approve and dismiss a held issue", async () => {
    const c = await tb.conversation();
    const held = {
      title: "Export fails",
      body: "Steps\n\nReported from a support conversation in Sessions.",
      requestedBy: { kind: "agent" as const, sessionId: "os-1" },
      ghRepo: "acme/acme",
    };
    await updateConversation(c.id, (x) => ({ ...x, pendingIssue: held }));
    expect((await call(`${base(c.id)}/issue/dismiss`)).status).toBe(200);
    const gone = (await getConversation(c.id))!;
    expect(
      (
        await call(`${base(c.id)}/issue/approve`, {
          expectedRevision: gone.revision,
        })
      ).status,
    ).toBe(409);
    expect(posted).toBe(0);
    const again = (await updateConversation(c.id, (x) => ({
      ...x,
      pendingIssue: held,
    })))!;
    // Without the revision the person saw, nothing is posted.
    expect((await call(`${base(c.id)}/issue/approve`)).status).toBe(400);
    expect(
      (
        await call(`${base(c.id)}/issue/approve`, {
          expectedRevision: again.revision - 1,
        })
      ).status,
    ).toBe(409);
    expect(posted).toBe(0);
    const approved = await call(`${base(c.id)}/issue/approve`, {
      expectedRevision: again.revision,
    });
    expect(approved.status).toBe(200);
    expect(
      ((await approved.json()) as SupportConversationView).conversation.issue
        ?.number,
    ).toBe(7);
    expect(posted).toBe(1);
  });

  test("only the instance owner approves an issue for a public repository", async () => {
    const c = await tb.conversation();
    const held = (await updateConversation(c.id, (x) => ({
      ...x,
      pendingIssue: {
        title: "Export fails",
        body: "Steps",
        requestedBy: { kind: "agent" as const, sessionId: "os-1" },
        ghRepo: "acme/acme",
      },
    })))!;
    const res = await call(
      `${base(c.id)}/issue/approve`,
      { expectedRevision: held.revision },
      GRACE,
    );
    expect(res.status).toBe(403);
    expect(posted).toBe(0);
  });

  test("an unknown conversation is 404", async () => {
    expect((await call(`${base("sc_00000000-0000")}/close`)).status).toBe(404);
  });

  test("accepts the list item id", async () => {
    const c = await tb.conversation();
    expect(
      (
        await call(
          `/api/support/conversations/${encodeURIComponent(`email:${c.id}`)}/close`,
        )
      ).status,
    ).toBe(200);
  });
});
