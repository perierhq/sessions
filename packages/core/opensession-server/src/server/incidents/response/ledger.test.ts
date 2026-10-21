import { expect, test } from "bun:test";
import { appendLedger, emptyResponse, LEDGER_CAP } from "./ledger";

test("ledger keeps the newest 300 and counts the rest", () => {
  let r = emptyResponse({
    now: "2026-10-20T10:00:00.000Z",
    maxRounds: 2,
    phase: "investigating",
  });
  for (let i = 0; i < 305; i++)
    r = appendLedger(r, {
      at: "t",
      actor: "sessions",
      kind: "proof",
      detail: `p${i}`,
    });
  expect(LEDGER_CAP).toBe(300);
  expect(r.ledger).toHaveLength(300);
  expect(r.droppedLedger).toBe(5);
  expect(r.ledger[0]!.detail).toBe("p5");
  expect(r.ledger[0]!.id).toMatch(/^led-/);
  expect(
    appendLedger(r, {
      at: "t",
      actor: "sessions",
      kind: "proof",
      detail: "x".repeat(900),
    }).ledger.at(-1)?.detail,
  ).toHaveLength(500);
});

test("an empty response starts round 1 with nothing spent", () => {
  expect(
    emptyResponse({
      now: "2026-10-20T10:00:00.000Z",
      maxRounds: 3,
      phase: "deciding",
      coordinatorSessionId: "coord-1",
      automationId: "auto-1",
    }),
  ).toEqual({
    phase: "deciding",
    round: 1,
    maxRounds: 3,
    coordinatorSessionId: "coord-1",
    automationId: "auto-1",
    agents: [],
    actionRuns: [],
    costUsd: 0,
    ownerTouched: false,
    next: { kind: "working", detail: "Starting" },
    ledger: [],
    droppedLedger: 0,
    startedAt: "2026-10-20T10:00:00.000Z",
    updatedAt: "2026-10-20T10:00:00.000Z",
  });
});
