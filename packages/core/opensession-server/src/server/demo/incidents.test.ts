import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  FINDING_ID,
  FINDING_KINDS,
  FINDINGS_LIMITS,
  type FindingBlock,
  type SignalWindow,
} from "../../shared/findings";
import { listIncidents } from "../incidents/incident-store";
import {
  __resetObservationsForTest,
  flushObservations,
  queryObservations,
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

test("demo findings are well-formed", async () => {
  await seedDemoIncidents(NOW);
  const incidents = await listIncidents();
  const veto = incidents.find((i) => i.state === "veto")!;
  const needsYou = incidents.find((i) => i.state === "needs-you")!;
  for (const incident of [veto, needsYou]) {
    const sets = incident.response?.findingSets ?? [];
    expect(sets.length).toBeGreaterThan(0);
    const investigator = incident.response!.agents.find(
      (a) => a.role === "investigator",
    )!;
    for (const set of sets) {
      expect(set.blocks.length).toBeGreaterThan(0);
      expect(set.blocks.length).toBeLessThanOrEqual(FINDINGS_LIMITS.blocks);
      expect(
        new TextEncoder().encode(JSON.stringify(set)).length,
      ).toBeLessThanOrEqual(65536);
      const run = incident.response!.agents.find(
        (a) => a.role === set.role && a.round === set.round,
      );
      expect(set.sessionId).toBe(run!.sessionId);
      const windows: SignalWindow[] = [];
      const ids = new Set<string>();
      for (const block of set.blocks as FindingBlock[]) {
        expect(block.id).toMatch(FINDING_ID);
        expect(ids.has(block.id)).toBe(false);
        ids.add(block.id);
        expect(FINDING_KINDS).toContain(block.kind);
        if (block.kind === "signal") windows.push(block);
        if (block.kind === "compare")
          for (const side of block.sides)
            if ("signal" in side) windows.push(side.signal);
        if (block.kind === "change" && block.change.type === "pr")
          expect(block.change.sessionId).toBe(investigator.sessionId);
        // No log blocks: demo sessions have no transcripts to open.
        expect(block.kind).not.toBe("log");
      }
      for (const w of windows) {
        expect(w.signalId).toBe(incident.primarySignalId!);
        const span = Date.parse(w.to) - Date.parse(w.from);
        expect(span).toBeGreaterThan(0);
        expect(span).toBeLessThanOrEqual(FINDINGS_LIMITS.windowMs);
        expect(Date.parse(w.to)).toBeLessThanOrEqual(NOW);
        const seen = await queryObservations(
          w.signalId,
          Date.parse(w.from),
          Date.parse(w.to),
        );
        expect(seen.length).toBeGreaterThan(0);
      }
    }
  }

  const vetoSets = veto.response!.findingSets!;
  expect(vetoSets.map((s) => s.role)).toEqual(["investigator", "verifier"]);
  const kinds = (role: string) =>
    vetoSets.find((s) => s.role === role)!.blocks.map((b) => b.kind);
  expect(kinds("investigator")).toEqual([
    "hypothesis",
    "question",
    "timeline",
    "signal",
    "change",
  ]);
  expect(kinds("verifier")).toEqual(["compare"]);
  const hypothesis = vetoSets[0]!.blocks.find((b) => b.kind === "hypothesis");
  const claim = "The replica was removed in the release config";
  expect(hypothesis).toMatchObject({ claims: [claim], size: "half" });
  const verifier = veto.response!.agents.find((a) => a.role === "verifier")!;
  expect(verifier.report).toMatchObject({
    claims: [{ text: claim, status: "verified" }],
  });

  const needsYouSets = needsYou.response!.findingSets!;
  expect(needsYouSets.map((s) => s.role)).toEqual(["investigator"]);
  expect(needsYouSets[0]!.blocks.map((b) => b.kind)).toEqual([
    "hypothesis",
    "question",
  ]);
  expect(needsYouSets[0]!.blocks[1]).toMatchObject({
    text: "Can the migration be applied before the deploy?",
  });
});
