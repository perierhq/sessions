import { describe, expect, test } from "bun:test";
import type {
  Incident,
  IncidentState,
  Signal,
  SignalEvaluation,
  SignalState,
} from "../../shared/incidents";
import {
  type EngineSnapshot,
  applyIncidentOps,
  decideIncidentOps,
} from "./engine";
import { getIncident } from "./incident-store";
import { useIncidentTestKernel } from "./testing/kernel-fixture";

const NOW = Date.parse("2026-10-20T10:00:00Z");
const iso = (msAgo = 0) => new Date(NOW - msAgo).toISOString();
const S = (id: string, over: Partial<Signal> = {}): Signal => ({
  id,
  name: id === "sig-a" ? "Search" : id,
  project: "acme",
  enabled: true,
  severity: "major",
  source: { kind: "http", url: "https://acme.example.test" },
  rule: { kind: "consecutive", failures: 3 },
  createdBy: "Ada",
  createdAt: iso(86_400_000),
  updatedAt: iso(86_400_000),
  ...over,
});
const E = (
  signalId: string,
  state: SignalState,
  reason = state === "ok" ? "Passing" : "3 failures in a row",
): SignalEvaluation => ({
  signalId,
  state,
  reason,
  since: iso(),
  at: iso(),
  inMaintenance: false,
});
const I = (
  id: string,
  state: IncidentState,
  over: Partial<Incident> = {},
): Incident => ({
  id,
  project: "acme",
  title: "x",
  state,
  severity: "major",
  owner: "Ada",
  openedBy: { kind: "rule" },
  signalIds: ["sig-a"],
  primarySignalId: "sig-a",
  openedAt: iso(600_000),
  updatedAt: iso(600_000),
  lastProblemAt: iso(600_000),
  findings: [],
  events: [],
  droppedEvents: 0,
  ...over,
});
const snap = (
  signals: Signal[],
  evals: SignalEvaluation[],
  incidents: Incident[] = [],
): EngineSnapshot => ({
  signals: new Map(signals.map((s) => [s.id, s])),
  evaluations: new Map(evals.map((e) => [e.signalId, e])),
  incidents,
  now: NOW,
});
const decide = (
  s: Signal,
  prev: SignalState | null,
  cur: SignalEvaluation,
  sn: EngineSnapshot,
) => decideIncidentOps(s, prev ? E(s.id, prev) : null, cur, sn);

