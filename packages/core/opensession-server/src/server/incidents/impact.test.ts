import { beforeEach, expect, spyOn, test } from "bun:test";
import type {
  Incident,
  IncidentImpact,
  Observation,
  Signal,
} from "../../shared/incidents";
import * as incidentStore from "./incident-store";
import { createIncident, getIncident, updateIncident } from "./incident-store";
import {
  type ImpactDeps,
  __resetImpactForTest,
  measureImpact,
  refreshIncidentImpacts,
} from "./impact";
import { createSignal, updateSignal } from "./signal-store";
import { isBlockedAddress } from "../shared/network-address";
import {
  runSignalSource,
  type SourceRun,
  type SourceRunOptions,
} from "./sources";
import { useIncidentTestKernel } from "./testing/kernel-fixture";

useIncidentTestKernel();
beforeEach(() => __resetImpactForTest());

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

const previousOf = (count: number) => ({
  signalId: "sig-a",
  at: "x",
  count,
  approximate: true,
  noun: "searches failed",
  label: "the request log",
});

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

test("until is now while open and the close once closed", async () => {
  const seen: string[] = [];
  const deps: Partial<ImpactDeps> = {
    runSource: async (s) => {
      seen.push((s.source as { url: string }).url);
      return run({ "$.n": [1] });
    },
    now: () => NOW,
  };
  const untilSignal: Signal = {
    ...signal,
    impact: {
      ...httpImpact,
      url: "https://logs.example.test/c?to={{until}}&toMs={{untilMs}}",
      countPath: "$.n",
    },
  };
  await measureImpact({ incident, signal: untilSignal }, deps);
  const closedAt = "2026-10-20T10:20:00.000Z";
  await measureImpact(
    {
      incident: { ...incident, state: "resolved", closedAt },
      signal: untilSignal,
    },
    deps,
  );
  expect(seen).toEqual([
    `https://logs.example.test/c?to=${encodeURIComponent(new Date(NOW).toISOString())}&toMs=${NOW}`,
    `https://logs.example.test/c?to=${encodeURIComponent(closedAt)}&toMs=${Date.parse(closedAt)}`,
  ]);
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

type Scan = NonNullable<ImpactDeps["scan"]>;

/** A scan over `list` that records every range it was asked for. */
function scanOf(list: Observation[], asked: unknown[][] = []): Scan {
  return async (signalId, from, to, visit, opts) => {
    asked.push([signalId, from, to, opts]);
    for (const o of list) {
      const at = Date.parse(o.at);
      if (at >= from && at <= to) visit(o);
    }
  };
}

const at = (iso: string) => new Date(iso).toISOString();
const sumImpact = {
  kind: "events",
  count: "value-sum",
  noun: "errors",
  label: "Sentry",
} as const;
const failImpact = { ...sumImpact, count: "fail-events" } as const;

test("webhook events count from stored observations", async () => {
  const asked: unknown[][] = [];
  const out = await measureImpact(
    { incident, signal: { ...hookSignal, impact: sumImpact } },
    {
      scan: scanOf(
        [
          {
            at: at("2026-10-20T10:01:00Z"),
            result: "fail",
            value: 3,
            detail: "",
          },
          {
            at: at("2026-10-20T10:02:00Z"),
            result: "ok",
            value: 9,
            detail: "",
          },
          {
            at: at("2026-10-20T10:03:00Z"),
            result: "fail",
            value: 4,
            detail: "",
          },
        ],
        asked,
      ),
      now: () => NOW,
    },
  );
  expect(out).toMatchObject({ count: 7, approximate: false, noun: "errors" });
  expect(out.people).toBeUndefined();
  expect(asked[0]).toEqual(["sig-hook", Date.parse(OPENED), NOW, { lane: "" }]);
  const failures = await measureImpact(
    {
      incident: { ...incident, closedAt: "2026-10-20T10:20:00.000Z" },
      signal: { ...hookSignal, impact: failImpact },
    },
    {
      scan: scanOf(
        [
          { at: at("2026-10-20T10:01:00Z"), result: "fail", detail: "" },
          { at: at("2026-10-20T10:02:00Z"), result: "ok", detail: "" },
          { at: at("2026-10-20T10:03:00Z"), result: "fail", detail: "" },
          { at: at("2026-10-20T10:25:00Z"), result: "fail", detail: "" },
        ],
        asked,
      ),
      now: () => NOW,
    },
  );
  expect(failures).toMatchObject({ count: 2 });
  expect(asked[1]?.[2]).toBe(Date.parse("2026-10-20T10:20:00.000Z"));
});

test("finished UTC days are counted once; today is scanned again", async () => {
  const opened = "2026-10-17T22:00:00.000Z";
  const list: Observation[] = [
    { at: at("2026-10-17T21:00:00Z"), result: "fail", value: 100, detail: "" },
    { at: at("2026-10-17T23:00:00Z"), result: "fail", value: 1, detail: "" },
    { at: at("2026-10-18T00:00:00Z"), result: "fail", value: 2, detail: "" },
    {
      at: at("2026-10-19T23:59:59.999Z"),
      result: "fail",
      value: 4,
      detail: "",
    },
    { at: at("2026-10-20T00:00:00Z"), result: "fail", value: 8, detail: "" },
  ];
  const asked: unknown[][] = [];
  const input = {
    incident: { ...incident, openedAt: opened },
    signal: { ...hookSignal, impact: sumImpact },
  };
  const first = await measureImpact(input, {
    scan: scanOf(list, asked),
    now: () => NOW,
  });
  expect(first.count).toBe(15);
  expect(asked.map((a) => [a[1], a[2]])).toEqual([
    [Date.parse(opened), Date.parse("2026-10-18T00:00:00Z") - 1],
    [
      Date.parse("2026-10-18T00:00:00Z"),
      Date.parse("2026-10-19T00:00:00Z") - 1,
    ],
    [
      Date.parse("2026-10-19T00:00:00Z"),
      Date.parse("2026-10-20T00:00:00Z") - 1,
    ],
    [Date.parse("2026-10-20T00:00:00Z"), NOW],
  ]);
  list.push({
    at: at("2026-10-20T10:31:00Z"),
    result: "fail",
    value: 16,
    detail: "",
  });
  asked.length = 0;
  const second = await measureImpact(input, {
    scan: scanOf(list, asked),
    now: () => NOW + 60_000,
  });
  expect(second.count).toBe(31);
  expect(asked.map((a) => [a[1], a[2]])).toEqual([
    [Date.parse("2026-10-20T00:00:00Z"), NOW + 60_000],
  ]);
  // Fail events read the same cached days; another signal has its own.
  asked.length = 0;
  const events = await measureImpact(
    { ...input, signal: { ...hookSignal, impact: failImpact } },
    { scan: scanOf(list, asked), now: () => NOW + 60_000 },
  );
  expect(events.count).toBe(5);
  expect(asked).toHaveLength(1);
  asked.length = 0;
  await measureImpact(
    { ...input, signal: { ...hookSignal, id: "sig-other", impact: sumImpact } },
    { scan: scanOf(list, asked), now: () => NOW + 60_000 },
  );
  expect(asked).toHaveLength(4);
});

test("events count at most the last 31 days, approximate past retention", async () => {
  const DAY = 86_400_000;
  const measure = async (openedMs: number) => {
    __resetImpactForTest();
    const asked: unknown[][] = [];
    const out = await measureImpact(
      {
        incident: { ...incident, openedAt: new Date(openedMs).toISOString() },
        signal: { ...hookSignal, impact: failImpact },
      },
      { scan: scanOf([], asked), now: () => NOW },
    );
    return { out, from: asked[0]?.[1], spans: asked.length };
  };
  const long = await measure(NOW - 40 * DAY);
  expect(long.out).toMatchObject({ count: 0, approximate: true });
  expect(long.from).toBe(NOW - 31 * DAY);
  const pastRetention = await measure(NOW - 30 * DAY - 3_600_000);
  expect(pastRetention.out.approximate).toBe(true);
  expect(pastRetention.from).toBe(NOW - 30 * DAY - 3_600_000);
  const within = await measure(NOW - 29 * DAY);
  expect(within.out.approximate).toBe(false);
  expect(within.spans).toBe(30);
});

test("a failed event read keeps the last numbers", async () => {
  const previous: IncidentImpact = {
    signalId: "sig-hook",
    at: "x",
    count: 12,
    approximate: false,
    noun: "errors",
    label: "Sentry",
  };
  const out = await measureImpact(
    { incident, signal: { ...hookSignal, impact: sumImpact }, previous },
    {
      scan: async () => {
        throw new Error("disk read failed");
      },
      now: () => NOW,
    },
  );
  expect(out).toMatchObject({
    count: 12,
    approximate: false,
    error: "disk read failed",
  });
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

async function impactSignal(name: string) {
  const s = await createSignal(
    {
      name,
      project: "acme",
      source: { kind: "http", url: `https://acme.example.test/${name}` },
      impact: httpImpact,
    },
    "Ada",
  );
  if ("error" in s) throw new Error(s.error);
  return s;
}

async function openOn(signalId: string, openedAt = OPENED) {
  return createIncident({
    project: "acme",
    title: `${signalId} is failing`,
    state: "investigating",
    severity: "major",
    owner: "Ada",
    openedBy: incident.openedBy,
    signalIds: [signalId],
    primarySignalId: signalId,
    at: openedAt,
    detail: "failed 3 times",
  });
}

test("at most four impact queries run at once, each bounded to 5 s", async () => {
  for (let i = 0; i < 6; i++) await openOn((await impactSignal(`s${i}`)).id);
  let running = 0;
  let most = 0;
  const timeouts: unknown[] = [];
  const written = await refreshIncidentImpacts(NOW, {
    runSource: async (s) => {
      timeouts.push((s.source as { timeoutMs?: number }).timeoutMs);
      running++;
      most = Math.max(most, running);
      await Bun.sleep(5);
      running--;
      return run({ "$.failed": [1] });
    },
  });
  expect(written).toBe(6);
  expect(most).toBe(4);
  expect(timeouts).toEqual(Array(6).fill(5_000));
});

test("an impact query that does not answer in time keeps the last numbers", async () => {
  const s = await impactSignal("slow");
  const inc = await openOn(s.id);
  await updateIncident(inc.id, (c) => ({
    ...c,
    impact: {
      signalId: s.id,
      at: OPENED,
      count: 7,
      approximate: true,
      noun: "searches failed",
      label: "the request log",
    },
  }));
  expect(
    await refreshIncidentImpacts(NOW, {
      runSource: () => new Promise(() => {}),
      queryTimeoutMs: 20,
    }),
  ).toBe(1);
  expect((await getIncident(inc.id))?.impact).toMatchObject({
    count: 7,
    error: "No answer within 20 ms",
  });
});

test("incidents of one signal opened together are measured once per tick", async () => {
  const s = await impactSignal("shared");
  const a = await openOn(s.id);
  const b = await openOn(s.id);
  const later = await openOn(s.id, "2026-10-20T10:10:00.000Z");
  const urls: string[] = [];
  expect(
    await refreshIncidentImpacts(NOW, {
      runSource: async (signal) => {
        urls.push((signal.source as { url: string }).url);
        return run({ "$.failed": [5] });
      },
    }),
  ).toBe(3);
  expect(urls).toHaveLength(2);
  for (const id of [a.id, b.id, later.id])
    expect((await getIncident(id))?.impact?.count).toBe(5);
});

test("one incident that fails to write does not stop the others", async () => {
  const bad = await openOn((await impactSignal("bad")).id);
  const good = await openOn((await impactSignal("good")).id);
  const realUpdate = incidentStore.updateIncident;
  const spy = spyOn(incidentStore, "updateIncident").mockImplementation(
    async (id, mutate) => {
      if (id === bad.id) throw new Error("store is down");
      return realUpdate(id, mutate);
    },
  );
  const logged: unknown[][] = [];
  const errors = spyOn(console, "error").mockImplementation((...args) => {
    logged.push(args);
  });
  try {
    expect(
      await refreshIncidentImpacts(NOW, {
        runSource: async () => run({ "$.failed": [2] }),
      }),
    ).toBe(1);
  } finally {
    spy.mockRestore();
    errors.mockRestore();
  }
  expect((await getIncident(good.id))?.impact?.count).toBe(2);
  expect((await getIncident(bad.id))?.impact).toBeUndefined();
  expect(logged).toEqual([
    [`[incidents] impact of ${bad.id} failed:`, "store is down"],
  ]);
});

test("a signal whose impact query keeps failing is backed off", async () => {
  const s = await impactSignal("flaky");
  await openOn(s.id);
  let runs = 0;
  let fail = true;
  const deps: Partial<ImpactDeps> = {
    runSource: async () => {
      runs++;
      return fail ? run({}, "fail") : run({ "$.failed": [3] });
    },
  };
  const MIN = 60_000;
  const tick = (t: number) => refreshIncidentImpacts(NOW + t, deps);
  for (const t of [0, 1, 2].map((m) => m * MIN)) await tick(t);
  expect(runs).toBe(3);
  // Three errors in a row: skipped for 5 minutes.
  await tick(3 * MIN);
  await tick(6 * MIN);
  expect(runs).toBe(3);
  await tick(7 * MIN + 1);
  expect(runs).toBe(4);
  // Failed again: the pause doubles to 10 minutes.
  await tick(16 * MIN);
  expect(runs).toBe(4);
  fail = false;
  await tick(17 * MIN + 2);
  expect(runs).toBe(5);
  // An answer clears the backoff.
  fail = true;
  await tick(18 * MIN);
  await tick(19 * MIN);
  expect(runs).toBe(7);
});

/** The real http source over a stubbed pinned network. */
function realHttp(
  respond: (url: URL, headers: Record<string, string>) => Response | Error,
  addresses = ["203.0.113.10"],
): { deps: Partial<ImpactDeps>; sent: string[] } {
  const sent: string[] = [];
  const net: SourceRunOptions["net"] = {
    resolve: async () => addresses,
    isBlocked: isBlockedAddress,
    send: async (target, init) => {
      sent.push(target.url.href);
      const answer = respond(target.url, init.headers ?? {});
      if (answer instanceof Error) throw answer;
      return {
        status: answer.status,
        headers: answer.headers,
        body: new Uint8Array(await answer.arrayBuffer()),
      };
    },
  };
  return {
    deps: {
      runSource: (s, opts) => runSignalSource(s, { ...opts, net }),
      now: () => NOW,
    },
    sent,
  };
}

const secretImpact: Signal = {
  ...signal,
  impact: {
    ...httpImpact,
    url: "https://logs.example.test/c?api_key=k3y-s3cret&since={{since}}",
    headers: { Authorization: "Bearer tok-s3cret" },
  },
};
const SECRETS = ["k3y-s3cret", "tok-s3cret"];

test("impact over the real http source counts and sends the secrets", async () => {
  const { deps, sent } = realHttp((url, headers) =>
    url.searchParams.get("api_key") === "k3y-s3cret" &&
    headers.Authorization === "Bearer tok-s3cret"
      ? Response.json({ failed: 41, users: 9 })
      : new Response("no", { status: 401 }),
  );
  expect(
    await measureImpact({ incident, signal: secretImpact }, deps),
  ).toMatchObject({ count: 41, people: 9 });
  expect(sent).toHaveLength(1);
});

test("secrets echoed back never reach the impact", async () => {
  const answers: Array<Response | Error> = [
    Response.json({ failed: "k3y-s3cret", users: "Bearer tok-s3cret" }),
    Response.json({ failed: 3, users: "tok-s3cret" }),
    new Response("bad key k3y-s3cret, Bearer tok-s3cret", { status: 503 }),
    new Error("socket reset after tok-s3cret"),
  ];
  const outs: IncidentImpact[] = [];
  for (const answer of answers) {
    const { deps } = realHttp(() => answer);
    outs.push(await measureImpact({ incident, signal: secretImpact }, deps));
  }
  for (const out of outs)
    for (const secret of SECRETS)
      expect([secret, JSON.stringify(out).includes(secret)]).toEqual([
        secret,
        false,
      ]);
  expect(outs[0]).toMatchObject({ error: "Nothing at $.failed" });
  expect(outs[1]).toMatchObject({ count: 3 });
  expect(outs[1]?.people).toBeUndefined();
  expect(outs[2]).toMatchObject({ error: "HTTP 503 (expected 2xx)" });
  expect(outs[3]?.error).toContain("[redacted]");
});

test("a count that is a secret the query sends is refused", async () => {
  const numeric: Signal = {
    ...signal,
    impact: {
      ...httpImpact,
      url: "https://logs.example.test/c?token=4242",
      headers: { "X-Api-Key": "77" },
    },
  };
  for (const body of [{ failed: 4242 }, { failed: 1, users: 77 }]) {
    const { deps } = realHttp(() => Response.json(body));
    const out = await measureImpact(
      {
        incident,
        signal: numeric,
        previous: previousOf(5),
      },
      deps,
    );
    expect(out).toMatchObject({
      count: 5,
      error: "The answer repeats a secret the query sends",
    });
    expect(out.people).toBeUndefined();
  }
});

test("an impact query to a private address is refused", async () => {
  const { deps, sent } = realHttp(
    () => Response.json({ failed: 1 }),
    ["10.0.0.5"],
  );
  const out = await measureImpact({ incident, signal: secretImpact }, deps);
  expect(out.error).toStartWith("Refused:");
  expect(out.error).toContain("10.0.0.5");
  expect(out.count).toBeUndefined();
  expect(sent).toEqual([]);
});
