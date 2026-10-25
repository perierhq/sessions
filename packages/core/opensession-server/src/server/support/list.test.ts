import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { SupportIndexRow, SupportMessage } from "../../shared/support";
import type { SupportThreadSummary } from "../../agents/plain/api";
import {
  __setPlainThreadsForTest,
  emailItem,
  listSupportItems as listAs,
  plainItem,
  SUPPORT_EMAIL_LIST_LIMIT,
} from "./list";
import { createConversation, updateConversation } from "./store";
import { useSupportTestKernel } from "./testing/kernel-fixture";

useSupportTestKernel();
afterEach(() => __setPlainThreadsForTest(undefined));

const listSupportItems = () => listAs({ person: "Ada" });

let seq = 0;
function message(at: string, address: string): SupportMessage {
  seq += 1;
  return {
    id: `sm_${seq}`,
    direction: "in",
    at,
    from: { name: "Ada", address },
    to: [{ name: null, address: "help@acme.example.test" }],
    cc: [],
    subject: `Question ${seq}`,
    text: `Body ${seq}`,
    keys: {
      messageId: `m${seq}@example.test`,
      inReplyTo: null,
      references: [],
    },
    providerId: `imap:1:${seq}`,
    attachments: [],
  };
}

async function conversation(at: string, status?: "closed") {
  const first = message(at, `c${seq}@example.test`);
  const created = await createConversation({
    channel: "email",
    inboxId: "inb_acme",
    project: "acme",
    subject: first.subject,
    customer: first.from,
    owner: null,
    first,
    now: at,
  });
  if (!status) return created;
  return (await updateConversation(created.id, (c) => ({
    ...c,
    status,
    closedAt: at,
  })))!;
}

const thread = (over: Partial<SupportThreadSummary> = {}) =>
  ({
    id: "th_1",
    title: "Refund please",
    previewText: "I was charged twice",
    status: "TODO",
    statusChangedAt: "2026-10-25T09:00:00.000Z",
    createdAt: "2026-10-24T09:00:00.000Z",
    priority: 0,
    labels: [],
    customer: { name: "Grace", email: "grace@example.test" },
    assignee: null,
    ...over,
  }) satisfies SupportThreadSummary;

describe("listSupportItems", () => {
  test("open email conversations, newest first; closed ones are left out", async () => {
    const older = await conversation("2026-10-25T08:00:00.000Z");
    const newer = await conversation("2026-10-25T09:30:00.000Z");
    await conversation("2026-10-25T10:00:00.000Z", "closed");
    const { items, channels } = await listSupportItems();
    expect(items.map((i) => i.id)).toEqual([
      `email:${newer.id}`,
      `email:${older.id}`,
    ]);
    expect(channels).toEqual([
      { channel: "email", label: "Email", error: null },
    ]);
  });

  test("without a signed-in person: Plain rows only, and email says why", async () => {
    await conversation("2026-10-25T08:00:00.000Z");
    __setPlainThreadsForTest(async () => [thread()]);
    const { items, channels } = await listAs({ person: null });
    expect(items.map((i) => i.id)).toEqual(["plain:th_1"]);
    expect(channels).toEqual([
      {
        channel: "email",
        label: "Email",
        error: "Sign in to read support mail",
      },
      { channel: "plain", label: "Plain", error: null },
    ]);
  });

  test("the email list stops at the newest conversations and says so", async () => {
    const first = await conversation("2026-10-25T08:00:00.000Z");
    for (let i = 0; i < SUPPORT_EMAIL_LIST_LIMIT; i++)
      await conversation(
        new Date(Date.parse("2026-10-25T09:00:00.000Z") + i * 1000).toISOString(),
      );
    const out = await listSupportItems();
    expect(SUPPORT_EMAIL_LIST_LIMIT).toBe(200);
    expect(out.items).toHaveLength(SUPPORT_EMAIL_LIST_LIMIT);
    expect(out.items.some((i) => i.id === `email:${first.id}`)).toBe(false);
    expect(out.truncated).toBe(true);
  });

  test("Plain rows join the list when the integration is loaded", async () => {
    const email = await conversation("2026-10-25T08:00:00.000Z");
    __setPlainThreadsForTest(async () => [thread()]);
    const { items, channels } = await listSupportItems();
    expect(items.map((i) => i.id)).toEqual(["plain:th_1", `email:${email.id}`]);
    expect(channels.map((c) => c.channel)).toEqual(["email", "plain"]);
  });

  test("a Plain failure keeps the email rows and gives fixed copy", async () => {
    const email = await conversation("2026-10-25T08:00:00.000Z");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const reason of [
        new Error("GraphQL: token xyz rejected"),
        { code: 500 },
      ]) {
        __setPlainThreadsForTest(async () => {
          throw reason;
        });
        const { items, channels, truncated } = await listSupportItems();
        expect(items.map((i) => i.id)).toEqual([`email:${email.id}`]);
        expect(truncated).toBe(false);
        expect(channels).toContainEqual({
          channel: "plain",
          label: "Plain",
          error: "Plain could not be reached",
        });
        // The raw error goes to the log, not the page.
        expect(warn.mock.calls.at(-1)).toContain(reason);
      }
    } finally {
      warn.mockRestore();
    }
  });
});

describe("row mapping", () => {
  const row: SupportIndexRow = {
    id: "sc_0190-ab",
    channel: "email",
    inboxId: "inb_acme",
    project: "acme",
    subject: "Login broken",
    preview: "I can't sign in",
    customer: { name: "Ada", address: "ada@example.test" },
    status: "waiting",
    owner: null,
    lastMessageAt: "2026-10-25T09:00:00.000Z",
    closedAt: null,
    draftState: "veto",
    vetoDeadline: "2026-10-25T09:05:00.000Z",
    sessionId: "s_1",
    unansweredSince: null,
    attachmentsExpireAt: null,
  };

  test("emailItem maps the index row", () => {
    expect(emailItem(row, "Acme help")).toEqual({
      id: "email:sc_0190-ab",
      channel: "email",
      title: "Login broken",
      preview: "I can't sign in",
      customer: { name: "Ada", email: "ada@example.test" },
      priority: null,
      status: "waiting",
      at: "2026-10-25T09:00:00.000Z",
      inbox: { id: "inb_acme", label: "Acme help" },
      project: "acme",
      draftState: "veto",
      vetoDeadline: "2026-10-25T09:05:00.000Z",
      sessionId: "s_1",
    });
    expect(emailItem(row, null).inbox).toBeNull();
  });

  test("plainItem maps the Plain list row", () => {
    expect(plainItem(thread())).toEqual({
      id: "plain:th_1",
      channel: "plain",
      title: "Refund please",
      preview: "I was charged twice",
      customer: { name: "Grace", email: "grace@example.test" },
      priority: 0,
      status: "TODO",
      at: "2026-10-25T09:00:00.000Z",
      inbox: null,
      project: null,
      draftState: null,
      vetoDeadline: null,
      sessionId: null,
    });
    expect(
      plainItem(
        thread({ title: null, previewText: null, statusChangedAt: null }),
      ).at,
    ).toBe("2026-10-24T09:00:00.000Z");
  });
});
