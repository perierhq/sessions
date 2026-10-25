import { describe, expect, spyOn, test } from "bun:test";
import type {
  AttachmentMeta,
  InboxConfig,
  InboxRetention,
  SupportConversation,
  SupportMessage,
} from "../../shared/support";
import { digest } from "../audit";
import { readAttachment, saveAttachment } from "./attachments";
import {
  type RetentionDeps,
  forgetCustomer,
  sweepRetention,
} from "./retention";
import * as store from "./store";
import {
  createConversation,
  getConversation,
  listIndexRows,
  lookupMessageIds,
  rememberMessageIds,
  updateConversation,
} from "./store";
import { useSupportTestKernel } from "./testing/kernel-fixture";

const kernel = useSupportTestKernel();

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-25T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const daysAgo = (days: number) => iso(NOW - days * DAY);

const RETENTION: Record<string, InboxRetention> = {
  inb_acme: { conversationDays: 180, attachmentDays: 30 },
  inb_api: { conversationDays: 30, attachmentDays: 7 },
};

function deps(over: Partial<RetentionDeps> = {}): {
  deps: Partial<RetentionDeps>;
  deletedSessions: string[];
} {
  const deletedSessions: string[] = [];
  return {
    deletedSessions,
    deps: {
      now: () => NOW,
      inbox: async (id) =>
        RETENTION[id]
          ? ({ id, retention: RETENTION[id] } as unknown as InboxConfig)
          : null,
      deleteSession: async (id) => {
        deletedSessions.push(id);
      },
      ...over,
    },
  };
}

let seq = 0;
function message(
  address: string,
  attachments: AttachmentMeta[] = [],
): SupportMessage {
  seq += 1;
  return {
    id: `msg_${seq}`,
    direction: "in",
    at: daysAgo(400),
    from: { name: null, address },
    to: [{ name: null, address: "help@acme.example.test" }],
    cc: [],
    subject: "Login broken",
    text: "Please help",
    keys: {
      messageId: `m${seq}@example.test`,
      inReplyTo: null,
      references: [],
    },
    providerId: `imap:1:${seq}`,
    attachments,
  };
}

async function conversation(opts: {
  inboxId?: string;
  customer?: string;
  closedDaysAgo?: number | null;
  attachments?: Array<{ id: string; savedDaysAgo: number }>;
  patch?: Partial<SupportConversation>;
}): Promise<SupportConversation> {
  const inboxId = opts.inboxId ?? "inb_acme";
  const customer = opts.customer ?? "ada@example.test";
  const first = message(customer);
  const created = await createConversation({
    channel: "email",
    inboxId,
    project: "acme",
    subject: first.subject,
    customer: first.from,
    owner: null,
    first,
    now: daysAgo(400),
  });
  const attachments: AttachmentMeta[] = [];
  for (const a of opts.attachments ?? [])
    attachments.push(
      await saveAttachment(
        created.id,
        {
          id: a.id,
          fileName: `${a.id}.pdf`,
          mimeType: "application/pdf",
          sizeBytes: 0,
          stored: false,
          expiresAt: null,
        },
        new TextEncoder().encode(a.id),
        RETENTION[inboxId] ?? { conversationDays: 180, attachmentDays: 30 },
        NOW - a.savedDaysAgo * DAY,
      ),
    );
  await rememberMessageIds(
    inboxId,
    created.id,
    [first.keys.messageId!],
    [first.providerId!],
  );
  const closed =
    opts.closedDaysAgo === undefined || opts.closedDaysAgo === null
      ? null
      : daysAgo(opts.closedDaysAgo);
  const updated = await updateConversation(created.id, (c) => ({
    ...c,
    ...opts.patch,
    status: closed ? "closed" : (opts.patch?.status ?? c.status),
    closedAt: closed,
    messages: [{ ...c.messages[0]!, attachments }],
  }));
  return updated!;
}

