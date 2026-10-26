import { describe, expect, test } from "bun:test";
import { type MailRecord, pairThreads } from "./pairs";

const CAROL = { name: "Carol", address: "carol@customer.example.test" };
const US = { name: "Acme help", address: "help@acme.example.test" };

function mail(
  messageId: string,
  over: Partial<MailRecord> & { ours?: boolean } = {},
): MailRecord {
  const ours = over.ours ?? false;
  return {
    messageId,
    inReplyTo: null,
    references: [],
    from: ours ? US : CAROL,
    at: "2026-10-20T08:00:00.000Z",
    text: ours ? "Our reply" : "A question",
    ours,
    ...over,
  };
}

const ids = (pairs: ReturnType<typeof pairThreads>) =>
  pairs.map((p) => [p.question.messageId, p.answer.messageId]);

describe("pairThreads", () => {
  test("a customer message and our reply with In-Reply-To pair", () => {
    const q = mail("q1@customer.example.test");
    const a = mail("a1@acme.example.test", {
      ours: true,
      inReplyTo: "q1@customer.example.test",
    });
    expect(ids(pairThreads([a, q]))).toEqual([
      ["q1@customer.example.test", "a1@acme.example.test"],
    ]);
  });

  test("a reply that names the question only in References pairs", () => {
    const q = mail("q1@customer.example.test");
    const a = mail("a1@acme.example.test", {
      ours: true,
      references: ["older@customer.example.test", "q1@customer.example.test"],
    });
    expect(ids(pairThreads([q, a]))).toEqual([
      ["q1@customer.example.test", "a1@acme.example.test"],
    ]);
  });

  test("a reply to our own message makes no pair", () => {
    // Our follow-up to our own reply: the customer's question further up
    // References was already answered by that reply.
    const q = mail("q1@customer.example.test");
    const a1 = mail("a1@acme.example.test", {
      ours: true,
      inReplyTo: "q1@customer.example.test",
    });
    const a2 = mail("a2@acme.example.test", {
      ours: true,
      inReplyTo: "a1@acme.example.test",
      references: ["q1@customer.example.test", "a1@acme.example.test"],
    });
    expect(ids(pairThreads([q, a1, a2]))).toEqual([
      ["q1@customer.example.test", "a1@acme.example.test"],
    ]);
  });

  test("Message-IDs match however they are written", () => {
    const q = mail("<Q1@Customer.Example.Test>");
    const a = mail("a1@acme.example.test", {
      ours: true,
      inReplyTo: "<Q1@customer.example.test>",
    });
    expect(pairThreads([q, a])).toHaveLength(1);
  });

  test("two of our replies to one question make two pairs", () => {
    const q = mail("q1@customer.example.test");
    const a1 = mail("a1@acme.example.test", {
      ours: true,
      inReplyTo: "q1@customer.example.test",
    });
    const a2 = mail("a2@acme.example.test", {
      ours: true,
      inReplyTo: "q1@customer.example.test",
    });
    expect(ids(pairThreads([q, a1, a2]))).toEqual([
      ["q1@customer.example.test", "a1@acme.example.test"],
      ["q1@customer.example.test", "a2@acme.example.test"],
    ]);
  });

  test("the nearest customer message in the thread is the question", () => {
    const q1 = mail("q1@customer.example.test");
    const a1 = mail("a1@acme.example.test", {
      ours: true,
      inReplyTo: "q1@customer.example.test",
    });
    const q2 = mail("q2@customer.example.test", {
      inReplyTo: "a1@acme.example.test",
      references: ["q1@customer.example.test", "a1@acme.example.test"],
    });
    const a2 = mail("a2@acme.example.test", {
      ours: true,
      inReplyTo: "q2@customer.example.test",
      references: [
        "q1@customer.example.test",
        "a1@acme.example.test",
        "q2@customer.example.test",
      ],
    });
    expect(ids(pairThreads([q1, a1, q2, a2]))).toEqual([
      ["q1@customer.example.test", "a1@acme.example.test"],
      ["q2@customer.example.test", "a2@acme.example.test"],
    ]);
  });

  test("our message with no customer parent is dropped", () => {
    const outreach = mail("a1@acme.example.test", { ours: true });
    const toUnknown = mail("a2@acme.example.test", {
      ours: true,
      inReplyTo: "missing@customer.example.test",
    });
    const toOurs = mail("a3@acme.example.test", {
      ours: true,
      inReplyTo: "a1@acme.example.test",
    });
    expect(pairThreads([outreach, toUnknown, toOurs])).toEqual([]);
  });

  test("a customer follow-up is never an answer", () => {
    const q = mail("q1@customer.example.test");
    const a = mail("a1@acme.example.test", {
      ours: true,
      inReplyTo: "q1@customer.example.test",
    });
    const followUp = mail("q2@customer.example.test", {
      inReplyTo: "a1@acme.example.test",
      references: ["q1@customer.example.test", "a1@acme.example.test"],
    });
    const pairs = pairThreads([q, a, followUp]);
    expect(ids(pairs)).toEqual([
      ["q1@customer.example.test", "a1@acme.example.test"],
    ]);
    expect(pairs.every((p) => p.answer.ours)).toBe(true);
  });

  test("a message seen in two folders counts once", () => {
    const q = mail("q1@customer.example.test");
    const a = mail("a1@acme.example.test", {
      ours: true,
      inReplyTo: "q1@customer.example.test",
    });
    // Our reply in Sent and in INBOX (a copy to ourselves): one pair. Two
    // customer messages with one ID are the ambiguous case below.
    expect(pairThreads([q, a, { ...a, ours: false }])).toHaveLength(1);
    expect(pairThreads([q, a, { ...a }])).toHaveLength(1);
  });

  test("a question dated after the answer (past 5 minutes) makes no pair", () => {
    const q = mail("q1@customer.example.test", {
      at: "2026-10-20T08:06:00.000Z",
    });
    const a = mail("a1@acme.example.test", {
      ours: true,
      inReplyTo: "q1@customer.example.test",
      at: "2026-10-20T08:00:00.000Z",
    });
    expect(pairThreads([q, a])).toEqual([]);
    // Within the 5-minute skew it still pairs.
    const close = { ...q, at: "2026-10-20T08:04:00.000Z" };
    expect(ids(pairThreads([close, a]))).toHaveLength(1);
  });

  test("a Message-ID on two INBOX messages pairs with neither", () => {
    const q = mail("q1@customer.example.test", { text: "Real" });
    const spoof = mail("q1@customer.example.test", { text: "Spoof" });
    const a = mail("a1@acme.example.test", {
      ours: true,
      inReplyTo: "q1@customer.example.test",
    });
    const b = mail("a2@acme.example.test", {
      ours: true,
      references: ["q1@customer.example.test"],
    });
    expect(pairThreads([q, spoof, a, b])).toEqual([]);
    // Without the duplicate both pair.
    expect(pairThreads([q, a, b])).toHaveLength(2);
  });

  test("a duplicate further up References is never fallen back past", () => {
    const old = mail("q0@customer.example.test");
    const q = mail("q1@customer.example.test");
    const dup = mail("q1@customer.example.test");
    const a = mail("a1@acme.example.test", {
      ours: true,
      references: ["q0@customer.example.test", "q1@customer.example.test"],
    });
    expect(pairThreads([old, q, dup, a])).toEqual([]);
  });
});
