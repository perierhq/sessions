import { afterEach, beforeEach, expect, test } from "bun:test";
import { listIncidents } from "../incidents/incident-store";
import {
  __resetObservationsForTest,
  flushObservations,
  recentObservations,
} from "../incidents/observation-store";
import {
  __resetSignalRuntimeForTest,
  getSignalEvaluation,
} from "../incidents/signal-runtime";
import {
  __setProjectCheckForTest,
  listSignals,
} from "../incidents/signal-store";
import { useIncidentTestKernel } from "../incidents/testing/kernel-fixture";
import { DEMO_REPO_ID } from "./fixtures";
import {
  DEMO_INCIDENT_AUTHOR,
  rearmDemoVeto,
  runDemoSignalSource,
  seedDemoIncidents,
  tickDemoSignals,
} from "./incidents";

useIncidentTestKernel();

beforeEach(() => {
  __resetSignalRuntimeForTest();
  __resetObservationsForTest();
  __setProjectCheckForTest((id) => id === DEMO_REPO_ID);
});

afterEach(() => {
  __resetSignalRuntimeForTest();
  __resetObservationsForTest();
});

const NOW = Date.parse("2026-10-20T12:31:00Z");

test("seeds signals in every state and incidents the engine leaves alone", async () => {
  await seedDemoIncidents(NOW);
  const signals = await listSignals();
  expect(signals).toHaveLength(8);
  expect(signals.every((s) => s.createdBy === DEMO_INCIDENT_AUTHOR)).toBe(true);
  const state = (name: string) =>
    getSignalEvaluation(signals.find((s) => s.name === name)!.id)?.state;
  expect(state("Search")).toBe("failing");
  expect(state("Checkout")).toBe("failing");
  expect(state("Bounce webhook")).toBe("flaky");
  expect(state("Search latency")).toBe("ok");
  expect(state("Sign-in")).toBe("ok");
  expect(state("acme.example.test certificate")).toBe("ok");
  expect(state("Error reports")).toBe("ok");

  const incidents = await listIncidents();
  const states = incidents.map((i) => i.state).sort();
  expect(states).toEqual([
    "heads-up",
    "needs-you",
    "resolved",
    "resolved",
    "resolved",
    "resolved",
    "resolved",
    "veto",
  ]);
  const veto = incidents.find((i) => i.state === "veto")!;
  expect(veto.response?.next.kind).toBe("veto");
  expect(Date.parse(veto.response!.veto!.deadline)).toBeGreaterThan(NOW);
  const needsYou = incidents.find((i) => i.state === "needs-you")!;
  expect(needsYou.response?.next).toMatchObject({
    kind: "needs-you",
    options: ["approve", "send-back", "stop"],
  });
});

test("a second boot adds nothing; the veto moves forward near its end", async () => {
  await seedDemoIncidents(NOW);
  await seedDemoIncidents(NOW + 1000);
  expect(await listSignals()).toHaveLength(8);
  expect(await listIncidents()).toHaveLength(8);

  const veto = (await listIncidents({ open: true })).find(
    (i) => i.state === "veto",
  )!;
  const deadline = Date.parse(veto.response!.veto!.deadline);
  await rearmDemoVeto(deadline - 5 * 60_000);
  const kept = (await listIncidents({ open: true })).find(
    (i) => i.id === veto.id,
  )!;
  expect(kept.response!.veto!.deadline).toBe(veto.response!.veto!.deadline);

  await rearmDemoVeto(deadline - 10_000);
  const moved = (await listIncidents({ open: true })).find(
    (i) => i.id === veto.id,
  )!;
  expect(Date.parse(moved.response!.veto!.deadline)).toBeGreaterThan(deadline);
  expect(moved.response!.next).toMatchObject({
    kind: "veto",
    deadline: moved.response!.veto!.deadline,
  });
});

test("demo checks answer from the script and never leave the machine", async () => {
  await seedDemoIncidents(NOW);
  const signals = await listSignals();
  const run = async (name: string) =>
    (await runDemoSignalSource(signals.find((s) => s.name === name)!))
      .observations[0]?.result;
  expect(await run("Search")).toBe("fail");
  expect(await run("Sign-in")).toBe("ok");
  expect(await run("acme.example.test certificate")).toBe("ok");
});

test("after a restart the demo fills the gap and its states come back", async () => {
  await seedDemoIncidents(NOW);
  await flushObservations();
  // A restart: evaluations and in-memory rings are gone, the files stay.
  __resetSignalRuntimeForTest();
  __resetObservationsForTest();
  const later = NOW + 30 * 60_000;
  await tickDemoSignals(later);
  const signals = await listSignals();
  const byName = (name: string) => signals.find((s) => s.name === name)!;
  expect(getSignalEvaluation(byName("Search").id)?.state).toBe("failing");
  expect(getSignalEvaluation(byName("Sign-in").id)?.state).toBe("ok");
  expect(getSignalEvaluation(byName("Bounce webhook").id)?.state).toBe("flaky");
  const last = recentObservations(byName("Sign-in").id).at(-1)!;
  expect(later - Date.parse(last.at)).toBeLessThan(60_000);
  // No duplicates across the seam.
  const ats = recentObservations(byName("Sign-in").id).map((o) => o.at);
  expect(new Set(ats).size).toBe(ats.length);
});
