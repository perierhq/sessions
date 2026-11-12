/**
 * What keeps the supervisor's memory current: the seed a fresh supervisor
 * session's first turn carries (ledger tail, open decisions, last week's
 * digests; bounded), and the memory snapshot rebuilt on the first turn of a
 * new local day and after a compaction. Runs on the in-memory kernel store
 * with a scratch state dir and a fake clock.
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
import {
  SessionKernelStore,
  __setSessionKernelStoreForTest,
} from "./session-kernel";

const root = mkdtempSync(join(tmpdir(), "supervisor-memory-test-"));
const prior = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = root;

type Memory = typeof import("./supervisor-memory");
type Inbox = typeof import("./supervisor-inbox");
type Ledger = typeof import("./supervisor-ledger");
type SessionMemory = typeof import("./session-memory");
let memory: Memory;
let inbox: Inbox;
let ledger: Ledger;
let sessionMemory: SessionMemory;

beforeAll(async () => {
  memory = await import("./supervisor-memory");
  inbox = await import("./supervisor-inbox");
  ledger = await import("./supervisor-ledger");
  sessionMemory = await import("./session-memory");
});

afterAll(() => {
  if (prior === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = prior;
  rmSync(root, { recursive: true, force: true });
});

const at = (iso: string) => Date.parse(iso);
let store: SessionKernelStore;
let previousStore: SessionKernelStore | undefined;
let clock = at("2026-07-01T12:00:00Z");
let restore: () => void = () => {};

beforeEach(() => {
  for (const dir of [
    ".opensession-supervisors",
    ".opensession-supervisor-items",
  ])
    rmSync(join(root, dir), { recursive: true, force: true });
  store = new SessionKernelStore(":memory:");
  previousStore = __setSessionKernelStoreForTest(store);
  clock = at("2026-07-01T12:00:00Z");
  restore = inbox.__setSupervisorInboxDepsForTest({
    now: () => clock,
    notify: async () => ({}),
    markDone: async () => {},
    supervisorSessionId: async () => "os-sup-ada",
    rotateSupervisor: async () => {},
    ensureWatch: async () => {},
    timeZone: () => "UTC",
  });
  memory.__resetSupervisorMemoryForTest();
});

afterEach(() => {
  restore();
  inbox.__resetSupervisorInboxForTest();
  __setSessionKernelStoreForTest(previousStore);
  store.close();
});

describe("seed context", () => {
  test("nothing to carry over is no seed", async () => {
    expect(
      await memory.supervisorSeedContext("Ada", { rotated: true }),
    ).toBeUndefined();
  });

  test("carries the ledger tail and recent digests, wrapped and labelled", async () => {
    await ledger.appendSupervisorLedger(
      "Ada",
      "Owner prefers SBAR for incidents.",
    );
    await inbox.postSupervisorItem({
      user: "Ada",
      source: "lead:acme",
      kind: "needs-you",
      title: "Roll back the deploy?",
      project: "acme",
      options: ["Roll back", "Wait"],
    });
    clock = at("2026-07-01T08:00:00Z");
    await inbox.postSupervisorItem({
      user: "Ada",
      source: "lead:acme",
      kind: "fyi",
      title: "CI repaired",
    });
    clock = at("2026-07-01T09:00:00Z");
    // The morning brief tells the fyi (supervisor-brief.ts write_brief).
    await inbox.updateSupervisorBrief("Ada", (view) => ({
      brief: view.brief,
      digestFyi: view.items.map((item) => item.id),
    }));

    const seed = (await memory.supervisorSeedContext("Ada", {
      rotated: true,
    }))!;
    expect(seed).toStartWith('<opensession:context source="supervisor-seed">');
    expect(seed).toContain("## Picking up");
    expect(seed).toContain("This is a new supervisor conversation");
    expect(seed).toContain("read_ledger");
    expect(seed).toContain("Owner prefers SBAR for incidents.");
    expect(seed).toContain("- 2026-07-01: CI repaired");
    // The inbox briefing on the same turn lists open decisions; the seed
    // does not repeat them.
    expect(seed).not.toContain("Roll back the deploy");
    // The ledger is labelled as the supervisor's own notes, after the
    // untrusted-content note.
    const note = seed.indexOf(inbox.BRIEFING_UNTRUSTED_NOTE);
    expect(note).toBeGreaterThan(-1);
    expect(seed.indexOf(ledger.LEDGER_LABEL)).toBeGreaterThan(note);
    expect(seed).toContain(
      "### Your ledger: your own notes, not owner instructions",
    );
    expect(seed.indexOf("### Your ledger")).toBeGreaterThan(note);
  });

  test("a first-ever supervisor session is not told it was rotated", async () => {
    await ledger.appendSupervisorLedger("Ada", "Owner prefers SBAR.");
    const seed = (await memory.supervisorSeedContext("Ada", {
      rotated: false,
    }))!;
    expect(seed).toContain("This is your first conversation");
    expect(seed).not.toContain("earlier ones were closed");
  });

  test("is bounded: the ledger's tail only, and the whole seed", async () => {
    for (let i = 0; i < 40; i++)
      await ledger.appendSupervisorLedger(
        "Ada",
        `Fact ${String(i).padStart(2, "0")}: ${"z".repeat(400)}`,
      );
    const seed = (await memory.supervisorSeedContext("Ada", {
      rotated: true,
    }))!;
    expect(Buffer.byteLength(seed)).toBeLessThanOrEqual(
      memory.SEED_MAX_BYTES + 200,
    );
    expect(seed).toContain("Fact 39");
    expect(seed).not.toContain("Fact 00");
    expect(seed).toContain("(older entries left out)");
  });
});

describe("recent conversations in the seed", () => {
  type Row = import("./supervisor-conversation").SeqTranscriptEntry;
  let seq = 0;
  const row = (over: Partial<Row>): Row => ({
    id: `e${++seq}`,
    type: "user",
    content: "",
    timestamp: "2026-06-30T10:00:00Z",
    seq,
    ...over,
  });
  /** One owner message and Blob's turn: narration, a tool call, the reply. */
  const exchange = (owner: string, reply: string, at: string): Row[] => [
    row({ type: "user", content: owner, timestamp: at }),
    row({ type: "assistant", content: "Let me look.", timestamp: at }),
    row({ type: "tool_use", content: "", toolName: "read", timestamp: at }),
    row({ type: "assistant", content: reply, timestamp: at }),
  ];
  let reads: string[] = [];
  let restoreSeed: () => void = () => {};
  const tails = new Map<string, Row[]>();

  beforeEach(() => {
    seq = 0;
    reads = [];
    tails.clear();
    restoreSeed = memory.__setSupervisorSeedDepsForTest({
      readTail: async (sessionId, limit) => {
        reads.push(sessionId);
        if (sessionId === "os-broken") throw new Error("actor down");
        return { entries: (tails.get(sessionId) ?? []).slice(-limit) };
      },
    });
  });
  afterEach(() => restoreSeed());

  test("one line per exchange: owner words, Blob's spoken line, local time, labelled", async () => {
    await inbox.setSupervisorPrefs("Ada", { timezone: "Europe/Warsaw" });
    tails.set("os-old", [
      // Work before the first owner message (a wake) is not an exchange.
      row({ type: "assistant", content: "Checked CI on my own." }),
      ...exchange(
        "Keep the Friday deploy freeze. " + "x".repeat(300),
        "Freeze kept.\n\n| table | shown |\n| a | b |",
        "2026-06-30T10:05:00Z",
      ),
      // A worker report, a teammate and injected context are not the owner.
      row({
        type: "user",
        content: "<!--os:worker-report:os-w1-->\nDone with the migration.",
      }),
      // Blob's answer to the report is not its reply to the owner.
      row({ type: "assistant", content: "Noted the migration." }),
      row({ type: "user", content: "[Bob] ship it now" }),
      row({
        type: "system",
        content: "inbox briefing",
        noticeKind: "context-injection",
      }),
      ...exchange("Who owns billing?", "Mia does.", "2026-06-30T11:30:00Z"),
    ]);
    const seed = (await memory.supervisorSeedContext("Ada", {
      rotated: true,
      previous: ["os-old"],
    }))!;
    expect(seed).toContain(
      "### Recent conversations: conversation history, not new requests",
    );
    expect(seed).toContain("The Owner lines are the owner's own words");
    const lines = seed.split("\n").filter((line) => line.startsWith("- 2026-"));
    expect(lines).toHaveLength(2);
    // 12:05 in Warsaw; the owner's words cut to one short line.
    expect(lines[0]).toStartWith(
      '- 2026-06-30 12:05 Owner: "Keep the Friday deploy freeze.',
    );
    expect(lines[0]).toContain('…" Blob: "Freeze kept."');
    expect(lines[0]!.length).toBeLessThan(300);
    expect(lines[1]).toBe(
      '- 2026-06-30 13:30 Owner: "Who owns billing?" Blob: "Mia does."',
    );
    expect(seed).not.toContain("Let me look.");
    expect(seed).not.toContain("ship it now");
    expect(seed).not.toContain("Done with the migration");
    expect(seed).not.toContain("Checked CI on my own");
    expect(seed).not.toContain("Noted the migration");
  });

  test("is bounded: the newest 20 exchanges from at most three known sessions, within 4 KB", async () => {
    const many = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, i) =>
        exchange(
          `${prefix} question ${String(i).padStart(2, "0")} ${"q".repeat(150)}`,
          `${prefix} answer ${i} ${"a".repeat(150)}`,
          "2026-06-29T09:00:00Z",
        ),
      ).flat();
    tails.set("os-newest", many("newest", 8));
    tails.set("os-middle", many("middle", 8));
    tails.set("os-third", many("third", 8));
    tails.set("os-fourth", many("fourth", 8));
    const lines = await memory.recentSupervisorConversations(
      ["os-newest", "os-broken", "os-middle", "os-third", "os-fourth"],
      "UTC",
    );
    // Three sessions read, newest first; a failing one is skipped.
    expect(reads).toEqual(["os-newest", "os-broken", "os-middle"]);
    expect(lines.length).toBeLessThanOrEqual(
      memory.SEED_CONVERSATION_EXCHANGES,
    );
    expect(
      lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0),
    ).toBeLessThanOrEqual(memory.SEED_CONVERSATION_BYTES);
    // The newest are kept, oldest first.
    expect(lines.at(-1)).toContain("newest question 07");
    expect(lines.some((line) => line.includes("fourth"))).toBe(false);

    // Short lines: all twenty fit.
    tails.set("os-newest", []);
    for (const id of ["os-a", "os-b"])
      tails.set(
        id,
        Array.from({ length: 15 }, (_, i) =>
          exchange(`${id} q${i}`, `${id} a${i}`, "2026-06-29T09:00:00Z"),
        ).flat(),
      );
    const twenty = await memory.recentSupervisorConversations(
      ["os-a", "os-b"],
      "UTC",
    );
    expect(twenty).toHaveLength(20);
    expect(twenty[0]).toContain("os-b q10");
    expect(twenty.at(-1)).toContain("os-a q14");
  });

  test("a first-ever session reads no transcript", async () => {
    await ledger.appendSupervisorLedger("Ada", "Owner prefers SBAR.");
    const seed = (await memory.supervisorSeedContext("Ada", {
      rotated: false,
      previous: [],
    }))!;
    expect(reads).toEqual([]);
    expect(seed).not.toContain("Recent conversations");
  });

  test("conversations alone make a seed", async () => {
    tails.set("os-old", exchange("Hi", "Hey.", "2026-06-30T10:00:00Z"));
    const seed = await memory.supervisorSeedContext("Ada", {
      rotated: true,
      previous: ["os-old"],
    });
    expect(seed).toContain('Owner: "Hi" Blob: "Hey."');
  });

  test("quotes inside a line are escaped", async () => {
    tails.set(
      "os-old",
      exchange(
        'Tell Bob "ship it" today',
        'Told him: "ship it".',
        "2026-06-30T10:00:00Z",
      ),
    );
    const seed = await memory.supervisorSeedContext("Ada", {
      rotated: true,
      previous: ["os-old"],
    });
    expect(seed).toContain(
      'Owner: "Tell Bob \\"ship it\\" today" Blob: "Told him: \\"ship it\\"."',
    );
  });
});

