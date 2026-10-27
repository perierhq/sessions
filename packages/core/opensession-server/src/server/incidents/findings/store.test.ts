import { expect, test } from "bun:test";
import type { FindingBlock, FindingsSet } from "../../../shared/findings";
import type { AgentRole } from "../../../shared/incident-response";
import type { Incident } from "../../../shared/incidents";
import type { updateIncident } from "../incident-store";
import {
  __queuedSessionsForTest,
  saveFindingSet,
  upsertFindingSet,
  withSessionQueue,
} from "./store";

const AT = "2026-10-27T10:00:00.000Z";
const LATER = "2026-10-27T10:05:00.000Z";

function question(id: string, text = "Why does acme slow down?"): FindingBlock {
  return { id, kind: "question", size: "full", text, wouldAnswer: "" };
}

function set(
  role: AgentRole,
  round: number,
  over: Partial<FindingsSet> = {},
): FindingsSet {
  return {
    role,
    round,
    attempt: 1,
    sessionId: role === "investigator" ? "os-inv" : "os-ver",
    source: "tool",
    updatedAt: AT,
    calls: 0,
    blocks: [question("q")],
    notes: [],
    ...over,
  };
}

const bytes = (value: FindingsSet | FindingsSet[]) =>
  Buffer.byteLength(JSON.stringify(value));

test("one set per role and round; a newer attempt replaces", () => {
  const first = upsertFindingSet(undefined, set("investigator", 1));
  expect(first.saved?.calls).toBe(1);
  const replaced = upsertFindingSet(
    first.sets,
    set("investigator", 1, { attempt: 2, blocks: [question("b")] }),
  );
  expect(replaced.sets).toHaveLength(1);
  expect(replaced.sets[0]?.attempt).toBe(2);
  expect(replaced.sets[0]?.calls).toBe(1);
  expect(replaced.sets[0]?.blocks.map((b) => b.id)).toEqual(["b"]);
  expect(replaced.notes).toEqual([]);

  const withVerifier = upsertFindingSet(
    [set("verifier", 1, { calls: 1 })],
    set("investigator", 1),
  );
  expect(withVerifier.sets.map((s) => s.role)).toEqual([
    "investigator",
    "verifier",
  ]);
  const added = upsertFindingSet(replaced.sets, set("verifier", 1));
  expect(added.sets.map((s) => `${s.role}:${s.round}`)).toEqual([
    "investigator:1",
    "verifier:1",
  ]);
});

test("an older attempt cannot overwrite", () => {
  const stored = [set("investigator", 1, { attempt: 2, calls: 3 })];
  const result = upsertFindingSet(stored, set("investigator", 1));
  expect(result.saved).toBeNull();
  expect(result.notes).toEqual([
    "A newer attempt owns round 1's findings; nothing saved.",
  ]);
  expect(result.sets).toEqual(stored);
});

test("calls are counted and capped at 60", () => {
  const once = upsertFindingSet(
    [set("investigator", 1, { calls: 4 })],
    set("investigator", 1),
  );
  expect(once.saved?.calls).toBe(5);
  const stored = [set("investigator", 1, { calls: 60 })];
  const capped = upsertFindingSet(stored, set("investigator", 1));
  expect(capped.saved).toBeNull();
  expect(capped.notes).toEqual([
    "You've updated the findings 60 times this round. Put anything else in your report.",
  ]);
  expect(capped.sets).toEqual(stored);
});

test("a set over 64 KB drops blocks from the end", () => {
  const blocks = Array.from({ length: 12 }, (_, i) =>
    question(`b${i + 1}`, "x".repeat(6000)),
  );
  const result = upsertFindingSet(
    undefined,
    set("investigator", 1, { blocks }),
  );
  const saved = result.saved;
  if (!saved) throw new Error("expected a saved set");
  expect(JSON.stringify(saved).length).toBeLessThanOrEqual(65536);
  expect(bytes(saved)).toBeLessThanOrEqual(65536);
  const kept = saved.blocks.map((b) => b.id);
  expect(kept).toEqual(blocks.slice(0, kept.length).map((b) => b.id));
  expect(kept.length).toBeLessThan(12);
  const dropped = blocks
    .slice(kept.length)
    .map((b) => b.id)
    .reverse();
  expect(result.notes).toEqual(
    dropped.map(
      (id) => `Dropped block \`${id}\`: the findings are over 64 KB.`,
    ),
  );
  expect(result.notes).toContain(
    "Dropped block `b12`: the findings are over 64 KB.",
  );
  expect(saved.notes).toEqual(result.notes);
});

test("at most 12 sets, oldest rounds go first", () => {
  const stored: FindingsSet[] = [];
  for (let round = 1; round <= 6; round++)
    stored.push(set("investigator", round), set("verifier", round));
  const result = upsertFindingSet(stored, set("investigator", 7));
  expect(result.sets).toHaveLength(12);
  expect(
    result.sets.some((s) => s.round === 1 && s.role === "investigator"),
  ).toBe(false);
  expect(result.sets.some((s) => s.round === 1 && s.role === "verifier")).toBe(
    true,
  );
  expect(result.sets.at(-1)).toMatchObject({ role: "investigator", round: 7 });
});