describe("sweepRetention", () => {
  test("deletes conversations closed longer than the inbox keeps them", async () => {
    const old = await conversation({
      closedDaysAgo: 181,
      attachments: [{ id: "att_1", savedDaysAgo: 1 }],
    });
    const recent = await conversation({ closedDaysAgo: 179 });
    const open = await conversation({ closedDaysAgo: null });
    const { deps: d } = deps();

    const result = await sweepRetention(d);

    expect(result).toEqual({ conversationsDeleted: 1, attachmentsExpired: 0 });
    expect(await getConversation(old.id)).toBeNull();
    expect(await readAttachment(old.id, "att_1")).toBeNull();
    expect(
      await lookupMessageIds("inb_acme", [old.messages[0]!.keys.messageId!]),
    ).toEqual(new Map());
    expect((await listIndexRows()).map((r) => r.id).sort()).toEqual(
      [recent.id, open.id].sort(),
    );
  });

  test("uses each inbox's own conversation days", async () => {
    const api = await conversation({ inboxId: "inb_api", closedDaysAgo: 31 });
    const acme = await conversation({ closedDaysAgo: 31 });
    const { deps: d } = deps();
    await sweepRetention(d);
    expect(await getConversation(api.id)).toBeNull();
    expect(await getConversation(acme.id)).not.toBeNull();
  });

  test("a conversation whose inbox is gone uses the default retention", async () => {
    const kept = await conversation({
      inboxId: "inb_gone",
      closedDaysAgo: 179,
    });
    const gone = await conversation({
      inboxId: "inb_gone",
      closedDaysAgo: 181,
    });
    const { deps: d } = deps();
    await sweepRetention(d);
    expect(await getConversation(kept.id)).not.toBeNull();
    expect(await getConversation(gone.id)).toBeNull();
  });

  test("expired attachments lose their file but keep name and size", async () => {
    const c = await conversation({
      attachments: [
        { id: "att_old", savedDaysAgo: 31 },
        { id: "att_new", savedDaysAgo: 10 },
      ],
    });
    const { deps: d } = deps();

    const result = await sweepRetention(d);

    expect(result).toEqual({ conversationsDeleted: 0, attachmentsExpired: 1 });
    expect(await readAttachment(c.id, "att_old")).toBeNull();
    expect(await readAttachment(c.id, "att_new")).not.toBeNull();
    const after = (await getConversation(c.id))!;
    const [old, fresh] = after.messages[0]!.attachments;
    expect(old).toEqual({
      id: "att_old",
      fileName: "att_old.pdf",
      mimeType: "application/pdf",
      sizeBytes: "att_old".length,
      stored: false,
      expiresAt: null,
    });
    expect(fresh!.stored).toBe(true);
    const [row] = await listIndexRows();
    expect(row!.attachmentsExpireAt).toBe(fresh!.expiresAt);

    // The last one expires too: the row has nothing left to expire.
    const later = deps({ now: () => NOW + 30 * DAY });
    expect(await sweepRetention(later.deps)).toEqual({
      conversationsDeleted: 0,
      attachmentsExpired: 1,
    });
    expect((await listIndexRows())[0]!.attachmentsExpireAt).toBeNull();
  });

  test("reads only the index and the conversations that are due", async () => {
    const due = await conversation({ closedDaysAgo: 181 });
    const expiring = await conversation({
      attachments: [{ id: "att_1", savedDaysAgo: 31 }],
    });
    await conversation({ closedDaysAgo: 10 });
    await conversation({
      attachments: [{ id: "att_2", savedDaysAgo: 1 }],
    });
    const spy = spyOn(store, "getConversation");
    try {
      const { deps: d } = deps();
      await sweepRetention(d);
      const read = new Set(spy.mock.calls.map(([id]) => id));
      expect([...read].sort()).toEqual([due.id, expiring.id].sort());
    } finally {
      spy.mockRestore();
    }
  });
});

describe("forgetCustomer", () => {
  test("deletes everything Sessions holds for the customer and says what stays", async () => {
    const a = await conversation({
      customer: "ada@example.test",
      attachments: [{ id: "att_1", savedDaysAgo: 1 }],
      patch: { sessionId: "ses_a", fixSessionId: "ses_fix" },
    });
    const b = await conversation({
      inboxId: "inb_api",
      customer: "ada@example.test",
      attachments: [
        { id: "att_2", savedDaysAgo: 1 },
        { id: "att_3", savedDaysAgo: 1 },
      ],
      patch: {
        sessionId: "ses_b",
        issue: {
          repo: "acme/app",
          number: 7,
          url: "https://github.com/acme/app/issues/7",
        },
      },
    });
    const other = await conversation({
      customer: "grace@example.test",
      patch: { sessionId: "ses_other" },
    });
    const { deps: d, deletedSessions } = deps();

    const result = await forgetCustomer("Ada@Example.test", "kacper", d);

    expect(result).toEqual({
      conversations: 2,
      sessions: 3,
      attachments: 3,
      notDeleted: [
        "Mail in the mailbox",
        "https://github.com/acme/app/issues/7",
      ],
    });
    expect(deletedSessions.sort()).toEqual(["ses_a", "ses_b", "ses_fix"]);
    expect(await getConversation(a.id)).toBeNull();
    expect(await getConversation(b.id)).toBeNull();
    expect(await readAttachment(b.id, "att_2")).toBeNull();
    expect(await getConversation(other.id)).not.toBeNull();
    expect(kernel.audits).toEqual([
      {
        type: "support.forget",
        by: "kacper",
        customer: digest("ada@example.test"),
        conversations: 2,
      },
    ]);
    expect(JSON.stringify(kernel.audits).toLowerCase()).not.toContain("ada@");
  });

  test("a customer Sessions never saw still gets a record", async () => {
    const { deps: d, deletedSessions } = deps();
    expect(await forgetCustomer("nobody@example.test", "kacper", d)).toEqual({
      conversations: 0,
      sessions: 0,
      attachments: 0,
      notDeleted: ["Mail in the mailbox"],
    });
    expect(deletedSessions).toEqual([]);
    expect(kernel.audits).toHaveLength(1);
  });

  test("a session that fails to delete keeps the conversation for a retry", async () => {
    const c = await conversation({ patch: { sessionId: "ses_a" } });
    const { deps: d } = deps({
      deleteSession: async () => {
        throw new Error("still stopping");
      },
    });
    await expect(
      forgetCustomer("ada@example.test", "kacper", d),
    ).rejects.toThrow("still stopping");
    expect(await getConversation(c.id)).not.toBeNull();
  });
});
