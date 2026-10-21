import { expect, test } from "bun:test";
import type { IncidentResponse } from "../../../shared/incident-response";
import type { IncidentState, IncidentSummary } from "../../../shared/incidents";
import { RECENTLY_FIXED_MS, sidebarIncidents } from "./sidebar";

const NOW = Date.parse("2026-10-20T12:31:00Z");
const response = (deadline: string): IncidentResponse => ({
  phase: "veto",
  round: 1,
  maxRounds: 2,
  agents: [],
  actionRuns: [],
  costUsd: 0,
  ownerTouched: false,
  next: { kind: "veto", deadline, rule: "" },
  veto: { startedAt: "2026-10-20T12:27:00Z", deadline },
  ledger: [],
  droppedLedger: 0,
  startedAt: "2026-10-20T12:00:00Z",
  updatedAt: "2026-10-20T12:27:00Z",
});
const s = (
  id: string,
  state: IncidentState,
  over: Partial<IncidentSummary> = {},
): IncidentSummary => ({
  id,
  state,
  title: id,
  project: "acme",
  severity: "major",
  owner: "Ada",
  openedBy: { kind: "rule" },
  signalIds: ["sig-a"],
  primarySignalId: "sig-a",
  openedAt: "2026-10-20T10:00:00Z",
  updatedAt: "2026-10-20T10:00:00Z",
  lastProblemAt: "2026-10-20T10:00:00Z",
  findings: [],
  droppedEvents: 0,
  eventCount: 0,
  ...over,
});

test("open first by urgency, then recently fixed; old and closed hidden", () => {
  const list = sidebarIncidents(
    [
      s("old-fix", "resolved", { closedAt: "2026-10-19T20:00:00Z" }),
      s("fixed", "resolved", { closedAt: "2026-10-20T11:00:00Z" }),
      s("closed", "closed-without-action", {
        closedAt: "2026-10-20T12:00:00Z",
      }),
      s("work", "investigating", { openedAt: "2026-10-20T12:00:00Z" }),
      s("veto-late", "veto", { response: response("2026-10-20T12:50:00Z") }),
      s("veto-soon", "veto", { response: response("2026-10-20T12:37:00Z") }),
      s("you", "needs-you"),
    ],
    NOW,
  );
  expect(list.map((i) => i.id)).toEqual([
    "you",
    "veto-soon",
    "veto-late",
    "work",
    "fixed",
  ]);
});

test("other open incidents by newest opened, fixed by newest closed", () => {
  const list = sidebarIncidents(
    [
      s("a", "watching", { openedAt: "2026-10-20T09:00:00Z" }),
      s("b", "heads-up", { openedAt: "2026-10-20T11:00:00Z" }),
      s("veto-no-deadline", "veto"),
      s("f1", "resolved", { closedAt: "2026-10-20T08:00:00Z" }),
      s("f2", "resolved", { closedAt: "2026-10-20T12:00:00Z" }),
    ],
    NOW,
  );
  expect(list.map((i) => i.id)).toEqual([
    "veto-no-deadline",
    "b",
    "a",
    "f2",
    "f1",
  ]);
});

test("a fix stays exactly twelve hours", () => {
  const at = (ms: number) => new Date(NOW - ms).toISOString();
  const list = sidebarIncidents(
    [
      s("edge", "resolved", { closedAt: at(RECENTLY_FIXED_MS) }),
      s("past", "resolved", { closedAt: at(RECENTLY_FIXED_MS + 1) }),
      s("no-close", "resolved"),
    ],
    NOW,
  );
  expect(list.map((i) => i.id)).toEqual(["edge"]);
  expect(sidebarIncidents([], NOW)).toEqual([]);
});
