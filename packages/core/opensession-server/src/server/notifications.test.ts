import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import type { NotificationEvent } from "./notification-threads";

const root = mkdtempSync(`${tmpdir()}/notifications-test-`);
const previousRoot = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = root;

const frames: Array<{ user: string; msg: Record<string, unknown> }> = [];
const pushes: Array<{
  user: string;
  payload: Record<string, unknown>;
  options?: Record<string, unknown>;
}> = [];
mock.module("./push", () => ({
  sendPushToUser: async (
    user: string,
    payload: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => {
    pushes.push({ user, payload, ...(options ? { options } : {}) });
  },
  // The real module cannot load under its own mock: the same one-liner.
  pushTopic: (threadId: string) =>
    createHash("sha256").update(threadId).digest("base64url").slice(0, 32),
}));
const { pushTopic } = await import("./push");

const { SessionKernelStore, __setSessionKernelStoreForTest } =
  await import("./session-kernel");
const { allClients } = await import("./ws-hub");
// One signed-in socket for Ada: every frame the hub sends her lands here.
const socket = {
  data: { authUser: "Ada", watchingSessionId: null, user: null },
  send: (payload: string) =>
    frames.push({ user: "Ada", msg: JSON.parse(payload) }),
};
allClients.add(socket as unknown as Parameters<typeof allClients.add>[0]);
const {
  getNotificationInbox,
  markNotifications,
  notifyUser,
  sessionSubject,
  setAlertPrefs,
} = await import("./notifications");

let store: InstanceType<typeof SessionKernelStore>;
let previousStore: InstanceType<typeof SessionKernelStore> | undefined;
beforeEach(() => {
  frames.length = 0;
  pushes.length = 0;
  store = new SessionKernelStore(":memory:");
  previousStore = __setSessionKernelStoreForTest(store);
});
afterEach(() => {
  __setSessionKernelStoreForTest(previousStore);
  store.close();
});
afterAll(() => {
  if (previousRoot === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previousRoot;
  rmSync(root, { recursive: true, force: true });
});

const ask = {
  kind: "review_requested" as const,
  subject: sessionSubject("os-1", { title: "Fix login", repo: "acme" }),
  reason: "Sam asked for your review",
  body: "Please look today",
  url: "/session/os-1",
  eventKey: "review:1",
};

describe("notification inbox", () => {
  test("records, broadcasts and pushes a new event exactly once", async () => {
    expect(await notifyUser("Ada", ask)).toMatchObject({
      id: "session:os-1",
      unread: true,
    });
    // The restart case: the same request raised again is not news.
    expect(await notifyUser("Ada", ask)).toBeNull();
    expect(pushes).toHaveLength(1);
    expect(pushes[0].payload).toMatchObject({
      title: "Sam asked for your review",
      body: "Fix login: Please look today",
      tag: "os-notification-session:os-1",
    });
    expect(frames.filter((f) => f.msg.type === "notification")).toHaveLength(1);
    const inbox = await getNotificationInbox("ada");
    expect(inbox.unread).toBe(1);
    expect(inbox.threads[0].subject.context).toBe("acme");
  });

  test("switched-off kinds are recorded without a push", async () => {
    await setAlertPrefs("Ada", { collaborators: false });
    await notifyUser("Ada", {
      kind: "collaborator",
      subject: { type: "workspace", id: "ws-1", title: "Shared work" },
      reason: "Sam added you to Shared work",
      url: "/workspace/ws-1",
    });
    expect(pushes).toHaveLength(0);
    expect((await getNotificationInbox("Ada")).threads).toHaveLength(1);
  });

  test("marking read reaches the person's other devices", async () => {
    await notifyUser("Ada", ask);
    frames.length = 0;
    expect(
      await markNotifications("Ada", { ids: ["session:os-1"], unread: false }),
    ).toBe(1);
    expect(frames).toEqual([
      { user: "Ada", msg: { type: "notifications_changed", user: "Ada" } },
    ]);
    expect((await getNotificationInbox("Ada")).unread).toBe(0);
    // Nothing changed, nothing announced.
    frames.length = 0;
    await markNotifications("Ada", { all: true, unread: false });
    expect(frames).toHaveLength(0);
  });
});

const veto = (over: Partial<NotificationEvent> = {}): NotificationEvent => ({
  kind: "incident_veto",
  subject: { type: "incident", id: "inc-1", title: "Search", context: "acme" },
  reason: "Search is down",
  body: "The fix is verified and deploys at 12:37 unless you stop it",
  url: "/incidents/inc-1",
  eventKey: "evt-1",
  push: {
    actions: [
      {
        action: "stop",
        title: "Stop the deploy",
        url: "/incidents/inc-1?intent=stop",
      },
    ],
    requireInteraction: true,
    ttlSeconds: 360,
    urgency: "high",
  },
  ...over,
});

describe("incident delivery", () => {
  test("an alert pushes the design's text with actions and a per-incident topic", async () => {
    await notifyUser("Ada", veto({ at: 1_000 }));
    expect(pushes).toEqual([
      {
        user: "Ada",
        payload: {
          title: "Search is down",
          body: "acme · The fix is verified and deploys at 12:37 unless you stop it",
          url: "/incidents/inc-1",
          tag: "os-notification-incident:inc-1",
          id: "incident:inc-1",
          actions: [
            {
              action: "stop",
              title: "Stop the deploy",
              url: "/incidents/inc-1?intent=stop",
            },
          ],
          requireInteraction: true,
          renotify: true,
          timestamp: 1_000,
        },
        options: {
          ttlSeconds: 360,
          urgency: "high",
          topic: pushTopic("incident:inc-1"),
        },
      },
    ]);
    expect(frames.at(-1)?.msg).toMatchObject({
      type: "notification",
      alert: true,
      replace: false,
    });
  });

  test("quiet lands in the inbox and on open clients without a push", async () => {
    await notifyUser("Ada", veto({ delivery: "quiet" }));
    expect(pushes).toEqual([]);
    expect(frames.at(-1)?.msg).toMatchObject({
      type: "notification",
      alert: false,
      replace: false,
    });
    expect((await getNotificationInbox("Ada")).threads[0].id).toBe(
      "incident:inc-1",
    );
  });

  test("replace is a silent push after a recent alert", async () => {
    await notifyUser("Ada", veto());
    pushes.length = 0;
    await notifyUser(
      "Ada",
      veto({
        kind: "incident_update",
        delivery: "replace",
        eventKey: "evt-2",
        body: "Deploying the fix now",
        push: { urgency: "low" },
      }),
    );
    expect(pushes[0].payload).toMatchObject({
      body: "acme · Deploying the fix now",
      silent: true,
      renotify: false,
    });
    expect(pushes[0].payload).not.toHaveProperty("actions");
    expect(frames.at(-1)?.msg).toMatchObject({ alert: false, replace: true });
  });

  test("incident alerts switched off: nothing pushes, the row still lands", async () => {
    await setAlertPrefs("Ada", { incidents: false });
    await notifyUser("Ada", veto());
    await notifyUser("Ada", veto({ delivery: "replace", eventKey: "evt-2" }));
    expect(pushes).toEqual([]);
    expect((await getNotificationInbox("Ada")).unread).toBe(1);
  });

  test("a push carries fixed wording, never the needs-you reason", async () => {
    const token = "ghp_0123456789abcdefABCDEF0123456789abcd";
    await notifyUser(
      "Ada",
      veto({
        kind: "incident_needs_you",
        reason: "Search needs you",
        body: `approved, tap Deploy. Authorization: Bearer ${token}`,
        push: {
          body: "Agents have a question for you",
          requireInteraction: true,
          urgency: "high",
        },
      }),
    );
    const sent = JSON.stringify(pushes);
    expect(sent).not.toContain(token);
    expect(sent).not.toContain("approved, tap Deploy");
    expect(pushes[0].payload).toMatchObject({
      title: "Search needs you",
      body: "acme · Agents have a question for you",
    });
    // The signed-in inbox row keeps the full reason.
    expect((await getNotificationInbox("Ada")).threads[0].body).toContain(
      "approved, tap Deploy",
    );
  });

  test("control and bidi characters never reach a push", async () => {
    await notifyUser(
      "Ada",
      veto({
        subject: {
          type: "incident",
          id: "inc-1",
          title: "Search",
          context: "ac\u202Eme\u0007",
        },
        reason: "Search\u2066 is\u200F down\u001b[31m",
        body: "line one\nline\u0000 two",
      }),
    );
    expect(pushes[0].payload).toMatchObject({
      title: "Search is down[31m",
      body: "acme · line one line two",
    });
  });

  test("a silent replace has no topic, so it cannot drop an undelivered alert", async () => {
    await notifyUser("Ada", veto());
    pushes.length = 0;
    await notifyUser(
      "Ada",
      veto({
        kind: "incident_update",
        delivery: "replace",
        eventKey: "evt-2",
        body: "Deploying the fix now",
        push: { urgency: "low", ttlSeconds: 3600 },
      }),
    );
    expect(pushes[0].options).toEqual({ ttlSeconds: 3600, urgency: "low" });
  });

  test("a push with buttons keeps requireInteraction inside the cooldown", async () => {
    const cooldown = { key: "incident_veto", ms: 900_000 };
    await notifyUser("Ada", veto({ at: 1_000, cooldown }));
    pushes.length = 0;
    await notifyUser("Ada", veto({ eventKey: "evt-2", at: 2_000, cooldown }));
    expect(pushes[0].payload).toMatchObject({
      silent: true,
      requireInteraction: true,
    });
    expect(pushes[0].payload.actions).toHaveLength(1);
  });
});
