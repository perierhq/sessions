import { expect, test } from "bun:test";
import type { Incident, IncidentImpact, Signal } from "../../shared/incidents";
import { createIncident, getIncident, updateIncident } from "./incident-store";
import {
  type ImpactDeps,
  measureImpact,
  refreshIncidentImpacts,
} from "./impact";
import { createSignal, updateSignal } from "./signal-store";
import type { SourceRun } from "./sources";
import { useIncidentTestKernel } from "./testing/kernel-fixture";

useIncidentTestKernel();

const OPENED = "2026-10-20T10:00:00.000Z";
const NOW = Date.parse("2026-10-20T10:30:00Z");
const signal: Signal = {
  id: "sig-a",
  name: "Search",
  project: "acme",
  enabled: true,
  severity: "major",
  source: { kind: "http", url: "https://acme.example.test/search" },
  rule: { kind: "consecutive", failures: 3 },
  createdBy: "Ada",
  createdAt: OPENED,
  updatedAt: OPENED,
};
const httpImpact = {
  kind: "http",
  url: "https://logs.example.test/c?since={{since}}",
  countPath: "$.failed",
  peoplePath: "$.users",
  noun: "searches failed",
  label: "the request log",
} as const;
const withHttpImpact: Signal = { ...signal, impact: httpImpact };
const hookSignal: Signal = {
  ...signal,
  id: "sig-hook",
  name: "Errors",
  source: { kind: "webhook" },
  rule: { kind: "rate", windowMs: 300_000, atLeast: 5 },
};
const incident: Incident = {
  id: "inc-a",
  project: "acme",
  title: "Search is failing",
  state: "investigating",
  severity: "major",
  owner: "Ada",
  openedBy: { kind: "rule", ref: "sig-a" },
  signalIds: ["sig-a"],
  primarySignalId: "sig-a",
  openedAt: OPENED,
  updatedAt: OPENED,
  lastProblemAt: OPENED,
  findings: [],
  events: [],
  droppedEvents: 0,
};

const run = (
  matches: Record<string, unknown[]>,
  result: "ok" | "fail" = "ok",
): SourceRun => ({
  observations: [
    {
      at: "t",
      result,
      detail: result === "ok" ? "HTTP 200 in 9 ms" : "HTTP 503 (expected 2xx)",
    },
  ],
  preview: { bodyHead: "", bodyTruncated: false, matches },
});

test("an http impact counts failures and people since the incident opened", async () => {
  const seen: Signal[] = [];
  const out = await measureImpact(
    {
      incident,
      signal: { ...signal, runOn: "runner-prod", impact: httpImpact },
    },
    {
      runSource: async (s) => {
        seen.push(s);
        return run({ "$.failed": [140], "$.users": ["23"] });
      },
      now: () => NOW,
    },
  );
  expect(out).toEqual({
    signalId: "sig-a",
    at: new Date(NOW).toISOString(),
    count: 140,
    people: 23,
    approximate: true,
    noun: "searches failed",
    label: "the request log",
  });
  expect(seen[0]).toMatchObject({
    runOn: "runner-prod",
    provider: false,
    source: {
      url: `https://logs.example.test/c?since=${encodeURIComponent(incident.openedAt)}`,
      json: { value: "$.failed", detail: "$.users" },
    },
  });
});

test("the first usable number counts; sinceMs is epoch milliseconds", async () => {
  const seen: Signal[] = [];
  const out = await measureImpact(
    {
      incident,
      signal: {
        ...signal,
        impact: {
          kind: "http",
          url: "https://logs.example.test/c?from={{sinceMs}}",
          countPath: "$.rows[*].n",
          noun: "requests failed",
          label: "the request log",
        },
      },
    },
    {
      runSource: async (s) => {
        seen.push(s);
        return run({ "$.rows[*].n": [null, -1, "x", "12", 30] });
      },
      now: () => NOW,
    },
  );
  expect(out).toMatchObject({ count: 12 });
  expect(out.people).toBeUndefined();
  expect(seen[0]?.source).toMatchObject({
    url: `https://logs.example.test/c?from=${Date.parse(OPENED)}`,
    json: { value: "$.rows[*].n" },
  });
});

