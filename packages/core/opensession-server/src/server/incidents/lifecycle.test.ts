import { expect, test } from "bun:test";
import {
  type FixedBy,
  INCIDENT_STATES,
  type Incident,
  type IncidentState,
} from "../../shared/incidents";
import {
  EVENT_DETAIL_MAX,
  INCIDENT_TRANSITIONS,
  TIMELINE_CAP,
  appendEvent,
  canTransition,
  markerForTransition,
  transitionIncident,
} from "./lifecycle";

const AT = "2026-10-20T10:00:00.000Z";
const inc = (state: IncidentState, over: Partial<Incident> = {}): Incident => ({
  id: "inc-1",
  project: "acme",
  title: "Search",
  state,
  severity: "major",
  owner: "Ada",
  openedBy: { kind: "rule", ref: "sig-a" },
  signalIds: ["sig-a"],
  primarySignalId: "sig-a",
  openedAt: AT,
  updatedAt: AT,
  lastProblemAt: AT,
  findings: [],
  events: [],
  droppedEvents: 0,
  ...over,
});
const go = (i: Incident, to: IncidentState, fixedBy?: FixedBy) => {
  const r = transitionIncident(i, to, {
    by: "sessions",
    detail: "x",
    at: AT,
    fixedBy,
  });
  if ("error" in r) throw new Error(r.error);
  return r;
};

test("every state has a row; the main path is allowed", () => {
  expect(Object.keys(INCIDENT_TRANSITIONS).sort()).toEqual(
    [...INCIDENT_STATES].sort(),
  );
  const path: IncidentState[] = [
    "heads-up",
    "investigating",
    "fix-ready",
    "veto",
    "deploying",
    "watching",
    "resolved",
  ];
  path
    .slice(1)
    .forEach((to, i) => expect(canTransition(path[i]!, to)).toBe(true));
  expect(canTransition("resolved", "fix-ready")).toBe(false);
  expect(canTransition("rolled-back", "deploying")).toBe(false);
  expect(
    transitionIncident(inc("resolved"), "fix-ready", {
      by: "s",
      detail: "",
      at: AT,
    }),
  ).toEqual({ error: "Cannot move from resolved to fix-ready" });
  expect(
    "error" in
      transitionIncident(inc("veto"), "veto", { by: "s", detail: "", at: AT }),
  ).toBe(true);
});

test("the table is pinned", () => {
  expect(INCIDENT_TRANSITIONS).toEqual({
    "heads-up": [
      "investigating",
      "waiting-on-provider",
      "needs-you",
      "paused",
      "closed-without-action",
    ],
    investigating: [
      "fix-ready",
      "waiting-on-provider",
      "needs-you",
      "paused",
      "resolved",
      "closed-without-action",
    ],
    "fix-ready": ["veto", "deploying", "investigating", "needs-you", "paused"],
    veto: ["deploying", "investigating", "needs-you", "paused"],
    deploying: [
      "watching",
      "rolled-back",
      "investigating",
      "needs-you",
      "paused",
    ],
    watching: ["resolved", "rolled-back", "needs-you", "paused"],
    "rolled-back": ["investigating", "needs-you"],
    "needs-you": [
      "heads-up",
      "investigating",
      "fix-ready",
      "veto",
      "deploying",
      "watching",
      "paused",
      "resolved",
      "closed-without-action",
    ],
    paused: [
      "heads-up",
      "investigating",
      "fix-ready",
      "veto",
      "deploying",
      "watching",
      "needs-you",
      "resolved",
      "closed-without-action",
    ],
    "waiting-on-provider": [
      "investigating",
      "needs-you",
      "paused",
      "resolved",
      "closed-without-action",
    ],
    resolved: ["investigating", "heads-up"],
    "closed-without-action": ["investigating", "heads-up"],
  });
});

test("side states remember where to return", () => {
  const paused = go(go(inc("investigating"), "needs-you"), "paused");
  expect(paused.resumeState).toBe("investigating");
  expect(go(paused, "investigating").resumeState).toBeUndefined();
  expect(go(inc("investigating"), "waiting-on-provider").resumeState).toBe(
    "investigating",
  );
});