describe("decide", () => {
  test("a failing signal opens an investigating incident owned by its creator", () => {
    const a = S("sig-a");
    expect(
      decide(
        a,
        "ok",
        E("sig-a", "failing"),
        snap([a], [E("sig-a", "failing")]),
      ),
    ).toEqual([
      {
        op: "open",
        incident: {
          project: "acme",
          title: "Search",
          state: "investigating",
          severity: "major",
          owner: "Ada",
          openedBy: { kind: "rule", ref: "sig-a" },
          signalIds: ["sig-a"],
          primarySignalId: "sig-a",
          at: iso(),
          detail: "3 failures in a row",
        },
      },
    ]);
  });

  test("slow opens an investigating incident with the signal's severity", () => {
    const a = S("sig-a", { severity: "critical" });
    expect(
      decide(a, "ok", E("sig-a", "slow", "Slow"), snap([a], []))[0],
    ).toMatchObject({
      op: "open",
      incident: {
        state: "investigating",
        severity: "critical",
        detail: "Slow",
      },
    });
  });

  test("flaky and upcoming open a heads-up; nothing happens without a change", () => {
    const a = S("sig-a");
    expect(
      decide(
        a,
        "ok",
        E("sig-a", "flaky", "Failing on and off"),
        snap([a], []),
      )[0],
    ).toMatchObject({ op: "open", incident: { state: "heads-up" } });
    expect(
      decide(
        a,
        "ok",
        E("sig-a", "upcoming", "Expires in 10 days"),
        snap([a], []),
      )[0],
    ).toMatchObject({ op: "open", incident: { state: "heads-up" } });
    expect(decide(a, "failing", E("sig-a", "failing"), snap([a], []))).toEqual(
      [],
    );
    expect(
      decide(
        a,
        "ok",
        { ...E("sig-a", "failing"), inMaintenance: true },
        snap([a], []),
      ),
    ).toEqual([]);
    expect(
      decide(
        a,
        "ok",
        E("sig-a", "unknown", "No usable data yet: x"),
        snap([a], []),
      ),
    ).toEqual([]);
  });

  test("a heads-up escalates in place", () => {
    const a = S("sig-a");
    expect(
      decide(
        a,
        "flaky",
        E("sig-a", "failing"),
        snap([a], [], [I("inc-1", "heads-up")]),
      ),
    ).toEqual([
      {
        op: "event",
        incidentId: "inc-1",
        signalId: "sig-a",
        signalState: "failing",
        detail: "3 failures in a row",
      },
      {
        op: "transition",
        incidentId: "inc-1",
        to: "investigating",
        detail: "3 failures in a row",
      },
    ]);
    // A warning on a heads-up only records it.
    expect(
      decide(
        a,
        "ok",
        E("sig-a", "flaky", "Failing on and off"),
        snap([a], [], [I("inc-1", "heads-up")]),
      ),
    ).toEqual([
      {
        op: "event",
        incidentId: "inc-1",
        signalId: "sig-a",
        signalState: "flaky",
        detail: "Failing on and off",
      },
    ]);
  });

  test("merging: same project inside the window, declared dependency across projects", () => {
    const b = S("sig-b");
    expect(
      decide(
        b,
        "ok",
        E("sig-b", "failing"),
        snap([S("sig-a"), b], [], [I("inc-1", "investigating")]),
      )[0],
    ).toMatchObject({ op: "attach", incidentId: "inc-1" });
    expect(
      decide(
        b,
        "ok",
        E("sig-b", "failing"),
        snap(
          [S("sig-a"), b],
          [],
          [I("inc-1", "investigating", { lastProblemAt: iso(2_400_000) })],
        ),
      )[0],
    ).toMatchObject({ op: "open" });
    const c = S("sig-c", { project: "acme-api", dependsOn: ["sig-a"] });
    expect(
      decide(
        c,
        "ok",
        E("sig-c", "failing"),
        snap(
          [S("sig-a"), c],
          [],
          [I("inc-1", "investigating", { lastProblemAt: iso(7_200_000) })],
        ),
      )[0],
    ).toMatchObject({ op: "attach", incidentId: "inc-1" });
    // The other direction: a signal that depends on this one.
    const d = S("sig-d", { project: "acme-api" });
    const dependent = S("sig-e", { project: "acme-api", dependsOn: ["sig-d"] });
    expect(
      decide(
        d,
        "ok",
        E("sig-d", "failing"),
        snap(
          [d, dependent],
          [],
          [
            I("inc-2", "investigating", {
              project: "acme",
              signalIds: ["sig-e"],
              lastProblemAt: iso(7_200_000),
            }),
          ],
        ),
      )[0],
    ).toMatchObject({ op: "attach", incidentId: "inc-2" });
  });

  test("attaching to a heads-up escalates it", () => {
    const b = S("sig-b");
    expect(
      decide(
        b,
        "ok",
        E("sig-b", "failing"),
        snap([S("sig-a"), b], [], [I("inc-1", "heads-up")]),
      ),
    ).toEqual([
      {
        op: "attach",
        incidentId: "inc-1",
        signalId: "sig-b",
        signalState: "failing",
        detail: "3 failures in a row",
      },
      {
        op: "transition",
        incidentId: "inc-1",
        to: "investigating",
        detail: "3 failures in a row",
      },
    ]);
  });

  test("ties go to the newest incident", () => {
    const b = S("sig-b");
    const older = I("inc-old", "investigating", { openedAt: iso(900_000) });
    const newer = I("inc-new", "investigating", { openedAt: iso(300_000) });
    expect(
      decide(
        b,
        "ok",
        E("sig-b", "failing"),
        snap([S("sig-a"), b], [], [older, newer]),
      )[0],
    ).toMatchObject({ incidentId: "inc-new" });
  });

  test("reopens a recently closed incident instead of opening another", () => {
    const a = S("sig-a");
    expect(
      decide(
        a,
        "ok",
        E("sig-a", "failing"),
        snap(
          [a],
          [],
          [I("inc-1", "closed-without-action", { closedAt: iso(600_000) })],
        ),
      ),
    ).toEqual([
      {
        op: "transition",
        incidentId: "inc-1",
        to: "investigating",
        detail: "3 failures in a row",
      },
    ]);
    expect(
      decide(
        a,
        "ok",
        E("sig-a", "flaky", "Failing on and off"),
        snap([a], [], [I("inc-1", "resolved", { closedAt: iso(600_000) })]),
      ),
    ).toEqual([
      {
        op: "transition",
        incidentId: "inc-1",
        to: "heads-up",
        detail: "Failing on and off",
      },
    ]);
    expect(
      decide(
        a,
        "ok",
        E("sig-a", "failing"),
        snap([a], [], [I("inc-1", "resolved", { closedAt: iso(2_400_000) })]),
      )[0],
    ).toMatchObject({ op: "open" });
  });

  test("recovery: an event, and a heads-up closes once all its signals are ok", () => {
    const a = S("sig-a");
    expect(
      decide(
        a,
        "failing",
        E("sig-a", "ok"),
        snap([a], [E("sig-a", "ok")], [I("inc-1", "investigating")]),
      ),
    ).toEqual([
      {
        op: "event",
        incidentId: "inc-1",
        signalId: "sig-a",
        signalState: "ok",
        detail: "Passing",
      },
    ]);
    expect(
      decide(
        a,
        "flaky",
        E("sig-a", "ok"),
        snap([a], [E("sig-a", "ok")], [I("inc-1", "heads-up")]),
      )[1],
    ).toEqual({
      op: "transition",
      incidentId: "inc-1",
      to: "closed-without-action",
      detail: "Signals back to normal",
    });
    // Another attached signal still bad: the heads-up stays.
    const b = S("sig-b");
    expect(
      decide(
        a,
        "flaky",
        E("sig-a", "ok"),
        snap(
          [a, b],
          [E("sig-a", "ok"), E("sig-b", "flaky")],
          [I("inc-1", "heads-up", { signalIds: ["sig-a", "sig-b"] })],
        ),
      ),
    ).toHaveLength(1);
    // A deleted attached signal does not hold it open.
    expect(
      decide(
        a,
        "flaky",
        E("sig-a", "ok"),
        snap(
          [a],
          [E("sig-a", "ok")],
          [I("inc-1", "heads-up", { signalIds: ["sig-a", "sig-gone"] })],
        ),
      ).at(-1),
    ).toMatchObject({ op: "transition", to: "closed-without-action" });
  });

  test("unknown is recorded on open incidents and opens nothing", () => {
    const a = S("sig-a");
    expect(
      decide(
        a,
        "failing",
        E("sig-a", "unknown", "No usable data for 5m: x"),
        snap([a], [], [I("inc-1", "investigating")]),
      ),
    ).toEqual([
      {
        op: "event",
        incidentId: "inc-1",
        signalId: "sig-a",
        signalState: "unknown",
        detail: "No usable data for 5m: x",
      },
    ]);
  });

  test("boot: an incident that already covers the signal is left alone", () => {
    const a = S("sig-a");
    expect(
      decide(
        a,
        null,
        E("sig-a", "failing"),
        snap([a], [], [I("inc-1", "investigating")]),
      ),
    ).toEqual([]);
    expect(
      decide(a, null, E("sig-a", "failing"), snap([a], []))[0],
    ).toMatchObject({ op: "open" });
    expect(
      decide(
        a,
        null,
        E("sig-a", "ok"),
        snap([a], [], [I("inc-1", "heads-up")]),
      ),
    ).toEqual([]);
  });

  test("dangling ids from deleted signals are ignored", () => {
    const a = S("sig-a", { dependsOn: ["sig-gone"] });
    const ops = decide(
      a,
      "ok",
      E("sig-a", "failing"),
      snap(
        [a],
        [],
        [
          I("inc-9", "investigating", {
            signalIds: ["sig-gone"],
            project: "acme-api",
          }),
        ],
      ),
    );
    expect(ops[0]).toMatchObject({ op: "open" });
  });
});

