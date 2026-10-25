import { describe, expect, test } from "bun:test";
import type { AttachmentMeta, SupportMessage } from "../../shared/support";
import { saveAttachment } from "../support/attachments";
import { createConversation, updateConversation } from "../support/store";
import { useSupportTestKernel } from "../support/testing/kernel-fixture";
import type { RouteContext } from "./context";
import { routeHandlers } from "./index";
import { handleSupportRoutes } from "./support";

useSupportTestKernel();

const ADA = { login: "ada", name: "Ada Lovelace" };
// The built-in automation principal (isAutomationPrincipal).
const AUTOMATION = {
  login: "automation",
  name: "Automation",
  automation: true,
};

async function call(
  path: string,
  auth: RouteContext["authUser"] = ADA,
): Promise<Response | undefined> {
  const url = new URL(`http://localhost${path}`);
  return handleSupportRoutes({
    req: new Request(url),
    url,
    path: url.pathname,
    publicPrefix: "/backstage",
    authUser: auth,
  });
}

function message(attachments: AttachmentMeta[] = []): SupportMessage {
  return {
    id: "sm_1",
    direction: "in",
    at: new Date().toISOString(),
    from: { name: "Ada", address: "ada@example.test" },
    to: [{ name: null, address: "help@acme.example.test" }],
    cc: [],
    subject: "Login broken",
    text: "Please help",
    keys: { messageId: "m1@example.test", inReplyTo: null, references: [] },
    providerId: "imap:1:1",
    attachments,
  };
}

async function conversationWith(
  files: Array<{ id: string; mimeType: string; savedAgoMs?: number }>,
) {
  const first = message();
  const created = await createConversation({
    channel: "email",
    inboxId: "inb_acme",
    project: "acme",
    subject: first.subject,
    customer: first.from,
    owner: null,
    first,
    now: first.at,
  });
  const attachments: AttachmentMeta[] = [];
  for (const f of files)
    attachments.push(
      await saveAttachment(
        created.id,
        {
          id: f.id,
          fileName: `${f.id}.bin`,
          mimeType: f.mimeType,
          sizeBytes: 0,
          stored: false,
          expiresAt: null,
        },
        new TextEncoder().encode(`<b>${f.id}</b>`),
        { conversationDays: 180, attachmentDays: 30 },
        Date.now() - (f.savedAgoMs ?? 0),
      ),
    );
  await updateConversation(created.id, (c) => ({
    ...c,
    messages: [{ ...c.messages[0]!, attachments }],
  }));
  return created.id;
}

test("is registered in the route chain", () => {
  expect(routeHandlers).toContain(handleSupportRoutes);
});

test("other paths fall through", async () => {
  expect(await call("/api/supportx")).toBeUndefined();
  expect(await call("/api/plain/threads")).toBeUndefined();
});

describe("auth", () => {
  test.each([
    "/api/support/conversations",
    "/api/support/conversations/sc_0190",
    "/api/support/conversations/sc_0190/attachments/att_1",
  ])("401 without a signed-in person: %s", async (path) => {
    expect((await call(path, null))?.status).toBe(401);
    expect((await call(path, AUTOMATION))?.status).toBe(401);
  });
});

test("the list returns items and channels", async () => {
  const id = await conversationWith([]);
  const res = await call("/api/support/conversations");
  expect(res?.status).toBe(200);
  const body = await res!.json();
  expect(body.items.map((i: { id: string }) => i.id)).toEqual([`email:${id}`]);
  expect(body.channels[0]).toMatchObject({ channel: "email", error: null });
});

describe("one conversation", () => {
  test("404 for an unknown id", async () => {
    expect((await call("/api/support/conversations/sc_0190-ab"))?.status).toBe(
      404,
    );
    expect((await call("/api/support/conversations/nope"))?.status).toBe(404);
  });

  test("the view, by conversation id or item id", async () => {
    const id = await conversationWith([]);
    for (const ref of [id, `email:${id}`]) {
      const res = await call(
        `/api/support/conversations/${encodeURIComponent(ref)}`,
      );
      expect(res?.status).toBe(200);
      const body = await res!.json();
      expect(body.conversation.id).toBe(id);
      expect(body.inbox).toBeNull();
    }
  });
});

describe("attachments", () => {
  test("an HTML attachment is served as bytes to download", async () => {
    const id = await conversationWith([{ id: "att_1", mimeType: "text/html" }]);
    const res = await call(
      `/api/support/conversations/${id}/attachments/att_1`,
    );
    expect(res?.status).toBe(200);
    expect(res!.headers.get("content-type")).toBe("application/octet-stream");
    expect(res!.headers.get("content-disposition")).toStartWith("attachment");
    expect(res!.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res!.text()).toBe("<b>att_1</b>");
  });

  test("an image keeps its type", async () => {
    const id = await conversationWith([{ id: "att_2", mimeType: "image/png" }]);
    const res = await call(
      `/api/support/conversations/${id}/attachments/att_2`,
    );
    expect(res!.headers.get("content-type")).toBe("image/png");
    expect(res!.headers.get("content-disposition")).toStartWith("attachment");
  });

  test("410 once expired, 404 for an unknown attachment", async () => {
    const id = await conversationWith([
      { id: "att_3", mimeType: "application/pdf", savedAgoMs: 31 * 86_400_000 },
    ]);
    expect(
      (await call(`/api/support/conversations/${id}/attachments/att_3`))
        ?.status,
    ).toBe(410);
    expect(
      (await call(`/api/support/conversations/${id}/attachments/att_9`))
        ?.status,
    ).toBe(404);
  });

  test("410 when retention already removed the file", async () => {
    const id = await conversationWith([]);
    await updateConversation(id, (c) => ({
      ...c,
      messages: [
        {
          ...c.messages[0]!,
          attachments: [
            {
              id: "att_4",
              fileName: "old.pdf",
              mimeType: "application/pdf",
              sizeBytes: 10,
              stored: false,
              expiresAt: null,
            },
          ],
        },
      ],
    }));
    expect(
      (await call(`/api/support/conversations/${id}/attachments/att_4`))
        ?.status,
    ).toBe(410);
  });
});
