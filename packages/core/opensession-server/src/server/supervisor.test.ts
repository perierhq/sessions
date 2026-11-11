/**
 * The supervisor's get-or-create: one session per person, kept in the
 * `supervisors` catalog namespace, never two under concurrent ensures, and a
 * fresh one when the mapped session is gone. Runs on the in-memory kernel
 * store with every state path under a scratch root.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionKernelStore,
  __setSessionKernelStoreForTest,
} from "./session-kernel";
import type { NativeSessionFile } from "./types";

const root = mkdtempSync(join(tmpdir(), "supervisor-test-"));
const sessionsDir = join(root, "sessions");
mkdirSync(sessionsDir, { recursive: true });
const prior = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = root;

type Supervisor = typeof import("./supervisor");
type Catalog = typeof import("./catalog-documents");
let supervisor: Supervisor;
let catalog: Catalog;
let priorSessionsDir: string | undefined;

beforeAll(async () => {
  priorSessionsDir = (await import("./paths")).__setSessionsDirForTest(
    sessionsDir,
  );
  const { __setSessionListStoreForTest, SessionListStore } =
    await import("./session-list-store");
  __setSessionListStoreForTest(new SessionListStore(":memory:"));
  supervisor = await import("./supervisor");
  catalog = await import("./catalog-documents");
});

afterAll(async () => {
  (await import("./session-list-store")).__setSessionListStoreForTest(
    undefined,
  );
  if (priorSessionsDir !== undefined)
    (await import("./paths")).__setSessionsDirForTest(priorSessionsDir);
  if (prior === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = prior;
  rmSync(root, { recursive: true, force: true });
});

let store: SessionKernelStore;
let previousStore: SessionKernelStore | undefined;
beforeEach(() => {
  rmSync(join(root, ".opensession-supervisors"), {
    recursive: true,
    force: true,
  });
  store = new SessionKernelStore(":memory:");
  previousStore = __setSessionKernelStoreForTest(store);
});
afterEach(() => {
  __setSessionKernelStoreForTest(previousStore);
  store.close();
});

async function sessionDoc(id: string): Promise<NativeSessionFile | undefined> {
  const { sessionMetadata } = await import("./session-kernel");
  const stored = await sessionMetadata({ op: "catalog_get", sessionId: id });
  return stored ? (JSON.parse(stored.doc) as NativeSessionFile) : undefined;
}

describe("ensureSupervisorSession", () => {
  test("creates a repo-less ask-mode supervisor on the instance default model", async () => {
    const { sessionId } = await supervisor.ensureSupervisorSession("Ada");
    const doc = await sessionDoc(sessionId);
    expect(doc).toMatchObject({
      id: sessionId,
      title: "Supervisor",
      mode: "ask",
      supervisor: true,
      repoLess: true,
      createdBy: "Ada",
      branch: "",
      worktreeDir: "",
    });
    expect(doc?.desk).toBeUndefined();
    expect(doc?.model).toBeUndefined();
    expect(doc?.effort).toBeUndefined();
    expect(doc?.repo).toBeUndefined();
  });

  test("is idempotent per person", async () => {
    const first = await supervisor.ensureSupervisorSession("Ada");
    expect(await supervisor.ensureSupervisorSession("Ada")).toEqual(first);
    const other = await supervisor.ensureSupervisorSession("Grace");
    expect(other.sessionId).not.toBe(first.sessionId);
  });

  test("concurrent ensures for one person create one session", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        supervisor.ensureSupervisorSession("Ada"),
      ),
    );
    const ids = new Set(results.map((r) => r.sessionId));
    expect(ids.size).toBe(1);
    // One session file was written, not five with four archived losers.
    const { sessionMetadata } = await import("./session-kernel");
    const sessions = await sessionMetadata({
      op: "catalog_page",
      afterSessionId: "",
      limit: 50,
    });
    expect(sessions.map((row) => row.sessionId)).toEqual([...ids]);
    const page = await catalog
      .catalogDocuments(supervisor.SUPERVISORS_NAMESPACE)
      .list();
    expect(page).toHaveLength(1);
  });

  test("keeps the map in the supervisors catalog namespace and its export", async () => {
    const { sessionId } = await supervisor.ensureSupervisorSession("Ada");
    const key = supervisor.supervisorKey("Ada");
    expect(
      await catalog.catalogDocuments(supervisor.SUPERVISORS_NAMESPACE).get(key),
    ).toMatchObject({ sessionId });
    const exported = JSON.parse(
      await readFile(
        join(root, ".opensession-supervisors", `${key}.json`),
        "utf8",
      ),
    );
    expect(exported.sessionId).toBe(sessionId);
  });

  test("replaces a mapping whose session is gone", async () => {
    const key = supervisor.supervisorKey("Ada");
    await catalog
      .catalogDocuments(supervisor.SUPERVISORS_NAMESPACE)
      .set(key, { sessionId: "os-missing", createdAt: "" });
    const { sessionId } = await supervisor.ensureSupervisorSession("Ada");
    expect(sessionId).not.toBe("os-missing");
    expect((await sessionDoc(sessionId))?.supervisor).toBe(true);
    expect(
      await catalog.catalogDocuments(supervisor.SUPERVISORS_NAMESPACE).get(key),
    ).toMatchObject({ sessionId });
  });
});

describe("rotationDue", () => {
  const now = Date.parse("2026-07-20T12:00:00Z");
  const record = (
    patch: Partial<import("./supervisor").SupervisorRecord> = {},
  ) => ({
    sessionId: "os-a",
    createdAt: "2026-07-01T12:00:00Z",
    previous: [],
    compactions: 0,
    ...patch,
  });
  const idle = {
    createdAt: "2026-07-01T12:00:00Z",
    lastActivity: "2026-07-20T11:00:00Z",
    busy: false,
  };

  test("an old, idle session is due", () => {
    expect(supervisor.rotationDue(record(), idle, now)).toBe(true);
  });

  test("never while a run is in progress", () => {
    expect(
      supervisor.rotationDue(
        record({ compactions: 9 }),
        { ...idle, busy: true },
        now,
      ),
    ).toBe(false);
  });

  test("never within 30 minutes of the last activity", () => {
    const recent = { ...idle, lastActivity: "2026-07-20T11:31:00Z" };
    expect(
      supervisor.rotationDue(record({ compactions: 9 }), recent, now),
    ).toBe(false);
    expect(
      supervisor.rotationDue(record(), { ...idle, lastActivity: "" }, now),
    ).toBe(false);
  });

  test("a young session is due only after three compactions", () => {
    const young = record({ createdAt: "2026-07-18T12:00:00Z" });
    expect(supervisor.rotationDue(young, idle, now)).toBe(false);
    expect(
      supervisor.rotationDue({ ...young, compactions: 2 }, idle, now),
    ).toBe(false);
    expect(
      supervisor.rotationDue({ ...young, compactions: 3 }, idle, now),
    ).toBe(true);
  });

  test("a young idle session is due once its context reaches 100k tokens", () => {
    const young = record({ createdAt: "2026-07-18T12:00:00Z" });
    expect(supervisor.ROTATE_CONTEXT_TOKENS).toBe(100_000);
    expect(
      supervisor.rotationDue(young, { ...idle, contextTokens: 99_999 }, now),
    ).toBe(false);
    expect(
      supervisor.rotationDue(young, { ...idle, contextTokens: 100_000 }, now),
    ).toBe(true);
    // Still only when idle.
    expect(
      supervisor.rotationDue(
        young,
        { ...idle, contextTokens: 246_000, busy: true },
        now,
      ),
    ).toBe(false);
    expect(
      supervisor.rotationDue(
        young,
        {
          ...idle,
          contextTokens: 246_000,
          lastActivity: "2026-07-20T11:45:00Z",
        },
        now,
      ),
    ).toBe(false);
  });

  test("exactly seven days is not yet old; the session's own date backs a record without one", () => {
    const week = record({ createdAt: "2026-07-13T12:00:00Z" });
    expect(supervisor.rotationDue(week, idle, now)).toBe(false);
    expect(supervisor.rotationDue(record({ createdAt: "" }), idle, now)).toBe(
      true,
    );
  });
});

describe("rotation", () => {
  const DAY = 24 * 60 * 60 * 1000;
  let clock = Date.parse("2026-07-01T12:00:00Z");
  let busy = false;
  let restoreDeps: () => void = () => {};
  beforeEach(() => {
    clock = Date.parse("2026-07-01T12:00:00Z");
    busy = false;
    restoreDeps = supervisor.__setSupervisorDepsForTest({
      now: () => clock,
      busy: () => busy,
    });
  });
  afterEach(() => restoreDeps());

  const record = async (user = "Ada") =>
    (await catalog
      .catalogDocuments(supervisor.SUPERVISORS_NAMESPACE)
      .get(
        supervisor.supervisorKey(user),
      )) as import("./supervisor").SupervisorRecord;

  test("an idle week-old session moves to a new one and keeps the old in previous", async () => {
    const first = await supervisor.ensureSupervisorSession("Ada");
    expect(first.previousSessionIds).toEqual([]);
    clock += 8 * DAY;
    const second = await supervisor.ensureSupervisorSession("Ada");
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.previousSessionIds).toEqual([first.sessionId]);
    // The old session keeps its history as a hidden supervisor, not
    // archived, but is marked retired: no new turns, no inbox.
    const old = await sessionDoc(first.sessionId);
    expect(old?.supervisor).toBe(true);
    expect(old?.archived).toBeUndefined();
    expect(old?.supervisorRetiredAt).toBe(new Date(clock).toISOString());
    expect(
      (await sessionDoc(second.sessionId))?.supervisorRetiredAt,
    ).toBeUndefined();
    expect((await sessionDoc(second.sessionId))?.supervisor).toBe(true);
    expect(await record()).toMatchObject({
      sessionId: second.sessionId,
      previous: [first.sessionId],
      compactions: 0,
      createdAt: new Date(clock).toISOString(),
    });
    // Idempotent again until the next week.
    expect(await supervisor.ensureSupervisorSession("Ada")).toEqual(second);
  });

  test("a busy or recently active session is kept", async () => {
    const first = await supervisor.ensureSupervisorSession("Ada");
    clock += 8 * DAY;
    busy = true;
    expect((await supervisor.ensureSupervisorSession("Ada")).sessionId).toBe(
      first.sessionId,
    );
    busy = false;
    const { updateSessionFile } = await import("./session-cache");
    await updateSessionFile(first.sessionId, (data) => ({
      ...data,
      lastActivity: new Date(clock - 10 * 60_000).toISOString(),
    }));
    expect((await supervisor.ensureSupervisorSession("Ada")).sessionId).toBe(
      first.sessionId,
    );
  });

  test("three compactions rotate a young idle session", async () => {
    const first = await supervisor.ensureSupervisorSession("Ada");
    const session = { id: first.sessionId, supervisor: true, createdBy: "Ada" };
    expect(await supervisor.recordSupervisorCompaction(session)).toBe(1);
    expect(await supervisor.recordSupervisorCompaction(session)).toBe(2);
    clock += 60 * 60_000;
    expect((await supervisor.ensureSupervisorSession("Ada")).sessionId).toBe(
      first.sessionId,
    );
    expect(await supervisor.recordSupervisorCompaction(session)).toBe(3);
    const second = await supervisor.ensureSupervisorSession("Ada");
    expect(second.sessionId).not.toBe(first.sessionId);
    expect((await record()).compactions).toBe(0);
    // A compaction of the retired session no longer counts.
    expect(await supervisor.recordSupervisorCompaction(session)).toBeNull();
    expect((await record()).compactions).toBe(0);
  });

  test("a large context rotates a young idle session and keeps the owner's model and effort", async () => {
    const first = await supervisor.ensureSupervisorSession("Ada");
    const { updateSessionFile } = await import("./session-cache");
    await updateSessionFile(first.sessionId, (data) => ({
      ...data,
      model: "pi/anthropic/claude-sonnet-5-5",
      effort: "low",
      usage: {
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        contextTokens: 120_000,
        contextWindow: 1_000_000,
        turns: 30,
        updatedAt: new Date(clock).toISOString(),
      },
    }));
    clock += 60 * 60_000;
    const second = await supervisor.ensureSupervisorSession("Ada");
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.previousSessionIds).toEqual([first.sessionId]);
    const fresh = await sessionDoc(second.sessionId);
    expect(fresh?.model).toBe("pi/anthropic/claude-sonnet-5-5");
    expect(fresh?.effort).toBe("low");
    expect(fresh?.usage).toBeUndefined();
  });

  test("a new supervisor without a chosen effort leaves it to the default", async () => {
    const first = await supervisor.ensureSupervisorSession("Ada");
    const doc = await sessionDoc(first.sessionId);
    expect(doc?.effort).toBeUndefined();
    expect(doc?.model).toBeUndefined();
    expect(supervisor.carriedSupervisorSettings(undefined)).toEqual({});
    expect(
      supervisor.carriedSupervisorSettings({
        model: undefined,
        effort: "high",
      }),
    ).toEqual({ effort: "high" });
  });

  test("compactions of any other session are not counted", async () => {
    await supervisor.ensureSupervisorSession("Ada");
    expect(
      await supervisor.recordSupervisorCompaction({
        id: "os-other",
        createdBy: "Ada",
      }),
    ).toBeNull();
    expect(
      await supervisor.recordSupervisorCompaction({
        id: "os-other",
        supervisor: true,
        createdBy: "Grace",
      }),
    ).toBeNull();
    expect(
      await catalog
        .catalogDocuments(supervisor.SUPERVISORS_NAMESPACE)
        .get(supervisor.supervisorKey("Grace")),
    ).toBeNull();
  });

  test("previous is bounded, newest first", async () => {
    const first = await supervisor.ensureSupervisorSession("Ada");
    const older = Array.from({ length: 60 }, (_, i) => `os-old-${i}`);
    await catalog
      .catalogDocuments(supervisor.SUPERVISORS_NAMESPACE)
      .set(supervisor.supervisorKey("Ada"), {
        ...(await record()),
        previous: older,
      });
    expect(
      (await supervisor.ensureSupervisorSession("Ada")).previousSessionIds,
    ).toHaveLength(supervisor.MAX_PREVIOUS);
    clock += 8 * DAY;
    const second = await supervisor.ensureSupervisorSession("Ada");
    expect(second.previousSessionIds).toHaveLength(supervisor.MAX_PREVIOUS);
    expect(second.previousSessionIds[0]).toBe(first.sessionId);
    expect(second.previousSessionIds[1]).toBe("os-old-0");
  });

  test("a mapping whose session is gone is replaced, keeping its history", async () => {
    await catalog
      .catalogDocuments(supervisor.SUPERVISORS_NAMESPACE)
      .set(supervisor.supervisorKey("Ada"), {
        sessionId: "os-missing",
        createdAt: "",
        previous: ["os-older"],
      });
    const ensured = await supervisor.ensureSupervisorSession("Ada");
    expect(ensured.sessionId).not.toBe("os-missing");
    expect(ensured.previousSessionIds).toEqual(["os-older"]);
  });

  test("concurrent ensures and sweeps during a due rotation mint one session", async () => {
    const first = await supervisor.ensureSupervisorSession("Ada");
    clock += 8 * DAY;
    const results = await Promise.all([
      supervisor.ensureSupervisorSession("Ada"),
      supervisor.rotateSupervisorIfDue("Ada"),
      supervisor.ensureSupervisorSession("Ada"),
      supervisor.rotateSupervisorIfDue("Ada"),
    ]);
    const ids = new Set(results.map((r) => r?.sessionId));
    expect(ids.size).toBe(1);
    expect(ids.has(first.sessionId)).toBe(false);
    const { sessionMetadata } = await import("./session-kernel");
    const sessions = await sessionMetadata({
      op: "catalog_page",
      afterSessionId: "",
      limit: 50,
    });
    expect(sessions).toHaveLength(2);
    expect((await record()).previous).toEqual([first.sessionId]);
  });

  test("an ensure racing a sweep check never returns a session that is gone", async () => {
    await catalog
      .catalogDocuments(supervisor.SUPERVISORS_NAMESPACE)
      .set(supervisor.supervisorKey("Ada"), {
        sessionId: "os-missing",
        createdAt: "",
        previous: [],
      });
    const [rotated, ensured] = await Promise.all([
      supervisor.rotateSupervisorIfDue("Ada"),
      supervisor.ensureSupervisorSession("Ada"),
    ]);
    expect(rotated).toBeNull();
    expect(ensured.sessionId).not.toBe("os-missing");
    expect((await sessionDoc(ensured.sessionId))?.supervisor).toBe(true);
    expect(await supervisor.rotateSupervisorIfDue("Ada")).toEqual(ensured);
  });

  test("a session retired by a rotation that failed to claim is rotated on the next ensure", async () => {
    const first = await supervisor.ensureSupervisorSession("Ada");
    const { updateSessionFile } = await import("./session-cache");
    await updateSessionFile(first.sessionId, (data) => ({
      ...data,
      supervisorRetiredAt: new Date(clock).toISOString(),
    }));
    const next = await supervisor.ensureSupervisorSession("Ada");
    expect(next.sessionId).not.toBe(first.sessionId);
    expect(next.previousSessionIds).toEqual([first.sessionId]);
  });

  test("the seed is due on a new session until a turn delivers it", async () => {
    const first = await supervisor.ensureSupervisorSession("Ada");
    expect(await supervisor.supervisorSeedDue("Ada", first.sessionId)).toEqual({
      rotated: false,
      previous: [],
    });
    // Nothing recorded yet (a failed turn records nothing): still due.
    expect(await supervisor.supervisorSeedDue("Ada", first.sessionId)).toEqual({
      rotated: false,
      previous: [],
    });
    expect(await supervisor.markSupervisorSeeded("Ada", first.sessionId)).toBe(
      true,
    );
    expect(
      await supervisor.supervisorSeedDue("Ada", first.sessionId),
    ).toBeNull();
    clock += 8 * DAY;
    const second = await supervisor.ensureSupervisorSession("Ada");
    expect(await supervisor.supervisorSeedDue("Ada", second.sessionId)).toEqual(
      { rotated: true, previous: [first.sessionId] },
    );
    // The retired session is never seeded or marked again.
    expect(
      await supervisor.supervisorSeedDue("Ada", first.sessionId),
    ).toBeNull();
    expect(await supervisor.markSupervisorSeeded("Ada", first.sessionId)).toBe(
      false,
    );
    expect((await record()).seededSessionId).toBeUndefined();
  });

  test("the memory writer's cursor moves by compare-and-set and survives a rotation", async () => {
    const first = await supervisor.ensureSupervisorSession("Ada");
    // A new record's writer starts at the new session's beginning.
    const start = { sessionId: first.sessionId, seq: 0 };
    expect((await record()).memoryCursor).toEqual(start);
    const at = { sessionId: first.sessionId, seq: 12 };
    expect(
      await supervisor.advanceSupervisorMemoryCursor("Ada", start, at),
    ).toBe(true);
    // A run that started from an older cursor never winds it back.
    expect(
      await supervisor.advanceSupervisorMemoryCursor("Ada", start, {
        sessionId: first.sessionId,
        seq: 3,
      }),
    ).toBe(false);
    expect((await record()).memoryCursor).toEqual(at);
    clock += 8 * DAY;
    const second = await supervisor.ensureSupervisorSession("Ada");
    expect(second.sessionId).not.toBe(first.sessionId);
    // The retired session's tail is still the writer's to read.
    expect((await record()).memoryCursor).toEqual(at);
    expect(await supervisor.markSupervisorSeeded("Ada", second.sessionId)).toBe(
      true,
    );
    expect((await record()).memoryCursor).toEqual(at);
  });

  test("a prompt to a retired session points at the current one", () => {
    expect(supervisor.retiredSupervisorMessage("os-new")).toContain(
      "/session/os-new",
    );
    expect(supervisor.retiredSupervisorMessage(null)).toContain(
      "Open the supervisor again",
    );
  });

  test("an ensure racing a sweep check for a new person still creates one", async () => {
    const [rotated, ensured] = await Promise.all([
      supervisor.rotateSupervisorIfDue("Ada"),
      supervisor.ensureSupervisorSession("Ada"),
    ]);
    expect(rotated).toBeNull();
    expect(ensured.sessionId).toBeTruthy();
  });

  test("the sweep check creates nothing for a person without a supervisor", async () => {
    expect(await supervisor.rotateSupervisorIfDue("Ada")).toBeNull();
    expect(
      await catalog.catalogDocuments(supervisor.SUPERVISORS_NAMESPACE).list(),
    ).toHaveLength(0);
  });

  test("a rotation another gateway claimed first keeps theirs and archives ours", async () => {
    const first = await supervisor.ensureSupervisorSession("Ada");
    clock += 8 * DAY;
    const real = catalog.catalogDocuments(supervisor.SUPERVISORS_NAMESPACE);
    const make = catalog.catalogDocuments;
    let raced = false;
    const spy = spyOn(catalog, "catalogDocuments").mockImplementation(
      (namespace: string) => {
        const documents = make(namespace);
        return {
          ...documents,
          update: async (key, mutate) => {
            // The other gateway's claim lands between our read and ours.
            if (!raced) {
              raced = true;
              await real.set(key, {
                sessionId: "os-theirs",
                createdAt: new Date(clock).toISOString(),
                previous: [first.sessionId],
                compactions: 0,
              });
            }
            return documents.update(key, mutate);
          },
        } as typeof documents;
      },
    );
    try {
      const won = await supervisor.ensureSupervisorSession("Ada");
      expect(won).toEqual({
        sessionId: "os-theirs",
        previousSessionIds: [first.sessionId],
      });
    } finally {
      spy.mockRestore();
    }
    const { sessionMetadata } = await import("./session-kernel");
    const sessions = await sessionMetadata({
      op: "catalog_page",
      afterSessionId: "",
      limit: 50,
    });
    const ours = sessions
      .map((row) => JSON.parse(row.doc) as NativeSessionFile)
      .filter((doc) => doc.id !== first.sessionId);
    expect(ours).toHaveLength(1);
    expect(ours[0]?.archived).toBe(true);
  });
});

describe("standing sessions", () => {
  test("only an explicit supervisor request leaves the Desk", () => {
    expect(supervisor.parseStanding("supervisor")).toBe("supervisor");
    expect(supervisor.parseStanding("desk")).toBe("desk");
    expect(supervisor.parseStanding(undefined)).toBe("desk");
    expect(supervisor.parseStanding("anything")).toBe("desk");
  });

  test("standingSessionFor resolves the supervisor through the catalog", async () => {
    const ensured = await supervisor.ensureSupervisorSession("Ada");
    expect(await supervisor.standingSessionFor("Ada", "supervisor")).toEqual(
      ensured,
    );
  });

  test("the charter is plain and short", () => {
    const note = supervisor.supervisorNote("Pat");
    expect(note).not.toContain("\u2014");
    expect(note).toContain("refunds");
    expect(note).toContain("create_session");
  });

  test("the charter keeps no timers and hands follow-ups to the watch", () => {
    const note = supervisor.supervisorNote("Pat");
    expect(note).toContain("You keep no timers and wait on nothing.");
    expect(note).toContain("Never use wait_for");
    expect(note).toContain("opensession-supervisor watch_for");
    expect(note).toContain("## Your watch");
    expect(note).toContain("It never speaks in this conversation");
  });

  test("each ensure tells the listeners, which never fail it", async () => {
    const seen: string[] = [];
    const off = supervisor.onSupervisorEnsured((user) => {
      seen.push(user);
    });
    const offThrowing = supervisor.onSupervisorEnsured(() => {
      throw new Error("listener down");
    });
    try {
      await supervisor.ensureSupervisorSession("Ada");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(seen).toEqual(["Ada"]);
    } finally {
      off();
      offThrowing();
    }
  });

  test("the charter acts, acknowledges slow tools and checks claims about itself", () => {
    const note = supervisor.supervisorNote("Pat");
    expect(note).toContain(
      "Act instead of asking back. When one option is clearly right and within what the owner asked for, do it and say so.",
    );
    expect(note).toContain(
      'A short yes or approval ("go", "approve", "do it") refers to the choices you offered last: act on them. Ask only when two of them fit.',
    );
    expect(note).toContain(
      "Before a tool call that can take more than a moment, write one short line saying what you're checking",
    );
    expect(note).toContain('("Checking Pat\'s review now.")');
    expect(note).toContain("within two seconds");
    expect(note).toContain(
      "that line is a short ```say fence, at most once per turn: later checks in the same turn get a plain line.",
    );
    expect(note).toContain(
      "Never state how Blob, Open Session or a tool behaves (what it shows, where a card appears, what it can or can't do) unless this turn's context, the charter or a tool result says so. Check first, or say you don't know.",
    );
    expect(note).toContain("Never offer a menu you already offered");
  });

  test("the charter says to read and keep the ledger", () => {
    const note = supervisor.supervisorNote("Pat");
    expect(note).toContain("## Your ledger");
    expect(note).toContain("read_ledger and append_ledger");
    expect(note).toContain("Read the ledger when you start a new conversation");
    expect(note).toContain("mark the old one superseded");
  });

  test("the charter merges through the owner's confirm card, only on request", () => {
    const note = supervisor.supervisorNote("Pat");
    expect(note).toContain(
      "When the owner asks to merge a pull request, use opensession-repos force_merge_pull_request.",
    );
    expect(note).toContain("puts a confirm card in front of the owner");
    expect(note).toContain("merges with the owner's account");
    expect(note).toContain("Never merge on your own initiative.");
    expect(note).not.toContain("send_to_session). Use force_merge");
    expect(note).not.toMatch(/merge it \(send_to_session\)/);
  });

  test("the charter answers an @Blob mention where it was asked", () => {
    const note = supervisor.supervisorNote("Pat");
    expect(note).toContain("When the owner mentions you (@Blob)");
    expect(note).toContain(
      "reply_in_thread for a thread, send_to_session for a session",
    );
    expect(note).toContain("create_session or spawn_task");
  });

  test("the charter keeps decisions to the owner's own words", () => {
    const note = supervisor.supervisorNote("Pat");
    expect(note).toContain(
      "Record a decision only if the owner said it in their own message or answer.",
    );
    expect(note).toContain("your own notes, not the owner's instructions");
  });

  test("the charter says how Blob speaks", () => {
    const note = supervisor.supervisorNote("Pat");
    expect(note).toContain("## How Blob speaks");
    expect(note).toContain("warm, but not pretending to be human");
    expect(note).toContain('("I\'d raise it")');
    expect(note).toContain('no filler ("Great question")');
    expect(note).toContain('Never say "as an AI"');
    expect(note).toContain("Never claim something you didn't do");
    expect(note).toContain('say "I don\'t know" plainly');
    expect(note).toContain("One to three sentences, then stop.");
    expect(note).toContain(
      "Only when the turn's Blob context asks for it, a reply opens with a ```say fence",
    );
    expect(note).toContain(
      "Anywhere else, write a normal reply with no say fence.",
    );
    expect(note).toContain(
      "It talks about what is shown and never repeats it.",
    );
    expect(note).toContain("What is shown is a view, not a recap");
    expect(note).toContain("never cute. No em dashes.");
  });

  test("Blob greets once a day and leaves the time of day out", () => {
    const note = supervisor.supervisorNote("Pat");
    expect(note).toContain(
      "Greet only in the first conversation of the day or after more than three hours apart",
    );
    expect(note).toContain("otherwise go straight to the point");
    expect(note).toContain("Never mention the time of day unless it matters.");
  });

  test("Blob names the persona when delegating and never posts publicly", () => {
    const note = supervisor.supervisorNote("Robin");
    expect(note).toContain('("I\'ve asked Robin to review it")');
    expect(note).toContain("ask_pat hands Robin GitHub work");
    expect(note).toContain(
      "You never sign or post anything public yourself, and nothing public is ever signed Blob. Anything public goes out as Robin",
    );
    expect(note).not.toContain("Pat ");
  });
});

describe("POST /api/supervisor/ensure", () => {
  async function post(
    body: unknown,
    authUser?: { login: string; name: string },
  ) {
    const { handleSupervisorRoutes } = await import("./routes/supervisor");
    const url = new URL("http://localhost/api/supervisor/ensure");
    return handleSupervisorRoutes({
      req: new Request(url, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      }),
      url,
      path: url.pathname,
      publicPrefix: "/backstage",
      authUser,
    });
  }

  test("answers the claimed user's supervisor without sign-in", async () => {
    const res = await post({ user: "Ada" });
    expect(res?.status).toBe(200);
    const json = (await res!.json()) as {
      sessionId: string;
      previousSessionIds: string[];
      session: { supervisor?: boolean } | null;
    };
    expect(json.sessionId).toBe(
      (await supervisor.ensureSupervisorSession("Ada")).sessionId,
    );
    expect(json.previousSessionIds).toEqual([]);
    expect(json.session?.supervisor).toBe(true);
  });

  test("a signed-in person gets their own, whatever the body claims", async () => {
    const res = await post(
      { user: "Grace" },
      { login: "ada", name: "Ada Lovelace" },
    );
    const json = (await res!.json()) as { sessionId: string };
    expect(json.sessionId).toBe(
      (await supervisor.ensureSupervisorSession("Ada")).sessionId,
    );
  });

  test("refuses a request with no user, and is in the route chain", async () => {
    expect((await post({}))?.status).toBe(400);
    const { routeHandlers } = await import("./routes/index");
    const { handleSupervisorRoutes } = await import("./routes/supervisor");
    expect(routeHandlers).toContain(handleSupervisorRoutes);
  });
});
