import { describe, expect, test } from "bun:test";
import {
  alertPrefs,
  applyNotificationEvent,
  bannerText,
  cleanDocument,
  INCIDENT_NOTIFICATION_KINDS,
  kindAlertGroup,
  EVENT_DEDUPE_MS,
  markNotificationThreads,
  MAX_THREADS,
  RETENTION_MS,
  shouldAlert,
  SUPPORT_NOTIFICATION_KINDS,
  unreadCount,
  wireThread,
  type NotificationDocument,
  type NotificationEvent,
} from "./notification-threads";

const T0 = 1_800_000_000_000;

function event(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    kind: "review_requested",
    subject: { type: "session", id: "os-1", title: "Fix the login bug" },
    reason: "Sam asked for your review",
    body: "",
    url: "/session/os-1",
    at: T0,
    ...overrides,
  };
}

const empty: NotificationDocument = { threads: [] };

describe("notification threads", () => {
  test("a new event creates an unread thread keyed by its subject", () => {
    const { doc, thread } = applyNotificationEvent(empty, event());
    expect(thread?.id).toBe("session:os-1");
    expect(thread?.unread).toBe(true);
    expect(unreadCount(doc)).toBe(1);
  });

  test("a replayed event key changes nothing, so a restart cannot notify twice", () => {
    const first = applyNotificationEvent(
      empty,
      event({ eventKey: "review:abc" }),
    );
    const read = markNotificationThreads(first.doc, {
      ids: ["session:os-1"],
      unread: false,
    }).doc;
    const replay = applyNotificationEvent(
      read,
      event({ eventKey: "review:abc", at: T0 + 60_000 }),
    );
    expect(replay.thread).toBeNull();
    expect(replay.doc).toBe(read);
    expect(unreadCount(replay.doc)).toBe(0);
  });

  test("the same key notifies again once the dedupe window has passed", () => {
    const first = applyNotificationEvent(
      empty,
      event({ eventKey: "review:abc" }),
    );
    const later = applyNotificationEvent(
      first.doc,
      event({ eventKey: "review:abc", at: T0 + EVENT_DEDUPE_MS + 1 }),
    );
    expect(later.thread).not.toBeNull();
  });

  test("a second event on a subject bumps the one row instead of adding one", () => {
    let doc = applyNotificationEvent(empty, event()).doc;
    doc = applyNotificationEvent(
      doc,
      event({
        subject: { type: "session", id: "os-2", title: "Other" },
        at: T0 + 1,
      }),
    ).doc;
    doc = markNotificationThreads(doc, { all: true, done: true }).doc;
    const bumped = applyNotificationEvent(
      doc,
      event({ reason: "Alex asked for your review", at: T0 + 2 }),
    );
    expect(bumped.doc.threads.map((t) => t.id)).toEqual([
      "session:os-1",
      "session:os-2",
    ]);
    expect(bumped.thread).toMatchObject({
      reason: "Alex asked for your review",
      unread: true,
      done: false,
    });
  });

  test("done implies read and marks count what changed", () => {
    const doc = applyNotificationEvent(empty, event()).doc;
    const done = markNotificationThreads(doc, {
      ids: ["session:os-1"],
      done: true,
    });
    expect(done.changed).toBe(1);
    expect(done.doc.threads[0]).toMatchObject({ unread: false, done: true });
    expect(
      markNotificationThreads(done.doc, { ids: ["session:os-1"], done: true })
        .changed,
    ).toBe(0);
  });

  test("old threads are pruned and the inbox is capped", () => {
    let doc = applyNotificationEvent(empty, event()).doc;
    doc = applyNotificationEvent(
      doc,
      event({
        subject: { type: "session", id: "os-new", title: "New" },
        at: T0 + RETENTION_MS,
      }),
    ).doc;
    expect(doc.threads.map((t) => t.id)).toEqual(["session:os-new"]);
    for (let i = 0; i < MAX_THREADS + 5; i++)
      doc = applyNotificationEvent(
        doc,
        event({
          subject: { type: "session", id: `os-${i}`, title: `${i}` },
          at: T0 + RETENTION_MS + i,
        }),
      ).doc;
    expect(doc.threads).toHaveLength(MAX_THREADS);
  });

  test("alerts follow the person's settings", () => {
    expect(shouldAlert(null, "review_requested")).toBe(true);
    expect(shouldAlert(null, "collaborator")).toBe(true);
    expect(shouldAlert(null, "mention")).toBe(true);
    expect(shouldAlert(null, "reminder")).toBe(true);
    expect(
      shouldAlert({ threads: [], alerts: { reviews: false } }, "review_done"),
    ).toBe(false);
    // Team requests (code owners) switch off apart from requests by name.
    expect(shouldAlert(null, "team_review_requested")).toBe(true);
    expect(
      shouldAlert(
        { threads: [], alerts: { teamReviews: false } },
        "team_review_requested",
      ),
    ).toBe(false);
    expect(
      shouldAlert(
        { threads: [], alerts: { teamReviews: false } },
        "review_requested",
      ),
    ).toBe(true);
    expect(
      shouldAlert(
        { threads: [], alerts: { collaborators: false } },
        "collaborator",
      ),
    ).toBe(false);
  });

  test("agent rows stored before they were removed are dropped", () => {
    const { doc } = applyNotificationEvent(empty, event());
    const stored = JSON.parse(JSON.stringify(doc));
    for (const kind of ["needs_input", "run_failed", "run_finished"])
      stored.threads.push({
        ...stored.threads[0],
        id: `session:${kind}`,
        kind,
        subject: { ...stored.threads[0].subject, id: kind },
      });
    stored.alerts = { needsInput: false, done: true };
    expect(cleanDocument(stored)).toEqual({ threads: doc.threads });
  });

  test("stored documents are cleaned and the wire form hides event keys", () => {
    const { doc } = applyNotificationEvent(empty, event({ eventKey: "k" }));
    const round = cleanDocument(JSON.parse(JSON.stringify(doc)));
    expect(round.threads[0].events).toHaveLength(1);
    expect("events" in wireThread(round.threads[0])).toBe(false);
    expect(
      cleanDocument({ threads: [{ id: "x", subject: { type: "nope" } }, 3] }),
    ).toEqual({ threads: [] });
  });
});

