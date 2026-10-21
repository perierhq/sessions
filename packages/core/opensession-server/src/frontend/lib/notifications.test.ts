import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { alertsSchema, notificationThreadSchema } from "./api/notifications";
import type { NotificationThread } from "./api/notifications";

const original = {
  Notification: globalThis.Notification,
  window: globalThis.window,
  document: globalThis.document,
  localStorage: globalThis.localStorage,
  fetch: globalThis.fetch,
};

const storage = new Map<string, string>([
  ["opensession-user", "Ada"],
  ["opensession-notif-alerts-migrated", "1"],
]);
let focused = true;
type Banner = { title: string; body?: string; tag?: string; silent?: boolean };
const banners: Banner[] = [];
type Mark = { user: string; ids?: string[]; unread?: boolean };
const marks: Mark[] = [];
let serverThreads: NotificationThread[] = [];

const markSchema = z.object({
  user: z.string(),
  ids: z.array(z.string()).optional(),
  all: z.boolean().optional(),
  unread: z.boolean().optional(),
  done: z.boolean().optional(),
});

class FakeNotification {
  static permission = "granted";
  onclick: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(
    title: string,
    options: { body?: string; tag?: string; silent?: boolean } = {},
  ) {
    banners.push({ title, ...options });
  }
  close() {}
}

const win = Object.assign(new EventTarget(), {
  Notification: FakeNotification,
  focus: () => {},
});
Object.assign(globalThis, {
  Notification: FakeNotification,
  window: win,
  document: Object.assign(new EventTarget(), {
    visibilityState: "visible",
    hasFocus: () => focused,
  }),
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
  fetch: async (input: string, init?: RequestInit) => {
    const path = String(input).split("?")[0];
    if (path === "/api/notifications/mark") {
      marks.push(markSchema.parse(JSON.parse(String(init?.body))));
      return Response.json({ ok: true, changed: 1 });
    }
    return Response.json({
      threads: serverThreads,
      unread: 0,
      alerts: {
        reviews: true,
        mentions: true,
        collaborators: true,
        reminders: true,
      },
    });
  },
});

const store = await import("./notifications");
afterAll(() => Object.assign(globalThis, original));

