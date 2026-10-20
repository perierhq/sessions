import { expect, test } from "bun:test";
import {
  createSignal,
  deleteSignal,
  getSignal,
  listSignals,
  signalWriteCount,
  updateSignal,
} from "./signal-store";
import { appendObservations, recentObservations } from "./observation-store";
import { useIncidentTestKernel } from "./testing/kernel-fixture";

const kit = useIncidentTestKernel();
const http = {
  name: "Search",
  project: "acme",
  source: {
    kind: "http",
    url: "https://acme.example.test/q",
    headers: { Authorization: "Bearer s3cret" },
  },
};

test("create, get, list", async () => {
  const a = await createSignal(http, "Ada");
  const b = await createSignal({ ...http, name: "Api" }, "Ada");
  if ("error" in a || "error" in b) throw new Error("create failed");
  expect(a.id).toMatch(/^sig-/);
  expect(a.hookSecret).toBeUndefined();
  expect(await getSignal(a.id)).toEqual(a);
  expect((await listSignals()).map((s) => s.name)).toEqual(["Api", "Search"]);
  expect(await getSignal("../etc")).toBeNull();
});

test("hook sources get a secret; switching to one creates it", async () => {
  const w = await createSignal(
    { name: "Errors", project: "acme", source: { kind: "webhook" } },
    "Ada",
  );
  if ("error" in w) throw new Error(w.error);
  expect(w.hookSecret).toMatch(/^[0-9a-f]{48}$/);
  const h = await createSignal(http, "Ada");
  if ("error" in h) throw new Error(h.error);
  const moved = await updateSignal(
    h.id,
    {
      source: { kind: "heartbeat" },
      rule: { kind: "missing", everyMs: 3_600_000, graceMs: 0 },
    },
    "Ada",
  );
  expect(moved && !("error" in moved) && moved.hookSecret).toMatch(
    /^[0-9a-f]{48}$/,
  );
});

test("partial update keeps the rest and the redacted header", async () => {
  const s = await createSignal(http, "Ada");
  if ("error" in s) throw new Error(s.error);
  const next = await updateSignal(
    s.id,
    {
      name: "Search API",
      source: {
        kind: "http",
        url: "https://acme.example.test/q",
        headers: { Authorization: "[redacted]" },
      },
    },
    "Bo",
  );
  expect(next).toMatchObject({
    name: "Search API",
    project: "acme",
    createdBy: "Ada",
    source: { headers: { Authorization: "Bearer s3cret" } },
  });
  expect(await updateSignal("sig-missing", { name: "x" }, "Bo")).toBeNull();
  expect(await updateSignal(s.id, { project: "globex" }, "Bo")).toEqual({
    error: expect.any(String),
  });
});

test("a redacted header does not follow the signal to another address", async () => {
  const s = await createSignal(http, "Ada");
  if ("error" in s) throw new Error(s.error);
  const moved = await updateSignal(
    s.id,
    {
      source: {
        kind: "http",
        url: "https://other.example.test/q",
        headers: { Authorization: "[redacted]" },
      },
    },
    "Bo",
  );
  expect(moved).toEqual({
    error: "Enter the Authorization value again for the new address",
  });
  expect(await getSignal(s.id)).toEqual(s);
  const retyped = await updateSignal(
    s.id,
    {
      source: {
        kind: "http",
        url: "https://other.example.test/q",
        headers: { Authorization: "Bearer other" },
      },
    },
    "Bo",
  );
  expect(retyped).toMatchObject({
    source: { headers: { Authorization: "Bearer other" } },
  });
});

test("a hook keeps its secret across a rename and a switch away and back", async () => {
  const w = await createSignal(
    { name: "Errors", project: "acme", source: { kind: "webhook" } },
    "Ada",
  );
  if ("error" in w) throw new Error(w.error);
  const renamed = await updateSignal(w.id, { name: "Errors API" }, "Ada");
  expect(renamed && !("error" in renamed) && renamed.hookSecret).toBe(
    w.hookSecret,
  );
  await updateSignal(w.id, { source: http.source }, "Ada");
  const back = await updateSignal(w.id, { source: { kind: "webhook" } }, "Ada");
  expect(back && !("error" in back) && back.hookSecret).toBe(w.hookSecret);
});

test("audits every write without secrets", async () => {
  const s = await createSignal(http, "Ada");
  if ("error" in s) throw new Error(s.error);
  await updateSignal(s.id, { name: "Search API", severity: "critical" }, "Bo");
  await deleteSignal(s.id, "Bo");
  expect(kit.audits).toEqual([
    {
      kind: "incident_signal_created",
      signalId: s.id,
      project: "acme",
      by: "Ada",
    },
    {
      kind: "incident_signal_updated",
      signalId: s.id,
      by: "Bo",
      fields: ["name", "severity"],
    },
    { kind: "incident_signal_deleted", signalId: s.id, by: "Bo" },
  ]);
  expect(JSON.stringify(kit.audits)).not.toContain("s3cret");
  expect(await getSignal(s.id)).toBeNull();
  expect(await deleteSignal(s.id, "Bo")).toBe(false);
});

test("writes bump the namespace counter", async () => {
  const before = signalWriteCount();
  await createSignal(http, "Ada");
  expect(signalWriteCount()).toBe(before + 1);
});

test("deleting a signal forgets its observations in memory", async () => {
  const s = await createSignal(http, "Ada");
  if ("error" in s) throw new Error(s.error);
  appendObservations(s.id, [
    { at: "2026-10-20T10:00:00.000Z", result: "ok", detail: "" },
  ]);
  expect(recentObservations(s.id)).toHaveLength(1);
  await deleteSignal(s.id, "Bo");
  expect(recentObservations(s.id)).toEqual([]);
});