test("close and reopen", () => {
  const done = go(inc("investigating"), "resolved", "by-hand");
  expect(done).toMatchObject({ closedAt: AT, fixedBy: "by-hand" });
  expect(done.events.at(-1)).toMatchObject({
    kind: "state",
    from: "investigating",
    to: "resolved",
    marker: "resolved",
    by: "sessions",
    detail: "x",
    at: AT,
  });
  const again = go(done, "investigating");
  expect(again.closedAt).toBeUndefined();
  expect(again.fixedBy).toBeUndefined();
  expect(again.events.at(-1)).toMatchObject({
    kind: "reopened",
    marker: "reopened",
    from: "resolved",
    to: "investigating",
  });
  // Only resolved records how it was fixed; closed without action records
  // only that it recovered on its own.
  expect(
    go(inc("heads-up"), "closed-without-action", "by-hand").fixedBy,
  ).toBeUndefined();
  const recovered = go(inc("needs-you"), "closed-without-action", "recovered");
  expect(recovered).toMatchObject({ closedAt: AT, fixedBy: "recovered" });
  expect(go(recovered, "investigating").fixedBy).toBeUndefined();
});

test("transitions never mutate their input", () => {
  const before = inc("investigating");
  const copy = structuredClone(before);
  go(before, "resolved", "by-hand");
  expect(before).toEqual(copy);
});

test("markers", () => {
  expect(markerForTransition("fix-ready", "investigating")).toBe("sent-back");
  expect(markerForTransition("veto", "investigating")).toBe("sent-back");
  expect(markerForTransition("deploying", "investigating")).toBe("sent-back");
  expect(markerForTransition("investigating", "fix-ready")).toBe("fix-ready");
  expect(markerForTransition("veto", "deploying")).toBe("deploy");
  expect(markerForTransition("deploying", "watching")).toBe("released");
  expect(markerForTransition("watching", "rolled-back")).toBe("rolled-back");
  expect(markerForTransition("watching", "resolved")).toBe("resolved");
  expect(markerForTransition("heads-up", "investigating")).toBeUndefined();
});

test("timeline cap keeps state events", () => {
  let i = appendEvent(inc("investigating"), {
    at: AT,
    kind: "opened",
    by: "sessions",
    detail: "opened",
  });
  i = go(i, "needs-you");
  for (let n = 0; n < 600; n++)
    i = appendEvent(i, {
      at: AT,
      kind: "signal-state",
      by: "sessions",
      detail: `n${n}`,
      signalId: "sig-a",
      signalState: "failing",
    });
  expect(i.events).toHaveLength(TIMELINE_CAP);
  expect(i.droppedEvents).toBe(102);
  expect(i.events[0]!.kind).toBe("opened");
  expect(i.events.some((e) => e.kind === "state")).toBe(true);
  expect(i.events.at(-1)?.detail).toBe("n599");
  expect(
    appendEvent(i, {
      at: AT,
      kind: "signal-state",
      by: "s",
      detail: "x".repeat(3000),
    }).events.at(-1)?.detail,
  ).toHaveLength(EVENT_DETAIL_MAX);
});

test("a timeline of only state events drops the oldest after the first", () => {
  let i = appendEvent(inc("investigating"), {
    at: AT,
    kind: "opened",
    by: "sessions",
    detail: "opened",
  });
  for (let n = 0; n < TIMELINE_CAP; n++)
    i = appendEvent(i, {
      at: AT,
      kind: "state",
      by: "sessions",
      detail: `s${n}`,
    });
  expect(i.events).toHaveLength(TIMELINE_CAP);
  expect(i.events[0]!.kind).toBe("opened");
  expect(i.events[1]!.detail).toBe("s1");
  expect(i.droppedEvents).toBe(1);
});

test("appendEvent gives ids and moves updatedAt", () => {
  const later = "2026-10-20T11:00:00.000Z";
  const i = appendEvent(inc("investigating"), {
    at: later,
    kind: "signal-state",
    by: "sessions",
    detail: "x",
  });
  expect(i.events[0]!.id).toMatch(/^evt-/);
  expect(i.updatedAt).toBe(later);
});