test("all sets stay under 256 KB", () => {
  const big = (round: number, kb: number) =>
    set("investigator", round, {
      blocks: [question("q", "y".repeat(kb * 1024))],
    });
  const stored = [1, 2, 3, 4, 5].map((round) => big(round, 50));
  expect(bytes(stored)).toBeGreaterThan(250 * 1024);
  const result = upsertFindingSet(stored, big(6, 30));
  expect(bytes(result.sets)).toBeLessThanOrEqual(262144);
  expect(result.sets.map((s) => s.round)).toEqual([2, 3, 4, 5, 6]);

  // The newest round's set stays even when it alone is close to the cap.
  const huge = [1, 2, 3, 4, 5].map((round) => big(round, 60));
  const kept = upsertFindingSet(huge, big(6, 60));
  expect(kept.sets.at(-1)?.round).toBe(6);
  expect(bytes(kept.sets)).toBeLessThanOrEqual(262144);
});

test("notes are capped at 20", () => {
  const notes = Array.from({ length: 25 }, (_, i) => `Note ${i + 1}.`);
  const result = upsertFindingSet(undefined, set("investigator", 1, { notes }));
  expect(result.saved?.notes).toEqual(notes.slice(0, 20));
});

function incidentFixture(): Incident {
  return {
    id: "inc-1",
    project: "acme",
    state: "investigating",
    signalIds: ["sig-a"],
    openedAt: AT,
    updatedAt: AT,
    events: [
      { id: "ev_1", at: AT, kind: "opened", by: "sessions", detail: "" },
    ],
    findings: [],
    response: {
      phase: "investigating",
      round: 1,
      maxRounds: 3,
      agents: [
        { role: "investigator", sessionId: "os-inv", status: "running" },
      ],
      actionRuns: [],
      costUsd: 0,
      ownerTouched: false,
      next: { kind: "working", detail: "Starting" },
      ledger: [{ id: "led_1" }],
      droppedLedger: 0,
      startedAt: AT,
      updatedAt: AT,
    },
  } as unknown as Incident;
}

function fakeUpdate(start: Incident | null) {
  let stored = start;
  const update = (async (_id, mutate) => {
    if (!stored) return null;
    const next = mutate(structuredClone(stored));
    if ("error" in next) return next;
    stored = next;
    return next;
  }) as typeof updateIncident;
  return { update, stored: () => stored };
}

test("saveFindingSet writes only findingSets and the incident's updatedAt", async () => {
  const fixture = incidentFixture();
  const fake = fakeUpdate(fixture);
  const result = await saveFindingSet(
    "inc-1",
    set("investigator", 1, { updatedAt: LATER }),
    { updateIncident: fake.update },
  );
  expect(result.saved?.calls).toBe(1);
  expect(result.notes).toEqual([]);
  const after = fake.stored();
  if (!after?.response) throw new Error("expected a stored response");
  expect(after.updatedAt).toBe(LATER);
  expect(after.response.findingSets).toEqual([result.saved as FindingsSet]);
  const { findingSets: _sets, ...restAfter } = after.response;
  expect(restAfter).toEqual(fixture.response as typeof restAfter);
  expect(after.events).toEqual(fixture.events);
  const { response: _a, updatedAt: _b, ...topAfter } = after;
  const { response: _c, updatedAt: _d, ...topBefore } = fixture;
  expect(topAfter).toEqual(topBefore);
});

test("saveFindingSet refuses without writing", async () => {
  const fixture = incidentFixture();
  if (!fixture.response) throw new Error("fixture has a response");
  fixture.response.findingSets = [set("investigator", 1, { attempt: 2 })];
  const fake = fakeUpdate(fixture);
  const refused = await saveFindingSet("inc-1", set("investigator", 1), {
    updateIncident: fake.update,
  });
  expect(refused).toEqual({
    saved: null,
    notes: ["A newer attempt owns round 1's findings; nothing saved."],
  });
  expect(fake.stored()).toBe(fixture);

  const bare = { ...incidentFixture(), response: undefined } as Incident;
  const none = fakeUpdate(bare);
  expect(
    await saveFindingSet("inc-1", set("investigator", 1), {
      updateIncident: none.update,
    }),
  ).toEqual({ saved: null, notes: ["This incident has no agents yet."] });
  expect(none.stored()).toBe(bare);

  const missing = fakeUpdate(null);
  expect(
    await saveFindingSet("inc-x", set("investigator", 1), {
      updateIncident: missing.update,
    }),
  ).toEqual({ saved: null, notes: ["No incident inc-x."] });
});

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

test("the queue runs one session's calls in order and others in parallel", async () => {
  const log: string[] = [];
  const gate = deferred();
  const first = withSessionQueue("os-1", async () => {
    log.push("os-1 a start");
    await gate.promise;
    log.push("os-1 a end");
    return "a";
  });
  const second = withSessionQueue("os-1", async () => {
    log.push("os-1 b start");
    return "b";
  });
  const other = withSessionQueue("os-2", async () => {
    log.push("os-2 start");
    return "c";
  });
  expect(await other).toBe("c");
  await settle();
  expect(log).toEqual(["os-1 a start", "os-2 start"]);
  gate.resolve();
  expect(await first).toBe("a");
  expect(await second).toBe("b");
  expect(log).toEqual([
    "os-1 a start",
    "os-2 start",
    "os-1 a end",
    "os-1 b start",
  ]);
  await settle();
  expect(__queuedSessionsForTest()).toBe(0);
});

test("a call that throws still lets the next one run", async () => {
  const gate = deferred();
  const log: string[] = [];
  const failing = withSessionQueue("os-1", async () => {
    await gate.promise;
    log.push("a");
  });
  const next = withSessionQueue("os-1", async () => {
    log.push("b");
    return "b";
  });
  await settle();
  expect(log).toEqual([]);
  gate.reject(new Error("boom"));
  await expect(failing).rejects.toThrow("boom");
  expect(await next).toBe("b");
  expect(log).toEqual(["b"]);
  await settle();
  expect(__queuedSessionsForTest()).toBe(0);
});
