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
    expect(await memory.supervisorSeedContext("Ada")).toBeUndefined();
  });

  test("carries the ledger tail, open decisions and recent digests, wrapped", async () => {
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
    await inbox.sweepSupervisorInbox();

    const seed = await memory.supervisorSeedContext("Ada");
    expect(seed).toStartWith('<opensession:context source="supervisor-seed">');
    expect(seed).toContain("## Picking up");
    expect(seed).toContain("read_ledger");
    expect(seed).toContain("Owner prefers SBAR for incidents.");
    expect(seed).toMatch(/- \[[^\]]+\] Roll back the deploy\? \(acme\)/);
    expect(seed).toContain("- 2026-07-01: CI repaired");
    expect(seed).toContain(inbox.BRIEFING_UNTRUSTED_NOTE);
  });

  test("is bounded: the ledger's tail only, and the whole seed", async () => {
    for (let i = 0; i < 40; i++)
      await ledger.appendSupervisorLedger(
        "Ada",
        `Fact ${String(i).padStart(2, "0")}: ${"z".repeat(400)}`,
      );
    for (let i = 0; i < 12; i++)
      await inbox.postSupervisorItem({
        user: "Ada",
        source: "lead:acme",
        kind: "needs-you",
        title: `Decision ${i} ${"w".repeat(100)}`,
        dedupeKey: `k${i}`,
      });
    const seed = (await memory.supervisorSeedContext("Ada"))!;
    expect(Buffer.byteLength(seed)).toBeLessThanOrEqual(
      memory.SEED_MAX_BYTES + 200,
    );
    expect(seed).toContain("Fact 39");
    expect(seed).not.toContain("Fact 00");
    expect(seed).toContain("(older ones left out)");
    expect(seed.match(/^- \[/gm)).toHaveLength(memory.SEED_NEEDS_YOU);
  });

  test("only a session that has not run on an engine yet gets it", () => {
    expect(memory.isFirstEngineTurn({})).toBe(true);
    expect(memory.isFirstEngineTurn({ piSessionId: "p" })).toBe(false);
    expect(memory.isFirstEngineTurn({ claudeSessionId: "c" })).toBe(false);
    expect(memory.isFirstEngineTurn({ codexThreadId: "x" })).toBe(false);
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
    expect(block).toContain("isFirstEngineTurn(session)");
    expect(block).toContain("supervisorSeedContext(inboxOwner)");
    expect(block).toContain(
      "refreshSupervisorMemoryDaily(session.id, inboxOwner)",
    );
    expect(source.indexOf("refreshSupervisorMemoryDaily(")).toBeLessThan(
      source.indexOf("await buildSessionNote(session, user)"),
    );
  });
});
