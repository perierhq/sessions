import { expect, spyOn, test } from "bun:test";
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

test("a write landing between read and commit is retried, not lost", async () => {
  const i = await createIncident(init());
  let runs = 0;
  const result = await updateIncident(i.id, (c) => {
    runs++;
    if (runs === 1) {
      // Another writer commits first, straight through the kernel.
      const stored = kit.store().catalogDocumentGet("incidents", i.id);
      if (!stored?.value) throw new Error("incident not stored");
      const other = appendEvent(JSON.parse(stored.value), {
        at: AT,
        kind: "signal-state",
        by: "sessions",
        detail: "other",
      });
      const put = kit.store().putCatalogDocument({
        op: "put",
        namespace: "incidents",
        key: i.id,
        expectedRev: stored.rev,
        value: JSON.stringify(other),
        requestId: crypto.randomUUID(),
      });
      if (put.status !== "committed")
        throw new Error(`bump failed: ${put.status}`);
    }
    return appendEvent(c, {
      at: AT,
      kind: "signal-state",
      by: "sessions",
      detail: "mine",
    });
  });
  expect(runs).toBe(2);
  const details = (await getIncident(i.id))?.events.map((e) => e.detail);
  expect(details?.slice(1)).toEqual(["other", "mine"]);
  expect(result).toEqual(await getIncident(i.id));
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

test("listeners run apart from the write: rejections and slow ones are contained", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const seen: string[] = [];
  const offs = [
    onIncidentChange(async () => {
      throw new Error("async listener bug");
    }),
    onIncidentChange(() => new Promise<void>(() => {})),
    onIncidentChange((next) => {
      seen.push(next.state);
    }),
  ];
  try {
    const i = await createIncident(init());
    await updateIncident(i.id, (c) => {
      const moved = transitionIncident(c, "paused", {
        by: "Ada",
        detail: "Later",
        at: AT,
      });
      return moved;
    });
    await Bun.sleep(0);
    expect(seen).toEqual(["investigating", "paused"]);
    expect(
      warn.mock.calls.filter((call) =>
        String(call[1]).includes("async listener bug"),
      ),
    ).toHaveLength(2);
  } finally {
    for (const off of offs) off();
    warn.mockRestore();
  }
});

test("a resolved disagreement is audited with the signal it was against", async () => {
  const i = await createIncident(
    init({
      findings: [
        {
          kind: "disagreement",
          at: AT,
          signalId: "sig-r",
          againstSignalId: "sig-a",
          detail: "Health reports ok while Search is failing",
        },
      ],
    }),
  );
  kit.audits.length = 0;
  await updateIncident(i.id, (c) => ({
    ...c,
    findings: c.findings.map((f) => ({ ...f, resolvedAt: AT })),
  }));
  expect(kit.audits).toEqual([
    {
      kind: "incident_finding_resolved",
      incidentId: i.id,
      findingKind: "disagreement",
      signalId: "sig-r",
      againstSignalId: "sig-a",
    },
  ]);
});

test("summary", async () => {
  const s = summarizeIncident(await createIncident(init()));
  expect(s).not.toHaveProperty("events");
  expect(s).toMatchObject({ eventCount: 1, lastEvent: { kind: "opened" } });
});
