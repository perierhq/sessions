import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type {
  AttachmentMeta,
  InboxConfig,
  InboxRetention,
  SupportConversation,
  SupportMessage,
} from "../../shared/support";
import { utimes } from "node:fs/promises";
import { join } from "node:path";
import { digest } from "../audit";
import type { SessionDeleteResult } from "../session-delete";
import type { UnifiedSession } from "../types";
import { resolveWorkspaceSecretAsync } from "../workspace-secrets";
import { catalogDocuments } from "../catalog-documents";
import { ATTACHMENTS_DIR, readAttachment, saveAttachment } from "./attachments";
import {
  FORGET_KEY_REF,
  type RetentionDeps,
  __resetRetentionForTest,
  customerDigest,
  deleteSupportSession,
  deleteSupportWorkspace,
  forgetCustomer,
  startSupportRetention,
  sweepRetention,
} from "./retention";
import { ForbiddenError } from "./actor";
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
afterEach(() => __resetRetentionForTest());

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
  /** Sessions deleted with their worktree. */
  worktrees: string[];
  /** Conversations whose support workspace was deleted. */
  workspaces: string[];
} {
  const deletedSessions: string[] = [];
  const worktrees: string[] = [];
  const workspaces: string[] = [];
  return {
    deletedSessions,
    worktrees,
    workspaces,
    deps: {
      deleteWorkspace: async (conversationId) => {
        workspaces.push(conversationId);
      },
      now: () => NOW,
      inbox: async (id) =>
        RETENTION[id]
          ? ({ id, retention: RETENTION[id] } as unknown as InboxConfig)
          : null,
      deleteSession: async (id, cleanWorktree) => {
        deletedSessions.push(id);
        if (cleanWorktree) worktrees.push(id);
      },
      shuttingDown: () => false,
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

    expect(result).toEqual({
      conversationsDeleted: 1,
      attachmentsExpired: 0,
      orphansRemoved: 0,
    });
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

    expect(result).toEqual({
      conversationsDeleted: 0,
      attachmentsExpired: 1,
      orphansRemoved: 0,
    });
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
      orphansRemoved: 0,
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

describe("sweepRetention, linked sessions and bounds", () => {
  test("deletes the linked sessions before the conversation", async () => {
    const old = await conversation({
      closedDaysAgo: 181,
      patch: { sessionId: "ses_support", fixSessionId: "ses_fix" },
    });
    const order: string[] = [];
    const { deps: d, deletedSessions, worktrees } = deps();
    const deleteSession = d.deleteSession!;
    d.deleteSession = async (id, clean) => {
      order.push(`${id}:${(await getConversation(old.id)) ? "kept" : "gone"}`);
      await deleteSession(id, clean);
    };

    await sweepRetention(d);

    expect(deletedSessions.sort()).toEqual(["ses_fix", "ses_support"]);
    // The support session's worktree holds nothing worth keeping; the fix
    // session's may hold a fix branch.
    expect(worktrees).toEqual(["ses_support"]);
    expect(order.sort()).toEqual(["ses_fix:kept", "ses_support:kept"]);
    expect(await getConversation(old.id)).toBeNull();
  });

  test("deletes the conversation's support workspace after its sessions", async () => {
    const old = await conversation({
      closedDaysAgo: 181,
      patch: { sessionId: "ses_support" },
    });
    const kept = await conversation({ closedDaysAgo: 10 });
    const order: string[] = [];
    const { deps: d } = deps({
      deleteSession: async (id) => {
        order.push(`session:${id}`);
      },
      deleteWorkspace: async (conversationId, deleted) => {
        order.push(`workspace:${conversationId}:${[...deleted].join(",")}`);
      },
    });

    await sweepRetention(d);

    expect(order).toEqual([
      "session:ses_support",
      `workspace:${old.id}:ses_support`,
    ]);
    expect(await getConversation(kept.id)).not.toBeNull();
  });

  test("a session that refuses to go keeps its conversation for the next sweep", async () => {
    const old = await conversation({
      closedDaysAgo: 181,
      patch: { sessionId: "ses_support" },
    });
    const { deps: d } = deps({
      deleteSession: async () => {
        throw new Error("still stopping");
      },
    });
    expect((await sweepRetention(d)).conversationsDeleted).toBe(0);
    expect(await getConversation(old.id)).not.toBeNull();
    expect((await listIndexRows()).map((r) => r.id)).toEqual([old.id]);
  });

  test("one run acts on at most maxActions conversations; the rest wait", async () => {
    for (let i = 0; i < 3; i++) await conversation({ closedDaysAgo: 200 });
    const { deps: d } = deps({ maxActions: 2 });
    expect((await sweepRetention(d)).conversationsDeleted).toBe(2);
    expect(await listIndexRows()).toHaveLength(1);
    expect((await sweepRetention(d)).conversationsDeleted).toBe(1);
    expect(await listIndexRows()).toEqual([]);
  });

  test("stops between conversations once the server is shutting down", async () => {
    for (let i = 0; i < 3; i++) await conversation({ closedDaysAgo: 200 });
    let checks = 0;
    const { deps: d } = deps({ shuttingDown: () => ++checks > 1 });
    expect((await sweepRetention(d)).conversationsDeleted).toBe(1);
    expect(await listIndexRows()).toHaveLength(2);
  });

  test("only one sweep runs at a time", async () => {
    await conversation({ closedDaysAgo: 200, patch: { sessionId: "ses_a" } });
    const { deps: d, deletedSessions } = deps();
    const first = sweepRetention(d);
    const second = sweepRetention(d);
    expect(second).toBe(first);
    await first;
    expect(deletedSessions).toEqual(["ses_a"]);
  });

  test("removes orphaned attachment directories once a day", async () => {
    const kept = await conversation({
      attachments: [{ id: "att_1", savedDaysAgo: 1 }],
    });
    const orphan = "sc_0192e8a0-0000-7000-8000-0000000000aa";
    await saveAttachment(
      orphan,
      {
        id: "att_x",
        fileName: "x.pdf",
        mimeType: "application/pdf",
        sizeBytes: 0,
        stored: false,
        expiresAt: null,
      },
      new TextEncoder().encode("x"),
      RETENTION.inb_acme!,
      NOW,
    );
    const old = new Date(NOW - 2 * 3_600_000);
    await utimes(join(ATTACHMENTS_DIR(), orphan), old, old);
    const { deps: d } = deps();

    expect((await sweepRetention(d)).orphansRemoved).toBe(1);
    expect(await readAttachment(orphan, "att_x")).toBeNull();
    expect(await readAttachment(kept.id, "att_1")).not.toBeNull();

    // Not again until a day has passed.
    await saveAttachment(
      orphan,
      {
        id: "att_y",
        fileName: "y.pdf",
        mimeType: "application/pdf",
        sizeBytes: 0,
        stored: false,
        expiresAt: null,
      },
      new TextEncoder().encode("y"),
      RETENTION.inb_acme!,
      NOW,
    );
    await utimes(join(ATTACHMENTS_DIR(), orphan), old, old);
    const hourLater = deps({ now: () => NOW + 3_600_000 });
    expect((await sweepRetention(hourLater.deps)).orphansRemoved).toBe(0);
    const dayLater = deps({ now: () => NOW + DAY });
    expect((await sweepRetention(dayLater.deps)).orphansRemoved).toBe(1);
  });
});

describe("startSupportRetention", () => {
  test("is idempotent", () => {
    startSupportRetention();
    const timer = globalThis.__supportRetention;
    try {
      expect(timer).toBeDefined();
      startSupportRetention();
      expect(globalThis.__supportRetention).toBe(timer);
    } finally {
      clearTimeout(timer);
      clearInterval(timer);
      globalThis.__supportRetention = undefined;
    }
  });
});

describe("deleteSupportSession", () => {
  const session = { id: "ses_a" } as UnifiedSession;
  const removed = (result: SessionDeleteResult) => {
    const calls: Array<[string, boolean]> = [];
    return {
      calls,
      remove: async (s: UnifiedSession, clean: boolean) => {
        calls.push([s.id, clean]);
        return result;
      },
    };
  };

  test("a session already gone is fine", async () => {
    const { calls, remove } = removed({ status: 200, body: { ok: true } });
    await deleteSupportSession("ses_a", true, {
      find: async () => null,
      remove,
    });
    expect(calls).toEqual([]);
  });

  test("a deleted session resolves, with the worktree choice passed on", async () => {
    const { calls, remove } = removed({ status: 200, body: { ok: true } });
    await deleteSupportSession("ses_a", false, {
      find: async () => session,
      remove,
    });
    expect(calls).toEqual([["ses_a", false]]);
  });

  test("a refused deletion throws its error", async () => {
    const { remove } = removed({
      status: 409,
      body: { error: "The session is still stopping. Retry deletion shortly." },
    });
    await expect(
      deleteSupportSession("ses_a", true, {
        find: async () => session,
        remove,
      }),
    ).rejects.toThrow("still stopping");
  });
});

const OWNER = { name: "kacper", verified: true, isInstanceOwner: true };

describe("deleteSupportWorkspace", () => {
  function seam(
    workspace: { id: string } | null,
    sessions: Array<{ id: string; workspaceId?: string | null }>,
  ) {
    const deleted: string[] = [];
    const keys: string[] = [];
    return {
      deleted,
      keys,
      seam: {
        find: async (key: string) => {
          keys.push(key);
          return workspace;
        },
        sessions: async () => sessions,
        remove: async (id: string) => {
          deleted.push(id);
          return true;
        },
      },
    };
  }

  test("deletes the support-<id> workspace once its sessions are gone", async () => {
    const t = seam({ id: "ws-support" }, [
      { id: "ses_support", workspaceId: "ws-support" },
      { id: "ses_elsewhere", workspaceId: "ws-other" },
    ]);
    await deleteSupportWorkspace("sc_1", new Set(["ses_support"]), t.seam);
    expect(t.keys).toEqual(["support-sc_1"]);
    expect(t.deleted).toEqual(["ws-support"]);
  });

  test("keeps a workspace another session still uses", async () => {
    const t = seam({ id: "ws-support" }, [
      { id: "ses_person", workspaceId: "ws-support" },
    ]);
    await deleteSupportWorkspace("sc_1", new Set(), t.seam);
    expect(t.deleted).toEqual([]);
  });

  test("no workspace is fine", async () => {
    const t = seam(null, []);
    await deleteSupportWorkspace("sc_1", new Set(), t.seam);
    expect(t.deleted).toEqual([]);
  });
});

describe("forgetCustomer", () => {
  test("only the instance owner may forget a customer", async () => {
    const c = await conversation({ customer: "ada@example.test" });
    const { deps: d, deletedSessions } = deps();
    for (const actor of [
      { name: "bea", verified: true, isInstanceOwner: false },
      { name: "kacper", verified: false, isInstanceOwner: true },
    ]) {
      const error = await forgetCustomer("ada@example.test", actor, d).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ForbiddenError);
      expect((error as ForbiddenError).status).toBe(403);
      expect((error as Error).message).toBe(
        "Only the instance owner can forget a customer",
      );
    }
    expect(await getConversation(c.id)).not.toBeNull();
    expect(deletedSessions).toEqual([]);
    expect(kernel.audits).toEqual([]);
  });

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
    const { deps: d, deletedSessions, worktrees, workspaces } = deps();

    const result = await forgetCustomer("Ada@Example.test", OWNER, d);
    expect(workspaces.sort()).toEqual([a.id, b.id].sort());

    expect(result).toEqual({
      conversations: 2,
      sessions: 3,
      attachments: 3,
      failed: 0,
      notDeleted: [
        "Mail in the mailbox",
        "Fix session worktree and branch",
        "https://github.com/acme/app/issues/7",
      ],
    });
    expect(deletedSessions.sort()).toEqual(["ses_a", "ses_b", "ses_fix"]);
    expect(worktrees.sort()).toEqual(["ses_a", "ses_b"]);
    // No message-id key, key list or index row is left for Ada.
    const ids = await catalogDocuments("support-message-ids").list();
    expect(ids.length).toBeGreaterThan(0);
    for (const { key, value } of ids)
      expect(
        key === `c:${other.id}` ||
          (value as { conversationId?: string }).conversationId === other.id,
      ).toBe(true);
    expect((await listIndexRows()).map((r) => r.id)).toEqual([other.id]);
    expect(await getConversation(a.id)).toBeNull();
    expect(await getConversation(b.id)).toBeNull();
    expect(await readAttachment(b.id, "att_2")).toBeNull();
    expect(await getConversation(other.id)).not.toBeNull();
    expect(kernel.audits).toEqual([
      {
        type: "support.forget",
        by: "kacper",
        customer: await customerDigest("ada@example.test"),
        conversations: 2,
        failed: 0,
      },
    ]);
    expect(JSON.stringify(kernel.audits).toLowerCase()).not.toContain("ada@");
  });

  test("the audit digest is keyed by a per-instance secret made on first use", async () => {
    expect(await resolveWorkspaceSecretAsync(FORGET_KEY_REF)).toBeUndefined();
    const [first, again] = await Promise.all([
      customerDigest("ada@example.test"),
      customerDigest("ada@example.test"),
    ]);
    const key = await resolveWorkspaceSecretAsync(FORGET_KEY_REF);
    expect(key).toBeDefined();
    expect(again).toBe(first);
    expect(await customerDigest("ada@example.test")).toBe(first);
    expect(first).not.toBe(digest("ada@example.test"));
    expect(await customerDigest("grace@example.test")).not.toBe(first);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
  });

  test("an empty or invalid address is refused before anything is deleted", async () => {
    const c = await conversation({ customer: "" });
    const { deps: d } = deps();
    for (const bad of ["", "   ", "ada", "@example.test", "ada@", "a b@x.test"])
      await expect(forgetCustomer(bad, OWNER, d)).rejects.toThrow(
        "Invalid customer address",
      );
    expect(await getConversation(c.id)).not.toBeNull();
    expect(kernel.audits).toEqual([]);
  });

  test("a customer Sessions never saw still gets a record", async () => {
    const { deps: d, deletedSessions } = deps();
    expect(await forgetCustomer("nobody@example.test", OWNER, d)).toEqual({
      conversations: 0,
      sessions: 0,
      attachments: 0,
      failed: 0,
      notDeleted: ["Mail in the mailbox"],
    });
    expect(deletedSessions).toEqual([]);
    expect(kernel.audits).toHaveLength(1);
  });

  test("a session that fails to delete keeps its conversation, the rest go and the audit says so", async () => {
    const stuck = await conversation({ patch: { sessionId: "ses_busy" } });
    const gone = await conversation({ patch: { sessionId: "ses_a" } });
    const { deps: d, deletedSessions } = deps();
    const deleteSession = d.deleteSession!;
    d.deleteSession = async (id, clean) => {
      if (id === "ses_busy") throw new Error("still stopping");
      await deleteSession(id, clean);
    };

    const result = await forgetCustomer("ada@example.test", OWNER, d);

    expect(result).toEqual({
      conversations: 1,
      sessions: 1,
      attachments: 0,
      failed: 1,
      notDeleted: [
        "Mail in the mailbox",
        "1 conversation still in use, try again",
      ],
    });
    expect(deletedSessions).toEqual(["ses_a"]);
    expect(await getConversation(stuck.id)).not.toBeNull();
    expect(await getConversation(gone.id)).toBeNull();
    expect(kernel.audits).toEqual([
      {
        type: "support.forget",
        by: "kacper",
        customer: await customerDigest("ada@example.test"),
        conversations: 1,
        failed: 1,
      },
    ]);
  });
});
