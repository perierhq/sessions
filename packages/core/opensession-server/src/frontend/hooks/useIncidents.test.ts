import { expect, test } from "bun:test";
import { apiSWRKey } from "../lib/api-swr";
import { stripRefreshMs } from "../lib/incidents/signal-summary";
import type { StripResponse } from "../../shared/incidents";
import { createCoalescer, isIncidentKey } from "./useIncidents";

test("incident keys are recognised by prefix", () => {
  expect(isIncidentKey(apiSWRKey.incident("inc-1"))).toBe(true);
  expect(isIncidentKey(apiSWRKey.incidentSignals())).toBe(true);
  expect(isIncidentKey(apiSWRKey.incidentSignalMini("sig-a"))).toBe(true);
  expect(isIncidentKey(apiSWRKey.incidents("open"))).toBe(true);
  expect(isIncidentKey(apiSWRKey.incidentAccessSettings("acme"))).toBe(true);
  expect(isIncidentKey(apiSWRKey.incidentProject("acme"))).toBe(true);
  expect(isIncidentKey(apiSWRKey.session("s1"))).toBe(false);
  expect(isIncidentKey("api")).toBe(false);
  expect(isIncidentKey(null)).toBe(false);
});

test("a mini strip has one key per signal, with no time in it", () => {
  expect(apiSWRKey.incidentSignalMini("sig-a")).toEqual([
    "api",
    "incident-signal-mini",
    "sig-a",
  ]);
});

test("strip refresh follows the bucket, capped at a minute", () => {
  // SAFETY: stripRefreshMs reads bucketMs only.
  expect(stripRefreshMs({ bucketMs: 15_000 } as StripResponse)).toBe(15_000);
  // SAFETY: as above.
  expect(stripRefreshMs({ bucketMs: 3_600_000 } as StripResponse)).toBe(60_000);
  expect(stripRefreshMs(undefined)).toBe(60_000);
});

test("a burst of messages revalidates once now and once after the window", async () => {
  let runs = 0;
  let clock = 1_000;
  const c = createCoalescer(
    () => runs++,
    20,
    () => clock,
  );
  c.request();
  expect(runs).toBe(1);
  c.request();
  c.request();
  expect(runs).toBe(1);
  clock += 25;
  await Bun.sleep(30);
  expect(runs).toBe(2);
  clock += 100;
  c.request();
  expect(runs).toBe(3);
  c.request();
  c.cancel();
  await Bun.sleep(30);
  expect(runs).toBe(3);
});
