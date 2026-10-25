import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SupportActor, SupportMessage } from "../../shared/support";
import { catalogDocuments } from "../catalog-documents";
import {
  INTERRUPTED_SEND,
  discardDraft,
  proposeDraft,
  replyAsPerson,
  sendDraft,
  stopVeto,
} from "./reply";
import { getConversation, lookupMessageIds, updateConversation } from "./store";
import {
  CUSTOMER,
  INBOX_ADDRESS,
  useReplyTestbed,
} from "./testing/reply-testbed";
import { runSupportTick } from "./tick";

const tb = useReplyTestbed();

const AGENT: SupportActor = { kind: "agent", sessionId: "os-1" };
const ADA: SupportActor = { kind: "person", name: "Ada" };
const DRAFT = "Please clear the zebracache folder and export again.";

function stringsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (value && typeof value === "object")
    return Object.values(value).flatMap(stringsOf);
  return [];
}

async function draftNeedingPerson() {
  const c = await tb.conversation();
  const proposed = await proposeDraft(c.id, DRAFT, AGENT);
  if (!proposed.ok) throw new Error(proposed.error);
  return { c, draft: proposed.draft };
}

describe("proposeDraft", () => {
  test("an agent draft under Draft waits for a person and sends nothing", async () => {
    const { c, draft } = await draftNeedingPerson();
    expect(draft.state).toBe("needs-person");
    expect(draft.rule).toBe("Drafts wait for a person");
    expect(draft.author).toEqual(AGENT);
    expect(tb.fixture().sent).toHaveLength(0);
    expect((await getConversation(c.id))!.draft?.id).toBe(draft.id);
  });

  test("send right away with known topics sends at once, marked automatic", async () => {
    await tb.setInbox({ autonomy: "deploy-right-away" });
    const c = await tb.conversation();
    const result = await proposeDraft(c.id, DRAFT, AGENT);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.draft.state).toBe("sent");
    expect(tb.fixture().sent).toHaveLength(1);
    const raw = tb.fixture().sent[0]!.raw;
    expect(raw).toMatch(/^Auto-Submitted: auto-replied/im);
    expect(raw).toContain("zebracache");
    const after = (await getConversation(c.id))!;
    expect(after.autoSends).toHaveLength(1);
    expect(after.draft).toBeNull();
    expect(after.status).toBe("waiting");
    const out = after.messages.at(-1)!;
    expect(out.direction).toBe("out");
    expect(out.sentBy).toEqual({ kind: "sessions" });
    expect(out.from.address).toBe(INBOX_ADDRESS);
    expect(out.to.map((a) => a.address)).toEqual([
      "carol@customer.example.test",
    ]);
  });

  test("the fourth automatic reply within an hour waits for a person", async () => {
    await tb.setInbox({ autonomy: "deploy-right-away" });
    const c = await tb.conversation();
    for (let i = 0; i < 3; i++) {
      const sent = await proposeDraft(c.id, `${DRAFT} (${i})`, AGENT);
      expect(sent.ok && sent.draft.state).toBe("sent");
    }
    const fourth = await proposeDraft(c.id, DRAFT, AGENT);
    expect(fourth.ok).toBe(true);
    if (fourth.ok) {
      expect(fourth.draft.state).toBe("needs-person");
      expect(fourth.draft.rule).toBe("3 automatic replies in the last hour");
    }
    expect(tb.fixture().sent).toHaveLength(3);
  });

  test("route 'simple' with unknown topics never sends on its own", async () => {
    await tb.setInbox({ autonomy: "deploy-right-away" });
    const c = await tb.conversation({
      triage: { route: "simple", topics: null },
    });
    const result = await proposeDraft(c.id, DRAFT, AGENT);
    expect(result.ok && result.draft.state).toBe("needs-person");
    expect(tb.fixture().sent).toHaveLength(0);
  });

  test("trust is checked on the message replyTarget answers", async () => {
    await tb.setInbox({ autonomy: "deploy-right-away" });
    const failed = await tb.conversation({
      trust: { replyToDiffers: false, authFailed: true },
    });
    const a = await proposeDraft(failed.id, DRAFT, AGENT);
    expect(a.ok && a.draft.rule).toBe("The sender could not be verified");

    // A Reply-To elsewhere, even when ingest didn't flag it.
    const elsewhere = await tb.conversation({
      replyTo: [{ name: null, address: "billing@other.example.test" }],
    });
    const b = await proposeDraft(elsewhere.id, DRAFT, AGENT);
    expect(b.ok && b.draft.rule).toBe(
      "Replies would go to a different address than the sender",
    );
    expect(tb.fixture().sent).toHaveLength(0);
  });

  test("a veto decision opens a window and sends nothing yet", async () => {
    await tb.setInbox({ autonomy: "deploy-after-veto", vetoMs: 600_000 });
    const c = await tb.conversation();
    const before = Date.now();
    const result = await proposeDraft(c.id, DRAFT, AGENT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.state).toBe("veto");
    const deadline = Date.parse(result.draft.vetoDeadline!);
    expect(deadline).toBeGreaterThanOrEqual(before + 600_000);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 600_000);
    expect(tb.fixture().sent).toHaveLength(0);
  });

  test("an empty draft is refused; a missing conversation is 404", async () => {
    const c = await tb.conversation();
    const empty = await proposeDraft(c.id, "   ", AGENT);
    expect(empty).toMatchObject({ ok: false, status: 400 });
    const missing = await proposeDraft("sc_0000-missing", DRAFT, AGENT);
    expect(missing).toMatchObject({ ok: false, status: 404 });
  });
});

