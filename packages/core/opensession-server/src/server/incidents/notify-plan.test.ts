import { expect, test } from "bun:test";
import type { IncidentResponse } from "../../shared/incident-response";
import type {
  Incident,
  IncidentEvent,
  IncidentState,
} from "../../shared/incidents";
import {
  type NotifyFacts,
  planHeldFlush,
  planIncidentNotification,
} from "./notify-plan";

const NOW = Date.parse("2026-10-20T10:31:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const facts = (over: Partial<NotifyFacts> = {}): NotifyFacts => ({
  signal: "failing",
  night: false,
  fullyDown: false,
  timeZone: "Europe/Warsaw",
  change: { kind: "deploy" },
  ...over,
});
let n = 0;
const ev = (
  to: IncidentState,
  from?: IncidentState,
  by = "sessions",
  kind: IncidentEvent["kind"] = from ? "state" : "opened",
): IncidentEvent => ({
  id: `evt-${++n}`,
  at: iso(NOW),
  kind,
  by,
  detail: "",
  to,
  ...(from ? { from } : {}),
});
const inc = (
  state: IncidentState,
  events: IncidentEvent[],
  over: Partial<Incident> = {},
): Incident => ({
  id: "inc-1",
  project: "acme",
  title: "Search",
  state,
  severity: "major",
  owner: "Ada",
  openedBy: { kind: "rule", ref: "sig-a" },
  signalIds: ["sig-a"],
  primarySignalId: "sig-a",
  openedAt: iso(NOW),
  updatedAt: iso(NOW),
  lastProblemAt: iso(NOW),
  findings: [],
  events,
  droppedEvents: 0,
  ...over,
});
const vetoResponse = {
  next: {
    kind: "veto",
    deadline: "2026-10-20T10:37:00.000Z",
    rule: "Deploy after veto, from the project settings",
  },
} as IncidentResponse;
const step = (
  prev: Incident,
  to: IncidentState,
  by = "sessions",
  over: Partial<Incident> = {},
) => inc(to, [...prev.events, ev(to, prev.state, by)], over);

test("the design's lock-screen notification", () => {
  const prev = inc("fix-ready", [ev("investigating")]);
  const next = step(prev, "veto", "sessions", { response: vetoResponse });
  expect(planIncidentNotification(next, prev, facts(), NOW)).toEqual({
    user: "Ada",
    event: {
      kind: "incident_veto",
      subject: {
        type: "incident",
        id: "inc-1",
        title: "Search",
        context: "acme",
      },
      reason: "Search is down",
      body: "The fix is verified and deploys at 12:37 unless you stop it",
      url: "/incidents/inc-1",
      eventKey: next.events.at(-1)!.id,
      at: NOW,
      delivery: "alert",
      cooldown: { key: "incident_veto", ms: 900_000 },
      push: {
        actions: [
          {
            action: "stop",
            title: "Stop the deploy",
            url: "/incidents/inc-1?intent=stop",
          },
          {
            action: "deploy-now",
            title: "Deploy now",
            url: "/incidents/inc-1?intent=deploy-now",
          },
          { action: "open", title: "Open", url: "/incidents/inc-1" },
        ],
        requireInteraction: true,
        urgency: "high",
        ttlSeconds: 360,
      },
    },
  });
});

test("the veto deadline falls back to the response's window", () => {
  const prev = inc("fix-ready", [ev("investigating")]);
  const response = {
    next: { kind: "working", detail: "" },
    veto: { startedAt: iso(NOW), deadline: iso(NOW + 2 * 3_600_000) },
  } as IncidentResponse;
  const planned = planIncidentNotification(
    step(prev, "veto", "sessions", { response }),
    prev,
    facts({ change: { kind: "rollback" } }),
    NOW,
  );
  expect(planned?.event).toMatchObject({
    kind: "incident_veto",
    body: "Rolls back to the last release at 14:31 unless you stop it",
    push: { ttlSeconds: 3600 },
  });
  expect(planned?.event.push?.actions?.map((a) => a.title)).toEqual([
    "Stop the rollback",
    "Roll back now",
    "Open",
  ]);
  expect(
    planIncidentNotification(step(prev, "veto"), prev, facts(), NOW)?.event,
  ).toMatchObject({ kind: "incident_update", body: "Deploying the fix now" });
});