const IT0 = 1_760_950_000_000;
const MIN = 60_000;
const incidentEvent = (
  over: Partial<NotificationEvent> = {},
): NotificationEvent => ({
  kind: "incident_veto",
  subject: { type: "incident", id: "inc-1", title: "Search", context: "acme" },
  reason: "Search is down",
  body: "The fix is verified and deploys at 12:37 unless you stop it",
  url: "/incidents/inc-1",
  eventKey: "evt-1",
  at: IT0,
  ...over,
});
const apply = (
  doc: NotificationDocument,
  over: Partial<NotificationEvent> = {},
) => applyNotificationEvent(doc, incidentEvent(over));

describe("incident notifications", () => {
  test("every incident kind alerts under the incidents group, on by default", () => {
    for (const kind of INCIDENT_NOTIFICATION_KINDS)
      expect(kindAlertGroup(kind)).toBe("incidents");
    expect(alertPrefs(null).incidents).toBe(true);
  });

  test("alert is the default and is remembered", () => {
    const r = apply({ threads: [] });
    expect(r.delivery).toBe("alert");
    expect(r.thread).toMatchObject({
      id: "incident:inc-1",
      unread: true,
      alerted: [{ key: "incident_veto", at: IT0 }],
    });
  });

  test("quiet updates the row in place and keeps it read", () => {
    const first = apply({ threads: [] }).doc;
    const read = markNotificationThreads(first, {
      ids: ["incident:inc-1"],
      unread: false,
    }).doc;
    const r = apply(read, {
      kind: "incident_update",
      delivery: "quiet",
      eventKey: "evt-2",
      reason: "Search is down",
      body: "Deploying the fix now",
      at: IT0 + MIN,
    });
    expect(r.delivery).toBe("quiet");
    expect(r.thread).toMatchObject({
      unread: false,
      body: "Deploying the fix now",
      kind: "incident_update",
      updatedAt: IT0 + MIN,
    });
    expect(r.doc.threads).toHaveLength(1);
    expect(apply({ threads: [] }, { delivery: "quiet" }).thread?.unread).toBe(
      true,
    );
  });

  test("replace needs an alert in the last 12 hours", () => {
    const alerted = apply({ threads: [] }).doc;
    expect(
      apply(alerted, {
        delivery: "replace",
        eventKey: "evt-2",
        at: IT0 + 60 * MIN,
      }).delivery,
    ).toBe("replace");
    expect(
      apply(alerted, {
        delivery: "replace",
        eventKey: "evt-2",
        at: IT0 + 13 * 60 * MIN,
      }).delivery,
    ).toBe("quiet");
    expect(apply({ threads: [] }, { delivery: "replace" }).delivery).toBe(
      "quiet",
    );
  });

  test("a repeat alert inside the cooldown becomes a replace", () => {
    const cooldown = { key: "incident_opened", ms: 15 * MIN };
    const first = apply(
      { threads: [] },
      { kind: "incident_opened", cooldown },
    ).doc;
    expect(
      apply(first, {
        kind: "incident_opened",
        cooldown,
        eventKey: "evt-2",
        at: IT0 + 5 * MIN,
      }).delivery,
    ).toBe("replace");
    expect(
      apply(first, {
        kind: "incident_opened",
        cooldown,
        eventKey: "evt-2",
        at: IT0 + 16 * MIN,
      }).delivery,
    ).toBe("alert");
  });

  test("hold keeps it quiet until one flush alerts", () => {
    const held = apply({ threads: [] }, { hold: true });
    expect(held.delivery).toBe("quiet");
    expect(held.thread?.heldAt).toBe(IT0);
    const flushed = apply(held.doc, {
      flushHeld: true,
      eventKey: "flush-1",
      at: IT0 + 8 * 60 * MIN,
    });
    expect(flushed.delivery).toBe("alert");
    expect(flushed.thread?.heldAt).toBeUndefined();
    expect(
      apply(flushed.doc, { flushHeld: true, eventKey: "flush-2" }).thread,
    ).toBeNull();
    expect(apply({ threads: [] }, { flushHeld: true }).thread).toBeNull();
  });

  test("reading a held row cancels its flush", () => {
    const held = apply({ threads: [] }, { hold: true }).doc;
    const read = markNotificationThreads(held, {
      ids: ["incident:inc-1"],
      unread: false,
    }).doc;
    expect(read.threads[0].heldAt).toBeUndefined();
    expect(
      apply(read, { flushHeld: true, eventKey: "flush-1" }).thread,
    ).toBeNull();
  });

  test("a hold on a read row marks it unread, so viewing it cancels the flush", () => {
    const alerted = apply({ threads: [] }).doc;
    const read = markNotificationThreads(alerted, {
      ids: ["incident:inc-1"],
      unread: false,
      done: true,
    }).doc;
    const held = apply(read, { hold: true, eventKey: "evt-2", at: IT0 + MIN });
    expect(held.delivery).toBe("quiet");
    expect(held.thread).toMatchObject({ unread: true, done: false });
    expect(unreadCount(held.doc)).toBe(1);
    // The incident page on screen during the night sends the read mark.
    const viewed = markNotificationThreads(held.doc, {
      ids: ["incident:inc-1"],
      unread: false,
    });
    expect(viewed.changed).toBe(1);
    expect(viewed.doc.threads[0].heldAt).toBeUndefined();
    expect(
      apply(viewed.doc, {
        flushHeld: true,
        eventKey: "flush-1",
        at: IT0 + 8 * 60 * MIN,
      }).thread,
    ).toBeNull();
  });

  test("clearHeld drops a pending hold without alerting", () => {
    const held = apply({ threads: [] }, { hold: true }).doc;
    const cleared = apply(held, {
      delivery: "quiet",
      clearHeld: true,
      eventKey: "evt-2",
      at: IT0 + MIN,
    });
    expect(cleared.delivery).toBe("quiet");
    expect(cleared.thread?.heldAt).toBeUndefined();
    expect(
      apply(cleared.doc, { flushHeld: true, eventKey: "flush-1" }).thread,
    ).toBeNull();
  });

  test("incident rows survive a clean; the wire shape hides delivery state", () => {
    const stored = apply({ threads: [] }, { hold: true }).doc;
    const cleaned = cleanDocument(JSON.parse(JSON.stringify(stored)));
    expect(cleaned.threads[0]).toMatchObject({
      subject: { type: "incident", id: "inc-1" },
      heldAt: IT0,
    });
    const wire = wireThread(cleaned.threads[0]);
    expect(wire).not.toHaveProperty("heldAt");
    expect(wire).not.toHaveProperty("alerted");
    expect(wire).not.toHaveProperty("events");
  });

  test("banner text leads incidents with the project", () => {
    const thread = apply({ threads: [] }).thread!;
    expect(bannerText(thread)).toEqual({
      title: "Search is down",
      body: "acme · The fix is verified and deploys at 12:37 unless you stop it",
    });
    expect(
      bannerText({
        subject: { type: "session", id: "s1", title: "Fix login" },
        reason: "Ada mentioned you",
        body: "look",
      }),
    ).toEqual({ title: "Ada mentioned you", body: "Fix login: look" });
  });
});

