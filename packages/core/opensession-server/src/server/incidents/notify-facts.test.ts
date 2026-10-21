import { expect, test } from "bun:test";
import type {
  CandidateState,
  IncidentAction,
  IncidentProjectSettings,
  IncidentResponse,
} from "../../shared/incident-response";
import type {
  Incident,
  Signal,
  SignalEvaluation,
} from "../../shared/incidents";
import {
  loadNotifyFacts,
  type NotifyFactsDeps,
  vetoChange,
} from "./notify-facts";
import { defaultProjectSettings } from "./response/project-settings";

const NOON = Date.parse("2026-10-20T10:00:00Z");
const NIGHT = Date.parse("2026-10-20T23:30:00Z");
const settings = (
  over: Partial<IncidentProjectSettings> = {},
): IncidentProjectSettings => ({
  ...defaultProjectSettings("acme"),
  night: { start: "23:00", end: "07:00", timeZone: "Europe/Warsaw" },
  actions: [
    { id: "pause-worker", kind: "pause", label: "Pause the worker" },
    { id: "roll", kind: "rollback", label: "Roll back" },
    { id: "ship", kind: "deploy", label: "Deploy" },
  ] as IncidentAction[],
  ...over,
});
const fail = (i: number, at = NOON) => ({
  at: new Date(at - i * 60_000).toISOString(),
  result: "fail" as const,
  detail: "",
});
const signal = (id: string, over: Partial<Signal> = {}): Signal =>
  ({
    id,
    source: { kind: "http", url: "https://example.test/search" },
    rule: { kind: "consecutive", failures: 3 },
    intervalMs: 60_000,
    ...over,
  }) as Signal;
const deps = (over: Partial<NotifyFactsDeps> = {}): NotifyFactsDeps => ({
  settings: async () => settings(),
  signal: async (id) =>
    id === "sig-p" ? signal(id, { provider: true }) : signal(id),
  evaluations: () =>
    new Map([
      ["sig-a", { signalId: "sig-a", state: "failing" } as SignalEvaluation],
      ["sig-p", { signalId: "sig-p", state: "ok" } as SignalEvaluation],
    ]),
  recent: () => [fail(3), fail(2), fail(1)],
  timeZone: () => "Europe/Warsaw",
  ...over,
});
const incident = (over: Partial<Incident> = {}) =>
  ({
    id: "inc-1",
    project: "acme",
    owner: "Ada",
    primarySignalId: "sig-a",
    signalIds: ["sig-a", "sig-p"],
    ...over,
  }) as Incident;
const withCandidate = (candidate: Partial<CandidateState>) =>
  incident({ response: { candidate } as IncidentResponse });

test("facts by day and by night", async () => {
  expect(await loadNotifyFacts(incident(), NOON, deps())).toEqual({
    signal: "failing",
    night: false,
    fullyDown: true,
    timeZone: "Europe/Warsaw",
    change: null,
  });
  expect((await loadNotifyFacts(incident(), NIGHT, deps())).night).toBe(true);
  expect(
    (
      await loadNotifyFacts(
        incident(),
        NOON,
        deps({ recent: () => [fail(2), { ...fail(1), result: "ok" }] }),
      )
    ).fullyDown,
  ).toBe(false);
  // The provider's own signal never counts towards fully down.
  expect(
    (
      await loadNotifyFacts(
        incident({ primarySignalId: "sig-p", signalIds: ["sig-p"] }),
        NOON,
        deps(),
      )
    ).fullyDown,
  ).toBe(false);
});

test("what the veto will run", () => {
  const s = settings();
  expect(
    vetoChange(withCandidate({ plan: { pr: true, actions: [] } }), s),
  ).toEqual({
    kind: "deploy",
  });
  expect(
    vetoChange(withCandidate({ plan: { pr: false, actions: ["roll"] } }), s),
  ).toEqual({ kind: "rollback" });
  expect(
    vetoChange(withCandidate({ plan: { pr: false, actions: ["ship"] } }), s),
  ).toEqual({ kind: "deploy" });
  expect(
    vetoChange(
      withCandidate({ plan: { pr: true, actions: [] }, rollbackFirst: true }),
      s,
    ),
  ).toEqual({ kind: "rollback" });
  expect(
    vetoChange(
      withCandidate({ plan: { pr: false, actions: ["pause-worker"] } }),
      s,
    ),
  ).toEqual({ kind: "action", label: "Pause the worker" });
  expect(
    vetoChange(withCandidate({ plan: { pr: false, actions: ["gone"] } }), s),
  ).toBeNull();
  expect(vetoChange(incident(), s)).toBeNull();
});

test("a project without settings, or a failing lookup, never throws", async () => {
  const f = await loadNotifyFacts(
    withCandidate({ plan: { pr: true, actions: [] } }),
    NIGHT,
    deps({
      settings: async () => {
        throw new Error("gone");
      },
    }),
  );
  expect(f).toMatchObject({ night: false, change: null });
  const g = await loadNotifyFacts(
    incident(),
    NOON,
    deps({
      signal: async () => {
        throw new Error("gone");
      },
    }),
  );
  expect(g).toMatchObject({ signal: "failing", fullyDown: false });
});