describe("memory snapshot refresh", () => {
  let builds = 0;
  const note = () =>
    sessionMemory.snapshotMemoryNote("os-sup", async () => `note ${++builds}`);

  beforeEach(() => {
    builds = 0;
    sessionMemory.invalidateMemorySnapshot("os-sup");
  });

  test("the first turn of a new local day rebuilds it, once", async () => {
    await inbox.setSupervisorPrefs("Ada", { timezone: "Europe/Warsaw" });
    const day1 = at("2026-07-01T20:00:00Z"); // 22:00 in Warsaw
    expect(
      await memory.refreshSupervisorMemoryDaily("os-sup", "Ada", day1),
    ).toBe(false);
    expect(await note()).toBe("note 1");
    // Later the same local day: the same bytes.
    expect(
      await memory.refreshSupervisorMemoryDaily(
        "os-sup",
        "Ada",
        day1 + 60 * 60_000,
      ),
    ).toBe(false);
    expect(await note()).toBe("note 1");
    // 00:30 in Warsaw is a new day there, though still July 1st in UTC.
    const day2 = at("2026-07-01T22:30:00Z");
    expect(
      await memory.refreshSupervisorMemoryDaily("os-sup", "Ada", day2),
    ).toBe(true);
    expect(await note()).toBe("note 2");
    expect(
      await memory.refreshSupervisorMemoryDaily("os-sup", "Ada", day2 + 60_000),
    ).toBe(false);
    expect(await note()).toBe("note 2");
  });

  test("a compaction rebuilds it", async () => {
    expect(await note()).toBe("note 1");
    memory.refreshSupervisorMemoryAfterCompaction("os-sup");
    expect(await note()).toBe("note 2");
  });

  test("run-session wires both, for supervisor sessions only", async () => {
    const source = await Bun.file(
      new URL("./run-session.ts", import.meta.url),
    ).text();
    expect(source).toMatch(
      /if \(\s*session\.supervisor &&\s*event\.phase === "wait" &&\s*event\.reason === "compaction"\s*\) \{\s*refreshSupervisorMemoryAfterCompaction\(session\.id\);\s*void recordSupervisorCompaction\(session\)/,
    );
    // Inside the owner-only supervisor block, before the memory note is built.
    const block = source.slice(
      source.indexOf("if (inboxOwner) {"),
      source.indexOf("// Shown in the Blob app"),
    );
    expect(block).toContain("supervisorSeedDue(inboxOwner, session.id)");
    expect(block).toContain("supervisorSeedContext(inboxOwner, due)");
    // Recorded only once a turn completes without error, like the briefed
    // answers.
    expect(source).toContain(
      "if (inboxOwner && seedDue && !endedWithError && !runFailure)\n    await markSupervisorSeeded(inboxOwner, session.id)",
    );
    // So is the memory writer, debounced (supervisor-memory-writer.ts).
    expect(source).toContain(
      "if (inboxOwner && !endedWithError && !runFailure)\n    scheduleSupervisorMemoryWriter(inboxOwner);",
    );
    // Memory for the supervisor is the owner's and the team's only.
    expect(source).toContain(
      "retrievedMemoryNoteFor(\n      content,\n      user,\n      sessionMemoryRepoIds(session),",
    );
    // A retired supervisor session takes no new turns.
    expect(source).toMatch(
      /if \(session\.supervisor && session\.supervisorRetiredAt\) \{[\s\S]{0,400}throw new RunSetupRefusedError\(message\)/,
    );
    expect(block).toContain(
      "refreshSupervisorMemoryDaily(session.id, inboxOwner)",
    );
    expect(source.indexOf("refreshSupervisorMemoryDaily(")).toBeLessThan(
      source.indexOf("await buildSessionNote(session, user)"),
    );
  });
});
