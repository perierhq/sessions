import { describe, expect, test } from "bun:test";
import type { Signal } from "../../shared/incidents";
import { flapReportMarkdown, triageFlaps } from "./flaps";
import {
  NOW,
  PROJECT,
  SIGNALS,
  fixtureIncidents,
  incident,
} from "./testing/fixture";

const DAY = 86_400_000;

function report() {
  return triageFlaps({
    project: PROJECT,
    signals: SIGNALS,
    incidents: fixtureIncidents(),
    now: NOW,
  });
}

function bySignal(id: string) {
  const r = report().signals.find((s) => s.signalId === id);
  if (!r) throw new Error(`no report for ${id}`);
  return r;
}

describe("triageFlaps on a status page and a provider that flap", () => {
  test("the status page flaps and should need more failures in a row", () => {
    const status = bySignal("sig-status");
    expect(status).toMatchObject({
      classification: "flapping",
      opened: 16,
      closedWithoutAction: 16,
      resolved: 0,
      resolvedWithAction: 0,
      stillOpen: 0,
      provider: false,
      selfClosed: { minutes: 30, count: 16, share: 1 },
      medianOpenMs: 4 * 60_000,
      maxOpenMs: 6 * 60_000,
    });
    // Open 6 min at most, plus one more check to open (3) than to close
    // (2): a 7-minute bad run, so 8 failures in a row ride it out.
    expect(status.proposal?.change).toEqual({
      rule: { kind: "consecutive", failures: 8, recoveries: 2 },
    });
    expect(status.proposal?.reason).toBe(
      "Opened 16 times in 14 days; 16 closed by themselves within 30 min (median 4 min, longest 6 min). Needing 8 failures in a row instead of 3 rides out the longest flap (7 min at one check every 1 min).",
    );
  });

  test("the outside provider should be marked a provider", () => {
    const rail = bySignal("sig-rail");
    expect(rail.classification).toBe("flapping");
    expect(rail.opened).toBe(16);
    expect(rail.proposal?.change).toEqual({ provider: true });
    expect(rail.proposal?.reason).toContain(
      "It polls api.railco.example, outside acme.example where the project's other signals point",
    );
  });

  test("the site had a real outage, and the certificates are quiet", () => {
    const site = bySignal("sig-site");
    expect(site).toMatchObject({
      classification: "real-outages",
      opened: 1,
      resolved: 1,
      resolvedWithAction: 1,
      selfClosed: { count: 0, share: 0 },
      maxOpenMs: 45 * 60_000,
    });
    expect(site.proposal).toBeUndefined();
    expect(bySignal("sig-cert").classification).toBe("quiet");
    expect(bySignal("sig-cert-www").classification).toBe("quiet");
  });

  test("counts, order and window", () => {
    const r = report();
    expect(r.counts).toEqual({
      flapping: 2,
      "real-outages": 1,
      quiet: 2,
      mixed: 0,
    });
    expect(r.signals.map((s) => s.signalId)).toEqual([
      "sig-rail",
      "sig-status",
      "sig-site",
      "sig-cert",
      "sig-cert-www",
    ]);
    expect(r.from).toBe(new Date(NOW - 14 * DAY).toISOString());
    expect(r.orphanIncidents).toBe(0);
  });

  test("the same input gives the same report", () => {
    expect(JSON.stringify(report())).toBe(JSON.stringify(report()));
  });

  test("markdown names each signal and the proposals", () => {
    const md = flapReportMarkdown(report());
    expect(md.split("\n")[0]).toBe(
      "Signals over the last 14 days: 2 flapping, 1 with real outages, 0 mixed, 2 quiet.",
    );
    expect(md).toContain(
      "- Status page (`sig-status`): flapping; 16 opened, 16 closed by themselves within 30 min, 0 fixed, median open 4 min",
    );
    expect(md).toContain('Proposed: `{"provider":true}`');
  });
});

