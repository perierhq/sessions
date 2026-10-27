import { beforeEach, expect, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import type { IncidentResponse } from "../../shared/incident-response";
import type { Incident, IncidentState } from "../../shared/incidents";
import type { NotificationEvent } from "../notification-threads";
import type { PushPayload } from "../push";
import { useIncidentTestKernel } from "./testing/kernel-fixture";

const pushes: Array<{ user: string; payload: PushPayload }> = [];
mock.module("../push", () => ({
  sendPushToUser: async (user: string, payload: PushPayload) => {
    pushes.push({ user, payload });
  },
  pushTopic: (threadId: string) =>
    createHash("sha256").update(threadId).digest("base64url").slice(0, 32),
}));

const { getNotificationInbox, notifyUser } = await import("../notifications");
const { createIncident, updateIncident } = await import("./incident-store");
const { transitionIncident } = await import("./lifecycle");
const { __setOwnerRosterForTest } = await import("./owner");
const {
  __resetIncidentNotifierForTest,
  incidentNotificationsSettled,
  startIncidentNotifications,
  sweepHeldIncidents,
} = await import("./notifier");
type NotifierDeps = import("./notifier").NotifierDeps;

useIncidentTestKernel();
let clock = Date.parse("2026-10-20T10:31:00Z");
let night = false;
const deps: NotifierDeps = {
  facts: async () => ({
    signal: "failing",
    night,
    fullyDown: false,
    timeZone: "UTC",
    change: { kind: "deploy" },
  }),
  notify: (user: string, event: NotificationEvent) => notifyUser(user, event),
  now: () => clock,
};
beforeEach(() => {
  __resetIncidentNotifierForTest();
  pushes.length = 0;
  night = false;
  clock = Date.parse("2026-10-20T10:31:00Z");
  startIncidentNotifications(deps);
});

const open = (owner = "Ada") =>
  createIncident({
    project: "acme",
    title: "Search",
    state: "investigating",
    severity: "major",
    owner,
    openedBy: { kind: "rule", ref: "sig-a" },
    signalIds: ["sig-a"],
    primarySignalId: "sig-a",
    at: new Date(clock).toISOString(),
    detail: "3 failures in a row",
  });
const move = (
  id: string,
  to: IncidentState,
  patch: Partial<Incident> = {},
  by = "sessions",
) =>
  updateIncident(id, (c) =>
    transitionIncident({ ...c, ...patch }, to, {
      by,
      detail: "",
      at: new Date(clock).toISOString(),
    }),
  );
const settle = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await incidentNotificationsSettled();
};

test("open, veto and deploy: one alert each, then a silent replace", async () => {
  const i = await open();
  await move(i.id, "fix-ready");
  await move(i.id, "veto", {
    response: {
      next: { kind: "veto", deadline: "2026-10-20T12:37:00.000Z", rule: "" },
    } as IncidentResponse,
  });
  await move(i.id, "deploying");
  await settle();
  expect(
    pushes.map((p) => [
      p.payload.title,
      p.payload.body,
      p.payload.silent ?? false,
    ]),
  ).toEqual([
    ["Search is down", "acme · Agents are investigating", false],
    ["Search is down", "acme · A verified fix is ready", true],
    [
      "Search is down",
      "acme · The fix is verified and deploys at 12:37 unless you stop it",
      false,
    ],
    ["Search is down", "acme · Deploying the fix now", true],
  ]);
  expect(pushes[2].payload.actions?.map((a) => a.title)).toEqual([
    "Stop the deploy",
    "Deploy now",
    "Open",
  ]);
  const inbox = await getNotificationInbox("Ada");
  expect(inbox.threads).toHaveLength(1);
  expect(inbox.threads[0]).toMatchObject({
    id: `incident:${i.id}`,
    kind: "incident_update",
    body: "Deploying the fix now",
  });
});

test("back-to-back commits end on the newest state", async () => {
  let slow = true;
  __resetIncidentNotifierForTest();
  startIncidentNotifications({
    ...deps,
    // The first change's facts arrive last: order must still hold.
    facts: async (incident, now) => {
      if (slow && incident.state === "investigating") {
        slow = false;
        await new Promise((r) => setTimeout(r, 15));
      }
      return deps.facts(incident, now);
    },
  });
  const i = await open();
  await move(i.id, "fix-ready");
  await settle();
  expect(pushes.map((p) => p.payload.body)).toEqual([
    "acme · Agents are investigating",
    "acme · A verified fix is ready",
  ]);
  expect((await getNotificationInbox("Ada")).threads[0].body).toBe(
    "A verified fix is ready",
  );
});

test("a night holds the push; the first sweep after it sends one", async () => {
  night = true;
  const i = await open();
  await move(i.id, "needs-you", {
    response: {
      next: {
        kind: "needs-you",
        reason: "Retry?",
        needsYou: "agent-error",
        options: ["retry"],
      },
    } as IncidentResponse,
  });
  await settle();
  expect(pushes).toEqual([]);
  expect(await sweepHeldIncidents(deps)).toBe(0);
  night = false;
  clock += 8 * 3_600_000;
  expect(await sweepHeldIncidents(deps)).toBe(1);
  expect(pushes.map((p) => p.payload.title)).toEqual(["Search needs you"]);
  expect(pushes[0].payload.actions?.map((a) => a.title)).toEqual([
    "Try again",
    "Open",
  ]);
  expect(await sweepHeldIncidents(deps)).toBe(0);
});

