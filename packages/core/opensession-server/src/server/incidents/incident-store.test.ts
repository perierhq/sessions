import { expect, test } from "bun:test";
import { appendEvent, transitionIncident } from "./lifecycle";
import {
  type NewIncident,
  createIncident,
  getIncident,
  listIncidents,
  newFinding,
  onIncidentChange,
  summarizeIncident,
  updateIncident,
} from "./incident-store";
import { useIncidentTestKernel } from "./testing/kernel-fixture";

const kit = useIncidentTestKernel();
const AT = "2026-10-20T10:00:00.000Z";
const init = (over: Partial<NewIncident> = {}): NewIncident => ({
  project: "acme",
  title: "Search",
  state: "investigating",
  severity: "major",
  owner: "Ada",
  openedBy: { kind: "rule", ref: "sig-a" },
  signalIds: ["sig-a"],
  primarySignalId: "sig-a",
  at: AT,
  detail: "3 failures in a row",
  ...over,
});

test("create writes the opened event and audits", async () => {
  const i = await createIncident(init());
  expect(i.id).toMatch(/^inc-/);
  expect(i).toMatchObject({
    openedAt: AT,
    updatedAt: AT,
    lastProblemAt: AT,
    droppedEvents: 0,
    findings: [],
  });
  expect(i.events).toEqual([
    expect.objectContaining({
      kind: "opened",
      by: "sessions",
      to: "investigating",
      marker: "detected",
      signalId: "sig-a",
      detail: "3 failures in a row",
    }),
  ]);
  expect(await getIncident(i.id)).toEqual(i);
  expect(kit.audits).toEqual([
    {
      kind: "incident_opened",
      incidentId: i.id,
      project: "acme",
      signalId: "sig-a",
      state: "investigating",
      owner: "Ada",
    },
  ]);
});

test("findings given at creation get ids and are audited", async () => {
  const i = await createIncident(
    init({
      state: "waiting-on-provider",
      signalIds: ["sig-a", "sig-p"],
      findings: [
        {
          kind: "external",
          at: AT,
          signalId: "sig-p",
          detail: "Status reports a problem",
        },
      ],
    }),
  );
  expect(i.findings).toEqual([
    expect.objectContaining({
      id: expect.stringMatching(/^fnd-/),
      kind: "external",
      signalId: "sig-p",
    }),
  ]);
  expect(kit.audits.map((a) => a.kind)).toEqual([
    "incident_opened",
    "incident_finding",
  ]);
  expect(kit.audits[1]).toEqual({
    kind: "incident_finding",
    incidentId: i.id,
    findingKind: "external",
    signalId: "sig-p",
  });
});

test("opening while waiting on a provider resumes to investigating", async () => {
  const i = await createIncident(init({ state: "waiting-on-provider" }));
  expect(i.resumeState).toBe("investigating");
  expect(await getIncident(i.id)).toEqual(i);
  expect(await createIncident(init())).not.toHaveProperty("resumeState");
});

test("list: newest first, filters", async () => {
  const old = await createIncident(init({ at: "2026-10-19T10:00:00.000Z" }));
  const other = await createIncident(
    init({
      project: "acme-api",
      signalIds: ["sig-b"],
      primarySignalId: "sig-b",
    }),
  );
  await updateIncident(old.id, (c) => ({
    ...c,
    state: "resolved",
    closedAt: AT,
  }));
  expect((await listIncidents()).map((i) => i.id)).toEqual([other.id, old.id]);
  expect((await listIncidents({ open: true })).map((i) => i.id)).toEqual([
    other.id,
  ]);
  expect((await listIncidents({ open: false })).map((i) => i.id)).toEqual([
    old.id,
  ]);
  expect((await listIncidents({ project: "acme" })).map((i) => i.id)).toEqual([
    old.id,
  ]);
  expect((await listIncidents({ signalId: "sig-b" })).map((i) => i.id)).toEqual(
    [other.id],
  );
});

test("concurrent updates both land", async () => {
  const i = await createIncident(init());
  const add = (d: string) =>
    updateIncident(i.id, (c) =>
      appendEvent(c, {
        at: AT,
        kind: "signal-state",
        by: "sessions",
        detail: d,
      }),
    );
  await Promise.all([add("a"), add("b")]);
  expect(
    (await getIncident(i.id))?.events
      .map((e) => e.detail)
      .slice(1)
      .sort(),
  ).toEqual(["a", "b"]);
});

test("an error aborts without a write or audit", async () => {
  const i = await createIncident(init());
  kit.audits.length = 0;
  const seen: string[] = [];
  const off = onIncidentChange((next) => seen.push(next.id));
  expect(await updateIncident(i.id, () => ({ error: "nope" }))).toEqual({
    error: "nope",
  });
  expect(await getIncident(i.id)).toEqual(i);
  expect(kit.audits).toEqual([]);
  expect(seen).toEqual([]);
  expect(await updateIncident("inc-missing", (c) => c)).toBeNull();
  expect(await updateIncident("../escape", (c) => c)).toBeNull();
  off();
});

test("an update that changes nothing is not audited or announced", async () => {
  const i = await createIncident(init());
  kit.audits.length = 0;
  const seen: string[] = [];
  const off = onIncidentChange((next) => seen.push(next.id));
  expect(await updateIncident(i.id, (c) => c)).toEqual(i);
  expect(kit.audits).toEqual([]);
  expect(seen).toEqual([]);
  off();
});

test("audits state, attach and findings; listeners see both versions", async () => {
  const seen: Array<[string, string | undefined]> = [];
  const off = onIncidentChange((next, prev) =>
    seen.push([next.state, prev?.state]),
  );
  const offBroken = onIncidentChange(() => {
    throw new Error("listener bug");
  });
  const i = await createIncident(init());
  kit.audits.length = 0;
  await updateIncident(i.id, (c) => {
    const moved = transitionIncident(c, "waiting-on-provider", {
      by: "sessions",
      detail: "Waiting on Status",
      at: AT,
    });
    if ("error" in moved) return moved;
    return {
      ...moved,
      signalIds: [...moved.signalIds, "sig-p"],
      findings: [
        newFinding({
          kind: "external",
          at: AT,
          signalId: "sig-p",
          detail: "Status reports a problem",
        }),
      ],
    };
  });
  expect(kit.audits).toEqual([
    {
      kind: "incident_state",
      incidentId: i.id,
      from: "investigating",
      to: "waiting-on-provider",
      by: "sessions",
      detail: "Waiting on Status",
    },
    { kind: "incident_signal_attached", incidentId: i.id, signalId: "sig-p" },
    {
      kind: "incident_finding",
      incidentId: i.id,
      findingKind: "external",
      signalId: "sig-p",
    },
  ]);
  expect(seen).toEqual([
    ["investigating", undefined],
    ["waiting-on-provider", "investigating"],
  ]);
  kit.audits.length = 0;
  await updateIncident(i.id, (c) => ({
    ...c,
    findings: c.findings.map((f) => ({ ...f, resolvedAt: AT })),
  }));
  expect(kit.audits).toEqual([
    {
      kind: "incident_finding_resolved",
      incidentId: i.id,
      findingKind: "external",
      signalId: "sig-p",
    },
  ]);
  off();
  offBroken();
});

test("summary", async () => {
  const s = summarizeIncident(await createIncident(init()));
  expect(s).not.toHaveProperty("events");
  expect(s).toMatchObject({ eventCount: 1, lastEvent: { kind: "opened" } });
});
