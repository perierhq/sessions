import { expect, test } from "bun:test";
import type {
  Incident,
  IncidentEvent,
  SignalView,
} from "../../../shared/incidents";
import {
  FLAP_SUGGEST_AT,
  MUTE_MS,
  flapCount,
  flapSuggestion,
  stricterRule,
} from "./flapping";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const event = (
  msAgo: number,
  kind: IncidentEvent["kind"],
  over: Partial<IncidentEvent> = {},
): IncidentEvent => ({
  id: `evt-${msAgo}-${kind}`,
  at: iso(msAgo),
  kind,
  by: "sessions",
  detail: "",
  ...over,
});
const failing = (msAgo: number, signalId = "sig-a") =>
  event(msAgo, "signal-state", { signalId, signalState: "failing" });
const passing = (msAgo: number, signalId = "sig-a") =>
  event(msAgo, "signal-state", { signalId, signalState: "ok" });

const incident = (over: Partial<Incident> = {}): Incident => ({
  id: "inc-1",
  project: "acme",
  title: "Search",
  state: "closed-without-action",
  severity: "major",
  owner: "Ada",
  openedBy: { kind: "rule", ref: "sig-a" },
  signalIds: ["sig-a"],
  primarySignalId: "sig-a",
  openedAt: iso(3_600_000),
  updatedAt: iso(600_000),
  lastProblemAt: iso(600_000),
  closedAt: iso(600_000),
  findings: [],
  events: [event(3_600_000, "opened", { signalId: "sig-a" })],
  droppedEvents: 0,
  ...over,
});

const signal = (over: Partial<SignalView> = {}): SignalView => ({
  id: "sig-a",
  name: "Search",
  project: "acme",
  enabled: true,
  severity: "major",
  source: { kind: "http", url: "https://acme.example.test" },
  intervalMs: 60_000,
  rule: { kind: "consecutive", failures: 3, recoveries: 2 },
  createdBy: "Ada",
  createdAt: iso(86_400_000),
  updatedAt: iso(86_400_000),
  evaluation: null,
  ...over,
});

test("flaps: each turn to failing, each reopen, each one held while quiet", () => {
  expect(flapCount(incident())).toBe(1);
  const events = [
    event(3_600_000, "opened", { signalId: "sig-a" }),
    passing(3_500_000),
    failing(3_400_000),
    // Still bad in another state: the same turn.
    event(3_350_000, "signal-state", {
      signalId: "sig-a",
      signalState: "flaky",
    }),
    // Another signal is not this one's flap.
    passing(3_300_000, "sig-b"),
    failing(3_200_000, "sig-b"),
    passing(3_100_000),
    event(3_000_000, "state", { to: "closed-without-action" }),
    event(2_900_000, "reopened", { to: "investigating" }),
    // Unknown says nothing: the next failing is no new turn.
    event(2_800_000, "signal-state", {
      signalId: "sig-a",
      signalState: "unknown",
    }),
    failing(2_700_000),
  ];
  expect(flapCount(incident({ events }))).toBe(3);
  expect(
    flapCount(incident({ events, quiet: { flaps: 4, lastAt: iso(300_000) } })),
  ).toBe(7);
});

test("a stricter rule asks for twice the evidence, where a rule counts it", () => {
  expect(stricterRule(signal())).toEqual({
    rule: { kind: "consecutive", failures: 6, recoveries: 2 },
    needs: "6 failures in a row",
  });
  expect(
    stricterRule(signal({ rule: { kind: "consecutive", failures: 40 } }))?.rule,
  ).toEqual({ kind: "consecutive", failures: 50 });
  expect(
    stricterRule(signal({ rule: { kind: "consecutive", failures: 50 } })),
  ).toBeNull();
  expect(
    stricterRule(
      signal({ rule: { kind: "threshold", above: 800, forMs: 300_000 } }),
    ),
  ).toEqual({
    rule: { kind: "threshold", above: 800, forMs: 600_000 },
    needs: "10 min over 800",
  });
  expect(
    stricterRule(
      signal({ rule: { kind: "rate", windowMs: 600_000, atLeast: 3 } }),
    ),
  ).toEqual({
    rule: { kind: "rate", windowMs: 600_000, atLeast: 6 },
    needs: "6 failures in 10 min",
  });
  expect(
    stricterRule(
      signal({ rule: { kind: "deadline", warnDays: 14, failDays: 3 } }),
    ),
  ).toBeNull();
});

test("a flapping incident closed without action suggests a stricter rule or a mute", () => {
  const flapped = incident({ quiet: { flaps: 4, lastAt: iso(300_000) } });
  const suggestion = flapSuggestion(flapped, [signal()], NOW);
  expect(suggestion).toEqual({
    signalId: "sig-a",
    signalName: "Search",
    flaps: 5,
    stricter: {
      label: "Need 6 failures in a row",
      landed: "Search now needs 6 failures in a row",
      patch: { rule: { kind: "consecutive", failures: 6, recoveries: 2 } },
      undo: { rule: { kind: "consecutive", failures: 3, recoveries: 2 } },
    },
    mute: {
      label: "Mute for a day",
      landed: "Search is muted for a day",
      patch: {
        maintenance: [
          {
            kind: "once",
            start: new Date(NOW).toISOString(),
            end: new Date(NOW + MUTE_MS).toISOString(),
            note: "Muted from an incident",
          },
        ],
      },
      undo: { maintenance: [] },
    },
  });
  // A mute keeps the windows the signal already has.
  const weekly = {
    kind: "weekly" as const,
    days: [0],
    start: "02:00",
    end: "03:00",
    timeZone: "UTC",
  };
  const muted = flapSuggestion(
    flapped,
    [signal({ maintenance: [weekly] })],
    NOW,
  );
  expect(muted?.mute.patch.maintenance?.[0]).toEqual(weekly);
  expect(muted?.mute.undo).toEqual({ maintenance: [weekly] });
});

test("no suggestion: too few flaps, not closed without action, or already changed", () => {
  const flapped = incident({
    quiet: { flaps: FLAP_SUGGEST_AT - 1, lastAt: iso(300_000) },
  });
  expect(flapSuggestion(flapped, [signal()], NOW)).not.toBeNull();
  expect(
    flapSuggestion(
      incident({ quiet: { flaps: FLAP_SUGGEST_AT - 2, lastAt: iso(300_000) } }),
      [signal()],
      NOW,
    ),
  ).toBeNull();
  expect(
    flapSuggestion({ ...flapped, state: "resolved" }, [signal()], NOW),
  ).toBeNull();
  expect(flapSuggestion(flapped, [], NOW)).toBeNull();
  expect(flapSuggestion(flapped, [signal({ enabled: false })], NOW)).toBeNull();
  // Edited since its last flap: the owner already acted.
  expect(
    flapSuggestion(flapped, [signal({ updatedAt: iso(60_000) })], NOW),
  ).toBeNull();
});
