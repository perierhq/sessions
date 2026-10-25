import { describe, expect, test } from "bun:test";
import type { SupportActor } from "../../shared/support";
import { catalogDocuments } from "../catalog-documents";
import { ingestInbound, setSupportPipeline } from "./ingest";
import {
  __resetReplyStateForTest,
  proposeDraft,
  sendDraft,
  stopVeto,
} from "./reply";
import { getConversation, updateConversation } from "./store";
import { useReplyTestbed, CITED } from "./testing/reply-testbed";
import { INTERRUPTED_SEND, emailSupportOn, runSupportTick } from "./tick";

const tb = useReplyTestbed();

const AGENT: SupportActor = { kind: "agent", sessionId: "os-1" };
const ADA: SupportActor = { kind: "person", name: "Ada" };
const MINUTE = 60_000;

async function vetoDraft(vetoMs = 600_000) {
  await tb.setInbox({ autonomy: "routine", vetoMs });
  const c = await tb.conversation();
  const proposed = await proposeDraft(
    c.id,
    "Fixed, please retry.",
    AGENT,
    undefined,
    CITED,
  );
  if (!proposed.ok) throw new Error(proposed.error);
  expect(proposed.draft.state).toBe("veto");
  return {
    c,
    draft: proposed.draft,
    deadline: Date.parse(proposed.draft.vetoDeadline!),
  };
}

