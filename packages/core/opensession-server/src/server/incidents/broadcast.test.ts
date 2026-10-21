import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  __setIncidentBroadcastForTest,
  startIncidentBroadcasts,
} from "./broadcast";
import { __resetObservationsForTest } from "./observation-store";
import {
  __resetSignalRuntimeForTest,
  ingestObservations,
} from "./signal-runtime";
import { createSignal } from "./signal-store";
import { useAccessTestEnv } from "./testing/access-fixture";
import { useIncidentTestKernel } from "./testing/kernel-fixture";

useIncidentTestKernel();
useAccessTestEnv();
const sent: Array<Record<string, unknown>> = [];
beforeEach(() => {
  __resetSignalRuntimeForTest();
  __resetObservationsForTest();
  sent.length = 0;
  __setIncidentBroadcastForTest((m) => sent.push(m));
});
afterEach(() => __setIncidentBroadcastForTest(undefined));

test("incident and signal changes broadcast ids and states only", async () => {
  startIncidentBroadcasts();
  startIncidentBroadcasts(); // idempotent
  const s = await createSignal(
    {
      name: "Search",
      project: "acme",
      source: { kind: "http", url: "https://acme.example.test" },
    },
    "Ada",
  );
  if ("error" in s) throw new Error(s.error);
  let t = Date.parse("2026-10-20T10:00:00Z");
  for (const result of ["fail", "fail", "fail"] as const) {
    t += 60_000;
    await ingestObservations(
      s.id,
      [
        {
          at: new Date(t).toISOString(),
          result,
          detail: "HTTP 503 secret-body",
        },
      ],
      t,
    );
  }
  await Bun.sleep(0); // listeners run on their own microtask
  expect(sent).toContainEqual({
    type: "incident_signals_changed",
    signalId: s.id,
    project: "acme",
    state: "failing",
  });
  const incidents = sent.filter((m) => m.type === "incidents_changed");
  expect(incidents).toHaveLength(1);
  expect(Object.keys(incidents[0]!).sort()).toEqual([
    "incidentId",
    "project",
    "state",
    "type",
  ]);
  expect(incidents[0]).toMatchObject({
    project: "acme",
    state: "investigating",
  });
  expect(JSON.stringify(sent)).not.toContain("secret-body");
  expect(JSON.stringify(sent)).not.toContain("Search");
});

test("access settings changes broadcast the project", async () => {
  startIncidentBroadcasts();
  const { updateIncidentAccess } = await import("./access/settings-store");
  const { defaultProjectGrants } = await import("../../shared/incident-access");
  const out = await updateIncidentAccess(
    "acme",
    {
      kind: "grants",
      grants: { ...defaultProjectGrants("acme"), connections: ["sentry"] },
    },
    { name: "Ada", login: "ada", verified: true },
  );
  expect("error" in out).toBe(false);
  expect(sent).toContainEqual({
    type: "incident_settings_changed",
    project: "acme",
  });
});
