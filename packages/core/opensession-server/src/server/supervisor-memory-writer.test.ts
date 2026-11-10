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
let failWrite: boolean;
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
  failWrite = false;
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
    complete: async (prompt) => {
      prompts.push(prompt);
      return answer;
    },
    existing: async () => ["Prefers BLUF replies."],
    write: async (input) => {
      if (failWrite) throw new Error("push rejected");
      written.push(input);
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
    exchange("os-sup", "I prefer Polish invoices.", "Okay.");
    answer = null;
    expect((await writer.runSupervisorMemoryWriter("Ada")).status).toBe(
      "failed",
    );
    expect(await cursor()).toBeUndefined();
    answer = "I could not decide.";
    expect((await writer.runSupervisorMemoryWriter("Ada")).status).toBe(
      "failed",
    );
    expect(await cursor()).toBeUndefined();

    answer =
      '{"facts":[{"text":"Prefers Polish invoices.","kind":"preference"}]}';
    failWrite = true;
    expect((await writer.runSupervisorMemoryWriter("Ada")).status).toBe(
      "failed",
    );
    expect(await cursor()).toBeUndefined();
    failWrite = false;
    expect((await writer.runSupervisorMemoryWriter("Ada")).status).toBe(
      "written",
    );
    expect(await cursor()).toEqual({ sessionId: "os-sup", seq: 3 });
  });

  test("the off switch writes nothing and reads nothing", async () => {
    await setRecord({ sessionId: "os-sup", previous: [] });
    exchange("os-sup", "I prefer short replies.", "Sure.");
    expect((await inbox.getSupervisorPrefs("Ada")).memoryWriter).toBe(true);
    await inbox.setSupervisorPrefs("Ada", { memoryWriter: false });
    const result = await writer.runSupervisorMemoryWriter("Ada");
    expect(result.status).toBe("off");
    expect(reads).toEqual([]);
    expect(prompts).toEqual([]);
    expect(await cursor()).toBeUndefined();
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
      readSince: async () => {
        throw new Error("must not read");
      },
    });
    await setRecord({ sessionId: "os-sup", previous: [] });
    expect((await writer.runSupervisorMemoryWriter("Ada")).status).toBe("off");
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
        readSince: async (sessionId, since, limit) => ({
          entries: (transcripts.get(sessionId) ?? [])
            .filter((row) => row.seq > since)
            .slice(0, limit),
        }),
        complete: async (prompt) => {
          prompts.push(prompt);
          return '{"facts":[{"text":"Prefers SBAR for incident reports.","kind":"preference"}]}';
        },
        sessionLink: async (id) => `https://os.example.test/session/${id}`,
      });
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
    } finally {
      __setMemoryRepoServiceForTest(null);
      service.close();
      rmSync(base, { recursive: true, force: true });
    }
  }, 30_000);
});
