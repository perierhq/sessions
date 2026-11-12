/**
 * The morning brief: the record and its checks against the owner's inbox,
 * the brief turn (scheduled from the sweep, on open, on request) and its
 * bounds, the push and its fallback, and the routes. Runs on the in-memory
 * kernel store with a fake clock, fake session delivery and fake
 * notifications; no real timers.
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
import type { NotificationEvent } from "./notification-threads";

const root = mkdtempSync(join(tmpdir(), "supervisor-brief-test-"));
const prior = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = root;

type Inbox = typeof import("./supervisor-inbox");
type Brief = typeof import("./supervisor-brief");
let inbox: Inbox;
let brief: Brief;

beforeAll(async () => {
  inbox = await import("./supervisor-inbox");
  brief = await import("./supervisor-brief");
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
let sent: Array<{ user: string; event: NotificationEvent }> = [];
let delivered: Array<{ sessionId: string; text: string; deliveryId: string }> =
  [];
let announced: Array<{ user: string; day: string }> = [];
let session: string | null = "os-sup-ada";
let failDeliver = false;
let restoreInbox: () => void = () => {};
let restoreBrief: () => void = () => {};

beforeEach(() => {
  rmSync(join(root, ".opensession-supervisor-items"), {
    recursive: true,
    force: true,
  });
  store = new SessionKernelStore(":memory:");
  previousStore = __setSessionKernelStoreForTest(store);
  clock = at("2026-07-01T12:00:00Z");
  sent = [];
  delivered = [];
  announced = [];
  session = "os-sup-ada";
  failDeliver = false;
  restoreInbox = inbox.__setSupervisorInboxDepsForTest({
    now: () => clock,
    notify: async (user, event) => {
      sent.push({ user, event });
      return {};
    },
    markDone: async () => {},
    supervisorSessionId: async () => "os-sup-ada",
    rotateSupervisor: async () => {},
    ensureWatch: async () => {},
    checkBlobGithub: async () => {},
    timeZone: () => "UTC",
  });
  restoreBrief = brief.__setBriefDepsForTest({
    now: () => clock,
    currentSessionId: async () => session,
    ensureSessionId: async () => {
      session ??= "os-sup-ada";
      return session;
    },
    deliver: async (sessionId, text, deliveryId) => {
      if (failDeliver) throw new Error("session busy elsewhere");
      delivered.push({ sessionId, text, deliveryId });
    },
    expand: async (items) =>
      items.map((item) => ({ ...item, revision: item.updatedAt })),
    announce: async (user, day) => {
      announced.push({ user, day });
    },
  });
});

afterEach(() => {
  restoreBrief();
  restoreInbox();
  inbox.__resetSupervisorInboxForTest();
  __setSessionKernelStoreForTest(previousStore);
  store.close();
});

async function decision(title: string, dedupeKey: string) {
  return (
    await inbox.postSupervisorItem({
      user: "Ada",
      source: "lead:acme",
      kind: "needs-you",
      title,
      project: "acme",
      options: ["Ship it", "Hold"],
      dedupeKey,
    })
  ).item;
}

async function fyi(title: string) {
  return (
    await inbox.postSupervisorItem({
      user: "Ada",
      source: "lead:acme",
      kind: "fyi",
      title,
    })
  ).item;
}

async function record() {
  const view = await inbox.readSupervisorBriefView("Ada");
  return brief.cleanBriefRecord(view.brief);
}

describe("the record", () => {
  test("decisions must be open needs-you items of the owner's, at most three", async () => {
    const a = await decision("Ship 1.19.0?", "a");
    const b = await decision("Merge PR 533?", "b");
    const c = await decision("Raise the budget?", "c");
    const d = await decision("Rotate the key?", "d");
    const note = await fyi("CI repaired");
    const items = (await inbox.readSupervisorBriefView("Ada")).items;

    const ok = brief.validateBrief(
      {
        say: "Morning. One release waits on you.",
        handled: [{ line: "Closed the stale budget card", itemId: c.id }],
        decisions: [{ itemId: a.id, recommended: "2" }],
      },
      items,
    );
    expect(ok).toEqual({
      ok: true,
      value: {
        say: "Morning. One release waits on you.",
        handled: [{ line: "Closed the stale budget card", itemId: c.id }],
        decisions: [{ itemId: a.id, recommended: "Hold" }],
        later: { count: 3, itemIds: expect.any(Array) },
      },
    });
    if (ok.ok)
      expect([...ok.value.later.itemIds].sort()).toEqual(
        [b.id, c.id, d.id].sort(),
      );

    const fail = (input: Parameters<Brief["validateBrief"]>[0]) => {
      const result = brief.validateBrief(input, items);
      expect(result.ok).toBe(false);
      return result.ok ? "" : result.error;
    };
    expect(
      fail({
        say: "x",
        decisions: [a, b, c, d].map((i) => ({ itemId: i.id })),
      }),
    ).toContain("At most 3 decisions");
    expect(fail({ say: "x", decisions: [{ itemId: note.id }] })).toContain(
      "not an open needs-you item",
    );
    expect(fail({ say: "x", decisions: [{ itemId: "si-nope" }] })).toContain(
      "not an open needs-you item",
    );
    expect(
      fail({ say: "x", decisions: [{ itemId: a.id }, { itemId: a.id }] }),
    ).toContain("twice");
    expect(
      fail({ say: "x", decisions: [{ itemId: a.id, recommended: "Panic" }] }),
    ).toContain("one of its options");
    expect(fail({ say: "x".repeat(601) })).toContain("under 600");
    expect(fail({ say: "  " })).toContain("empty");
    expect(
      fail({ say: "x", handled: [{ line: "Did it", itemId: "si-nope" }] }),
    ).toContain("No item si-nope");

    // A closed item can't be a decision either.
    await inbox.dismissSupervisorItem("Ada", d.id);
    const after = (await inbox.readSupervisorBriefView("Ada")).items;
    expect(
      brief.validateBrief({ say: "x", decisions: [{ itemId: d.id }] }, after)
        .ok,
    ).toBe(false);
  });

  test("say keeps every sentence but no control or bidi characters", () => {
    const result = brief.validateBrief(
      {
        say: "Morning.\nCI is fixed.\u202E Two\u0007 things\r\n\twait.\u2066",
      },
      [],
    );
    expect(result.ok && result.value.say).toBe(
      "Morning. CI is fixed. Two things wait.",
    );
    // Only control characters: empty, refused.
    expect(brief.validateBrief({ say: "\u0000\u202E" }, []).ok).toBe(false);
    // A stored say is cleaned the same way when read back.
    expect(
      brief.cleanBriefRecord({
        brief: {
          day: "2026-07-01",
          asOf: 1,
          say: "Hi\u202E there.\nBye.",
          handled: [],
          decisions: [],
          later: { count: 0, itemIds: [] },
        },
      }).brief?.say,
    ).toBe("Hi there. Bye.");
  });

  test("handled lines are one bounded line each", async () => {
    const result = brief.validateBrief(
      {
        say: "Morning.",
        handled: [{ line: `Closed\nthree ${"x".repeat(300)}` }],
      },
      [],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.handled[0]!.line).not.toContain("\n");
    expect(result.value.handled[0]!.line.length).toBeLessThanOrEqual(
      brief.BRIEF_LINE_LEN,
    );
  });

  test("write_brief stores it for today, tells open clients, and counts the fyi as told", async () => {
    const a = await decision("Ship 1.19.0?", "a");
    const note = await fyi("CI repaired");
    const written = await brief.writeSupervisorBrief("Ada", {
      say: "Morning. CI is fixed; the release waits on you.",
      decisions: [{ itemId: a.id, recommended: "Ship it" }],
    });
    expect(written.ok).toBe(true);
    expect((await record()).brief).toEqual({
      day: "2026-07-01",
      asOf: clock,
      say: "Morning. CI is fixed; the release waits on you.",
      handled: [],
      decisions: [{ itemId: a.id, recommended: "Ship it" }],
      later: { count: 0, itemIds: [] },
    });
    expect(announced).toEqual([{ user: "Ada", day: "2026-07-01" }]);
    const items = await inbox.listSupervisorItems("Ada");
    expect(items.find((i) => i.id === note.id)?.digestedAt).toBe(clock);
    // Written in conversation, not by a scheduled turn: no push.
    expect(sent).toHaveLength(0);
  });

  test("an invalid brief writes nothing", async () => {
    const result = await brief.writeSupervisorBrief("Ada", {
      say: "Morning.",
      decisions: [{ itemId: "si-nope" }],
    });
    expect(result.ok).toBe(false);
    expect((await record()).brief).toBeUndefined();
    expect(announced).toEqual([]);
  });
});

describe("the brief turn", () => {
  test("the sweep starts it at the digest time, once a day, in the supervisor session", async () => {
    await decision("Ship 1.19.0?", "a");
    clock = at("2026-07-01T08:59:00Z");
    expect((await inbox.sweepSupervisorInbox()).briefs).toBe(0);
    clock = at("2026-07-01T09:00:00Z");
    expect((await inbox.sweepSupervisorInbox()).briefs).toBe(1);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.sessionId).toBe("os-sup-ada");
    expect(delivered[0]!.text).toStartWith("<!--os:session-notice-->\n");
    expect(delivered[0]!.text).toContain("Morning brief for 2026-07-01");
    expect(delivered[0]!.deliveryId).toStartWith(brief.BRIEF_DELIVERY_PREFIX);
    expect((await record()).run).toMatchObject({
      day: "2026-07-01",
      trigger: "scheduled",
    });

    // Not again that day, even after the turn is over.
    clock = at("2026-07-01T10:00:00Z");
    await inbox.sweepSupervisorInbox();
    clock = at("2026-07-01T18:00:00Z");
    await inbox.sweepSupervisorInbox();
    expect(delivered).toHaveLength(1);

    clock = at("2026-07-02T09:01:00Z");
    expect((await inbox.sweepSupervisorInbox()).briefs).toBe(1);
    expect(delivered).toHaveLength(2);
  });

  test("a scheduled brief pushes once with fixed copy, after quiet hours, unless seen", async () => {
    const a = await decision("Ship 1.19.0?", "a");
    await decision("Merge PR 533?", "b");
    clock = at("2026-07-01T09:00:00Z");
    await inbox.sweepSupervisorInbox();
    clock = at("2026-07-01T09:04:00Z");
    expect(
      (
        await brief.writeSupervisorBrief("Ada", {
          say: "Morning.",
          decisions: [{ itemId: a.id }],
        })
      ).ok,
    ).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.event).toMatchObject({
      kind: "supervisor_digest",
      reason: "Your morning brief is ready",
      body: "1 decision",
      url: "/session/os-sup-ada?brief=2026-07-01",
      push: { body: "Open Blob to hear it" },
    });
    // The push names no item.
    expect(JSON.stringify(sent[0]!.event)).not.toContain("Ship 1.19.0");
    const stored = (await record()).brief!;
    expect(stored).toMatchObject({ trigger: "scheduled", pushedAt: clock });
    expect((await record()).run).toBeUndefined();

    // The sweep doesn't push it again.
    clock = at("2026-07-01T09:10:00Z");
    await inbox.sweepSupervisorInbox();
    expect(sent).toHaveLength(1);
  });

  test("a brief written in quiet hours pushes when they end; a seen one never", async () => {
    await inbox.setSupervisorPrefs("Ada", {
      digestAt: "07:00",
      quietStart: "22:00",
      quietEnd: "07:00",
    });
    clock = at("2026-07-01T07:00:00Z");
    await inbox.sweepSupervisorInbox();
    expect(delivered).toHaveLength(1);
    await inbox.setSupervisorPrefs("Ada", { quietEnd: "08:00" });
    clock = at("2026-07-01T07:05:00Z");
    await brief.writeSupervisorBrief("Ada", { say: "Morning." });
    expect(sent).toHaveLength(0);
    clock = at("2026-07-01T08:00:00Z");
    await inbox.sweepSupervisorInbox();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.event.body).toBe("Nothing to decide");

    // The next day the owner opens it before quiet hours end.
    clock = at("2026-07-02T07:00:00Z");
    await inbox.setSupervisorPrefs("Ada", { quietEnd: "07:00" });
    await inbox.sweepSupervisorInbox();
    await inbox.setSupervisorPrefs("Ada", { quietEnd: "08:00" });
    await brief.writeSupervisorBrief("Ada", { say: "Morning." });
    expect(await brief.markBriefSeen("Ada")).toMatchObject({
      day: "2026-07-02",
      seenAt: clock,
    });
    clock = at("2026-07-02T08:00:00Z");
    await inbox.sweepSupervisorInbox();
    expect(sent).toHaveLength(1);
  });

  test("no supervisor yet, or a turn that wrote nothing: one fallback push when decisions wait", async () => {
    session = null;
    await decision("Ship 1.19.0?", "a");
    await inbox.postSupervisorItem({
      user: "Ada",
      source: "lead:acme",
      kind: "fyi",
      title: "CI repaired",
    });
    clock = at("2026-07-01T09:00:00Z");
    await inbox.sweepSupervisorInbox();
    // A scheduled brief never creates a supervisor.
    expect(delivered).toHaveLength(0);
    expect((await record()).run?.failedAt).toBe(clock);
    clock = at("2026-07-01T09:01:00Z");
    await inbox.sweepSupervisorInbox();
    expect(sent).toHaveLength(1);
    // The updates the digest used to tell are counted too, and kept.
    expect(sent[0]!.event).toMatchObject({
      reason: "Your brief couldn't be put together",
      body: "1 decision and 1 update are waiting.",
      push: { body: "1 decision and 1 update are waiting." },
    });
    expect(JSON.stringify(sent[0]!.event)).not.toContain("CI repaired");
    expect(await record()).toMatchObject({
      fallbackDay: "2026-07-01",
      fallbackCounts: { decisions: 1, updates: 1 },
    });
    expect((await brief.getSupervisorBrief("Ada")).fallback).toEqual({
      day: "2026-07-01",
      decisions: 1,
      updates: 1,
    });
    // The update stays untold for the next brief.
    const [update] = await inbox.listSupervisorItems("Ada", { kind: "fyi" });
    expect(update!.digestedAt).toBeUndefined();
    clock = at("2026-07-01T09:30:00Z");
    await inbox.sweepSupervisorInbox();
    expect(sent).toHaveLength(1);

    // A turn that started but wrote nothing within its time.
    session = "os-sup-ada";
    clock = at("2026-07-02T09:00:00Z");
    await inbox.sweepSupervisorInbox();
    expect(delivered).toHaveLength(1);
    clock = at("2026-07-02T09:19:00Z");
    await inbox.sweepSupervisorInbox();
    expect(sent).toHaveLength(1);
    clock = at("2026-07-02T09:20:00Z");
    await inbox.sweepSupervisorInbox();
    expect(sent).toHaveLength(2);
  });

  test("a fallback with only updates waiting still pushes", async () => {
    session = null;
    await inbox.postSupervisorItem({
      user: "Ada",
      source: "lead:acme",
      kind: "fyi",
      title: "CI repaired",
    });
    clock = at("2026-07-01T09:00:00Z");
    await inbox.sweepSupervisorInbox();
    clock = at("2026-07-01T09:01:00Z");
    await inbox.sweepSupervisorInbox();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.event.body).toBe("0 decisions and 1 update are waiting.");
  });

  test("opening Blob runs the day's turn: preparing, then ready; never in quiet hours", async () => {
    const a = await decision("Ship 1.19.0?", "a");
    clock = at("2026-07-01T03:00:00Z");
    expect(
      await brief.getSupervisorBrief("Ada", { start: true }),
    ).toMatchObject({ state: "none", brief: null });
    expect(delivered).toHaveLength(0);

    clock = at("2026-07-01T08:10:00Z");
    const opened = await brief.getSupervisorBrief("Ada", { start: true });
    expect(opened).toMatchObject({
      state: "preparing",
      brief: null,
      preparingSince: clock,
    });
    // The delivery runs after the answer.
    await Promise.resolve();
    await Promise.resolve();
    expect(delivered).toHaveLength(1);
    // Opening again while it runs starts nothing more.
    await brief.getSupervisorBrief("Ada", { start: true });
    expect(delivered).toHaveLength(1);

    clock = at("2026-07-01T08:12:00Z");
    await brief.writeSupervisorBrief("Ada", {
      say: "Morning.",
      decisions: [{ itemId: a.id, recommended: "Ship it" }],
    });
    // Opened by the owner: no push for it.
    expect(sent).toHaveLength(0);
    const ready = await brief.getSupervisorBrief("Ada", { start: true });
    expect(ready.state).toBe("ready");
    expect(ready.brief!.decisions).toEqual([
      {
        itemId: a.id,
        recommended: "Ship it",
        item: expect.objectContaining({
          id: a.id,
          title: "Ship 1.19.0?",
          options: ["Ship it", "Hold"],
          revision: expect.any(Number),
        }),
      },
    ]);
    // It counted as the day's turn: the digest time starts none.
    clock = at("2026-07-01T09:00:00Z");
    await inbox.sweepSupervisorInbox();
    expect(delivered).toHaveLength(1);
  });

  test("on request at most every 30 minutes", async () => {
    clock = at("2026-07-01T12:00:00Z");
    const first = await brief.startBriefTurn("Ada", "refresh");
    expect(first.started).toBe(true);
    if (first.started) await first.delivered;
    await brief.writeSupervisorBrief("Ada", { say: "Morning." });
    clock = at("2026-07-01T12:29:00Z");
    expect(await brief.startBriefTurn("Ada", "refresh")).toEqual({
      started: false,
      reason: "too-soon",
      retryAt: at("2026-07-01T12:30:00Z"),
    });
    clock = at("2026-07-01T12:30:00Z");
    expect((await brief.startBriefTurn("Ada", "refresh")).started).toBe(true);
  });
});

describe("reading", () => {
  test("the latest brief, closed decisions dropped, new decisions since counted", async () => {
    const a = await decision("Ship 1.19.0?", "a");
    const b = await decision("Merge PR 533?", "b");
    const c = await decision("Raise the budget?", "c");
    await brief.writeSupervisorBrief("Ada", {
      say: "Morning.",
      decisions: [{ itemId: a.id }, { itemId: b.id }],
    });
    await inbox.answerSupervisorItem("Ada", a.id, "1", "owner");
    clock = at("2026-07-02T06:00:00Z"); // quiet: nothing starts
    const later = await decision("Rotate the key?", "d");
    const read = await brief.getSupervisorBrief("Ada", { start: true });
    expect(read.state).toBe("ready");
    expect(read.brief!.day).toBe("2026-07-01");
    expect(read.brief!.decisions.map((d) => d.itemId)).toEqual([b.id]);
    expect(read.brief!.later).toEqual({ count: 1, itemIds: [c.id] });
    expect(read.newSince).toEqual({ count: 1, itemIds: [later.id] });
    expect(read.preparingSince).toBeNull();
  });
});

describe("routes", () => {
  async function call(
    method: string,
    path: string,
    body?: unknown,
    authUser: Record<string, unknown> | null = { login: "ada", name: "Ada" },
  ) {
    const { handleSupervisorRoutes } = await import("./routes/supervisor");
    const url = new URL(`http://localhost${path}`);
    return handleSupervisorRoutes({
      req: new Request(url, {
        method,
        ...(body === undefined
          ? {}
          : {
              body: JSON.stringify(body),
              headers: { "Content-Type": "application/json" },
            }),
      }),
      url,
      path: url.pathname,
      publicPrefix: "/backstage",
      authUser: authUser as never,
    });
  }

  test("only the signed-in person, never a claimed name or an automation", async () => {
    await decision("Ship 1.19.0?", "a");
    for (const path of [
      ["GET", "/api/supervisor/brief?user=Ada&start=1"],
      ["POST", "/api/supervisor/brief/seen"],
      ["POST", "/api/supervisor/brief/refresh"],
    ] as const) {
      // No sign-in: the claimed user is ignored.
      expect(
        (await call(path[0], path[1], { user: "Ada" }, null))?.status,
      ).toBe(401);
      // The automation principal, even with a login and a name.
      expect(
        (
          await call(
            path[0],
            path[1],
            { user: "Ada" },
            { login: "ada", name: "Ada", automation: true },
          )
        )?.status,
      ).toBe(401);
    }
    // Nothing started for anyone.
    expect((await brief.getSupervisorBrief("Ada")).preparingSince).toBeNull();
  });

  test("GET the brief, POST seen and refresh, each for the signed-in owner", async () => {
    const a = await decision("Ship 1.19.0?", "a");
    // A plain GET only reads, whatever user it claims.
    const none = await call("GET", "/api/supervisor/brief?user=Grace");
    expect(none?.status).toBe(200);
    expect(await none!.json()).toMatchObject({
      state: "none",
      brief: null,
      preparingSince: null,
    });
    expect(
      (
        (await (await call(
          "GET",
          "/api/supervisor/brief?start=true",
        ))!.json()) as {
          state: string;
        }
      ).state,
    ).toBe("none");

    // Blob opening sends start=1: the turn starts for the signed-in Ada.
    const started = await call("GET", "/api/supervisor/brief?start=1");
    expect(((await started!.json()) as { state: string }).state).toBe(
      "preparing",
    );
    expect(
      (await call("POST", "/api/supervisor/brief/seen", { user: "Ada" }))
        ?.status,
    ).toBe(404);

    await brief.writeSupervisorBrief("Ada", {
      say: "Morning.",
      decisions: [{ itemId: a.id, recommended: "Hold" }],
    });
    const ready = (await (await call(
      "GET",
      "/api/supervisor/brief",
    ))!.json()) as Awaited<ReturnType<Brief["getSupervisorBrief"]>>;
    expect(ready.state).toBe("ready");
    expect(ready.brief!.decisions[0]!.item.id).toBe(a.id);

    const seen = await call("POST", "/api/supervisor/brief/seen", {
      user: "Grace",
      day: "2026-07-01",
    });
    expect(seen?.status).toBe(200);
    expect(await seen!.json()).toEqual({ seenAt: clock });
    expect(
      (
        await call("POST", "/api/supervisor/brief/seen", {
          user: "Ada",
          day: 7,
        })
      )?.status,
    ).toBe(400);

    // The open turn started at 12:00: a refresh waits 30 minutes.
    const soon = await call("POST", "/api/supervisor/brief/refresh", {
      user: "Ada",
    });
    expect(soon?.status).toBe(429);
    clock += 30 * 60_000;
    const refresh = await call("POST", "/api/supervisor/brief/refresh", {
      user: "Ada",
    });
    expect(refresh?.status).toBe(202);
    expect(await refresh!.json()).toEqual({ state: "preparing" });
  });
});