test("a failed query keeps the last numbers and says why", async () => {
  const previous: IncidentImpact = {
    signalId: "sig-a",
    at: "x",
    count: 90,
    approximate: true,
    noun: "searches failed",
    label: "the request log",
  };
  expect(
    await measureImpact(
      { incident, signal: withHttpImpact, previous },
      { runSource: async () => run({}, "fail"), now: () => NOW },
    ),
  ).toMatchObject({ count: 90, error: "HTTP 503 (expected 2xx)" });
  expect(
    await measureImpact(
      { incident, signal: withHttpImpact, previous },
      { runSource: async () => run({ "$.failed": [] }), now: () => NOW },
    ),
  ).toMatchObject({ count: 90, error: "Nothing at $.failed" });
  expect(
    await measureImpact(
      { incident, signal: withHttpImpact },
      {
        runSource: async () => {
          throw new Error("socket closed");
        },
        now: () => NOW,
      },
    ),
  ).toMatchObject({ error: "socket closed", noun: "searches failed" });
});

test("webhook events count from stored observations", async () => {
  const asked: unknown[] = [];
  const out = await measureImpact(
    {
      incident,
      signal: {
        ...hookSignal,
        impact: {
          kind: "events",
          count: "value-sum",
          noun: "errors",
          label: "Sentry",
        },
      },
    },
    {
      observations: async (...args) => {
        asked.push(args);
        return [
          { at: "1", result: "fail", value: 3, detail: "" },
          { at: "2", result: "ok", value: 9, detail: "" },
          { at: "3", result: "fail", value: 4, detail: "" },
        ];
      },
      now: () => NOW,
    },
  );
  expect(out).toMatchObject({ count: 7, approximate: false, noun: "errors" });
  expect(out.people).toBeUndefined();
  expect(asked[0]).toEqual(["sig-hook", Date.parse(OPENED), NOW, { lane: "" }]);
  const failures = await measureImpact(
    {
      incident: { ...incident, closedAt: "2026-10-20T10:20:00.000Z" },
      signal: {
        ...hookSignal,
        impact: {
          kind: "events",
          count: "fail-events",
          noun: "errors",
          label: "Sentry",
        },
      },
    },
    {
      observations: async (...args) => {
        asked.push(args);
        return [
          { at: "1", result: "fail", detail: "" },
          { at: "2", result: "ok", detail: "" },
          { at: "3", result: "fail", detail: "" },
        ];
      },
      now: () => NOW,
    },
  );
  expect(failures).toMatchObject({ count: 2 });
  expect((asked[1] as unknown[])[2]).toBe(
    Date.parse("2026-10-20T10:20:00.000Z"),
  );
});

async function openIncidentWithImpact() {
  const s = await createSignal(
    {
      name: "Search",
      project: "acme",
      source: { kind: "http", url: "https://acme.example.test/search" },
      impact: httpImpact,
    },
    "Ada",
  );
  if ("error" in s) throw new Error(s.error);
  const plain = await createSignal(
    {
      name: "Api",
      project: "acme",
      source: { kind: "http", url: "https://acme.example.test/api" },
    },
    "Ada",
  );
  if ("error" in plain) throw new Error(plain.error);
  const inc = await createIncident({
    project: "acme",
    title: "Search is failing",
    state: "investigating",
    severity: "major",
    owner: "Ada",
    openedBy: incident.openedBy,
    signalIds: ["sig-gone", plain.id, s.id],
    primarySignalId: plain.id,
    at: OPENED,
    detail: "Search failed 3 times",
  });
  return { s, inc };
}

test("refresh writes only when the numbers change", async () => {
  const { s, inc } = await openIncidentWithImpact();
  const counts = [140, 140, 150];
  const queried: string[] = [];
  const deps: Partial<ImpactDeps> = {
    runSource: async (signal) => {
      queried.push(signal.id);
      return run({ "$.failed": [counts.shift()], "$.users": [3] });
    },
  };
  expect(await refreshIncidentImpacts(NOW, deps)).toBe(1);
  expect(await refreshIncidentImpacts(NOW + 60_000, deps)).toBe(0);
  expect((await getIncident(inc.id))?.impact?.at).toBe(
    new Date(NOW).toISOString(),
  );
  expect(await refreshIncidentImpacts(NOW + 120_000, deps)).toBe(1);
  expect((await getIncident(inc.id))?.impact).toMatchObject({
    signalId: s.id,
    count: 150,
    people: 3,
  });
  expect(queried).toEqual([s.id, s.id, s.id]);
});