describe("runSupportTick", () => {
  test("a veto whose deadline passed is sent by Sessions", async () => {
    const { c, deadline } = await vetoDraft();
    expect((await runSupportTick(deadline - 1)).vetoSent).toBe(0);
    expect(tb.fixture().sent).toHaveLength(0);

    const result = await runSupportTick(deadline + 1);
    expect(result.vetoSent).toBe(1);
    expect(tb.fixture().sent).toHaveLength(1);
    expect(tb.fixture().sent[0]!.raw).toMatch(
      /^Auto-Submitted: auto-replied/im,
    );
    const after = (await getConversation(c.id))!;
    expect(after.messages.at(-1)!.sentBy).toEqual({ kind: "sessions" });
    expect(after.autoSends).toHaveLength(1);

    // Nothing left to do.
    expect((await runSupportTick(deadline + 2)).vetoSent).toBe(0);
    expect(tb.fixture().sent).toHaveLength(1);
  });

  test("a stopped veto is never sent", async () => {
    const { c, draft, deadline } = await vetoDraft();
    expect((await stopVeto(c.id, draft.id, ADA)).ok).toBe(true);
    expect((await runSupportTick(deadline + 1)).vetoSent).toBe(0);
    expect(tb.fixture().sent).toHaveLength(0);
    expect((await getConversation(c.id))!.draft?.state).toBe("needs-person");
  });

  test("a veto due after a restart is sent once", async () => {
    const { deadline } = await vetoDraft();
    __resetReplyStateForTest();
    expect((await runSupportTick(deadline + 1)).vetoSent).toBe(1);
    __resetReplyStateForTest();
    expect((await runSupportTick(deadline + 2)).vetoSent).toBe(0);
    expect(tb.fixture().sent).toHaveLength(1);
  });

  test("a veto whose inbox went back to Draft waits for a person", async () => {
    const { c, deadline } = await vetoDraft();
    await tb.setInbox({ autonomy: "draft" });
    expect((await runSupportTick(deadline + 1)).vetoSent).toBe(0);
    expect(tb.fixture().sent).toHaveLength(0);
    const draft = (await getConversation(c.id))!.draft!;
    expect(draft.state).toBe("needs-person");
    expect(draft.rule).toBe("Drafts wait for a person");
  });

  test("a send interrupted by a restart fails and is never resent", async () => {
    await tb.setInbox({ autonomy: "draft" });
    const c = await tb.conversation();
    const proposed = await proposeDraft(
      c.id,
      "Fixed, please retry.",
      AGENT,
      undefined,
      CITED,
    );
    if (!proposed.ok) throw new Error(proposed.error);
    const startedAt = Date.now();
    // What a crash in the middle of an SMTP send leaves behind.
    await updateConversation(c.id, (x) => ({
      ...x,
      draft: {
        ...x.draft!,
        state: "sending",
        attempts: 1,
        nextAttemptAt: null,
        decidedBy: ADA,
      },
    }));
    await catalogDocuments("support-pending").update(`send:${c.id}`, () => ({
      conversationId: c.id,
      draftId: proposed.draft.id,
      startedAt,
    }));
    __resetReplyStateForTest();

    // Under two minutes: it may still be going.
    expect((await runSupportTick(startedAt + MINUTE)).interrupted).toBe(0);
    expect((await getConversation(c.id))!.draft!.state).toBe("sending");

    const result = await runSupportTick(startedAt + 2 * MINUTE + 1);
    expect(result.interrupted).toBe(1);
    const draft = (await getConversation(c.id))!.draft!;
    expect(draft.state).toBe("failed");
    expect(draft.lastError).toBe(INTERRUPTED_SEND);
    expect(INTERRUPTED_SEND).toBe(
      "Interrupted while sending. Check the mailbox's Sent folder before sending again",
    );
    expect(tb.fixture().sent).toHaveLength(0);
    expect((await runSupportTick(startedAt + 10 * MINUTE)).retried).toBe(0);
    expect(tb.fixture().sent).toHaveLength(0);
  });

  test("a transient failure is retried when due", async () => {
    await tb.setInbox({ autonomy: "draft" });
    const c = await tb.conversation();
    const proposed = await proposeDraft(
      c.id,
      "Fixed, please retry.",
      AGENT,
      undefined,
      CITED,
    );
    if (!proposed.ok) throw new Error(proposed.error);
    tb.fixture().smtpReply = { code: 451, message: "Try again later" };
    await sendDraft(c.id, proposed.draft.id, ADA);
    const waiting = (await getConversation(c.id))!.draft!;
    const due = Date.parse(waiting.nextAttemptAt!);
    // The 451 was recorded; the retry is the second DATA.
    const sentBefore = tb.fixture().sent.length;

    expect((await runSupportTick(due - 1)).retried).toBe(0);
    expect((await runSupportTick(due + 1)).retried).toBe(1);
    expect(tb.fixture().sent.length).toBe(sentBefore + 1);
    const after = (await getConversation(c.id))!;
    expect(after.draft).toBeNull();
    expect(after.messages.at(-1)!.sentBy).toEqual(ADA);
  });

  test("three transient failures fail the draft", async () => {
    await tb.setInbox({ autonomy: "draft" });
    const c = await tb.conversation();
    const proposed = await proposeDraft(
      c.id,
      "Fixed, please retry.",
      AGENT,
      undefined,
      CITED,
    );
    if (!proposed.ok) throw new Error(proposed.error);
    tb.fixture().smtpReply = { code: 451, message: "Try again later" };
    await sendDraft(c.id, proposed.draft.id, ADA);
    for (let i = 0; i < 2; i++) {
      tb.fixture().smtpReply = { code: 451, message: "Try again later" };
      const next = (await getConversation(c.id))!.draft!.nextAttemptAt!;
      expect((await runSupportTick(Date.parse(next) + 1)).retried).toBe(1);
    }
    const draft = (await getConversation(c.id))!.draft!;
    expect(draft.state).toBe("failed");
    expect(draft.attempts).toBe(3);
  });

  test("pending inbound hand-offs are retried", async () => {
    const handed: string[] = [];
    try {
      await ingestInbound({
        inboxId: tb.inbox().id,
        channel: "email",
        providerId: "imap:1:99",
        receivedAt: new Date().toISOString(),
        from: { name: "Dan", address: "dan@customer.example.test" },
        to: [{ name: null, address: tb.inbox().address }],
        cc: [],
        replyTo: [],
        subject: "Hello",
        text: "Hi there",
        keys: {
          messageId: "hello@customer.example.test",
          inReplyTo: null,
          references: [],
        },
        loopHeaders: {},
        attachments: [],
      });
      setSupportPipeline({
        async onInbound(conversation) {
          handed.push(conversation.id);
        },
      });
      const result = await runSupportTick(Date.now() + 10 * MINUTE);
      expect(result.triaged).toBe(1);
      expect(handed).toHaveLength(1);
    } finally {
      setSupportPipeline(null);
    }
  });
});

