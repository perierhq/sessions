/**
 * The supervisor's memory writer: debounced after a turn, reads only the
 * owner/Blob exchanges past its cursor on the supervisor record, asks a
 * (mocked) small model for durable facts, writes them to the owner's
 * personal memory, and moves the cursor only after a successful write. The
 * last block runs the real memory service to show the facts reach the
 * supervisor's retrieval and its rebuilt memory snapshot.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SessionKernelStore,
  __setSessionKernelStoreForTest,
} from "./session-kernel";
import type { EntryInput } from "./memory-repo/service";
import type { SeqTranscriptEntry } from "./supervisor-conversation";

const root = mkdtempSync(join(tmpdir(), "supervisor-memory-writer-test-"));
const prior = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = root;

type Writer = typeof import("./supervisor-memory-writer");
type Inbox = typeof import("./supervisor-inbox");
type Catalog = typeof import("./catalog-documents");
let writer: Writer;
let inbox: Inbox;
let catalog: Catalog;

beforeAll(async () => {
  writer = await import("./supervisor-memory-writer");
  inbox = await import("./supervisor-inbox");
  catalog = await import("./catalog-documents");
});

afterAll(() => {
  if (prior === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = prior;
  rmSync(root, { recursive: true, force: true });
});

const NOW = Date.parse("2026-07-01T12:00:00Z");
let store: SessionKernelStore;
let previousStore: SessionKernelStore | undefined;
let transcripts: Map<string, SeqTranscriptEntry[]>;
let reads: Array<{ sessionId: string; since: number }>;
let prompts: string[];
let answer: string | null;
let written: EntryInput[];
let failWrite: Error | null;
let busy: boolean;
let timers: Array<{ run: () => void; ms: number; cleared: boolean }>;
let restore: () => void = () => {};
let restoreInbox: () => void = () => {};

function append(sessionId: string, ...rows: Omit<SeqTranscriptEntry, "seq">[]) {
  const list = transcripts.get(sessionId) ?? [];
  for (const row of rows)
    list.push({
      ...row,
      seq: (list.at(-1)?.seq ?? 0) + 1,
    } as SeqTranscriptEntry);
  transcripts.set(sessionId, list);
}

function exchange(
  sessionId: string,
  owner: string,
  reply: string,
  at = "2026-07-01T09:00:00Z",
) {
  append(
    sessionId,
    { id: `u-${owner}`, type: "user", content: owner, timestamp: at },
    { id: `t-${owner}`, type: "tool_use", content: "", timestamp: at },
    { id: `a-${owner}`, type: "assistant", content: reply, timestamp: at },
  );
}

async function setRecord(record: Record<string, unknown>) {
  const { SUPERVISORS_NAMESPACE, supervisorKey } = await import("./supervisor");
  await catalog
    .catalogDocuments(SUPERVISORS_NAMESPACE)
    .update(supervisorKey("Ada"), () => ({
      createdAt: "",
      compactions: 0,
      // A record made today starts its writer at the session's beginning.
      memoryCursor: { sessionId: record.sessionId, seq: 0 },
      ...record,
    }));
}

async function cursor() {
  return (await (await import("./supervisor")).readSupervisorRecord("Ada"))
    ?.memoryCursor;
}

beforeEach(() => {
  for (const dir of [
    ".opensession-supervisors",
    ".opensession-supervisor-items",
  ])
    rmSync(join(root, dir), { recursive: true, force: true });
  store = new SessionKernelStore(":memory:");
  previousStore = __setSessionKernelStoreForTest(store);
  transcripts = new Map();
  reads = [];
  prompts = [];
  answer = '{"facts":[]}';
  written = [];
  failWrite = null;
  busy = false;
  timers = [];
  restoreInbox = inbox.__setSupervisorInboxDepsForTest({
    now: () => NOW,
    notify: async () => ({}),
    markDone: async () => {},
    supervisorSessionId: async () => "os-sup",
    rotateSupervisor: async () => {},
    timeZone: () => "UTC",
  });
  restore = writer.__setSupervisorMemoryWriterDepsForTest({
    now: () => NOW,
    enabled: () => true,
    setTimer: (run, ms) => {
      const timer = { run, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      (timer as { cleared: boolean }).cleared = true;
    },
    readSince: async (sessionId, since, limit) => {
      reads.push({ sessionId, since });
      return {
        entries: (transcripts.get(sessionId) ?? [])
          .filter((row) => row.seq > since)
          .slice(0, limit),
      };
    },
    lastSeq: async (sessionId) => transcripts.get(sessionId)?.at(-1)?.seq ?? 0,
    busy: () => busy,
    complete: async (prompt) => {
      prompts.push(prompt);
      return answer;
    },
    existing: async () => ["Prefers BLUF replies."],
    write: async (input) => {
      if (failWrite) throw failWrite;
      written.push(input);
      return true;
    },
    sessionLink: async (id) => `https://os.example.test/session/${id}`,
  });
});

afterEach(() => {
  writer.__resetSupervisorMemoryWriterForTest();
  restore();
  restoreInbox();
  inbox.__resetSupervisorInboxForTest();
  __setSessionKernelStoreForTest(previousStore);
  store.close();
});

describe("writer run", () => {
  test("writes the owner's facts with kind, source and expiry, then moves the cursor", async () => {
    await setRecord({ sessionId: "os-sup", previous: [] });
    exchange("os-sup", "I prefer SBAR for incident reports now.", "Got it.");
    exchange("os-sup", "Mia owns billing until August.", "Noted.");
    answer = JSON.stringify({
      facts: [
        {
          text: "Used to want BLUF incident reports, now prefers SBAR.",
          kind: "preference",
        },
        {
          text: "Mia owns billing until the end of August.",
          kind: "status",
          expires: "2026-08-31",
        },
      ],
    });
    const result = await writer.runSupervisorMemoryWriter("Ada");
    expect(result.status).toBe("written");
    expect(written).toEqual([
      {
        scopeKey: "user-ada",
        text: "Used to want BLUF incident reports, now prefers SBAR.",
        kind: "preference",
        source: "https://os.example.test/session/os-sup",
        by: "Ada",
        via: "supervisor",
        tags: ["supervisor"],
      },
      {
        scopeKey: "user-ada",
        text: "Mia owns billing until the end of August.",
        kind: "status",
        source: "https://os.example.test/session/os-sup",
        by: "Ada",
        via: "supervisor",
        tags: ["supervisor"],
        expires: "2026-08-31",
      },
    ]);
    expect(prompts[0]).toContain("I prefer SBAR for incident reports now.");
    expect(prompts[0]).toContain("Prefers BLUF replies.");
    expect(await cursor()).toEqual({ sessionId: "os-sup", seq: 6 });

    // Nothing new: no model call, nothing written.
    prompts = [];
    const idle = await writer.runSupervisorMemoryWriter("Ada");
    expect(idle.status).toBe("nothing");
    expect(prompts).toEqual([]);

    // Only what came after the cursor reaches the model.
    exchange("os-sup", "Call me Ada.", "Will do.");
    answer = '{"facts":[]}';
    await writer.runSupervisorMemoryWriter("Ada");
    expect(reads.at(-1)).toEqual({ sessionId: "os-sup", since: 6 });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Call me Ada.");
    expect(prompts[0]).not.toContain("SBAR");
    // Nothing worth keeping still counts as read.
    expect(await cursor()).toEqual({ sessionId: "os-sup", seq: 9 });
  });

  test("the cursor stays when the model or a write fails", async () => {
    await setRecord({ sessionId: "os-sup", previous: [] });
    const start = { sessionId: "os-sup", seq: 0 };
    exchange("os-sup", "I prefer Polish invoices.", "Okay.");
    answer = null;
    expect((await writer.runSupervisorMemoryWriter("Ada")).status).toBe(
      "failed",
    );
    expect(await cursor()).toEqual(start);
    answer = "I could not decide.";
    expect((await writer.runSupervisorMemoryWriter("Ada")).status).toBe(
      "failed",
    );
    expect(await cursor()).toEqual(start);

    answer =
      '{"facts":[{"text":"Prefers Polish invoices.","kind":"preference"}]}';
    failWrite = new Error("push rejected");
    expect((await writer.runSupervisorMemoryWriter("Ada")).status).toBe(
      "failed",
    );
    expect(await cursor()).toEqual(start);
    // The worker being away is transient too.
    const { MemoryRepoError } = await import("./memory-repo/git-store");
    failWrite = new MemoryRepoError("Memory request timed out.", 503);
    expect((await writer.runSupervisorMemoryWriter("Ada")).status).toBe(
      "failed",
    );
    expect(await cursor()).toEqual(start);
    failWrite = null;
    expect((await writer.runSupervisorMemoryWriter("Ada")).status).toBe(
      "written",
    );
    expect(await cursor()).toEqual({ sessionId: "os-sup", seq: 3 });
  });

  test("a fact the memory service refuses for good is skipped and the run goes on", async () => {
    await setRecord({ sessionId: "os-sup", previous: [] });
    exchange("os-sup", "I prefer Polish invoices and short replies.", "Okay.");
    answer = JSON.stringify({
      facts: [
        { text: "Prefers Polish invoices.", kind: "preference" },
        { text: "Prefers short replies.", kind: "preference" },
      ],
    });
    const { MemoryRepoError } = await import("./memory-repo/git-store");
    for (const refusal of [
      new MemoryRepoError("Line 3: unknown kind.", 400),
      new MemoryRepoError("The memory was saved but not indexed.", 500),
      Object.assign(new Error("Looks like a credential."), {
        name: "SecretInMemoryError",
      }),
      new MemoryRepoError("Duplicate memory.", 409),
    ])
      expect(writer.permanentWriteError(refusal)).toBe(true);
    expect(writer.permanentWriteError(new Error("push rejected"))).toBe(false);
    expect(
      writer.permanentWriteError(new MemoryRepoError("Worker stopped.", 503)),
    ).toBe(false);

    restore();
    restore = writer.__setSupervisorMemoryWriterDepsForTest({
      now: () => NOW,
      enabled: () => true,
      busy: () => false,
      readSince: async (sessionId, since, limit) => ({
        entries: (transcripts.get(sessionId) ?? [])
          .filter((row) => row.seq > since)
          .slice(0, limit),
      }),
      complete: async () => answer,
      existing: async () => [],
      write: async (input) => {
        if (input.text.includes("Polish"))
          throw new MemoryRepoError("Line 3: unknown kind.", 400);
        written.push(input);
        return true;
      },
      sessionLink: async (id) => `https://os.example.test/session/${id}`,
    });
    const result = await writer.runSupervisorMemoryWriter("Ada");
    expect(result.status).toBe("written");
    expect(result.facts.map((fact) => fact.text)).toEqual([
      "Prefers short replies.",
    ]);
    expect(written.map((input) => input.text)).toEqual([
      "Prefers short replies.",
    ]);
    expect(await cursor()).toEqual({ sessionId: "os-sup", seq: 3 });
  });

  test("while off it reads and writes nothing, and keeps the cursor at the session's end", async () => {
    await setRecord({ sessionId: "os-sup", previous: [] });
    exchange("os-sup", "I prefer short replies.", "Sure.");
    expect((await inbox.getSupervisorPrefs("Ada")).memoryWriter).toBe(true);
    await inbox.setSupervisorPrefs("Ada", { memoryWriter: false });
    const result = await writer.runSupervisorMemoryWriter("Ada");
    expect(result.status).toBe("off");
    expect(reads).toEqual([]);
    expect(prompts).toEqual([]);
    expect(await cursor()).toEqual({ sessionId: "os-sup", seq: 3 });
    exchange("os-sup", "I prefer Polish invoices.", "Okay.");
    await writer.runSupervisorMemoryWriter("Ada");
    expect(await cursor()).toEqual({ sessionId: "os-sup", seq: 6 });

    // Turned on again, only what is said after that is read.
    await inbox.setSupervisorPrefs("Ada", { memoryWriter: true });
    exchange("os-sup", "Call me Ada.", "Will do.");
    await writer.runSupervisorMemoryWriter("Ada");
    expect(reads).toEqual([{ sessionId: "os-sup", since: 6 }]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Call me Ada.");
    expect(prompts[0]).not.toContain("short replies");
    expect(prompts[0]).not.toContain("Polish");
  });

  test("a record without a cursor starts at the session's end: no backfill", async () => {
    await setRecord({
      sessionId: "os-sup",
      previous: [],
      memoryCursor: undefined,
    });
    exchange("os-sup", "I prefer short replies.", "Sure.");
    const first = await writer.runSupervisorMemoryWriter("Ada");
    expect(first.status).toBe("moved");
    expect(reads).toEqual([]);
    expect(prompts).toEqual([]);
    expect(await cursor()).toEqual({ sessionId: "os-sup", seq: 3 });
    exchange("os-sup", "Call me Ada.", "Will do.");
    await writer.runSupervisorMemoryWriter("Ada");
    expect(reads).toEqual([{ sessionId: "os-sup", since: 3 }]);
    expect(prompts[0]).toContain("Call me Ada.");
    expect(prompts[0]).not.toContain("short replies");
  });

  test("a live turn puts the run off and it tries again later", async () => {
    await setRecord({ sessionId: "os-sup", previous: [] });
    exchange("os-sup", "I prefer mornings for calls.", "Okay.");
    busy = true;
    const result = await writer.runSupervisorMemoryWriter("Ada");
    expect(result).toMatchObject({ status: "busy", retry: true });
    expect(reads).toEqual([]);
    expect(prompts).toEqual([]);
    expect(await cursor()).toEqual({ sessionId: "os-sup", seq: 0 });

    // Scheduled, it reschedules a bounded number of times.
    writer.scheduleSupervisorMemoryWriter("Ada");
    for (let i = 0; i < writer.WRITER_MAX_DEFERRALS + 2; i++) {
      const pending = timers.filter((timer) => !timer.cleared);
      if (!pending.length) break;
      for (const timer of pending) {
        timer.cleared = true;
        timer.run();
      }
      await Bun.sleep(20);
    }
    expect(timers).toHaveLength(writer.WRITER_MAX_DEFERRALS + 1);
    expect(prompts).toEqual([]);

    busy = false;
    writer.scheduleSupervisorMemoryWriter("Ada");
    timers.at(-1)!.run();
    await Bun.sleep(20);
    expect(prompts).toHaveLength(1);
    expect(await cursor()).toEqual({ sessionId: "os-sup", seq: 3 });
  });

  test("a reply followed by more tool work is not final and waits", async () => {
    await setRecord({ sessionId: "os-sup", previous: [] });
    exchange("os-sup", "First question", "First answer");
    exchange("os-sup", "Second question", "Let me check.");
    append("os-sup", {
      id: "t-more",
      type: "tool_use",
      content: "",
      timestamp: "2026-07-01T09:05:00Z",
    });
    const result = await writer.runSupervisorMemoryWriter("Ada");
    expect(result.retry).toBe(true);
    expect(prompts[0]).toContain("First question");
    expect(prompts[0]).not.toContain("Second question");
    expect(await cursor()).toEqual({ sessionId: "os-sup", seq: 3 });
  });

  test("a message still waiting for its reply is left for the next run", async () => {
    await setRecord({ sessionId: "os-sup", previous: [] });
    exchange("os-sup", "First question", "First answer");
    append("os-sup", {
      id: "u-late",
      type: "user",
      content: "Second question",
      timestamp: "2026-07-01T09:05:00Z",
    });
    await writer.runSupervisorMemoryWriter("Ada");
    expect(prompts[0]).toContain("First question");
    expect(prompts[0]).not.toContain("Second question");
    expect(await cursor()).toEqual({ sessionId: "os-sup", seq: 3 });
  });

  test("is bounded per run and asks for another run when more is waiting", async () => {
    await setRecord({ sessionId: "os-sup", previous: [] });
    for (let i = 0; i < 30; i++)
      exchange(
        "os-sup",
        `Question ${String(i).padStart(2, "0")}`,
        `Answer ${i}`,
      );
    const first = await writer.runSupervisorMemoryWriter("Ada");
    expect(first.more).toBe(true);
    expect(prompts[0]).toContain("Question 19");
    expect(prompts[0]).not.toContain("Question 20");
    expect(await cursor()).toEqual({ sessionId: "os-sup", seq: 60 });
    const second = await writer.runSupervisorMemoryWriter("Ada");
    expect(second.more).toBe(false);
    expect(prompts[1]).toContain("Question 20");
    expect(prompts[1]).toContain("Question 29");
    expect(prompts[1]).not.toContain("Question 19");
  });

  test("finishes a retired session before moving to the current one", async () => {
    await setRecord({
      sessionId: "os-new",
      previous: ["os-old"],
      memoryCursor: { sessionId: "os-old", seq: 3 },
    });
    exchange("os-old", "Old question", "Old answer");
    exchange("os-old", "Last words in the old one", "Bye");
    exchange("os-new", "New question", "New answer");
    const first = await writer.runSupervisorMemoryWriter("Ada");
    expect(reads.map((read) => read.sessionId)).toEqual(["os-old"]);
    expect(prompts[0]).toContain("Last words in the old one");
    expect(prompts[0]).not.toContain("Old question");
    expect(first.more).toBe(true);
    expect(await cursor()).toEqual({ sessionId: "os-new", seq: 0 });
    await writer.runSupervisorMemoryWriter("Ada");
    expect(reads.at(-1)).toEqual({ sessionId: "os-new", since: 0 });
    expect(prompts[1]).toContain("New question");
  });

  test("a cursor into a session the record no longer knows starts on the current one", async () => {
    await setRecord({
      sessionId: "os-sup",
      previous: [],
      memoryCursor: { sessionId: "os-gone", seq: 99 },
    });
    exchange("os-sup", "Hello", "Hi");
    await writer.runSupervisorMemoryWriter("Ada");
    expect(reads).toEqual([{ sessionId: "os-sup", since: 0 }]);
    expect(await cursor()).toEqual({ sessionId: "os-sup", seq: 3 });
  });

  test("no supervisor, or another memory mode, is a no-op", async () => {
    expect((await writer.runSupervisorMemoryWriter("Ada")).status).toBe("none");
    restore();
    restore = writer.__setSupervisorMemoryWriterDepsForTest({
      enabled: () => false,
      lastSeq: async () => 0,
      readSince: async () => {
        throw new Error("must not read");
      },
    });
    await setRecord({ sessionId: "os-sup", previous: [] });
    expect((await writer.runSupervisorMemoryWriter("Ada")).status).toBe("off");
  });
});

describe("owner_memory", () => {
  type Entry = import("./supervisor-memory-writer").OwnerMemoryEntry;
  let entries: Entry[];
  let updates: Array<{ id: string; patch: unknown }>;
  let notes: Array<{ user: string; fact: string }>;

  beforeEach(() => {
    entries = [
      {
        id: "m-own",
        scopeKey: "user-ada",
        summary: "Acme's canonical domain is .com.",
        kind: "reference",
        state: "active",
        by: "supervisor",
        tags: ["supervisor"],
      },
      {
        id: "m-said",
        scopeKey: "user-ada",
        summary: "Ada reviews pull requests in the morning.",
        kind: "preference",
        state: "active",
        by: "Ada",
      },
      {
        id: "m-writer",
        scopeKey: "user-ada",
        summary: "Ada prefers short replies.",
        kind: "preference",
        state: "active",
        by: "Ada",
        tags: ["supervisor"],
      },
      {
        id: "m-team",
        scopeKey: "team",
        summary: "The team ships on Fridays.",
        kind: "reference",
        state: "active",
      },
      {
        id: "m-old",
        scopeKey: "user-ada",
        summary: "Old fact.",
        kind: "reference",
        state: "superseded",
      },
    ];
    updates = [];
    notes = [];
    restore();
    restore = writer.__setSupervisorMemoryWriterDepsForTest({
      now: () => NOW,
      enabled: () => true,
      write: async (input) => {
        if (failWrite) throw failWrite;
        written.push(input);
        return true;
      },
      sessionLink: async (id) => `https://os.example.test/session/${id}`,
      entries: async (scopeKey) =>
        entries.filter((e) => e.scopeKey === scopeKey && e.state === "active"),
      get: async (id) => entries.find((e) => e.id === id) ?? null,
      update: async (id, patch) => {
        updates.push({ id, patch });
      },
      notify: async (user, fact) => {
        notes.push({ user, fact });
      },
    });
  });

  test("lists the owner's active personal facts with their ids", async () => {
    const result = await writer.listOwnerMemory("Ada");
    expect(result).toEqual({
      ok: true,
      message: [
        "- [m-own] (reference) Acme's canonical domain is .com.",
        "- [m-said] (preference) Ada reviews pull requests in the morning.",
        "- [m-writer] (preference) Ada prefers short replies.",
      ].join("\n"),
    });
  });

  test("adds a fact to the owner's scope through the writer's path", async () => {
    const result = await writer.addOwnerMemory(
      "Ada",
      { text: "Acme is back on the .eu domain fully.", kind: "decision" },
      "os-sup",
    );
    expect(result.ok).toBe(true);
    expect(written).toEqual([
      {
        scopeKey: "user-ada",
        text: "Acme is back on the .eu domain fully.",
        kind: "decision",
        source: "https://os.example.test/session/os-sup",
        by: "supervisor",
        via: "supervisor",
        tags: ["supervisor"],
      },
    ]);
    expect(notes).toEqual([
      { user: "Ada", fact: "Acme is back on the .eu domain fully." },
    ]);
  });

  test("a repeat posts nothing; a failed post doesn't fail the save", async () => {
    restore();
    restore = writer.__setSupervisorMemoryWriterDepsForTest({
      now: () => NOW,
      enabled: () => true,
      write: async () => false,
      notify: async (user, fact) => {
        notes.push({ user, fact });
      },
    });
    const again = await writer.addOwnerMemory("Ada", {
      text: "Prefers short replies.",
      kind: "preference",
    });
    expect(again).toEqual({ ok: true, message: "Already remembered." });
    expect(notes).toEqual([]);
    restore();
    restore = writer.__setSupervisorMemoryWriterDepsForTest({
      now: () => NOW,
      enabled: () => true,
      write: async () => true,
      notify: async () => {
        throw new Error("inbox down");
      },
    });
    expect(
      (
        await writer.addOwnerMemory("Ada", {
          text: "Prefers short replies.",
          kind: "preference",
        })
      ).ok,
    ).toBe(true);
  });

  test("the fyi is the fixed copy with the fact quoted", () => {
    expect(writer.memorySavedItem("Ada prefers short replies.")).toEqual({
      title: 'Blob saved to memory: "Ada prefers short replies."',
      body: '"Ada prefers short replies."',
    });
    const long = writer.memorySavedItem("x".repeat(300));
    expect(long.title.length).toBeLessThanOrEqual(120);
    expect(long.title).toEndWith('…"');
    expect(long.body).toBe(`"${"x".repeat(300)}"`);
  });

  test("refuses what the writer refuses: secrets, contact data, bad kinds", async () => {
    for (const [text, kind, why] of [
      ["Deploy key is ghp_" + "a".repeat(36), "reference", "secret"],
      ["Jan is at jan@example.test", "reference", "email"],
      ["Prefers short replies.", "mood", "Unknown kind"],
      ["Away this week.", "status", "future expiry"],
      ["x".repeat(400), "reference", "Too long"],
    ] as const) {
      const result = await writer.addOwnerMemory("Ada", { text, kind });
      expect(result.ok).toBe(false);
      expect(result.message).toContain(why);
    }
    expect(written).toEqual([]);
  });

  test("corrects an entry only in the owner's own scope", async () => {
    const fixed = await writer.correctOwnerMemory("Ada", "m-own", {
      text: "Acme's canonical domain is .eu again.",
    });
    expect(fixed).toEqual({
      ok: true,
      message: "Corrected [m-own]: Acme's canonical domain is .eu again.",
    });
    expect(updates).toEqual([
      {
        id: "m-own",
        patch: {
          text: "Acme's canonical domain is .eu again.",
          kind: "reference",
          expires: null,
        },
      },
    ]);
    for (const id of ["m-team", "m-old", "m-nope"]) {
      const refused = await writer.correctOwnerMemory("Ada", id, {
        text: "Something else.",
      });
      expect(refused.ok).toBe(false);
      expect(refused.message).toContain("Team and project memory");
    }
    // Another person's supervisor can't reach Ada's entry either.
    expect(
      (await writer.correctOwnerMemory("Grace", "m-own", { text: "No." })).ok,
    ).toBe(false);
    expect(updates).toHaveLength(1);
    expect(notes).toEqual([
      { user: "Ada", fact: "Acme's canonical domain is .eu again." },
    ]);
  });

  test("won't rewrite a fact the owner wrote; the writer's own it may", async () => {
    const refused = await writer.correctOwnerMemory("Ada", "m-said", {
      text: "Ada reviews pull requests after lunch.",
    });
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain("The owner wrote that fact");
    expect(updates).toEqual([]);
    expect(notes).toEqual([]);
    expect(
      (
        await writer.correctOwnerMemory("Ada", "m-writer", {
          text: "Ada prefers very short replies.",
        })
      ).ok,
    ).toBe(true);
    expect(updates.map((u) => u.id)).toEqual(["m-writer"]);
  });

  test("says so when memory isn't kept in repositories, or a write fails", async () => {
    failWrite = Object.assign(new Error("credential found"), {
      name: "SecretInMemoryError",
    });
    expect(
      (
        await writer.addOwnerMemory("Ada", {
          text: "Prefers short replies.",
          kind: "preference",
        })
      ).message,
    ).toBe("Not saved: credential found");
    restore();
    restore = writer.__setSupervisorMemoryWriterDepsForTest({
      enabled: () => false,
    });
    expect((await writer.listOwnerMemory("Ada")).ok).toBe(false);
  });
});

describe("debounce", () => {
  test("waits five quiet minutes; each turn restarts the wait; one run", async () => {
    await setRecord({ sessionId: "os-sup", previous: [] });
    exchange("os-sup", "I prefer mornings for calls.", "Okay.");
    writer.scheduleSupervisorMemoryWriter("Ada");
    writer.scheduleSupervisorMemoryWriter("Ada");
    writer.scheduleSupervisorMemoryWriter("Ada");
    expect(timers).toHaveLength(3);
    expect(timers.map((timer) => timer.ms)).toEqual([
      5 * 60_000,
      5 * 60_000,
      5 * 60_000,
    ]);
    expect(timers.filter((timer) => !timer.cleared)).toHaveLength(1);
    expect(prompts).toEqual([]);
    timers.find((timer) => !timer.cleared)!.run();
    await Bun.sleep(50);
    expect(prompts).toHaveLength(1);
    expect(await cursor()).toEqual({ sessionId: "os-sup", seq: 3 });
  });
});

describe("parseWriterFacts", () => {
  test("keeps durable, clean facts only", () => {
    const facts = writer.parseWriterFacts(
      `Here you go: ${JSON.stringify({
        facts: [
          { text: "Prefers SBAR.", kind: "preference" },
          { text: "Decided to drop the Chrome extension.", kind: "decision" },
          { text: "Deploy is running now.", kind: "status" },
          { text: "Away this week.", kind: "status", expires: "2026-06-01" },
          { text: "Away until July 8.", kind: "status", expires: "2026-07-08" },
          { text: "Likes it.", kind: "gotcha" },
          { text: "Email jan@acme.test for refunds.", kind: "reference" },
          { text: "Call +48 600 100 200.", kind: "reference" },
          {
            text: "Token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB",
            kind: "reference",
          },
          { text: "x".repeat(400), kind: "preference" },
        ],
      })}`,
      NOW,
    );
    expect(facts).toEqual([
      { text: "Prefers SBAR.", kind: "preference" },
      { text: "Decided to drop the Chrome extension.", kind: "decision" },
      { text: "Away until July 8.", kind: "status", expires: "2026-07-08" },
    ]);
    expect(writer.parseWriterFacts("no json", NOW)).toBeNull();
    expect(writer.parseWriterFacts('{"other":1}', NOW)).toBeNull();
    const many = writer.parseWriterFacts(
      JSON.stringify({
        facts: Array.from({ length: 12 }, (_, i) => ({
          text: `Fact ${i}`,
          kind: "reference",
        })),
      }),
      NOW,
    );
    expect(many).toHaveLength(writer.WRITER_MAX_FACTS);
  });

  test("the prompt carries the owner's rules", () => {
    for (const rule of [
      "Only facts the owner stated or clearly confirmed",
      "Used to X, now Y",
      "Never secrets",
      "Never customers' personal data",
      "Nothing transient",
      "pasted or quoted from someone else is not the owner's statement",
    ])
      expect(writer.WRITER_SYSTEM).toContain(rule);
  });
});

describe("with the memory service", () => {
  test("facts land in the owner's personal repository and reach the supervisor's memory", async () => {
    const { MemoryRepoService } = await import("./memory-repo/service");
    const { __setMemoryRepoServiceForTest } =
      await import("./memory-repo/client");
    const base = mkdtempSync(join(tmpdir(), "supervisor-writer-repo-"));
    const service = new MemoryRepoService({
      base,
      hookCommand: [
        process.execPath,
        fileURLToPath(new URL("./memory-repo/hook-main.ts", import.meta.url)),
      ],
      uiBase: "https://os.example.test",
      labels: {},
    });
    __setMemoryRepoServiceForTest(service);
    try {
      // The real write path and the real "already remembered" list.
      restore();
      restore = writer.__setSupervisorMemoryWriterDepsForTest({
        now: () => NOW,
        enabled: () => true,
        busy: () => false,
        readSince: async (sessionId, since, limit) => ({
          entries: (transcripts.get(sessionId) ?? [])
            .filter((row) => row.seq > since)
            .slice(0, limit),
        }),
        complete: async (prompt) => {
          prompts.push(prompt);
          return answer;
        },
        sessionLink: async (id) => `https://os.example.test/session/${id}`,
      });
      answer =
        '{"facts":[{"text":"Prefers SBAR for incident reports.","kind":"preference"}]}';
      await setRecord({ sessionId: "os-sup", previous: [] });
      exchange("os-sup", "Use SBAR for incidents from now on.", "Will do.");

      const { snapshotMemoryNote, invalidateMemorySnapshot } =
        await import("./session-memory");
      const { renderRepoMemoryNote, retrieveRepoMemoryForPrompt } =
        await import("./memory-repo/session");
      const { sessionMemoryScopes } = await import("./session-memory");
      // The supervisor's scopes: the owner's and the team's.
      const scopeKeys = sessionMemoryScopes({ user: "Ada", repos: [] }).map(
        (scope) => scope.key,
      );
      expect(scopeKeys).toEqual(["user-ada", "workspace"]);
      const render = () =>
        renderRepoMemoryNote({
          scopeKeys,
          prepared: { repos: ["user-ada", "team"], present: [], added: false },
          user: "Ada",
        });
      await service.ensureRepo("user-ada");
      const before = await snapshotMemoryNote("os-sup", render);

      expect((await writer.runSupervisorMemoryWriter("Ada")).status).toBe(
        "written",
      );
      const record = (
        await service.index.list({ scopeKeys: ["user-ada"] }, { limit: 10 })
      ).items[0]!;
      expect(record).toMatchObject({
        scopeKey: "user-ada",
        kind: "preference",
        summary: "Prefers SBAR for incident reports.",
      });
      expect(record.source.sessionId).toBe("os-sup");

      // The next supervisor turn retrieves it.
      const retrieved = await retrieveRepoMemoryForPrompt(
        "how should incident reports look",
        scopeKeys,
      );
      expect(retrieved.text).toContain("Prefers SBAR for incident reports.");
      // The snapshot keeps its bytes until the daily refresh drops it; the
      // rebuilt one links the new topic file.
      expect(await snapshotMemoryNote("os-sup", render)).toBe(before);
      invalidateMemorySnapshot("os-sup");
      const after = await snapshotMemoryNote("os-sup", render);
      expect(after).not.toBe(before);
      expect(after).toContain("preferences");
      // Already remembered facts reach the writer's next prompt, and a
      // repeat is not written twice.
      exchange("os-sup", "And keep it short.", "Sure.");
      const again = await writer.runSupervisorMemoryWriter("Ada");
      expect(prompts.at(-1)).toContain("Prefers SBAR for incident reports.");
      expect(again.status).toBe("nothing");
      expect(await cursor()).toEqual({ sessionId: "os-sup", seq: 6 });
      expect(
        (await service.readFile("user-ada", "preferences.md"))!.match(
          /Prefers SBAR/g,
        ),
      ).toHaveLength(1);

      // A fact whose entry has expired is still in the index: the same text
      // again adds no second line, and the cursor moves on.
      await service.addEntry({
        scopeKey: "user-ada",
        text: "Away until June 20.",
        kind: "status",
        expires: "2026-06-20",
      });
      const expired = await service.index.list(
        { scopeKeys: ["user-ada"], states: ["expired"] },
        { limit: 10 },
      );
      expect(expired.items.map((item) => item.summary)).toEqual([
        "Away until June 20.",
      ]);
      exchange("os-sup", "I'm away until June 20.", "Noted.");
      answer = '{"facts":[{"text":"Away until June 20.","kind":"reference"}]}';
      const repeat = await writer.runSupervisorMemoryWriter("Ada");
      expect(repeat.status).toBe("nothing");
      expect(await cursor()).toEqual({ sessionId: "os-sup", seq: 9 });
      const files = await service.listFiles("user-ada");
      let lines = 0;
      for (const file of files.filter((path) => path.endsWith(".md")))
        lines +=
          (await service.readFile("user-ada", file))?.match(
            /Away until June 20\./g,
          )?.length ?? 0;
      expect(lines).toBe(1);
    } finally {
      __setMemoryRepoServiceForTest(null);
      service.close();
      rmSync(base, { recursive: true, force: true });
    }
  }, 30_000);
});