describe("triageFlaps edges", () => {
  const status = SIGNALS[0]!;

  test("a mix of flaps and fixed outages is mixed, with no proposal", () => {
    const incidents = [
      incident({
        signalId: status.id,
        openedAt: NOW - DAY,
        openMinutes: 3,
        state: "closed-without-action",
      }),
      incident({
        signalId: status.id,
        openedAt: NOW - 2 * DAY,
        openMinutes: 90,
        state: "resolved",
        fixedBy: "agents",
      }),
    ];
    const r = triageFlaps({
      project: PROJECT,
      signals: [status],
      incidents,
      now: NOW,
    });
    expect(r.signals[0]!.classification).toBe("mixed");
    expect(r.signals[0]!.proposal).toBeUndefined();
  });

  test("two flaps are too few to call it flapping", () => {
    const incidents = [1, 2].map((d) =>
      incident({
        signalId: status.id,
        openedAt: NOW - d * DAY,
        openMinutes: 3,
        state: "closed-without-action",
      }),
    );
    const r = triageFlaps({
      project: PROJECT,
      signals: [status],
      incidents,
      now: NOW,
    });
    expect(r.signals[0]!.classification).toBe("mixed");
  });

  test("closing by itself after the cutoff is not a flap", () => {
    const incidents = [1, 2, 3].map((d) =>
      incident({
        signalId: status.id,
        openedAt: NOW - d * DAY,
        openMinutes: 40,
        state: "closed-without-action",
      }),
    );
    const r = triageFlaps({
      project: PROJECT,
      signals: [status],
      incidents,
      now: NOW,
    });
    expect(r.signals[0]).toMatchObject({
      classification: "real-outages",
      selfClosed: { count: 0 },
    });
    // A wider cutoff counts them.
    const wide = triageFlaps({
      project: PROJECT,
      signals: [status],
      incidents,
      now: NOW,
      selfCloseMinutes: 60,
    });
    expect(wide.signals[0]!.classification).toBe("flapping");
  });

  test("still-open incidents count as opened, not as flaps", () => {
    const incidents = [
      incident({
        signalId: status.id,
        openedAt: NOW - 3_600_000,
        openMinutes: null,
        state: "investigating",
      }),
    ];
    const r = triageFlaps({
      project: PROJECT,
      signals: [status],
      incidents,
      now: NOW,
    });
    expect(r.signals[0]).toMatchObject({
      classification: "real-outages",
      stillOpen: 1,
      medianOpenMs: null,
    });
  });

  test("long flaps on a consecutive rule become a rate rule", () => {
    const incidents = [1, 2, 3, 4].map((d) =>
      incident({
        signalId: status.id,
        openedAt: NOW - d * DAY,
        openMinutes: 20,
        state: "closed-without-action",
      }),
    );
    const r = triageFlaps({
      project: PROJECT,
      signals: [status],
      incidents,
      now: NOW,
    });
    // A 21-minute bad run: 22 in a row is too slow, so 60% of a 45-minute
    // window (twice the run, rounded up to 5 minutes).
    expect(r.signals[0]!.proposal?.change).toEqual({
      rule: { kind: "rate", windowMs: 45 * 60_000, atLeast: 27, ratio: 0.6 },
    });
  });

  test("a threshold rule holds longer", () => {
    const slow: Signal = {
      ...status,
      rule: { kind: "threshold", above: 2000, forMs: 120_000 },
    };
    const incidents = [1, 2, 3].map((d) =>
      incident({
        signalId: slow.id,
        openedAt: NOW - d * DAY,
        openMinutes: 5,
        state: "closed-without-action",
      }),
    );
    const r = triageFlaps({
      project: PROJECT,
      signals: [slow],
      incidents,
      now: NOW,
    });
    // Bad run 5 + (1 - 2) = 4 min; the longer of twice 2 min and 4 + 1.
    expect(r.signals[0]!.proposal?.change).toEqual({
      rule: { kind: "threshold", above: 2000, forMs: 5 * 60_000 },
    });
  });

  test("an already-marked provider gets a rule change instead", () => {
    const rail = { ...SIGNALS[1]!, provider: true };
    const r = triageFlaps({
      project: PROJECT,
      signals: [rail, ...SIGNALS.slice(2)],
      incidents: fixtureIncidents(),
      now: NOW,
    });
    const report = r.signals.find((s) => s.signalId === "sig-rail")!;
    expect(report.provider).toBe(true);
    // Open 6 min at most, as many checks to open as to close: 7 in a row.
    expect(report.proposal?.change).toEqual({
      rule: { kind: "consecutive", failures: 7, recoveries: 2 },
    });
  });

  test("other projects and deleted signals are left out", () => {
    const incidents = [
      incident({
        signalId: status.id,
        project: "other",
        openedAt: NOW - DAY,
        openMinutes: 3,
        state: "closed-without-action",
      }),
      incident({
        signalId: "sig-gone",
        openedAt: NOW - DAY,
        openMinutes: 3,
        state: "closed-without-action",
      }),
    ];
    const r = triageFlaps({
      project: PROJECT,
      signals: [status, { ...SIGNALS[1]!, project: "other" }],
      incidents,
      now: NOW,
    });
    expect(r.signals.map((s) => s.signalId)).toEqual(["sig-status"]);
    expect(r.signals[0]!.opened).toBe(0);
    expect(r.orphanIncidents).toBe(1);
  });
});