test("a closed incident gets one last measurement, then none", async () => {
  const { inc } = await openIncidentWithImpact();
  const closedAt = new Date(NOW - 60_001).toISOString();
  await updateIncident(inc.id, (c) => ({
    ...c,
    state: "resolved",
    closedAt,
  }));
  let runs = 0;
  const deps: Partial<ImpactDeps> = {
    runSource: async () => {
      runs++;
      return run({ "$.failed": [200] });
    },
  };
  expect(await refreshIncidentImpacts(NOW, deps)).toBe(1);
  expect(await refreshIncidentImpacts(NOW + 10_000, deps)).toBe(0);
  expect(runs).toBe(1);
  expect((await getIncident(inc.id))?.impact?.count).toBe(200);
  // Closed more than an hour ago: left alone.
  const old = await openIncidentWithImpact();
  await updateIncident(old.inc.id, (c) => ({
    ...c,
    state: "resolved",
    closedAt: new Date(NOW - 3_600_001).toISOString(),
  }));
  expect(await refreshIncidentImpacts(NOW + 20_000, deps)).toBe(0);
  expect(runs).toBe(1);
});

test("the final measurement is written even when the numbers did not change", async () => {
  const { inc } = await openIncidentWithImpact();
  let runs = 0;
  const deps: Partial<ImpactDeps> = {
    runSource: async () => {
      runs++;
      return run({ "$.failed": [140] });
    },
  };
  expect(await refreshIncidentImpacts(NOW, deps)).toBe(1);
  const closedAt = new Date(NOW + 30_000).toISOString();
  await updateIncident(inc.id, (c) => ({ ...c, state: "resolved", closedAt }));
  expect(await refreshIncidentImpacts(NOW + 60_000, deps)).toBe(1);
  expect((await getIncident(inc.id))?.impact).toMatchObject({
    count: 140,
    at: new Date(NOW + 60_000).toISOString(),
  });
  expect(await refreshIncidentImpacts(NOW + 120_000, deps)).toBe(0);
  expect(runs).toBe(2);
});

test("an incident without an impact signal is not written", async () => {
  const plain = await createSignal(
    {
      name: "Api",
      project: "acme",
      source: { kind: "http", url: "https://acme.example.test/api" },
    },
    "Ada",
  );
  if ("error" in plain) throw new Error(plain.error);
  const inc = await createIncident({
    project: "acme",
    title: "Api is failing",
    state: "investigating",
    severity: "major",
    owner: "Ada",
    openedBy: incident.openedBy,
    signalIds: [plain.id],
    primarySignalId: plain.id,
    at: OPENED,
    detail: "Api failed 3 times",
  });
  expect(
    await refreshIncidentImpacts(NOW, {
      runSource: async () => run({ "$.failed": [1] }),
    }),
  ).toBe(0);
  expect((await getIncident(inc.id))?.impact).toBeUndefined();
});

test("a disabled impact signal is skipped for the next one", async () => {
  const { s, inc } = await openIncidentWithImpact();
  const off = await updateSignal(s.id, { enabled: false }, "Ada");
  if (!off || "error" in off) throw new Error("update failed");
  const queried: string[] = [];
  const deps: Partial<ImpactDeps> = {
    runSource: async (signal) => {
      queried.push(signal.id);
      return run({ "$.failed": [1] });
    },
  };
  expect(await refreshIncidentImpacts(NOW, deps)).toBe(0);
  expect(queried).toEqual([]);
  expect((await getIncident(inc.id))?.impact).toBeUndefined();
  const next = await createSignal(
    {
      name: "Search log",
      project: "acme",
      source: { kind: "http", url: "https://acme.example.test/log" },
      impact: httpImpact,
    },
    "Ada",
  );
  if ("error" in next) throw new Error(next.error);
  await updateIncident(inc.id, (c) => ({
    ...c,
    signalIds: [...c.signalIds, next.id],
  }));
  expect(await refreshIncidentImpacts(NOW, deps)).toBe(1);
  expect(queried).toEqual([next.id]);
});