describe("sendDraft", () => {
  test("a person sends a waiting draft; the audit row holds a digest, not the text", async () => {
    const { c, draft } = await draftNeedingPerson();
    const result = await sendDraft(c.id, draft.id, ADA);
    expect(result.ok).toBe(true);
    expect(tb.fixture().sent).toHaveLength(1);
    const after = (await getConversation(c.id))!;
    const out = after.messages.at(-1)!;
    expect(out.direction).toBe("out");
    expect(out.sentBy).toEqual(ADA);
    expect(out.draftId).toBe(draft.id);
    expect(after.draft).toBeNull();
    // A person's send is not automatic.
    expect(after.autoSends).toHaveLength(0);
    expect(tb.fixture().sent[0]!.raw).not.toMatch(/^Auto-Submitted:/im);
    // Our id threads replies to this conversation.
    expect(
      (await lookupMessageIds(c.inboxId, [draft.messageId])).get(
        draft.messageId,
      ),
    ).toBe(c.id);

    const rows = tb.kernel.audits.filter((a) => a.type === "support.reply");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      conversationId: c.id,
      inboxId: c.inboxId,
      channel: "email",
      draftId: draft.id,
      author: "agent",
      edited: false,
      messageId: draft.messageId,
    });
    expect(typeof rows[0]!.textDigest).toBe("string");
    for (const value of stringsOf(rows[0]))
      expect(value.length > 3 && DRAFT.includes(value)).toBe(false);
    expect(JSON.stringify(rows[0])).not.toContain("zebracache");
  });

  test("an edited send sends the edit and says so in the audit row", async () => {
    const { c, draft } = await draftNeedingPerson();
    const result = await sendDraft(c.id, draft.id, ADA, {
      text: "Edited: please try the export once more.",
    });
    expect(result.ok).toBe(true);
    expect(tb.fixture().sent[0]!.raw).toContain("Edited: please try");
    expect(tb.fixture().sent[0]!.raw).not.toContain("zebracache");
    const row = tb.kernel.audits.find((a) => a.type === "support.reply")!;
    expect(row.edited).toBe(true);
  });

  test("two sends of the same draft at once send one mail", async () => {
    const { c, draft } = await draftNeedingPerson();
    const results = await Promise.all([
      sendDraft(c.id, draft.id, ADA),
      sendDraft(c.id, draft.id, { kind: "person", name: "Bob" }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(tb.fixture().sent).toHaveLength(1);
    // And once more after it went out.
    expect(await sendDraft(c.id, draft.id, ADA)).toMatchObject({
      ok: false,
      status: 409,
    });
  });

  test("a discarded draft can't be sent", async () => {
    const { c, draft } = await draftNeedingPerson();
    expect((await discardDraft(c.id, draft.id, ADA)).ok).toBe(true);
    expect((await getConversation(c.id))!.draft?.state).toBe("discarded");
    expect(await sendDraft(c.id, draft.id, ADA)).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(tb.fixture().sent).toHaveLength(0);
  });

  test("only a person sends a draft that waits for a person", async () => {
    const { c, draft } = await draftNeedingPerson();
    expect(await sendDraft(c.id, draft.id, AGENT)).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(await sendDraft(c.id, draft.id, { kind: "sessions" })).toMatchObject(
      { ok: false, status: 409 },
    );
    expect(tb.fixture().sent).toHaveLength(0);
  });

  test("an unknown draft is 404", async () => {
    const { c } = await draftNeedingPerson();
    expect(await sendDraft(c.id, "sd_nope", ADA)).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  test("a 451 keeps the draft sending with a retry time", async () => {
    const { c, draft } = await draftNeedingPerson();
    tb.fixture().smtpReply = { code: 451, message: "Try again later" };
    const result = await sendDraft(c.id, draft.id, ADA);
    expect(result).toMatchObject({ ok: false, status: 502 });
    const after = (await getConversation(c.id))!.draft!;
    expect(after.state).toBe("sending");
    expect(after.attempts).toBe(1);
    expect(after.nextAttemptAt).not.toBeNull();
    expect(Date.parse(after.nextAttemptAt!)).toBeGreaterThan(Date.now());
    expect(after.lastError).toContain("451");
    expect(
      tb.kernel.audits.filter((a) => a.type === "support.reply.failed"),
    ).toHaveLength(1);
    // Never claimed twice while it waits for its retry.
    expect(await sendDraft(c.id, draft.id, ADA)).toMatchObject({
      ok: false,
      status: 409,
    });
  });

  test("a 550 fails the draft with the reason", async () => {
    const { c, draft } = await draftNeedingPerson();
    tb.fixture().smtpReply = { code: 550, message: "No such user" };
    const result = await sendDraft(c.id, draft.id, ADA);
    expect(result).toMatchObject({ ok: false, status: 502 });
    const after = (await getConversation(c.id))!.draft!;
    expect(after.state).toBe("failed");
    expect(after.lastError).toContain("550");
    const failed = tb.kernel.audits.filter(
      (a) => a.type === "support.reply.failed",
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]!.permanent).toBe(true);
    expect(JSON.stringify(failed[0])).not.toContain("zebracache");
  });

  test("the mailbox is marked handled unless the inbox leaves it untouched", async () => {
    const first = await draftNeedingPerson();
    await sendDraft(first.c.id, first.draft.id, ADA);
    expect(tb.adapter().marks).toHaveLength(0);

    await tb.setInbox({ mailbox: "mark-read" });
    const second = await draftNeedingPerson();
    await sendDraft(second.c.id, second.draft.id, ADA);
    expect(tb.adapter().marks).toEqual([
      { conversationId: second.c.id, state: "handled" },
    ]);
  });
});

describe("veto, discard, person replies", () => {
  test("stopping a veto hands the draft to a person", async () => {
    await tb.setInbox({ autonomy: "deploy-after-veto" });
    const c = await tb.conversation();
    const proposed = await proposeDraft(c.id, DRAFT, AGENT);
    if (!proposed.ok) throw new Error(proposed.error);
    const stopped = await stopVeto(c.id, proposed.draft.id, ADA);
    expect(stopped.ok).toBe(true);
    if (stopped.ok) {
      expect(stopped.draft.state).toBe("needs-person");
      expect(stopped.draft.rule).toBe("Stopped by Ada");
      expect(stopped.draft.vetoDeadline).toBeNull();
    }
    // Not a veto any more.
    expect(await stopVeto(c.id, proposed.draft.id, ADA)).toMatchObject({
      ok: false,
      status: 409,
    });
  });

  test("a person's reply sends at once whatever the autonomy", async () => {
    await tb.setInbox({ autonomy: "watch" });
    const c = await tb.conversation({
      triage: { topics: ["refund"] },
      trust: { replyToDiffers: true, authFailed: true },
    });
    const result = await replyAsPerson(
      c.id,
      "A person will refund you.",
      "Ada",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.sentBy).toEqual(ADA);
      expect(result.message.text).toBe("A person will refund you.");
    }
    expect(tb.fixture().sent).toHaveLength(1);
  });

  test("a person's reply replaces the agent's waiting draft", async () => {
    const { c } = await draftNeedingPerson();
    const result = await replyAsPerson(c.id, "Answered by hand.", "Ada");
    expect(result.ok).toBe(true);
    const after = (await getConversation(c.id))!;
    expect(after.draft).toBeNull();
    expect(tb.fixture().sent).toHaveLength(1);
    expect(tb.fixture().sent[0]!.raw).not.toContain("zebracache");
  });
});

describe("one send path", () => {
  test("only reply.ts calls a channel adapter's send", async () => {
    const root = join(import.meta.dir, "..", "..");
    const offenders: string[] = [];
    for (const dir of ["server", "agents"]) {
      const files = await readdir(join(root, dir), { recursive: true });
      for (const file of files) {
        if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
        if (file.includes("/testing/") || file.startsWith("testing/")) continue;
        const path = join(root, dir, file);
        if (path === join(import.meta.dir, "reply.ts")) continue;
        const source = await readFile(path, "utf8");
        if (
          /\badapter\??\.send\(/.test(source) ||
          /channelAdapterFor\([^)]*\)[^;]*\.send\(/.test(source)
        )
          offenders.push(join(dir, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});

/** A later customer message on `c`, as ingest stores it. */
async function customerWritesAgain(
  conversationId: string,
  over: Partial<SupportMessage> = {},
): Promise<SupportMessage> {
  const m: SupportMessage = {
    id: `sm_later-${Math.random().toString(16).slice(2)}`,
    direction: "in",
    at: new Date().toISOString(),
    from: { name: "Carol", address: "carol@customer.example.test" },
    to: [{ name: null, address: INBOX_ADDRESS }],
    cc: [],
    subject: "Re: Export is broken",
    text: "Any news?",
    keys: {
      messageId: `later-${Math.random()}@customer.example.test`,
      inReplyTo: null,
      references: [],
    },
    providerId: null,
    attachments: [],
    trust: { replyToDiffers: false, authFailed: false, authVerified: true },
    topicsChecked: true,
    ...over,
  };
  await updateConversation(conversationId, (x) => ({
    ...x,
    messages: [...x.messages, m],
  }));
  return m;
}

describe("pinned target", () => {
  test("a draft is pinned to the message it answers and its one address", async () => {
    const { c, draft } = await draftNeedingPerson();
    expect(draft.answersMessageId).toBe(c.messages[0]!.id);
    expect(draft.to).toEqual([CUSTOMER]);
  });

  test("a person's send after a newer message asks the person to look again", async () => {
    const { c, draft } = await draftNeedingPerson();
    const later = await customerWritesAgain(c.id, {
      replyTo: [{ name: null, address: "billing@other.example.test" }],
    });
    const first = await sendDraft(c.id, draft.id, ADA);
    expect(first).toMatchObject({
      ok: false,
      status: 409,
      error: "A newer message arrived",
    });
    expect(tb.fixture().sent).toHaveLength(0);
    const held = (await getConversation(c.id))!.draft!;
    expect(held.state).toBe("needs-person");
    expect(held.rule).toBe("A newer message arrived");
    expect(held.answersMessageId).toBe(later.id);
    // The person looked again: it goes where the newer message asks.
    expect((await sendDraft(c.id, draft.id, ADA)).ok).toBe(true);
    expect(tb.fixture().sent[0]!.envelope.to).toEqual([
      "billing@other.example.test",
    ]);
  });
});

describe("sends that may have gone out", () => {
  test("a connection dropped after DATA fails the draft; it is never resent", async () => {
    const { c, draft } = await draftNeedingPerson();
    tb.fixture().smtpDropAfterData = true;
    const result = await sendDraft(c.id, draft.id, ADA);
    expect(result).toMatchObject({ ok: false, status: 502 });
    const after = (await getConversation(c.id))!.draft!;
    expect(after.state).toBe("failed");
    expect(after.lastError).toBe(INTERRUPTED_SEND);
    expect(after.nextAttemptAt).toBeNull();
    tb.fixture().smtpDropAfterData = false;
    expect((await runSupportTick(Date.now() + 3_600_000)).retried).toBe(0);
    expect(tb.fixture().sent.length).toBeLessThanOrEqual(1);
  });
});

describe("after a person stopped the agent", () => {
  test("stop, then the agent proposes again: it waits for a person, until a person acts", async () => {
    await tb.setInbox({ autonomy: "deploy-after-veto" });
    const c = await tb.conversation();
    const first = await proposeDraft(c.id, DRAFT, AGENT);
    if (!first.ok) throw new Error(first.error);
    expect((await stopVeto(c.id, first.draft.id, ADA)).ok).toBe(true);

    const again = await proposeDraft(c.id, `${DRAFT} Really.`, AGENT);
    expect(again.ok && again.draft.state).toBe("needs-person");
    expect(again.ok && again.draft.rule).toBe("A person stopped the last reply");
    // And the time after, too.
    const third = await proposeDraft(c.id, `${DRAFT} Once more.`, AGENT);
    expect(third.ok && third.draft.rule).toBe("A person stopped the last reply");
    expect(tb.fixture().sent).toHaveLength(0);

    // A person sends: the hold ends.
    if (!third.ok) throw new Error(third.error);
    expect((await sendDraft(c.id, third.draft.id, ADA)).ok).toBe(true);
    const fourth = await proposeDraft(c.id, "Anything else?", AGENT);
    expect(fourth.ok && fourth.draft.state).toBe("veto");
  });

  test("a discard holds the agent's next draft for a person", async () => {
    await tb.setInbox({ autonomy: "deploy-right-away" });
    const c = await tb.conversation();
    await tb.setInbox({ autonomy: "propose" });
    const first = await proposeDraft(c.id, DRAFT, AGENT);
    if (!first.ok) throw new Error(first.error);
    expect((await discardDraft(c.id, first.draft.id, ADA)).ok).toBe(true);
    await tb.setInbox({ autonomy: "deploy-right-away" });
    const again = await proposeDraft(c.id, DRAFT, AGENT);
    expect(again.ok && again.draft.rule).toBe("A person stopped the last reply");
    expect(tb.fixture().sent).toHaveLength(0);
  });

  test("a send that may have gone out holds the agent's next draft", async () => {
    await tb.setInbox({ autonomy: "deploy-right-away" });
    const c = await tb.conversation();
    tb.fixture().smtpDropAfterData = true;
    await proposeDraft(c.id, DRAFT, AGENT);
    tb.fixture().smtpDropAfterData = false;
    expect((await getConversation(c.id))!.draft?.lastError).toBe(
      INTERRUPTED_SEND,
    );
    const sent = tb.fixture().sent.length;
    const again = await proposeDraft(c.id, DRAFT, AGENT);
    expect(again.ok && again.draft.rule).toBe("A person stopped the last reply");
    expect(tb.fixture().sent.length).toBe(sent);
  });
});

describe("discarding a send", () => {
  test("a person may discard a send waiting for its retry; the tick then leaves it", async () => {
    const { c, draft } = await draftNeedingPerson();
    tb.fixture().smtpReply = { code: 451, message: "Try again later" };
    await sendDraft(c.id, draft.id, ADA);
    const keys = (await catalogDocuments("support-pending").list()).map(
      (e) => e.key,
    );
    expect(keys).toContain(`send:${c.id}:${draft.id}`);
    expect((await discardDraft(c.id, draft.id, ADA)).ok).toBe(true);
    expect((await getConversation(c.id))!.draft?.state).toBe("discarded");
    const after = (await catalogDocuments("support-pending").list()).map(
      (e) => e.key,
    );
    expect(after).not.toContain(`send:${c.id}:${draft.id}`);
    expect((await runSupportTick(Date.now() + 3_600_000)).retried).toBe(0);
    expect(tb.fixture().sent).toHaveLength(0);
  });

  test("a send that just started can't be discarded", async () => {
    const { c, draft } = await draftNeedingPerson();
    await updateConversation(c.id, (x) => ({
      ...x,
      draft: {
        ...x.draft!,
        state: "sending",
        attemptStartedAt: new Date().toISOString(),
      },
    }));
    expect(await discardDraft(c.id, draft.id, ADA)).toMatchObject({
      ok: false,
      status: 409,
    });
  });
});

describe("spam conversations", () => {
  test("an agent's draft on spam waits; a person's reply keeps it spam", async () => {
    await tb.setInbox({ autonomy: "deploy-right-away" });
    const c = await tb.conversation();
    await updateConversation(c.id, (x) => ({ ...x, status: "spam" }));
    const proposed = await proposeDraft(c.id, DRAFT, AGENT);
    expect(proposed.ok && proposed.draft.rule).toBe(
      "The conversation is marked as spam",
    );
    expect((await replyAsPerson(c.id, "Hi.", "Ada")).ok).toBe(true);
    expect((await getConversation(c.id))!.status).toBe("spam");
  });
});

describe("who acted", () => {
  test("audit rows name the person's login and display name", async () => {
    const { c, draft } = await draftNeedingPerson();
    const result = await sendDraft(c.id, draft.id, {
      kind: "person",
      name: "Ada",
      login: "ada",
    });
    expect(result.ok).toBe(true);
    const row = tb.kernel.audits.find((a) => a.type === "support.reply")!;
    expect(row.by).toBe("ada");
    expect(row.byName).toBe("Ada");
  });
});