describe("apply", () => {
  useIncidentTestKernel();

  test("apply: open, attach, event, stale transition", async () => {
    const [opened] = await applyIncidentOps(
      [
        {
          op: "open",
          incident: {
            project: "acme",
            title: "Search",
            state: "investigating",
            severity: "major",
            owner: "Ada",
            openedBy: { kind: "rule", ref: "sig-a" },
            signalIds: ["sig-a"],
            primarySignalId: "sig-a",
            at: iso(60_000),
            detail: "x",
          },
        },
      ],
      iso(60_000),
    );
    const [after] = await applyIncidentOps(
      [
        {
          op: "attach",
          incidentId: opened!.id,
          signalId: "sig-b",
          signalState: "failing",
          detail: "y",
        },
        {
          op: "attach",
          incidentId: opened!.id,
          signalId: "sig-b",
          signalState: "failing",
          detail: "y",
        },
        {
          op: "transition",
          incidentId: opened!.id,
          to: "veto",
          detail: "not allowed from investigating",
        },
      ],
      iso(),
    );
    const stored = await getIncident(opened!.id);
    expect(stored?.signalIds).toEqual(["sig-a", "sig-b"]);
    expect(stored?.lastProblemAt).toBe(iso());
    expect(stored?.state).toBe("investigating");
    expect(after!.id).toBe(opened!.id);
    expect(stored?.events.map((e) => e.kind)).toEqual([
      "opened",
      "signal-attached",
      "signal-state",
    ]);
  });

  test("apply: an ok event keeps lastProblemAt; transitions and findings", async () => {
    const [opened] = await applyIncidentOps(
      [
        {
          op: "open",
          incident: {
            project: "acme",
            title: "Search",
            state: "investigating",
            severity: "major",
            owner: "Ada",
            openedBy: { kind: "rule", ref: "sig-a" },
            signalIds: ["sig-a"],
            primarySignalId: "sig-a",
            at: iso(60_000),
            detail: "x",
          },
        },
      ],
      iso(60_000),
    );
    const id = opened!.id;
    const finding = {
      kind: "disagreement" as const,
      at: iso(),
      signalId: "sig-r",
      againstSignalId: "sig-a",
      detail: "d",
    };
    await applyIncidentOps(
      [
        {
          op: "event",
          incidentId: id,
          signalId: "sig-a",
          signalState: "ok",
          detail: "Passing",
        },
        { op: "finding", incidentId: id, finding },
        { op: "finding", incidentId: id, finding },
        {
          op: "transition",
          incidentId: id,
          to: "resolved",
          detail: "Fixed",
          fixedBy: "by-hand",
        },
      ],
      iso(),
    );
    let stored = await getIncident(id);
    expect(stored?.lastProblemAt).toBe(iso(60_000));
    expect(stored?.findings).toHaveLength(1);
    expect(stored).toMatchObject({
      state: "resolved",
      fixedBy: "by-hand",
      closedAt: iso(),
    });
    expect(stored?.events.map((e) => e.kind)).toEqual([
      "opened",
      "signal-state",
      "finding",
      "state",
    ]);
    await applyIncidentOps(
      [
        {
          op: "resolve-finding",
          incidentId: id,
          kind: "disagreement",
          againstSignalId: "sig-a",
        },
      ],
      iso(),
    );
    stored = await getIncident(id);
    expect(stored?.findings[0]?.resolvedAt).toBe(iso());
    // Reopening restarts the merge window.
    const later = new Date(NOW + 60_000).toISOString();
    await applyIncidentOps(
      [
        {
          op: "transition",
          incidentId: id,
          to: "investigating",
          detail: "Back",
        },
      ],
      later,
    );
    stored = await getIncident(id);
    expect(stored).toMatchObject({
      state: "investigating",
      lastProblemAt: later,
    });
    expect(stored?.closedAt).toBeUndefined();
    // A missing incident is skipped.
    expect(
      await applyIncidentOps(
        [
          {
            op: "event",
            incidentId: "inc-missing",
            signalId: "sig-a",
            signalState: "ok",
            detail: "",
          },
        ],
        iso(),
      ),
    ).toEqual([]);
  });
});
