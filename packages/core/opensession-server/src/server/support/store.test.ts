import { afterEach, expect, test } from "bun:test";
import {
  MAX_DOC_BYTES,
  MAX_MESSAGES,
  MAX_TEXT_CHARS,
  type SupportConversation,
  type SupportMessage,
} from "../../shared/support";
import {
  type ConversationListener,
  createConversation,
  deleteConversation,
  getConversation,
  indexRowFor,
  listIndexRows,
  lookupMessageIds,
  lookupProviderId,
  onConversationChange,
  rememberMessageIds,
  updateConversation,
} from "./store";
import { catalogDocuments } from "../catalog-documents";
import { useSupportTestKernel } from "./testing/kernel-fixture";

const kernel = useSupportTestKernel();

const INBOX = "inb_acme";
const NOW = "2026-10-25T10:00:00.000Z";

let unsubscribe: (() => void) | undefined;
afterEach(() => {
  unsubscribe?.();
  unsubscribe = undefined;
});

/** Listeners run on their own microtask. */
const settle = () => Bun.sleep(0);

function record(): Array<
  [SupportConversation | null, SupportConversation | null]
> {
  const calls: Array<[SupportConversation | null, SupportConversation | null]> =
    [];
  const listener: ConversationListener = (next, previous) => {
    calls.push([next, previous]);
  };
  unsubscribe = onConversationChange(listener);
  return calls;
}

function message(
  n: number,
  over: Partial<SupportMessage> = {},
): SupportMessage {
  return {
    id: `msg_${n}`,
    direction: "in",
    at: new Date(Date.parse(NOW) + n * 60_000).toISOString(),
    from: { name: "Ada", address: "ada@example.test" },
    to: [{ name: null, address: "help@acme.example.test" }],
    cc: [],
    subject: "Login broken",
    text: `Message ${n}`,
    keys: { messageId: `m${n}@example.test`, inReplyTo: null, references: [] },
    providerId: `imap:1:${n}`,
    attachments: [],
    ...over,
  };
}

async function create(first = message(0)): Promise<SupportConversation> {
  return createConversation({
    channel: "email",
    inboxId: INBOX,
    project: "acme",
    subject: first.subject,
    customer: first.from,
    owner: null,
    first,
    now: NOW,
  });
}

test("createConversation stores an open conversation and its index row", async () => {
  const text = `  Hello,\n\n  I cannot\tlog in.  ${"x".repeat(300)}`;
  const c = await create(message(0, { text }));
  expect(c.id.startsWith("sc_")).toBe(true);
  expect(c.revision).toBe(0);
  expect(c.status).toBe("open");
  expect(c.messages).toHaveLength(1);
  expect(await getConversation(c.id)).toEqual(c);

  const rows = await listIndexRows();
  expect(rows).toHaveLength(1);
  const collapsed = text.replace(/\s+/g, " ").trim();
  expect(rows[0]!.preview).toBe(collapsed.slice(0, 160));
  expect(rows[0]!.id).toBe(c.id);
  expect(rows[0]!.unansweredSince).toBe(c.messages[0]!.at);
  expect(rows[0]).toEqual(indexRowFor(c));
});

test("getConversation refuses ids that are not conversation ids", async () => {
  expect(await getConversation("nope")).toBeNull();
  expect(await getConversation("sc_../x")).toBeNull();
});

test("updateConversation: null writes nothing, a change bumps revision once", async () => {
  const c = await create();
  const calls = record();

  const same = await updateConversation(c.id, () => null);
  await settle();
  expect(same?.revision).toBe(0);
  expect(calls).toHaveLength(0);

  const next = await updateConversation(c.id, (cur) => ({
    ...cur,
    status: "waiting",
  }));
  await settle();
  expect(next?.revision).toBe(1);
  expect(next?.status).toBe("waiting");
  expect(calls).toHaveLength(1);
  expect(calls[0]![0]).toEqual(next);
  expect(calls[0]![1]).toEqual(c);
  expect((await listIndexRows())[0]!.status).toBe("waiting");

  expect(await updateConversation("sc_missing", (cur) => cur)).toBeNull();
});

test("two overlapping updates in one process both land (the per-key queue serialises them)", async () => {
  const c = await create();
  await Promise.all([
    updateConversation(c.id, (cur) => ({
      ...cur,
      messages: [...cur.messages, message(1)],
    })),
    updateConversation(c.id, (cur) => ({
      ...cur,
      messages: [...cur.messages, message(2)],
    })),
  ]);
  const stored = await getConversation(c.id);
  expect(stored?.messages).toHaveLength(3);
  expect(stored?.revision).toBe(2);
});