describe("retries and the pinned target", () => {
  test("a veto whose conversation got a newer message waits for a person", async () => {
    const { c, deadline } = await vetoDraft();
    await updateConversation(c.id, (x) => ({
      ...x,
      messages: [
        ...x.messages,
        {
          ...x.messages[0]!,
          id: "sm_newer",
          keys: {
            messageId: "newer@customer.example.test",
            inReplyTo: null,
            references: [],
          },
          replyTo: [{ name: null, address: "billing@other.example.test" }],
        },
      ],
    }));
    expect((await runSupportTick(deadline + 1)).vetoSent).toBe(0);
    expect(tb.fixture().sent).toHaveLength(0);
    const draft = (await getConversation(c.id))!.draft!;
    expect(draft.state).toBe("needs-person");
    expect(draft.rule).toBe("A newer message arrived");
  });

  test("an automatic retry checks the policy again", async () => {
    await tb.setInbox({ autonomy: "routine", vetoMs: null });
    const c = await tb.conversation();
    tb.fixture().smtpReply = { code: 451, message: "Try again later" };
    const proposed = await proposeDraft(
      c.id,
      "Fixed, please retry.",
      AGENT,
      undefined,
      CITED,
    );
    expect(proposed.ok).toBe(false);
    const waiting = (await getConversation(c.id))!.draft!;
    expect(waiting.state).toBe("sending");
    await tb.setInbox({ autonomy: "draft" });
    const sentBefore = tb.fixture().sent.length;
    await runSupportTick(Date.parse(waiting.nextAttemptAt!) + 1);
    expect(tb.fixture().sent.length).toBe(sentBefore);
    const draft = (await getConversation(c.id))!.draft!;
    expect(draft.state).toBe("needs-person");
    expect(draft.rule).toBe("Drafts wait for a person");
  });

  test("an automatic retry after a newer message waits for a person", async () => {
    await tb.setInbox({ autonomy: "routine", vetoMs: null });
    const c = await tb.conversation();
    tb.fixture().smtpReply = { code: 451, message: "Try again later" };
    await proposeDraft(c.id, "Fixed, please retry.", AGENT, undefined, CITED);
    const waiting = (await getConversation(c.id))!.draft!;
    await updateConversation(c.id, (x) => ({
      ...x,
      messages: [
        ...x.messages,
        {
          ...x.messages[0]!,
          id: "sm_newer2",
          keys: {
            messageId: "n2@customer.example.test",
            inReplyTo: null,
            references: [],
          },
        },
      ],
    }));
    await runSupportTick(Date.parse(waiting.nextAttemptAt!) + 1);
    const draft = (await getConversation(c.id))!.draft!;
    expect(draft.state).toBe("needs-person");
    expect(draft.rule).toBe("A newer message arrived");
  });
});

describe("the tick's keys", () => {
  test("a veto key naming an older draft is fixed, not dropped", async () => {
    const { c, draft } = await vetoDraft();
    const docs = catalogDocuments("support-pending");
    // A key left by an earlier draft, as a crash between writes would.
    await docs.update(`veto:${c.id}`, () => ({
      conversationId: c.id,
      draftId: "sd_older",
      deadline: 0,
    }));
    await runSupportTick(Date.now());
    const value = (await docs.get(`veto:${c.id}`)) as { draftId: string };
    expect(value.draftId).toBe(draft.id);
    expect(tb.fixture().sent).toHaveLength(0);
  });

  test("due vetoes of one tick are sent within its time budget", async () => {
    await tb.setInbox({ autonomy: "routine", vetoMs: MINUTE });
    for (let i = 0; i < 3; i++) {
      const c = await tb.conversation();
      const proposed = await proposeDraft(
        c.id,
        `Fixed (${i}).`,
        AGENT,
        undefined,
        CITED,
      );
      if (!proposed.ok) throw new Error(proposed.error);
    }
    const result = await runSupportTick(Date.now() + 2 * MINUTE);
    expect(result.vetoSent).toBe(3);
    expect(tb.fixture().sent).toHaveLength(3);
  });
});

describe("startSupportTick", () => {
  test("does nothing while email support is off", () => {
    const saved = process.env.ENABLE_EMAIL_SUPPORT;
    process.env.ENABLE_EMAIL_SUPPORT = "false";
    try {
      expect(emailSupportOn()).toBe(false);
      process.env.ENABLE_EMAIL_SUPPORT = "true";
      expect(emailSupportOn()).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.ENABLE_EMAIL_SUPPORT;
      else process.env.ENABLE_EMAIL_SUPPORT = saved;
    }
  });
});