describe("support notifications", () => {
  test("every support kind alerts under the support group", () => {
    expect(kindAlertGroup("support_veto")).toBe("support");
    for (const kind of SUPPORT_NOTIFICATION_KINDS)
      expect(kindAlertGroup(kind)).toBe("support");
  });

  test("a stored document without the support switch reads as on", () => {
    const stored = cleanDocument({
      threads: [],
      alerts: { reviews: false, incidents: true },
    });
    expect(alertPrefs(stored).support).toBe(true);
    expect(alertPrefs(stored).reviews).toBe(false);
    expect(alertPrefs(null).support).toBe(true);
  });

  test("support rows survive a round trip and lead the banner with the project", () => {
    const doc: NotificationDocument = { threads: [] };
    const r = applyNotificationEvent(
      doc,
      event({
        kind: "support_needs_you",
        subject: {
          type: "support",
          id: "sc_1",
          title: "A support reply is ready",
          context: "acme",
        },
        reason: "Drafts wait for a person",
        body: "Open Sessions to read it and send",
        url: "/support/email:sc_1",
      }),
    );
    const round = cleanDocument(JSON.parse(JSON.stringify(r.doc)));
    expect(round.threads.map((t) => t.id)).toEqual(["support:sc_1"]);
    expect(bannerText(round.threads[0])).toEqual({
      title: "A support reply is ready",
      body: "acme · Open Sessions to read it and send",
    });
  });

  test("an existing-only event updates a row but never opens one", () => {
    const settle = event({
      kind: "support_needs_you",
      subject: {
        type: "support",
        id: "sc_1",
        title: "Reply sent",
        context: "acme",
      },
      reason: "Nothing waits on you",
      body: "Nothing waits on you",
      url: "/support/email:sc_1",
      delivery: "replace",
      existingOnly: true,
    });
    const none = applyNotificationEvent(empty, settle);
    expect(none.thread).toBeNull();
    expect(none.doc).toBe(empty);
    const opened = applyNotificationEvent(
      empty,
      event({
        kind: "support_veto",
        subject: {
          type: "support",
          id: "sc_1",
          title: "A support reply will send",
        },
        reason: "Sends when the window ends unless someone stops it",
        url: "/support/email:sc_1",
      }),
    );
    const settled = applyNotificationEvent(opened.doc, {
      ...settle,
      at: T0 + 60_000,
    });
    expect(settled.delivery).toBe("replace");
    expect(settled.thread?.subject.title).toBe("Reply sent");
    expect(settled.thread?.unread).toBe(true);
  });
});