test("more than MAX_MESSAGES drops the oldest", async () => {
  const c = await create();
  const extra = Array.from({ length: MAX_MESSAGES + 4 }, (_, i) =>
    message(i + 1, { text: "short" }),
  );
  const next = await updateConversation(c.id, (cur) => ({
    ...cur,
    messages: [...cur.messages, ...extra],
  }));
  expect(next?.messages).toHaveLength(MAX_MESSAGES);
  expect(next?.messages[0]!.id).toBe("msg_5");
  expect(next?.messages.at(-1)!.id).toBe(`msg_${MAX_MESSAGES + 4}`);
  const row = (await listIndexRows())[0]!;
  expect(row.lastMessageAt).toBe(next!.lastMessageAt);
});

test("an oversized document clears the oldest texts until it fits", async () => {
  const c = await create();
  const big = "y".repeat(MAX_TEXT_CHARS);
  const count = Math.ceil(MAX_DOC_BYTES / MAX_TEXT_CHARS) + 5;
  const extra = Array.from({ length: count }, (_, i) =>
    message(i + 1, { text: big }),
  );
  const next = await updateConversation(c.id, (cur) => ({
    ...cur,
    messages: [...cur.messages, ...extra],
  }));
  expect(next).not.toBeNull();
  expect(Buffer.byteLength(JSON.stringify(next))).toBeLessThanOrEqual(
    MAX_DOC_BYTES,
  );
  expect(next!.messages).toHaveLength(count + 1);
  expect(next!.messages[0]!.text).toBeNull();
  expect(next!.messages[1]!.text).toBeNull();
  expect(next!.messages.at(-1)!.text).toBe(big);
  // Cleared from the oldest forward: no kept text before a cleared one.
  const firstKept = next!.messages.findIndex((m) => m.text !== null);
  expect(next!.messages.slice(firstKept).every((m) => m.text !== null)).toBe(
    true,
  );
  expect((await getConversation(c.id))?.revision).toBe(1);
});

test("updateConversation keeps the inbox: mutate cannot move a conversation", async () => {
  const c = await create();
  const next = await updateConversation(c.id, (cur) => ({
    ...cur,
    inboxId: "inb_other",
  }));
  expect(next?.inboxId).toBe(INBOX);
  expect(next?.revision).toBe(0);
  expect((await getConversation(c.id))?.inboxId).toBe(INBOX);
  expect(await listIndexRows({ inboxId: "inb_other" })).toEqual([]);
});

test("events, moves and auto-sends are trimmed to the newest so the document fits", async () => {
  const c = await create();
  const detail = "z".repeat(1_000);
  const events = Array.from({ length: 5_000 }, (_, i) => ({
    at: NOW,
    kind: "note",
    actor: { kind: "sessions" as const },
    detail: `${i} ${detail}`,
  }));
  const moves = Array.from({ length: 5_000 }, (_, i) => ({
    at: NOW,
    from: "acme",
    to: "acme-api",
    by: { kind: "sessions" as const },
    reason: `${i} ${detail}`,
  }));
  const autoSends = Array.from({ length: 5_000 }, (_, i) =>
    new Date(Date.parse(NOW) + i).toISOString(),
  );
  const next = await updateConversation(c.id, (cur) => ({
    ...cur,
    events,
    moves,
    autoSends,
  }));
  expect(next).not.toBeNull();
  expect(Buffer.byteLength(JSON.stringify(next))).toBeLessThanOrEqual(
    MAX_DOC_BYTES,
  );
  expect(next!.events.length).toBeLessThan(events.length);
  expect(next!.events.at(-1)).toEqual(events.at(-1)!);
  expect(next!.moves.length).toBeLessThan(moves.length);
  expect(next!.moves.at(-1)).toEqual(moves.at(-1)!);
  expect(next!.autoSends.length).toBeLessThan(autoSends.length);
  expect(next!.autoSends.at(-1)).toBe(autoSends.at(-1)!);
  expect(next!.messages.at(-1)!.text).toBe("Message 0");
});

test("message ids and provider ids round-trip, per inbox", async () => {
  const c = await create();
  await rememberMessageIds(
    INBOX,
    c.id,
    ["m0@example.test", "Weird/<id>@example.test"],
    ["imap:1:0"],
  );
  const found = await lookupMessageIds(INBOX, [
    "m0@example.test",
    "Weird/<id>@example.test",
    "unknown@example.test",
  ]);
  expect([...found]).toEqual([
    ["m0@example.test", c.id],
    ["Weird/<id>@example.test", c.id],
  ]);
  expect(await lookupProviderId(INBOX, "imap:1:0")).toBe(c.id);
  expect(await lookupProviderId(INBOX, "imap:1:99")).toBeNull();
  expect((await lookupMessageIds("inb_other", ["m0@example.test"])).size).toBe(
    0,
  );
});