test("needs you offers the top option only", () => {
  const prev = inc("investigating", [ev("investigating")]);
  const response = {
    next: {
      kind: "needs-you",
      reason: "This change costs money, so it needs you",
      needsYou: "policy",
      options: ["stop", "approve", "send-back"],
    },
    needsYou: {
      kind: "policy",
      reason: "x",
      since: iso(NOW),
      resumePhase: "deciding",
    },
  } as IncidentResponse;
  const planned = planIncidentNotification(
    step(prev, "needs-you", "sessions", { response }),
    prev,
    facts(),
    NOW,
  );
  expect(planned?.event).toMatchObject({
    kind: "incident_needs_you",
    reason: "Search needs you",
    body: "This change costs money, so it needs you",
    delivery: "alert",
    push: { requireInteraction: true, urgency: "high", ttlSeconds: 43_200 },
  });
  expect(planned?.event.push?.actions).toEqual([
    {
      action: "answer",
      title: "Deploy the fix",
      url: "/incidents/inc-1?intent=approve",
    },
    { action: "open", title: "Open", url: "/incidents/inc-1" },
  ]);
});

test("heads-up is quiet and never says down", () => {
  const p = planIncidentNotification(
    inc("heads-up", [ev("heads-up")]),
    null,
    facts({ signal: "upcoming" }),
    NOW,
  );
  expect(p?.event).toMatchObject({
    kind: "incident_heads_up",
    reason: "Search needs attention soon",
    body: "Heads-up. Nothing is down yet",
    delivery: "quiet",
  });
  expect(p?.event.reason).not.toContain("down");
  const escalated = planIncidentNotification(
    step(inc("heads-up", [ev("heads-up")]), "investigating"),
    inc("heads-up", [ev("heads-up")]),
    facts(),
    NOW,
  );
  expect(escalated?.event).toMatchObject({
    kind: "incident_opened",
    reason: "Search is down",
    body: "Agents are investigating",
    delivery: "alert",
    push: { urgency: "normal", ttlSeconds: 3600 },
  });
});

test("progress replaces in place; the owner's own tap never alerts them", () => {
  const veto = step(
    inc("fix-ready", [ev("investigating")]),
    "veto",
    "sessions",
    {
      response: vetoResponse,
    },
  );
  expect(
    planIncidentNotification(step(veto, "deploying"), veto, facts(), NOW)
      ?.event,
  ).toMatchObject({
    kind: "incident_update",
    body: "Deploying the fix now",
    delivery: "replace",
    push: { urgency: "low" },
  });
  expect(
    planIncidentNotification(
      step(veto, "investigating", "ada"),
      veto,
      facts(),
      NOW,
    )?.event,
  ).toMatchObject({
    body: "You stopped it. Agents are investigating",
    delivery: "replace",
  });
  expect(
    planIncidentNotification(
      step(veto, "investigating", "Bo"),
      veto,
      facts(),
      NOW,
    )?.event.body,
  ).toBe("Bo stopped it. Agents are investigating");
  const watching = step(step(veto, "deploying"), "watching");
  expect(
    planIncidentNotification(watching, step(veto, "deploying"), facts(), NOW)
      ?.event,
  ).toMatchObject({
    reason: "Search: the fix is live",
    body: "The fix is live. Watching the signal before closing",
  });
  expect(
    planIncidentNotification(
      step(watching, "resolved", "ada", { fixedBy: "by-hand" }),
      watching,
      facts(),
      NOW,
    )?.event,
  ).toMatchObject({
    kind: "incident_resolved",
    reason: "Search is back to normal",
    body: "You closed it as fixed",
    delivery: "replace",
  });
  const needs = step(veto, "needs-you");
  expect(
    planIncidentNotification(
      step(needs, "investigating", "Bo"),
      needs,
      facts(),
      NOW,
    )?.event.body,
  ).toBe("Bo answered. Agents are continuing");
  expect(
    planIncidentNotification(
      step(veto, "closed-without-action", "Bo"),
      veto,
      facts(),
      NOW,
    )?.event,
  ).toMatchObject({
    kind: "incident_resolved",
    body: "Closed without action",
    delivery: "quiet",
  });
});