function thread(
  id: string,
  overrides: Partial<NotificationThread> = {},
): NotificationThread {
  return {
    id: `session:${id}`,
    subject: { type: "session", id, title: `Session ${id}` },
    kind: "review_requested",
    reason: "Sam asked for your review",
    body: "",
    url: `/session/${id}`,
    updatedAt: Date.now(),
    unread: true,
    done: false,
    ...overrides,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

beforeEach(async () => {
  focused = true;
  banners.length = 0;
  marks.length = 0;
  serverThreads = [];
  store.startNotifications(() => {});
  store.refreshNotifications();
  await settle();
});

describe("notification inbox on this device", () => {
  test("news about the session you are looking at is read everywhere", async () => {
    const stop = store.watchSessionNotifications("os-open");
    store.receiveNotification("Ada", thread("os-open"), true);
    await settle();
    expect(store.unreadNotificationCount()).toBe(0);
    // The server hears it too, or the other devices keep it unread.
    expect(marks).toContainEqual({
      user: "Ada",
      ids: ["session:os-open"],
      unread: false,
    });
    expect(banners).toEqual([]);
    stop();
  });

  test("a background window keeps it unread and raises a banner", async () => {
    focused = false;
    const stop = store.watchSessionNotifications("os-open");
    store.receiveNotification("Ada", thread("os-open"), true);
    await settle();
    expect(store.unreadNotificationCount()).toBe(1);
    expect(marks).toEqual([]);
    expect(banners.map((b) => b.title)).toEqual(["Sam asked for your review"]);
    stop();
  });

  test("reconnecting refreshes the list without replaying anything", async () => {
    focused = false;
    serverThreads = [thread("os-1"), thread("os-2")];
    store.refreshNotifications();
    await settle();
    expect(store.unreadNotificationCount()).toBe(2);
    expect(banners).toEqual([]);
  });

  test("switched-off kinds land in the list without a banner", async () => {
    focused = false;
    store.receiveNotification(
      "Ada",
      thread("os-3", { kind: "collaborator", reason: "Sam added you" }),
      false,
    );
    expect(store.unreadNotificationCount()).toBe(1);
    expect(banners).toEqual([]);
  });

  test("frames for somebody else are ignored", () => {
    store.receiveNotification("Grace", thread("os-4"), true);
    expect(store.getNotificationState().threads).toEqual([]);
  });

  test("filters: done rows only show under Done", () => {
    const rows = [
      thread("a", { unread: false, updatedAt: 1 }),
      thread("b", { updatedAt: 2 }),
      thread("c", { done: true, unread: false, updatedAt: 3 }),
    ];
    expect(store.filterThreads(rows, "all").map((t) => t.id)).toEqual([
      "session:b",
      "session:a",
    ]);
    expect(store.filterThreads(rows, "unread").map((t) => t.id)).toEqual([
      "session:b",
    ]);
    expect(store.filterThreads(rows, "done").map((t) => t.id)).toEqual([
      "session:c",
    ]);
  });
});

const incidentThread = (
  over: Partial<NotificationThread> = {},
): NotificationThread => ({
  id: "incident:inc-1",
  subject: { type: "incident", id: "inc-1", title: "Search", context: "acme" },
  kind: "incident_veto",
  reason: "Search is down",
  body: "The fix is verified and deploys at 12:37 unless you stop it",
  url: "/incidents/inc-1",
  updatedAt: 1_000,
  unread: true,
  done: false,
  ...over,
});

describe("incident notifications on this device", () => {
  test("incident rows parse and lead with the project", () => {
    expect(notificationThreadSchema.safeParse(incidentThread()).success).toBe(
      true,
    );
    expect(store.notificationBannerText(incidentThread())).toEqual({
      title: "Search is down",
      body: "acme · The fix is verified and deploys at 12:37 unless you stop it",
    });
    expect(store.notificationRowText(incidentThread())).toEqual({
      title: "Search is down",
      line: "The fix is verified and deploys at 12:37 unless you stop it",
    });
  });

  test("other rows keep their text", () => {
    const row = thread("s1", { reason: "Ada mentioned you", body: "look" });
    expect(store.notificationBannerText(row)).toEqual({
      title: "Ada mentioned you",
      body: "Session s1: look",
    });
    expect(store.notificationRowText(row)).toEqual({
      title: "Session s1",
      line: "Ada mentioned you: look",
    });
  });

  test("a replace frame updates a banner on screen, silently, and never raises a new one", () => {
    focused = false;
    store.receiveNotification(
      "Ada",
      incidentThread({
        kind: "incident_update",
        body: "Deploying the fix now",
      }),
      false,
      true,
    );
    expect(banners).toEqual([]);
    store.receiveNotification("Ada", incidentThread(), true);
    store.receiveNotification(
      "Ada",
      incidentThread({
        kind: "incident_update",
        body: "Deploying the fix now",
        updatedAt: 2_000,
      }),
      false,
      true,
    );
    expect(banners.map((b) => [b.body, b.silent ?? false])).toEqual([
      [
        "acme · The fix is verified and deploys at 12:37 unless you stop it",
        false,
      ],
      ["acme · Deploying the fix now", true],
    ]);
  });

  test("news about the incident on screen is read without a banner", async () => {
    focused = true;
    const stop = store.watchIncidentNotifications("inc-1");
    store.receiveNotification(
      "Ada",
      incidentThread({ updatedAt: 3_000 }),
      true,
    );
    await settle();
    expect(banners).toEqual([]);
    expect(marks.at(-1)).toMatchObject({
      ids: ["incident:inc-1"],
      unread: false,
    });
    stop();
  });

  test("opening the incident during the night reads a held row", async () => {
    focused = true;
    // A held alert arrives quietly; the server marks the row unread.
    store.receiveNotification(
      "Ada",
      incidentThread({ updatedAt: 4_000, unread: true }),
      false,
    );
    await settle();
    expect(banners).toEqual([]);
    marks.length = 0;
    const stop = store.watchIncidentNotifications("inc-1");
    await settle();
    expect(marks.at(-1)).toMatchObject({
      ids: ["incident:inc-1"],
      unread: false,
    });
    stop();
  });

  test("an older server without the incidents switch reads as on", () => {
    expect(
      alertsSchema.parse({
        reviews: true,
        mentions: true,
        collaborators: true,
        reminders: true,
      }).incidents,
    ).toBe(true);
  });
});