test("a failed flush stays held for the next sweep; a sent one leaves", async () => {
  night = true;
  await open();
  await settle();
  night = false;
  clock += 8 * 3_600_000;
  let fail = true;
  let calls = 0;
  const flaky: NotifierDeps = {
    ...deps,
    notify: async (user, event) => {
      calls++;
      if (fail) throw new Error("catalog unavailable");
      return notifyUser(user, event);
    },
  };
  expect(await sweepHeldIncidents(flaky)).toBe(0);
  expect(pushes).toEqual([]);
  fail = false;
  expect(await sweepHeldIncidents(flaky)).toBe(1);
  expect(pushes).toHaveLength(1);
  expect(await sweepHeldIncidents(flaky)).toBe(0);
  expect(calls).toBe(2);
});

test("a flush that fails to load its facts stays held", async () => {
  night = true;
  await open();
  await settle();
  night = false;
  let fail = true;
  const flaky: NotifierDeps = {
    ...deps,
    facts: async (incident, now) => {
      if (fail) throw new Error("settings unavailable");
      return deps.facts(incident, now);
    },
  };
  expect(await sweepHeldIncidents(flaky)).toBe(0);
  fail = false;
  expect(await sweepHeldIncidents(flaky)).toBe(1);
});

test("a row read during the night is not alerted after it", async () => {
  night = true;
  const i = await open();
  await settle();
  const { markNotifications } = await import("../notifications");
  await markNotifications("Ada", { ids: [`incident:${i.id}`], unread: false });
  night = false;
  expect(await sweepHeldIncidents(deps)).toBe(0);
  expect(pushes).toEqual([]);
});

test("a failing notifier never breaks the incident flow", async () => {
  __resetIncidentNotifierForTest();
  startIncidentNotifications({
    ...deps,
    facts: async () => {
      throw new Error("boom");
    },
  });
  const i = await open();
  expect(await move(i.id, "fix-ready")).toMatchObject({ state: "fix-ready" });
  await settle();
  expect(pushes).toEqual([]);
});

test("a change to the findings alone loads no facts", async () => {
  __resetIncidentNotifierForTest();
  let loaded = 0;
  startIncidentNotifications({
    ...deps,
    facts: async (incident, now) => {
      loaded += 1;
      return deps.facts(incident, now);
    },
  });
  const i = await open();
  await move(i.id, "fix-ready", {
    response: { round: 1, agents: [] } as unknown as IncidentResponse,
  });
  await settle();
  const before = loaded;
  expect(before).toBeGreaterThan(0);
  await updateIncident(i.id, (c) => {
    if (c.response) c.response.findingSets = [];
    c.updatedAt = new Date(clock + 1000).toISOString();
    return c;
  });
  await settle();
  expect(loaded).toBe(before);
});

test("idempotent start subscribes once", async () => {
  startIncidentNotifications(deps);
  await open();
  await settle();
  expect(pushes).toHaveLength(1);
});

test("an incident nobody can be told about goes to the instance owner", async () => {
  __setOwnerRosterForTest([{ name: "Bo Diddley" }, { name: "Ada Lovelace" }]);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await open("Automation");
    await open("");
    await settle();
    expect(pushes.map((p) => p.user)).toEqual(["Bo", "Bo"]);
    expect((await getNotificationInbox("Bo")).threads).toHaveLength(2);
    expect((await getNotificationInbox("Automation")).threads).toEqual([]);
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringContaining("no person to tell"),
      expect.stringContaining("no person to tell"),
    ]);
  } finally {
    warn.mockRestore();
    __setOwnerRosterForTest(undefined);
  }
});

test("a held alert for an incident nobody owns goes to the instance owner", async () => {
  __setOwnerRosterForTest([{ name: "Bo Diddley" }]);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    night = true;
    await open("Automation");
    await settle();
    expect(pushes).toEqual([]);
    // Still night: the alert stays held, sweep after sweep.
    expect(await sweepHeldIncidents(deps)).toBe(0);
    expect(await sweepHeldIncidents(deps)).toBe(0);
    night = false;
    expect(await sweepHeldIncidents(deps)).toBe(1);
    expect(pushes.map((p) => p.user)).toEqual(["Bo"]);
    // The fallback is logged once for the incident, not on every sweep.
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringContaining("no person to tell"),
    ]);
  } finally {
    warn.mockRestore();
    __setOwnerRosterForTest(undefined);
  }
});

test("with no instance owner either, nothing is written and it is logged", async () => {
  __setOwnerRosterForTest([]);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await open("Automation");
    await settle();
    expect(pushes).toEqual([]);
    expect((await getNotificationInbox("Automation")).threads).toEqual([]);
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringContaining("no person to tell"),
    ]);
  } finally {
    warn.mockRestore();
    __setOwnerRosterForTest(undefined);
  }
});
