import { describe, expect, test } from "bun:test";
import type { SupportConversationView } from "../../shared/support";
import { proposeDraft } from "../support/reply";
import { getConversation } from "../support/store";
import { CITED, useReplyTestbed } from "../support/testing/reply-testbed";
import type { RouteContext } from "./context";
import { routeHandlers } from "./index";
import { handleSupportReplyRoutes } from "./support-replies";

const tb = useReplyTestbed();

const ADA = { login: "ada", name: "Ada Lovelace" };
// The built-in automation principal (isAutomationPrincipal).
const AUTOMATION = {
  login: "automation",
  name: "Automation",
  automation: true,
};

async function call(
  path: string,
  body?: unknown,
  auth: RouteContext["authUser"] | null = ADA,
): Promise<Response> {
  const url = new URL(`http://localhost${path}`);
  const res = await handleSupportReplyRoutes({
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

async function waitingDraft() {
  const c = await tb.conversation();
  const proposed = await proposeDraft(
    c.id,
    "Fixed, please retry.",
    { kind: "agent", sessionId: "os-1" },
    undefined,
    CITED,
  );
  if (!proposed.ok) throw new Error(proposed.error);
  return { c, draft: proposed.draft };
}

describe("support reply routes", () => {
  test("are registered", () => {
    expect(routeHandlers).toContain(handleSupportReplyRoutes);
  });

  test("need a signed-in person", async () => {
    const { c, draft } = await waitingDraft();
    for (const auth of [null, AUTOMATION]) {
      expect(
        (
          await call(
            `/api/support/conversations/${c.id}/reply`,
            { text: "Hi" },
            auth,
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await call(
            `/api/support/conversations/${c.id}/drafts/${draft.id}/send`,
            {},
            auth,
          )
        ).status,
      ).toBe(401);
    }
    expect(tb.fixture().sent).toHaveLength(0);
  });

  test("a reply to a missing conversation is 404", async () => {
    const res = await call("/api/support/conversations/sc_0000-missing/reply", {
      text: "Hi",
    });
    expect(res.status).toBe(404);
  });

  test("a reply without text is 400", async () => {
    const c = await tb.conversation();
    const res = await call(`/api/support/conversations/${c.id}/reply`, {});
    expect(res.status).toBe(400);
  });

  test("reply sends and returns the conversation", async () => {
    const c = await tb.conversation();
    const res = await call(`/api/support/conversations/${c.id}/reply`, {
      text: "Answered by hand.",
    });
    expect(res.status).toBe(200);
    const view = (await res.json()) as SupportConversationView;
    expect(view.conversation.id).toBe(c.id);
    expect(view.conversation.messages.at(-1)!.direction).toBe("out");
    expect(view.conversation.messages.at(-1)!.sentBy?.kind).toBe("person");
    expect(view.inbox?.id).toBe(tb.inbox().id);
    expect(tb.fixture().sent).toHaveLength(1);
  });

  test("send, with an edit", async () => {
    const { c, draft } = await waitingDraft();
    const res = await call(
      `/api/support/conversations/${c.id}/drafts/${draft.id}/send`,
      { text: "Edited reply." },
    );
    expect(res.status).toBe(200);
    const view = (await res.json()) as SupportConversationView;
    expect(view.conversation.draft).toBeNull();
    expect(view.conversation.messages.at(-1)!.text).toBe("Edited reply.");
    expect(tb.fixture().sent).toHaveLength(1);
  });

  test("discard", async () => {
    const { c, draft } = await waitingDraft();
    const res = await call(
      `/api/support/conversations/${c.id}/drafts/${draft.id}/discard`,
    );
    expect(res.status).toBe(200);
    const view = (await res.json()) as SupportConversationView;
    expect(view.conversation.draft?.state).toBe("discarded");
    // Sending it now conflicts.
    const again = await call(
      `/api/support/conversations/${c.id}/drafts/${draft.id}/send`,
    );
    expect(again.status).toBe(409);
  });

  test("stop", async () => {
    await tb.setInbox({ autonomy: "routine" });
    const { c, draft } = await waitingDraft();
    expect(draft.state).toBe("veto");
    const res = await call(
      `/api/support/conversations/${c.id}/drafts/${draft.id}/stop`,
    );
    expect(res.status).toBe(200);
    const view = (await res.json()) as SupportConversationView;
    expect(view.conversation.draft?.state).toBe("needs-person");
    expect((await getConversation(c.id))!.draft?.rule).toMatch(/^Stopped by /);
  });

  test("other paths and methods are not handled here", async () => {
    const url = new URL("http://localhost/api/support/conversations/sc_1");
    expect(
      await handleSupportReplyRoutes({
        req: new Request(url),
        url,
        path: url.pathname,
        publicPrefix: "/backstage",
        authUser: ADA,
      }),
    ).toBeUndefined();
  });
});

describe("support reply routes: who and which", () => {
  test("a reply records the signed-in login and the display name", async () => {
    const c = await tb.conversation();
    const res = await call(`/api/support/conversations/${c.id}/reply`, {
      text: "Answered by hand.",
    });
    expect(res.status).toBe(200);
    const out = (await getConversation(c.id))!.messages.at(-1)!;
    expect(out.sentBy).toMatchObject({ kind: "person", login: "ada" });
    const row = tb.kernel.audits.find((a) => a.type === "support.reply")!;
    expect(row.by).toBe("ada");
  });

  test("ids that aren't a conversation's or a draft's are 404", async () => {
    const { c } = await waitingDraft();
    for (const path of [
      "/api/support/conversations/sc_NOT-HEX/reply",
      "/api/support/conversations/nope/reply",
      `/api/support/conversations/${c.id}/drafts/nope/send`,
    ])
      expect((await call(path, { text: "Hi" })).status).toBe(404);
    expect(tb.fixture().sent).toHaveLength(0);
  });
});