test("a Message-ID stays with the conversation that stored it first", async () => {
  const a = await create();
  const b = await create(message(1));
  await rememberMessageIds(INBOX, a.id, ["shared@example.test"], []);
  await rememberMessageIds(INBOX, b.id, ["shared@example.test"], []);
  expect(
    (await lookupMessageIds(INBOX, ["shared@example.test"])).get(
      "shared@example.test",
    ),
  ).toBe(a.id);
  // Deleting b leaves a's key alone.
  await deleteConversation(b.id);
  expect(
    (await lookupMessageIds(INBOX, ["shared@example.test"])).get(
      "shared@example.test",
    ),
  ).toBe(a.id);
});

test("deleteConversation removes the doc, its index row and its keys", async () => {
  const c = await create();
  const other = await create(message(7));
  await rememberMessageIds(
    INBOX,
    c.id,
    ["m0@example.test", "m1@example.test"],
    ["imap:1:0", "imap:1:1"],
  );
  await rememberMessageIds(INBOX, other.id, ["m7@example.test"], ["imap:1:7"]);
  const calls = record();

  expect(await deleteConversation(c.id)).toBe(true);
  await settle();
  expect(await getConversation(c.id)).toBeNull();
  expect((await listIndexRows()).map((r) => r.id)).toEqual([other.id]);
  expect(
    (await lookupMessageIds(INBOX, ["m0@example.test", "m1@example.test"]))
      .size,
  ).toBe(0);
  expect(await lookupProviderId(INBOX, "imap:1:0")).toBeNull();
  expect(await lookupProviderId(INBOX, "imap:1:1")).toBeNull();
  expect(await lookupProviderId(INBOX, "imap:1:7")).toBe(other.id);
  expect(calls).toHaveLength(1);
  expect(calls[0]![0]).toBeNull();
  expect(calls[0]![1]?.id).toBe(c.id);

  expect(await deleteConversation(c.id)).toBe(false);
});

test("deleteConversation still clears the index row and keys when the document is already gone", async () => {
  const c = await create();
  await rememberMessageIds(INBOX, c.id, ["m0@example.test"], ["imap:1:0"]);
  expect(await catalogDocuments("support-conversations").delete(c.id)).toBe(
    true,
  );
  const calls = record();

  expect(await deleteConversation(c.id)).toBe(true);
  await settle();
  expect(await listIndexRows()).toEqual([]);
  expect((await lookupMessageIds(INBOX, ["m0@example.test"])).size).toBe(0);
  expect(await lookupProviderId(INBOX, "imap:1:0")).toBeNull();
  expect(await catalogDocuments("support-message-ids").get(`c:${c.id}`)).toBe(
    null,
  );
  expect(calls).toHaveLength(0);
  expect(await deleteConversation(c.id)).toBe(false);
});

test("an index write that lands after a concurrent delete is dropped", async () => {
  const c = await create();
  const store = kernel.store();
  const put = store.putCatalogDocument.bind(store);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  // Hold the update's document commit so the delete runs meanwhile.
  store.putCatalogDocument = ((input) => {
    if (input.namespace !== "support-conversations" || held) return put(input);
    held = true;
    return gate.then(() => put(input));
  }) as typeof store.putCatalogDocument;

  const updating = updateConversation(c.id, (cur) => ({
    ...cur,
    status: "waiting",
  }));
  while (!held) await Bun.sleep(0);
  const deleting = deleteConversation(c.id);
  await Bun.sleep(5);
  release();
  await Promise.all([updating, deleting]);

  expect(await getConversation(c.id)).toBeNull();
  expect(await listIndexRows()).toEqual([]);
});

test("listIndexRows filters by inbox, status and customer (any case)", async () => {
  const a = await create();
  const b = await create(
    message(1, { from: { name: "Bo", address: "bo@example.test" } }),
  );
  await updateConversation(b.id, (cur) => ({ ...cur, status: "closed" }));

  expect(
    (await listIndexRows({ customerEmail: "ADA@example.test" })).map(
      (r) => r.id,
    ),
  ).toEqual([a.id]);
  expect(
    (await listIndexRows({ status: ["closed"] })).map((r) => r.id),
  ).toEqual([b.id]);
  expect(await listIndexRows({ inboxId: "inb_other" })).toEqual([]);
  expect((await listIndexRows({ inboxId: INBOX })).length).toBe(2);
});
