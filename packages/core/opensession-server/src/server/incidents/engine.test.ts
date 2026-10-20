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

  test("an attached signal still bad keeps the merge window open past its last report", () => {
    const a = S("sig-a");
    const b = S("sig-b");
    // sig-a has been failing for 40 minutes without a new report.
    const outage = I("inc-1", "investigating", {
      lastProblemAt: iso(2_400_000),
    });
    expect(
      decide(
        b,
        "ok",
        E("sig-b", "failing"),
        snap([a, b], [E("sig-a", "failing"), E("sig-b", "failing")], [outage]),
      )[0],
    ).toMatchObject({ op: "attach", incidentId: "inc-1", signalId: "sig-b" });
    // A warning counts as still bad too.
    expect(
      decide(
        b,
        "ok",
        E("sig-b", "failing"),
        snap([a, b], [E("sig-a", "flaky"), E("sig-b", "failing")], [outage]),
      )[0],
    ).toMatchObject({ op: "attach", incidentId: "inc-1" });
    // Recovered, or gone: the window counts from the last report again.
    for (const sn of [
      snap([a, b], [E("sig-a", "ok"), E("sig-b", "failing")], [outage]),
      snap([b], [E("sig-a", "failing"), E("sig-b", "failing")], [outage]),
    ])
      expect(decide(b, "ok", E("sig-b", "failing"), sn)[0]).toMatchObject({
        op: "open",
      });
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

describe("providers and disagreements", () => {
  const P = S("sig-p", { name: "Status", provider: true });

  test("own failure during a provider outage waits on the provider", () => {
    const a = S("sig-a");
    const [op] = decide(
      a,
      "ok",
      E("sig-a", "failing"),
      snap([a, P], [E("sig-a", "failing"), E("sig-p", "external")]),
    );
    expect(op).toMatchObject({
      op: "open",
      incident: {
        state: "waiting-on-provider",
        signalIds: ["sig-a", "sig-p"],
        findings: [
          {
            kind: "external",
            signalId: "sig-p",
            detail: "Status reports a problem",
          },
        ],
      },
    });
  });

  test("a disabled or unrelated provider is not consulted", () => {
    const a = S("sig-a");
    const off = S("sig-p", { name: "Status", provider: true, enabled: false });
    expect(
      decide(
        a,
        "ok",
        E("sig-a", "failing"),
        snap([a, off], [E("sig-a", "failing"), E("sig-p", "external")]),
      )[0],
    ).toMatchObject({
      incident: { state: "investigating", signalIds: ["sig-a"] },
    });
    const elsewhere = S("sig-p", {
      name: "Status",
      provider: true,
      project: "acme-api",
    });
    expect(
      decide(
        a,
        "ok",
        E("sig-a", "failing"),
        snap([a, elsewhere], [E("sig-a", "failing"), E("sig-p", "external")]),
      )[0],
    ).toMatchObject({ incident: { state: "investigating" } });
  });

  test("an existing incident moves to waiting on the provider instead of escalating", () => {
    const a = S("sig-a");
    const ops = decide(
      a,
      "flaky",
      E("sig-a", "failing"),
      snap(
        [a, P],
        [E("sig-a", "failing"), E("sig-p", "external")],
        [I("inc-1", "heads-up")],
      ),
    );
    expect(ops).toEqual([
      {
        op: "event",
        incidentId: "inc-1",
        signalId: "sig-a",
        signalState: "failing",
        detail: "3 failures in a row",
      },
      {
        op: "attach",
        incidentId: "inc-1",
        signalId: "sig-p",
        signalState: "external",
        detail: "Status reports a problem",
      },
      {
        op: "finding",
        incidentId: "inc-1",
        finding: {
          kind: "external",
          at: iso(),
          signalId: "sig-p",
          detail: "Status reports a problem",
        },
      },
      {
        op: "transition",
        incidentId: "inc-1",
        to: "waiting-on-provider",
        detail: "Waiting on Status",
      },
    ]);
  });

  test("a provider going external moves an investigating incident; never opens one", () => {
    const a = S("sig-a");
    const ops = decide(
      P,
      "ok",
      E("sig-p", "external"),
      snap(
        [a, P],
        [E("sig-a", "failing"), E("sig-p", "external")],
        [I("inc-1", "investigating")],
      ),
    );
    expect(ops.map((o) => o.op)).toEqual(["attach", "finding", "transition"]);
    expect(ops[2]).toMatchObject({
      to: "waiting-on-provider",
      detail: "Waiting on Status",
    });
    expect(
      decide(
        P,
        "ok",
        E("sig-p", "external"),
        snap([a, P], [E("sig-a", "ok"), E("sig-p", "external")]),
      ),
    ).toEqual([]);
    // A failing provider page is never an incident of its own, even at boot.
    expect(
      decide(
        P,
        null,
        E("sig-p", "external"),
        snap([P], [E("sig-p", "external")]),
      ),
    ).toEqual([]);
  });

  test("a provider already recorded is not attached or found twice", () => {
    const a = S("sig-a");
    const recorded = I("inc-1", "waiting-on-provider", {
      signalIds: ["sig-a", "sig-p"],
      findings: [
        {
          id: "f1",
          kind: "external",
          at: iso(),
          signalId: "sig-p",
          detail: "",
        },
      ],
    });
    expect(
      decide(
        P,
        "unknown",
        E("sig-p", "external"),
        snap(
          [a, P],
          [E("sig-a", "failing"), E("sig-p", "external")],
          [recorded],
        ),
      ),
    ).toEqual([
      {
        op: "event",
        incidentId: "inc-1",
        signalId: "sig-p",
        signalState: "external",
        detail: "3 failures in a row",
      },
    ]);
  });

  test("a provider declared through dependsOn counts across projects", () => {
    const c = S("sig-c", { project: "acme-api", dependsOn: ["sig-p"] });
    expect(
      decide(
        c,
        "ok",
        E("sig-c", "failing"),
        snap([c, P], [E("sig-c", "failing"), E("sig-p", "external")]),
      )[0],
    ).toMatchObject({ incident: { state: "waiting-on-provider" } });
  });

  test("provider recovery: resolved when ours is fine, back to investigating when not", () => {
    const a = S("sig-a");
    const waiting = I("inc-1", "waiting-on-provider", {
      signalIds: ["sig-a", "sig-p"],
      findings: [
        {
          id: "f1",
          kind: "external",
          at: iso(),
          signalId: "sig-p",
          detail: "",
        },
      ],
    });
    const recovered = decide(
      P,
      "external",
      E("sig-p", "ok"),
      snap([a, P], [E("sig-a", "ok"), E("sig-p", "ok")], [waiting]),
    );
    expect(recovered).toContainEqual({
      op: "resolve-finding",
      incidentId: "inc-1",
      kind: "external",
      signalId: "sig-p",
    });
    expect(recovered.at(-1)).toEqual({
      op: "transition",
      incidentId: "inc-1",
      to: "resolved",
      fixedBy: "provider-recovered",
      detail: "Status recovered",
    });
    expect(
      decide(
        P,
        "external",
        E("sig-p", "ok"),
        snap([a, P], [E("sig-a", "failing"), E("sig-p", "ok")], [waiting]),
      ).at(-1),
    ).toMatchObject({
      to: "investigating",
      detail: "Status recovered, Search still failing",
    });
    expect(
      decide(
        a,
        "failing",
        E("sig-a", "ok"),
        snap([a, P], [E("sig-a", "ok"), E("sig-p", "external")], [waiting]),
      ).at(-1),
    ).toMatchObject({
      to: "resolved",
      fixedBy: "provider-recovered",
      detail: "Recovered while a provider had a problem",
    });
  });

  test("one provider recovering while another is still out keeps waiting", () => {
    const a = S("sig-a");
    const Q = S("sig-q", { name: "Cloud", provider: true });
    const waiting = I("inc-1", "waiting-on-provider", {
      signalIds: ["sig-a", "sig-p", "sig-q"],
      findings: [
        {
          id: "f1",
          kind: "external",
          at: iso(),
          signalId: "sig-p",
          detail: "",
        },
        {
          id: "f2",
          kind: "external",
          at: iso(),
          signalId: "sig-q",
          detail: "",
        },
      ],
    });
    const ops = decide(
      P,
      "external",
      E("sig-p", "ok"),
      snap(
        [a, P, Q],
        [E("sig-a", "ok"), E("sig-p", "ok"), E("sig-q", "external")],
        [waiting],
      ),
    );
    expect(ops.some((o) => o.op === "transition")).toBe(false);
    expect(ops).toContainEqual({
      op: "resolve-finding",
      incidentId: "inc-1",
      kind: "external",
      signalId: "sig-p",
    });
  });

  test("self-reported ok while a real check fails is a finding, deduplicated and resolved", () => {
    const a = S("sig-a");
    const R = S("sig-r", { name: "Health", selfReported: true });
    const [open] = decide(
      a,
      "ok",
      E("sig-a", "failing"),
      snap([a, R], [E("sig-a", "failing"), E("sig-r", "ok")]),
    );
    expect(open).toMatchObject({
      incident: {
        findings: [
          {
            kind: "disagreement",
            signalId: "sig-r",
            againstSignalId: "sig-a",
            detail: "Health reports ok while Search is failing",
          },
        ],
      },
    });
    const withFinding = I("inc-1", "investigating", {
      findings: [
        {
          id: "f",
          kind: "disagreement",
          at: iso(),
          signalId: "sig-r",
          againstSignalId: "sig-a",
          detail: "",
        },
      ],
    });
    expect(
      decide(
        R,
        "unknown",
        E("sig-r", "ok"),
        snap([a, R], [E("sig-a", "failing"), E("sig-r", "ok")], [withFinding]),
      ),
    ).toEqual([]);
    expect(
      decide(
        R,
        "unknown",
        E("sig-r", "ok"),
        snap(
          [a, R],
          [E("sig-a", "failing"), E("sig-r", "ok")],
          [I("inc-1", "investigating")],
        ),
      ),
    ).toEqual([
      {
        op: "finding",
        incidentId: "inc-1",
        finding: expect.objectContaining({
          kind: "disagreement",
          signalId: "sig-r",
          againstSignalId: "sig-a",
        }),
      },
    ]);
    expect(
      decide(
        a,
        "failing",
        E("sig-a", "ok"),
        snap([a, R], [E("sig-a", "ok"), E("sig-r", "ok")], [withFinding]),
      ),
    ).toContainEqual({
      op: "resolve-finding",
      incidentId: "inc-1",
      kind: "disagreement",
      againstSignalId: "sig-a",
    });
    expect(
      decide(
        R,
        "ok",
        E("sig-r", "unknown", "No usable data yet: x"),
        snap(
          [a, R],
          [E("sig-a", "failing"), E("sig-r", "unknown")],
          [withFinding],
        ),
      ),
    ).toEqual([
      {
        op: "resolve-finding",
        incidentId: "inc-1",
        kind: "disagreement",
        signalId: "sig-r",
      },
    ]);
  });

  test("a self-reported signal that starts failing ends its disagreements", () => {
    const a = S("sig-a");
    const R = S("sig-r", { name: "Health", selfReported: true });
    const withFinding = I("inc-1", "investigating", {
      findings: [
        {
          id: "f",
          kind: "disagreement",
          at: iso(),
          signalId: "sig-r",
          againstSignalId: "sig-a",
          detail: "",
        },
      ],
    });
    const ops = decide(
      R,
      "ok",
      E("sig-r", "failing"),
      snap(
        [a, R],
        [E("sig-a", "failing"), E("sig-r", "failing")],
        [withFinding],
      ),
    );
    expect(ops).toEqual([
      {
        op: "attach",
        incidentId: "inc-1",
        signalId: "sig-r",
        signalState: "failing",
        detail: "3 failures in a row",
      },
      {
        op: "resolve-finding",
        incidentId: "inc-1",
        kind: "disagreement",
        signalId: "sig-r",
      },
    ]);
  });

  test("findings come after events and before transitions on an existing incident", () => {
    const a = S("sig-a");
    const R = S("sig-r", { name: "Health", selfReported: true });
    const ops = decide(
      a,
      "flaky",
      E("sig-a", "failing"),
      snap(
        [a, R],
        [E("sig-a", "failing"), E("sig-r", "ok")],
        [I("inc-1", "heads-up")],
      ),
    );
    expect(ops.map((o) => o.op)).toEqual(["event", "finding", "transition"]);
  });

  test("a failing self-reported signal is an ordinary own signal", () => {
    const R = S("sig-r", { name: "Health", selfReported: true });
    const a = S("sig-a");
    expect(
      decide(
        R,
        "ok",
        E("sig-r", "failing"),
        snap([a, R], [E("sig-a", "ok"), E("sig-r", "failing")]),
      ),
    ).toEqual([
      expect.objectContaining({
        op: "open",
        incident: expect.objectContaining({
          state: "investigating",
          signalIds: ["sig-r"],
        }),
      }),
    ]);
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