test("night: hold everything except fully down and needing you", () => {
  const prev = inc("fix-ready", [ev("investigating")]);
  const night = facts({ night: true });
  expect(
    planIncidentNotification(
      step(prev, "veto", "sessions", { response: vetoResponse }),
      prev,
      night,
      NOW,
    )?.event,
  ).toMatchObject({ delivery: "quiet", hold: true });
  expect(
    planIncidentNotification(
      inc("investigating", [ev("investigating")]),
      null,
      night,
      NOW,
    )?.event,
  ).toMatchObject({ delivery: "quiet", hold: true });
  const needs = step(prev, "needs-you", "sessions", {
    response: {
      next: {
        kind: "needs-you",
        reason: "Retry?",
        needsYou: "agent-error",
        options: ["retry"],
      },
    } as IncidentResponse,
  });
  expect(
    planIncidentNotification(needs, prev, night, NOW)?.event,
  ).toMatchObject({ delivery: "quiet", hold: true });
  expect(
    planIncidentNotification(
      needs,
      prev,
      facts({ night: true, fullyDown: true }),
      NOW,
    )?.event,
  ).toMatchObject({ delivery: "alert" });
  expect(
    planIncidentNotification(
      inc("heads-up", [ev("heads-up")]),
      null,
      night,
      NOW,
    )?.event.hold,
  ).toBeUndefined();
});

test("only state changes and new questions notify", () => {
  const a = inc("investigating", [ev("investigating")]);
  const b = {
    ...a,
    events: [
      ...a.events,
      { ...ev("investigating"), kind: "signal-state" as const },
    ],
    updatedAt: iso(NOW + 1),
  };
  expect(planIncidentNotification(b, a, facts(), NOW)).toBeNull();
  const r1 = {
    next: {
      kind: "needs-you",
      reason: "One",
      needsYou: "question",
      options: [],
    },
    needsYou: {
      kind: "question",
      reason: "One",
      since: "t1",
      resumePhase: "investigating",
    },
  } as unknown as IncidentResponse;
  const r2 = {
    ...r1,
    next: { ...r1.next, reason: "Two" },
    needsYou: { ...r1.needsYou!, since: "t2" },
  } as IncidentResponse;
  const waiting = step(a, "needs-you", "sessions", { response: r1 });
  const again = planIncidentNotification(
    { ...waiting, response: r2 },
    waiting,
    facts(),
    NOW,
  );
  expect(again?.event).toMatchObject({
    kind: "incident_needs_you",
    body: "Two",
    eventKey: "needs:t2",
  });
  expect(again?.event.push?.actions).toEqual([
    { action: "open", title: "Open", url: "/incidents/inc-1" },
  ]);
  expect(
    planIncidentNotification(
      inc("investigating", [ev("investigating")], { owner: " " }),
      null,
      facts(),
      NOW,
    ),
  ).toBeNull();
});

test("reopen, rollback and the flush after a night", () => {
  const done = inc(
    "resolved",
    [ev("investigating"), ev("resolved", "investigating")],
    { fixedBy: "agents" },
  );
  const reopened = inc("investigating", [
    ...done.events,
    ev("investigating", "resolved", "sessions", "reopened"),
  ]);
  expect(
    planIncidentNotification(reopened, done, facts(), NOW)?.event,
  ).toMatchObject({
    kind: "incident_opened",
    reason: "Search is failing again",
    body: "Agents are investigating again",
  });
  const deploying = inc("deploying", [ev("investigating")]);
  expect(
    planIncidentNotification(
      step(deploying, "rolled-back"),
      deploying,
      facts(),
      NOW,
    )?.event,
  ).toMatchObject({
    kind: "incident_rolled_back",
    reason: "Search: the fix was rolled back",
    delivery: "alert",
  });
  expect(planHeldFlush(done, facts(), NOW)?.event).toMatchObject({
    kind: "incident_resolved",
    body: "Fixed by agents and verified in production",
    delivery: "alert",
    flushHeld: true,
    eventKey: "flush:2026-10-20",
  });
  expect(planHeldFlush(done, facts(), NOW)?.event.cooldown).toBeUndefined();
  const byHand = inc(
    "resolved",
    [ev("investigating"), ev("resolved", "investigating", "Bo")],
    { fixedBy: "by-hand" },
  );
  expect(planHeldFlush(byHand, facts(), NOW)?.event.body).toBe(
    "Bo closed it as fixed",
  );
  expect(
    planHeldFlush(inc("heads-up", [ev("heads-up")]), facts(), NOW),
  ).toBeNull();
  expect(
    planHeldFlush(inc("investigating", [ev("investigating")]), facts(), NOW)
      ?.event,
  ).toMatchObject({
    kind: "incident_opened",
    reason: "Search is down",
    body: "Agents are investigating",
  });
  const lateVeto = inc("veto", [ev("veto", "fix-ready")], {
    response: {
      next: { kind: "veto", deadline: iso(NOW - 60_000), rule: "" },
    } as IncidentResponse,
  });
  expect(planHeldFlush(lateVeto, facts(), NOW)?.event).toMatchObject({
    kind: "incident_update",
    body: "Deploying the fix now",
  });
});
