import { afterEach, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AUTO_SENDS_PER_INBOX_PER_HOUR,
  type SupportActor,
  type SupportMessage,
} from "../../shared/support";
import type { KnowledgeVerdict } from "../../shared/knowledge";
import { catalogDocuments } from "../catalog-documents";
import { personaName } from "../config";
import {
  type VerdictInput,
  __setKnowledgeVerdictForTest,
} from "../knowledge/backing";
import {
  INTERRUPTED_SEND,
  discardDraft,
  onReplySent,
  onReplyStoring,
  proposeDraft,
  replyAsPerson,
  retrySend,
  sendDraft,
  sendDueVeto,
  stopVeto,
} from "./reply";
import { getConversation, lookupMessageIds, updateConversation } from "./store";
import {
  CUSTOMER,
  INBOX_ADDRESS,
  useReplyTestbed,
  CITED,
  cleanLabels,
} from "./testing/reply-testbed";
import { runSupportTick } from "./tick";
import { draftStats } from "./draft-stats";
import { __setDraftCheckForTest } from "./verify";

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
  const proposed = await proposeDraft(c.id, DRAFT, AGENT, undefined, CITED);
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
    await tb.setInbox({ autonomy: "routine", vetoMs: null });
    const c = await tb.conversation();
    const result = await proposeDraft(c.id, DRAFT, AGENT, undefined, CITED);
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
    await tb.setInbox({ autonomy: "routine", vetoMs: null });
    const c = await tb.conversation();
    for (let i = 0; i < 3; i++) {
      if (i > 0) await tb.customerReply(c.id);
      const sent = await proposeDraft(
        c.id,
        `${DRAFT} (${i})`,
        AGENT,
        undefined,
        CITED,
      );
      expect(sent.ok && sent.draft.state).toBe("sent");
    }
    await tb.customerReply(c.id);
    const fourth = await proposeDraft(c.id, DRAFT, AGENT, undefined, CITED);
    expect(fourth.ok).toBe(true);
    if (fourth.ok) {
      expect(fourth.draft.state).toBe("needs-person");
      expect(fourth.draft.rule).toBe("3 automatic replies in the last hour");
    }
    expect(tb.fixture().sent).toHaveLength(3);
  });

  test("route 'simple' with unknown topics never sends on its own", async () => {
    await tb.setInbox({ autonomy: "routine", vetoMs: null });
    const c = await tb.conversation({
      triage: { route: "simple", topics: null },
    });
    const result = await proposeDraft(c.id, DRAFT, AGENT, undefined, CITED);
    expect(result.ok && result.draft.state).toBe("needs-person");
    expect(tb.fixture().sent).toHaveLength(0);
  });

  test("trust is checked on the message replyTarget answers", async () => {
    await tb.setInbox({ autonomy: "routine", vetoMs: null });
    const failed = await tb.conversation({
      trust: { replyToDiffers: false, authFailed: true },
    });
    const a = await proposeDraft(failed.id, DRAFT, AGENT, undefined, CITED);
    expect(a.ok && a.draft.rule).toBe("The sender could not be verified");

    // A Reply-To elsewhere, even when ingest didn't flag it.
    const elsewhere = await tb.conversation({
      replyTo: [{ name: null, address: "billing@other.example.test" }],
    });
    const b = await proposeDraft(elsewhere.id, DRAFT, AGENT, undefined, CITED);
    expect(b.ok && b.draft.rule).toBe(
      "Replies would go to a different address than the sender",
    );
    expect(tb.fixture().sent).toHaveLength(0);
  });

  test("a veto decision opens a window and sends nothing yet", async () => {
    await tb.setInbox({ autonomy: "routine", vetoMs: 600_000 });
    const c = await tb.conversation();
    const before = Date.now();
    const result = await proposeDraft(c.id, DRAFT, AGENT, undefined, CITED);
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
    const empty = await proposeDraft(c.id, "   ", AGENT, undefined, CITED);
    expect(empty).toMatchObject({ ok: false, status: 400 });
    const missing = await proposeDraft(
      "sc_0000-missing",
      DRAFT,
      AGENT,
      undefined,
      CITED,
    );
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
    expect(typeof row.originalDigest).toBe("string");
    expect(row.originalDigest).not.toBe(row.textDigest);
  });

  test("an attempt row is written before the mail goes out", async () => {
    const { c, draft } = await draftNeedingPerson();
    expect((await sendDraft(c.id, draft.id, ADA)).ok).toBe(true);
    const types = tb.kernel.audits
      .filter((a) => a.draftId === draft.id)
      .map((a) => a.type);
    expect(types).toEqual(["support.reply.attempt", "support.reply"]);
  });

  test("stops and discards are audited", async () => {
    await tb.setInbox({ autonomy: "routine" });
    const c = await tb.conversation();
    const proposed = await proposeDraft(c.id, DRAFT, AGENT, undefined, CITED);
    if (!proposed.ok) throw new Error(proposed.error);
    await stopVeto(c.id, proposed.draft.id, ADA);
    await discardDraft(c.id, proposed.draft.id, ADA);
    expect(
      tb.kernel.audits
        .filter((a) => a.draftId === proposed.draft.id)
        .map((a) => a.type),
    ).toEqual(["support.reply.stopped", "support.reply.discarded"]);
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

describe("the conversation's event log", () => {
  const kinds = async (id: string) =>
    (await getConversation(id))!.events.map((e) => [e.kind, e.detail]);

  test("drafts and sends are logged, without the text", async () => {
    const { c, draft } = await draftNeedingPerson();
    expect(await kinds(c.id)).toContainEqual([
      "draft-written",
      `${personaName()} wrote a draft. Drafts wait for a person`,
    ]);
    expect((await sendDraft(c.id, draft.id, ADA)).ok).toBe(true);
    const second = await proposeDraft(c.id, DRAFT, AGENT, undefined, CITED);
    if (!second.ok) throw new Error(second.error);
    await sendDraft(c.id, second.draft.id, ADA, { text: "Edited reply." });
    expect(await replyAsPerson(c.id, "On it.", "Ada")).toMatchObject({
      ok: true,
    });
    const events = await kinds(c.id);
    expect(events.filter(([k]) => k === "draft-written")).toHaveLength(2);
    expect(events.filter(([k]) => k === "reply-sent")).toEqual([
      ["reply-sent", "Ada sent the draft unchanged"],
      ["reply-sent", "Ada sent the draft edited"],
      ["reply-sent", "Ada replied"],
    ]);
    expect(JSON.stringify(events)).not.toContain("zebracache");
  });

  test("automatic sends, stops, discards and failed sends are logged", async () => {
    await tb.setInbox({ autonomy: "routine", vetoMs: null });
    const auto = await tb.conversation();
    await proposeDraft(auto.id, DRAFT, AGENT, undefined, CITED);
    // The send says how it went; the draft line names no rule.
    expect(await kinds(auto.id)).toEqual([
      ["draft-written", `${personaName()} wrote a draft`],
      ["reply-sent", "Sent on its own"],
    ]);

    await tb.setInbox({ autonomy: "routine", vetoMs: 600_000 });
    const c = await tb.conversation();
    const proposed = await proposeDraft(c.id, DRAFT, AGENT, undefined, CITED);
    if (!proposed.ok) throw new Error(proposed.error);
    await stopVeto(c.id, proposed.draft.id, ADA);
    await discardDraft(c.id, proposed.draft.id, ADA);
    const events = await kinds(c.id);
    expect(events).toContainEqual(["draft-stopped", "Stopped by Ada"]);
    expect(events).toContainEqual(["draft-discarded", "Discarded by Ada"]);

    await tb.setInbox({ autonomy: "draft" });
    const { c: f, draft } = await draftNeedingPerson();
    tb.fixture().smtpReply = { code: 550, message: "No such user" };
    await sendDraft(f.id, draft.id, ADA);
    const failed = (await kinds(f.id)).find(([k]) => k === "send-failed");
    expect(failed?.[1]).toStartWith("The reply was not sent: ");
  });
});

describe("veto, discard, person replies", () => {
  test("stopping a veto hands the draft to a person", async () => {
    await tb.setInbox({ autonomy: "routine" });
    const c = await tb.conversation();
    const proposed = await proposeDraft(c.id, DRAFT, AGENT, undefined, CITED);
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
        const transport =
          path === join(root, "agents", "email", "adapter.ts") ||
          path === join(root, "agents", "email", "smtp-transport.ts");
        if (
          // Any adapter variable's send (adapter, emailAdapter, a, …).
          /\b\w*[aA]dapter\w*\??\.send\(/.test(source) ||
          /channelAdapterFor\([^)]*\)[^;]*\.send\(/.test(source) ||
          /listChannelAdapters\(\)[^;]*\.send\(/.test(source) ||
          (!transport && /\bnew SmtpTransport\(/.test(source)) ||
          (!transport && /\bsendMail\(/.test(source))
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
    triage: cleanLabels(),
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
    await tb.setInbox({ autonomy: "routine" });
    const c = await tb.conversation();
    const first = await proposeDraft(c.id, DRAFT, AGENT, undefined, CITED);
    if (!first.ok) throw new Error(first.error);
    expect((await stopVeto(c.id, first.draft.id, ADA)).ok).toBe(true);

    const again = await proposeDraft(
      c.id,
      `${DRAFT} Really.`,
      AGENT,
      undefined,
      CITED,
    );
    expect(again.ok && again.draft.state).toBe("needs-person");
    expect(again.ok && again.draft.rule).toBe(
      "A person stopped the last reply",
    );
    // And the time after, too.
    const third = await proposeDraft(
      c.id,
      `${DRAFT} Once more.`,
      AGENT,
      undefined,
      CITED,
    );
    expect(third.ok && third.draft.rule).toBe(
      "A person stopped the last reply",
    );
    expect(tb.fixture().sent).toHaveLength(0);

    // A person sends: the hold ends.
    if (!third.ok) throw new Error(third.error);
    expect((await sendDraft(c.id, third.draft.id, ADA)).ok).toBe(true);
    await tb.customerReply(c.id);
    const fourth = await proposeDraft(
      c.id,
      "Anything else?",
      AGENT,
      undefined,
      CITED,
    );
    expect(fourth.ok && fourth.draft.state).toBe("veto");
  });

  test("a discard holds the agent's next draft for a person", async () => {
    await tb.setInbox({ autonomy: "routine", vetoMs: null });
    const c = await tb.conversation();
    await tb.setInbox({ autonomy: "draft" });
    const first = await proposeDraft(c.id, DRAFT, AGENT, undefined, CITED);
    if (!first.ok) throw new Error(first.error);
    expect((await discardDraft(c.id, first.draft.id, ADA)).ok).toBe(true);
    await tb.setInbox({ autonomy: "routine", vetoMs: null });
    const again = await proposeDraft(c.id, DRAFT, AGENT, undefined, CITED);
    expect(again.ok && again.draft.rule).toBe(
      "A person stopped the last reply",
    );
    expect(tb.fixture().sent).toHaveLength(0);
  });

  test("a send that may have gone out holds the agent's next draft", async () => {
    await tb.setInbox({ autonomy: "routine", vetoMs: null });
    const c = await tb.conversation();
    tb.fixture().smtpDropAfterData = true;
    await proposeDraft(c.id, DRAFT, AGENT, undefined, CITED);
    tb.fixture().smtpDropAfterData = false;
    expect((await getConversation(c.id))!.draft?.lastError).toBe(
      INTERRUPTED_SEND,
    );
    const sent = tb.fixture().sent.length;
    const again = await proposeDraft(c.id, DRAFT, AGENT, undefined, CITED);
    expect(again.ok && again.draft.rule).toBe(
      "A person stopped the last reply",
    );
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
    await tb.setInbox({ autonomy: "routine", vetoMs: null });
    const c = await tb.conversation();
    await updateConversation(c.id, (x) => ({ ...x, status: "spam" }));
    const proposed = await proposeDraft(c.id, DRAFT, AGENT, undefined, CITED);
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

  test("an automatic send's audit rows name the persona, never as a login", async () => {
    await tb.setInbox({ autonomy: "routine", vetoMs: null });
    const c = await tb.conversation();
    const result = await proposeDraft(c.id, DRAFT, AGENT, undefined, CITED);
    expect(result.ok && result.draft.state).toBe("sent");
    const rows = tb.kernel.audits.filter(
      (a) =>
        a.conversationId === c.id && String(a.type).startsWith("support.reply"),
    );
    expect(rows.map((a) => a.type)).toEqual([
      "support.reply.attempt",
      "support.reply",
    ]);
    for (const row of rows) {
      expect(row.by).toBe("sessions");
      expect(row.byName).toBe(personaName());
    }
  });
});

describe("who acted on an agent-proposed draft", () => {
  test("its audit rows keep the agent as author and name the persona, never a login", async () => {
    // The agent proposes; Sessions sends it when the veto window ends.
    // Only a person or Sessions ever sends (claimAndDeliver), so `by` is
    // the machine kind and the persona is its display name.
    await tb.setInbox({ autonomy: "routine", vetoMs: 600_000 });
    const c = await tb.conversation();
    const proposed = await proposeDraft(c.id, DRAFT, AGENT, undefined, CITED);
    if (!proposed.ok) throw new Error(proposed.error);
    expect(proposed.draft.state).toBe("veto");
    const due = Date.parse(proposed.draft.vetoDeadline!) + 1;
    expect(await sendDueVeto(c.id, proposed.draft.id, due)).toMatchObject({
      ok: true,
    });
    const rows = tb.kernel.audits.filter(
      (a) =>
        a.conversationId === c.id && String(a.type).startsWith("support.reply"),
    );
    expect(rows.map((a) => a.type)).toEqual([
      "support.reply.attempt",
      "support.reply",
    ]);
    for (const row of rows) {
      expect(row.author).toBe("agent");
      expect(row.by).toBe("sessions");
      expect(row.byName).toBe(personaName());
    }
  });

  test("only a person may discard it, so no rule ever names the customer as the persona", async () => {
    const { c, draft } = await draftNeedingPerson();
    for (const by of [AGENT, { kind: "customer" } as const])
      expect(await discardDraft(c.id, draft.id, by)).toEqual({
        ok: false,
        status: 409,
        error: "Only a person can do this",
      });
    expect((await getConversation(c.id))!.draft?.state).toBe("needs-person");
  });
});

describe("automatic sends need checked topics and an authenticated sender", () => {
  test("a newer message whose topics aren't checked yet holds the send", async () => {
    await tb.setInbox({ autonomy: "routine", vetoMs: null });
    const c = await tb.conversation();
    await customerWritesAgain(c.id, { triage: undefined });
    const result = await proposeDraft(c.id, DRAFT, AGENT, undefined, CITED);
    expect(result.ok && result.draft.rule).toBe(
      "The newest message isn't checked yet",
    );
    expect(tb.fixture().sent).toHaveLength(0);
  });

  test("an earlier unchecked message since our last reply holds it too", async () => {
    await tb.setInbox({ autonomy: "routine", vetoMs: null });
    const c = await tb.conversation();
    await customerWritesAgain(c.id, { triage: undefined });
    await customerWritesAgain(c.id);
    const result = await proposeDraft(c.id, DRAFT, AGENT, undefined, CITED);
    expect(result.ok && result.draft.state).toBe("needs-person");
  });

  test("a sender without positive authentication waits for a person", async () => {
    await tb.setInbox({ autonomy: "routine", vetoMs: null });
    const c = await tb.conversation({
      trust: { replyToDiffers: false, authFailed: false },
    });
    const result = await proposeDraft(c.id, DRAFT, AGENT, undefined, CITED);
    expect(result.ok && result.draft.rule).toBe(
      "The sender's mail wasn't authenticated",
    );
    expect(tb.fixture().sent).toHaveLength(0);
  });

  test("the inbox's hourly cap holds automatic sends across conversations", async () => {
    await tb.setInbox({ autonomy: "routine", vetoMs: null });
    const now = Date.now();
    await catalogDocuments("support-pending").update(
      `autosends:${tb.inbox().id}`,
      () => ({
        inboxId: tb.inbox().id,
        sends: Array.from(
          { length: AUTO_SENDS_PER_INBOX_PER_HOUR },
          (_, i) => ({
            at: now - i * 1000,
            draftId: `sd_other-${i}`,
          }),
        ),
      }),
    );
    const c = await tb.conversation();
    const result = await proposeDraft(c.id, DRAFT, AGENT, undefined, CITED);
    expect(result.ok && result.draft.rule).toBe(
      `${AUTO_SENDS_PER_INBOX_PER_HOUR} automatic replies from this inbox in the last hour`,
    );
    expect(tb.fixture().sent).toHaveLength(0);
    // A person's reply is never capped.
    expect((await replyAsPerson(c.id, "By hand.", "Ada")).ok).toBe(true);
  });

  test("an automatic send counts against the inbox's cap", async () => {
    await tb.setInbox({ autonomy: "routine", vetoMs: null });
    const c = await tb.conversation();
    const result = await proposeDraft(c.id, DRAFT, AGENT, undefined, CITED);
    expect(result.ok && result.draft.state).toBe("sent");
    const entry = (await catalogDocuments("support-pending").list()).find(
      (e) => e.key === `autosends:${tb.inbox().id}`,
    );
    expect((entry?.value as { sends: unknown[] }).sends).toHaveLength(1);
  });
});

describe("routine sends need a cited source, clean labels and the project's links", () => {
  test("a draft without a source waits for a person", async () => {
    await tb.setInbox({ autonomy: "routine", vetoMs: null });
    const c = await tb.conversation();
    const result = await proposeDraft(c.id, DRAFT, AGENT);
    expect(result.ok && result.draft).toMatchObject({
      state: "needs-person",
      rule: "No source cited",
    });
    expect(tb.fixture().sent).toHaveLength(0);
  });

  test("a promise without a source waits for a person", async () => {
    await tb.setInbox({ autonomy: "routine", vetoMs: null });
    const c = await tb.conversation();
    const result = await proposeDraft(c.id, DRAFT, AGENT, undefined, {
      promises: true,
    });
    expect(result.ok && result.draft.rule).toBe(
      "A promise without a source needs a person",
    );
    expect(result.ok && result.draft.promises).toBe(true);
  });

  test("a link outside the project's sites waits for a person", async () => {
    await tb.setInbox({ autonomy: "routine", vetoMs: null });
    const c = await tb.conversation();
    const result = await proposeDraft(
      c.id,
      "Log in at https://evil.example.test/login to fix it.",
      AGENT,
      undefined,
      CITED,
    );
    expect(result.ok && result.draft.rule).toBe(
      "Links outside the project's sites",
    );
    expect(tb.fixture().sent).toHaveLength(0);
  });

  test("a cited draft with links to the project's sites sends and keeps its sources", async () => {
    await tb.setInbox({ autonomy: "routine", vetoMs: null });
    const c = await tb.conversation();
    const result = await proposeDraft(
      c.id,
      "See https://docs.acme.example.test/export",
      AGENT,
      undefined,
      CITED,
    );
    expect(result.ok && result.draft.state).toBe("sent");
    expect(result.ok && result.draft.sources).toEqual(CITED.sources);
  });

  for (const [label, rule] of [
    ["injection", "The message tries to instruct the agent"],
    ["wantsHuman", "The customer asked for a person"],
    ["angry", "The customer sounds upset"],
    ["repeat", "The customer repeats an answered question"],
  ] as const)
    test(`a message labelled ${label} waits for a person`, async () => {
      await tb.setInbox({ autonomy: "routine", vetoMs: null });
      const c = await tb.conversation({ labels: { [label]: true } });
      const result = await proposeDraft(c.id, DRAFT, AGENT, undefined, CITED);
      expect(result.ok && result.draft.rule).toBe(rule);
    });

  test("an injection flag earlier in the conversation holds later sends", async () => {
    await tb.setInbox({ autonomy: "routine", vetoMs: null });
    const c = await tb.conversation();
    await updateConversation(c.id, (x) => ({ ...x, injectionFlags: 1 }));
    const result = await proposeDraft(c.id, DRAFT, AGENT, undefined, CITED);
    expect(result.ok && result.draft.rule).toBe(
      "The message tries to instruct the agent",
    );
  });
});

describe("draft figures", () => {
  test("count agent drafts sent unchanged, sent edited and discarded", async () => {
    const inboxId = tb.inbox().id;
    const a = await tb.conversation();
    const first = await proposeDraft(a.id, DRAFT, AGENT, undefined, CITED);
    if (!first.ok) throw new Error(first.error);
    expect((await sendDraft(a.id, first.draft.id, ADA)).ok).toBe(true);
    const b = await tb.conversation();
    const second = await proposeDraft(b.id, DRAFT, AGENT, undefined, CITED);
    if (!second.ok) throw new Error(second.error);
    expect(
      (await sendDraft(b.id, second.draft.id, ADA, { text: "Edited." })).ok,
    ).toBe(true);
    const d = await tb.conversation();
    const third = await proposeDraft(d.id, DRAFT, AGENT, undefined, CITED);
    if (!third.ok) throw new Error(third.error);
    expect((await discardDraft(d.id, third.draft.id, ADA)).ok).toBe(true);
    // A person's own reply is not an agent draft.
    await replyAsPerson((await tb.conversation()).id, "Hi", "Ada");
    expect(await draftStats(inboxId)).toEqual({
      days: 30,
      sentUnchanged: 1,
      sentEdited: 1,
      discarded: 1,
      sentAutomatically: 0,
    });
  });

  test("an automatic send counts apart, never as sent unchanged", async () => {
    await tb.setInbox({ autonomy: "routine", vetoMs: null });
    const c = await tb.conversation();
    const sent = await proposeDraft(c.id, DRAFT, AGENT, undefined, CITED);
    expect(sent.ok && sent.draft.state).toBe("sent");
    expect(await draftStats(tb.inbox().id)).toEqual({
      days: 30,
      sentUnchanged: 0,
      sentEdited: 0,
      discarded: 0,
      sentAutomatically: 1,
    });
  });
});

describe("automatic sends answer the customer", () => {
  test("a second automatic reply without a new customer message waits", async () => {
    await tb.setInbox({ autonomy: "routine", vetoMs: null });
    const c = await tb.conversation();
    const first = await proposeDraft(c.id, DRAFT, AGENT, undefined, CITED);
    expect(first.ok && first.draft.state).toBe("sent");
    const second = await proposeDraft(
      c.id,
      `${DRAFT} And more.`,
      AGENT,
      undefined,
      CITED,
    );
    expect(second.ok && second.draft.rule).toBe(
      "No new customer message to answer",
    );
    expect(tb.fixture().sent).toHaveLength(1);
  });

  test("one clarifying question sends without a source, the second waits", async () => {
    await tb.setInbox({ autonomy: "routine", vetoMs: null });
    const c = await tb.conversation();
    const ask = await proposeDraft(
      c.id,
      "Which browser do you use?",
      AGENT,
      undefined,
      {
        purpose: "clarify",
      },
    );
    expect(ask.ok && ask.draft.state).toBe("sent");
    expect((await getConversation(c.id))!.autoClarified).toBe(true);
    await tb.customerReply(c.id, "Firefox.");
    const again = await proposeDraft(c.id, "Which version?", AGENT, undefined, {
      purpose: "clarify",
    });
    expect(again.ok && again.draft.rule).toBe(
      "Only one clarifying question sends on its own",
    );
  });

  test("a draft whose sources the server couldn't verify waits", async () => {
    await tb.setInbox({ autonomy: "routine", vetoMs: null });
    __setDraftCheckForTest(async (input) => ({
      verified: [],
      topics: [],
      promises: false,
      at: new Date(input.now).toISOString(),
    }));
    const c = await tb.conversation();
    const result = await proposeDraft(c.id, DRAFT, AGENT, undefined, CITED);
    expect(result.ok && result.draft.rule).toBe("No source cited");
    expect(result.ok && result.draft.check?.verified).toEqual([]);
    expect(tb.fixture().sent).toHaveLength(0);
  });
});

describe("knowledge at the moment of sending", () => {
  const ARTICLE = "articles/export.md@3f2a1b0";
  const KNOWLEDGE = {
    sources: [{ kind: "knowledge" as const, ref: ARTICLE }],
  };
  const backing = (at: number): KnowledgeVerdict => ({
    backing: [{ kind: "knowledge", ref: ARTICLE }],
    blocked: [],
    internalQuoted: null,
    failed: false,
    at: new Date(at).toISOString(),
  });
  const blocked = (at: number): KnowledgeVerdict => ({
    backing: [],
    blocked: [
      {
        ref: ARTICLE,
        path: "articles/export.md",
        title: "Export",
        reason: "docs/export.md changed in 9c1d2e0",
      },
    ],
    internalQuoted: null,
    failed: false,
    at: new Date(at).toISOString(),
  });

  /** A routine inbox with a veto window and an agent draft citing an
   *  article that backs it when proposed. */
  async function vetoed() {
    await tb.setInbox({ autonomy: "routine", vetoMs: 600_000 });
    const asked: VerdictInput[] = [];
    __setKnowledgeVerdictForTest(async (i) => {
      asked.push(i);
      return backing(i.now);
    });
    const c = await tb.conversation();
    const proposed = await proposeDraft(
      c.id,
      DRAFT,
      AGENT,
      undefined,
      KNOWLEDGE,
    );
    if (!proposed.ok) throw new Error(proposed.error);
    expect(proposed.draft.state).toBe("veto");
    expect(proposed.draft.check?.knowledge?.backing).toHaveLength(1);
    return {
      c,
      draft: proposed.draft,
      deadline: Date.parse(proposed.draft.vetoDeadline!),
      asked,
    };
  }

  test("claimAndDeliver re-verifies knowledge at veto end", async () => {
    const { c, draft, deadline } = await vetoed();
    const asked: VerdictInput[] = [];
    __setKnowledgeVerdictForTest(async (i) => {
      asked.push(i);
      return blocked(i.now);
    });
    const result = await sendDueVeto(c.id, draft.id, deadline + 1);
    expect(result).toMatchObject({
      ok: false,
      error: "Knowledge may be out of date: Export",
    });
    expect(asked).toEqual([
      {
        project: "acme",
        sessionId: "os-1",
        sources: KNOWLEDGE.sources,
        text: DRAFT,
        now: deadline + 1,
      },
    ]);
    const after = (await getConversation(c.id))!.draft!;
    expect(after.state).toBe("needs-person");
    expect(after.rule).toBe("Knowledge may be out of date: Export");
    expect(tb.fixture().sent).toHaveLength(0);
  });

  test("a check that fails at veto end holds the draft", async () => {
    const { c, draft, deadline } = await vetoed();
    __setKnowledgeVerdictForTest(async (i) => ({
      ...backing(i.now),
      backing: [],
      failed: true,
    }));
    await sendDueVeto(c.id, draft.id, deadline + 1);
    expect((await getConversation(c.id))!.draft!.rule).toBe(
      "Knowledge couldn't be checked",
    );
    expect(tb.fixture().sent).toHaveLength(0);
  });

  test("a still-backing article sends at veto end", async () => {
    const { c, draft, deadline } = await vetoed();
    const result = await sendDueVeto(c.id, draft.id, deadline + 1);
    expect(result.ok).toBe(true);
    expect(tb.fixture().sent).toHaveLength(1);
  });

  test("a retry re-verifies knowledge too", async () => {
    const { c, draft } = await vetoed();
    const now = Date.now();
    // A first attempt failed and the retry is due.
    await updateConversation(c.id, (x) => ({
      ...x,
      draft: {
        ...x.draft!,
        state: "sending",
        vetoDeadline: null,
        attempts: 1,
        nextAttemptAt: new Date(now - 1).toISOString(),
        decidedBy: { kind: "sessions" },
      },
    }));
    __setKnowledgeVerdictForTest(async (i) => blocked(i.now));
    const result = await retrySend(c.id, draft.id, now);
    expect(result.ok).toBe(false);
    const after = (await getConversation(c.id))!.draft!;
    expect(after.state).toBe("needs-person");
    expect(after.rule).toBe("Knowledge may be out of date: Export");
    expect(tb.fixture().sent).toHaveLength(0);
  });

  test("the read proof stored at propose goes to the check at veto end", async () => {
    await tb.setInbox({ autonomy: "routine", vetoMs: 600_000 });
    const read = [{ path: "articles/export.md", commit: "3f2a1b0" }];
    __setKnowledgeVerdictForTest(async (i) => ({ ...backing(i.now), read }));
    const c = await tb.conversation();
    const proposed = await proposeDraft(
      c.id,
      DRAFT,
      AGENT,
      undefined,
      KNOWLEDGE,
    );
    if (!proposed.ok) throw new Error(proposed.error);
    expect(proposed.draft.check?.knowledge?.read).toEqual(read);
    const asked: VerdictInput[] = [];
    __setKnowledgeVerdictForTest(async (i) => {
      asked.push(i);
      return backing(i.now);
    });
    const deadline = Date.parse(proposed.draft.vetoDeadline!);
    const result = await sendDueVeto(c.id, proposed.draft.id, deadline + 1);
    expect(result.ok).toBe(true);
    expect(asked.map((i) => i.read)).toEqual([read]);
  });

  test("an automatic send whose verdict wasn't computed refuses", async () => {
    const { c, draft } = await vetoed();
    const now = Date.now();
    // A person's send is being retried: no knowledge check for it.
    await updateConversation(c.id, (x) => ({
      ...x,
      draft: {
        ...x.draft!,
        state: "sending",
        vetoDeadline: null,
        attempts: 1,
        nextAttemptAt: new Date(now - 1).toISOString(),
        decidedBy: { kind: "person", name: "Ada" },
      },
    }));
    let calls = 0;
    __setKnowledgeVerdictForTest(async (i) => {
      calls++;
      return backing(i.now);
    });
    const retry = retrySend(c.id, draft.id, now);
    // Meanwhile the send became automatic.
    await updateConversation(c.id, (x) => ({
      ...x,
      draft: { ...x.draft!, decidedBy: { kind: "sessions" } },
    }));
    expect(await retry).toMatchObject({
      ok: false,
      error: "The conversation changed. Try again",
    });
    expect(calls).toBe(0);
    expect((await getConversation(c.id))!.draft!.state).toBe("sending");
    expect(tb.fixture().sent).toHaveLength(0);
  });

  test("a person sending the draft is not gated by knowledge", async () => {
    const { c, draft } = await vetoed();
    let calls = 0;
    __setKnowledgeVerdictForTest(async (i) => {
      calls++;
      return blocked(i.now);
    });
    const result = await sendDraft(c.id, draft.id, ADA);
    expect(result.ok).toBe(true);
    expect(calls).toBe(0);
    expect(tb.fixture().sent).toHaveLength(1);
  });
});

describe("reply-sent listener", () => {
  type Sent = Parameters<Parameters<typeof onReplySent>[0] & object>[0];
  afterEach(() => onReplySent(null));

  test("a person's reply fires it once, by the person", async () => {
    const seen: Sent[] = [];
    onReplySent((e) => seen.push(e));
    const c = await tb.conversation();
    const result = await replyAsPerson(c.id, "Answered by hand.", "Ada");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(seen).toEqual([
      {
        conversationId: c.id,
        project: "acme",
        messageId: result.message.id,
        by: ADA,
        author: ADA,
        rule: "Sent by Ada",
        knowledgeHold: null,
        citations: [],
      },
    ]);
  });

  test("a person sending an agent draft its knowledge check held carries the hold and the citations", async () => {
    const seen: Sent[] = [];
    onReplySent((e) => seen.push(e));
    const c = await tb.conversation();
    const proposed = await proposeDraft(c.id, DRAFT, AGENT, undefined, CITED);
    if (!proposed.ok) throw new Error(proposed.error);
    const ref = `articles/export.md@${"a".repeat(40)}`;
    await updateConversation(c.id, (x) => ({
      ...x,
      draft: {
        ...x.draft!,
        sources: [...(x.draft!.sources ?? []), { kind: "knowledge", ref }],
        check: {
          verified: [],
          topics: [],
          promises: false,
          knowledge: {
            backing: [],
            blocked: [],
            internalQuoted: { path: "articles/notes.md", title: "Notes" },
            failed: false,
            at: new Date().toISOString(),
          },
          at: new Date().toISOString(),
        },
      },
    }));
    const sent = await sendDraft(c.id, proposed.draft.id, ADA);
    expect(sent.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      by: ADA,
      author: AGENT,
      rule: "Sent by Ada",
      knowledgeHold: "The reply quotes an internal note",
      citations: [ref],
    });
  });

  test("the storing hook runs before the message is stored; its failure doesn't fail the send", async () => {
    const stored: boolean[] = [];
    onReplyStoring(async (e) => {
      const c = await getConversation(e.conversationId);
      stored.push(c!.messages.some((m) => m.id === e.messageId));
    });
    const c = await tb.conversation();
    expect((await replyAsPerson(c.id, "Answered by hand.", "Ada")).ok).toBe(
      true,
    );
    expect(stored).toEqual([false]);
    onReplyStoring(async () => {
      throw new Error("hook broke");
    });
    await tb.customerReply(c.id);
    expect((await replyAsPerson(c.id, "Again.", "Ada")).ok).toBe(true);
    expect(tb.fixture().sent).toHaveLength(2);
    onReplyStoring(null);
  });

  test("an automatic send fires it by sessions", async () => {
    const seen: Sent[] = [];
    onReplySent((e) => seen.push(e));
    await tb.setInbox({ autonomy: "routine", vetoMs: null });
    const c = await tb.conversation();
    const result = await proposeDraft(c.id, DRAFT, AGENT, undefined, CITED);
    expect(result.ok && result.draft.state).toBe("sent");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.by).toEqual({ kind: "sessions" });
    expect(seen[0]!.author).toEqual(AGENT);
  });

  test("a listener that throws doesn't fail the send", async () => {
    onReplySent(() => {
      throw new Error("listener broke");
    });
    const c = await tb.conversation();
    const result = await replyAsPerson(c.id, "Answered by hand.", "Ada");
    expect(result.ok).toBe(true);
    expect(tb.fixture().sent).toHaveLength(1);
    onReplySent(async () => {
      throw new Error("async listener broke");
    });
    await tb.customerReply(c.id);
    expect((await replyAsPerson(c.id, "Again.", "Ada")).ok).toBe(true);
    expect(tb.fixture().sent).toHaveLength(2);
  });
});
