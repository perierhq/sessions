import { expect, test } from "bun:test";
import type { SupportMessage, ThreadKeys } from "../../shared/support";
import { catalogDocuments } from "../catalog-documents";
import { createConversation, rememberMessageIds } from "./store";
import { useSupportTestKernel } from "./testing/kernel-fixture";
import { findConversation, threadCandidates } from "./threading";

useSupportTestKernel();

const INBOX_I = "inb_i";
const INBOX_J = "inb_j";
const NOW = "2026-10-25T10:00:00.000Z";

function message(keys: ThreadKeys): SupportMessage {
  return {
    id: "msg_1",
    direction: "in",
    at: NOW,
    from: { name: "Ada", address: "ada@example.test" },
    to: [{ name: null, address: "help@acme.example.test" }],
    cc: [],
    subject: "Login broken",
    text: "I cannot log in.",
    keys,
    providerId: "imap:1:10",
    attachments: [],
  };
}

async function conversationIn(inboxId: string, messageId: string) {
  const first = message({ messageId, inReplyTo: null, references: [] });
  const c = await createConversation({
    channel: "email",
    inboxId,
    project: "acme",
    subject: first.subject,
    customer: first.from,
    owner: null,
    first,
    now: NOW,
  });
  await rememberMessageIds(inboxId, c.id, [messageId], ["imap:1:10"]);
  return c;
}

test("threadCandidates: In-Reply-To first, then References newest first", () => {
  expect(
    threadCandidates({
      messageId: "c@x",
      inReplyTo: "b@x",
      references: ["a@x", "b@x"],
    }),
  ).toEqual(["b@x", "a@x"]);
  expect(
    threadCandidates({
      messageId: "c@x",
      inReplyTo: null,
      references: ["a@x", "c@x", "b@x"],
    }),
  ).toEqual(["b@x", "a@x"]);
  expect(
    threadCandidates({ messageId: null, inReplyTo: null, references: [] }),
  ).toEqual([]);
});

test("threadCandidates: In-Reply-To plus only the newest 20 References", () => {
  const references = Array.from({ length: 30 }, (_, i) => `r${i}@x`);
  const out = threadCandidates({
    messageId: "c@x",
    inReplyTo: "irt@x",
    references,
  });
  expect(out).toHaveLength(21);
  expect(out[0]).toBe("irt@x");
  expect(out[1]).toBe("r29@x");
  expect(out.at(-1)).toBe("r10@x");
});

test("a key left pointing at a deleted conversation is skipped", async () => {
  const older = await conversationIn(INBOX_I, "older@acme.example.test");
  const gone = await conversationIn(INBOX_I, "gone@acme.example.test");
  // The document is gone; its key was not cleaned up.
  await catalogDocuments("support-conversations").delete(gone.id);
  expect(
    await findConversation(INBOX_I, {
      messageId: "reply@example.test",
      inReplyTo: "gone@acme.example.test",
      references: ["older@acme.example.test", "gone@acme.example.test"],
    }),
  ).toBe(older.id);
  expect(
    await findConversation(INBOX_I, {
      messageId: "reply@example.test",
      inReplyTo: "gone@acme.example.test",
      references: [],
    }),
  ).toBeNull();
});

test("a reply to a stored message finds its conversation", async () => {
  const k = await conversationIn(INBOX_I, "first@acme.example.test");
  expect(
    await findConversation(INBOX_I, {
      messageId: "reply@example.test",
      inReplyTo: "first@acme.example.test",
      references: ["first@acme.example.test"],
    }),
  ).toBe(k.id);
});

test("References alone thread", async () => {
  const k = await conversationIn(INBOX_I, "first@acme.example.test");
  expect(
    await findConversation(INBOX_I, {
      messageId: "reply@example.test",
      inReplyTo: null,
      references: ["unknown@example.test", "first@acme.example.test"],
    }),
  ).toBe(k.id);
});

test("In-Reply-To wins over References", async () => {
  const a = await conversationIn(INBOX_I, "a@acme.example.test");
  const b = await conversationIn(INBOX_I, "b@acme.example.test");
  expect(
    await findConversation(INBOX_I, {
      messageId: "reply@example.test",
      inReplyTo: "a@acme.example.test",
      references: ["a@acme.example.test", "b@acme.example.test"],
    }),
  ).toBe(a.id);
  expect(b.id).not.toBe(a.id);
});

test("no threading across inboxes", async () => {
  await conversationIn(INBOX_J, "first@acme.example.test");
  expect(
    await findConversation(INBOX_I, {
      messageId: "reply@example.test",
      inReplyTo: null,
      references: ["first@acme.example.test"],
    }),
  ).toBeNull();
});

test("no keys, or only a matching subject, start a new conversation", async () => {
  await conversationIn(INBOX_I, "first@acme.example.test");
  expect(
    await findConversation(INBOX_I, {
      messageId: null,
      inReplyTo: null,
      references: [],
    }),
  ).toBeNull();
  // Same subject ("Login broken"), new Message-ID, no reply keys.
  expect(
    await findConversation(INBOX_I, {
      messageId: "other@example.test",
      inReplyTo: null,
      references: [],
    }),
  ).toBeNull();
});
