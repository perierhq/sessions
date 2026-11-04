import { expect, test } from "bun:test";
import type { FindingsSet } from "../../../shared/findings";
import type { IncidentResponse } from "../../../shared/incident-response";
import type { Incident } from "../../../shared/incidents";
import { incidentPrUrls, knownPrs, mergedFixFor } from "./outside";

const url = (n: number) => `https://github.com/acme/web/pull/${n}`;

function response(): IncidentResponse {
  return {
    phase: "needs-you",
    round: 3,
    maxRounds: 2,
    agents: [
      { role: "investigator", round: 1, prUrl: url(11) },
      { role: "verifier", round: 1 },
      { role: "investigator", round: 3, prUrl: url(13) },
      // A send-back kept the same session and its pull request.
      { role: "investigator", round: 3, prUrl: url(13) },
      { role: "investigator", round: 2, prUrl: "not a pull request" },
    ] as IncidentResponse["agents"],
    candidate: {
      round: 3,
      prUrl: url(13),
    } as IncidentResponse["candidate"],
    actionRuns: [],
    costUsd: 0,
    ownerTouched: false,
    ledger: [],
    droppedLedger: 0,
    next: { kind: "working", detail: "" },
    startedAt: "2026-10-20T12:00:00.000Z",
    updatedAt: "2026-10-20T12:00:00.000Z",
  };
}

test("an incident's pull requests: every round's, each once, with its round", () => {
  expect(incidentPrUrls(response())).toEqual([
    { url: url(11), number: 11, round: 1 },
    { url: url(13), number: 13, round: 3 },
  ]);
});

test("known pull requests: only the ones the PR cache knows; a lookup that throws knows none", () => {
  const at = "2026-10-21T09:00:00.000Z";
  expect(
    knownPrs(response(), (u) =>
      u === url(13) ? { state: "MERGED", updatedAt: at } : undefined,
    ),
  ).toEqual([
    { url: url(13), number: 13, round: 3, state: "MERGED", updatedAt: at },
  ]);
  expect(
    knownPrs(response(), () => {
      throw new Error("cache unavailable");
    }),
  ).toEqual([]);
});

// ── A fix merged already: the card's "I released it, watch" ────────────────

const OPENED = "2026-10-20T12:00:00.000Z";
const AFTER = "2026-10-21T09:00:00.000Z";
const BEFORE = "2026-10-19T09:00:00.000Z";

function waiting(over: Partial<IncidentResponse> = {}): Incident {
  return {
    id: "inc-1",
    project: "acme",
    title: "Search is down",
    state: "needs-you",
    severity: "major",
    owner: "Ada",
    openedBy: { kind: "rule" },
    signalIds: ["sig-a"],
    primarySignalId: "sig-a",
    openedAt: OPENED,
    updatedAt: OPENED,
    lastProblemAt: OPENED,
    findings: [],
    events: [],
    droppedEvents: 0,
    response: {
      ...response(),
      needsYou: {
        kind: "rounds",
        reason: "Not certain after 3 rounds",
        since: "2026-10-22T09:00:00.000Z",
        resumePhase: "verifying",
      },
      ...over,
    },
  };
}

/** The latest round's verifier naming pull requests in its reasons. */
function naming(text: string, round = 3): Partial<IncidentResponse> {
  const base = response();
  return {
    agents: [
      ...base.agents,
      {
        role: "verifier",
        round,
        report: {
          role: "verifier",
          verdict: "not-certain",
          reasons: [text],
          claims: [],
          proofAccepted: false,
        },
      } as unknown as IncidentResponse["agents"][number],
    ],
  };
}

test("a fix merged already: the incident's own pull request, merged before the card went up", () => {
  const lookup = (u: string) =>
    u === url(13)
      ? {
          state: "MERGED" as const,
          updatedAt: AFTER,
          mergedAt: BEFORE,
          headSha: "abc1234",
        }
      : undefined;
  expect(mergedFixFor(waiting(), lookup)).toEqual({
    url: url(13),
    number: 13,
    at: BEFORE,
    headSha: "abc1234",
  });
  // One Sessions already acted on is not offered again.
  expect(mergedFixFor(waiting({ settledPrs: [url(13)] }), lookup)).toBe(
    undefined,
  );
  // The PR cache's row doesn't say when it merged: not acted on.
  expect(
    mergedFixFor(waiting(), (u) =>
      u === url(13) ? { state: "MERGED", updatedAt: AFTER } : undefined,
    ),
  ).toBe(undefined);
  // Open or closed: nothing merged.
  expect(
    mergedFixFor(waiting(), (u) =>
      u === url(13) ? { state: "CLOSED", updatedAt: AFTER } : undefined,
    ),
  ).toBe(undefined);
});

test("a fix merged already: another pull request the latest round's agents named, merged since the incident opened", () => {
  const lookup = (u: string) =>
    u === url(9)
      ? { state: "MERGED" as const, updatedAt: AFTER, mergedAt: AFTER }
      : u === url(8)
        ? // Merged before the incident; a comment since moved its update.
          { state: "MERGED" as const, updatedAt: AFTER, mergedAt: BEFORE }
        : undefined;
  expect(
    mergedFixFor(
      waiting(naming("PR #9 drops the slowest call; #8 is older")),
      lookup,
    ),
  ).toEqual({ url: url(9), number: 9, at: AFTER, named: true });
  // By its URL too; another repository's pull request is not this fix.
  expect(mergedFixFor(waiting(naming(`see ${url(9)}`)), lookup)).toMatchObject({
    number: 9,
  });
  expect(
    mergedFixFor(
      waiting(naming("see https://github.com/acme/api/pull/9")),
      lookup,
    ),
  ).toBe(undefined);
  // Merged before the incident opened: an old fix, not this one.
  expect(mergedFixFor(waiting(naming("PR #8")), lookup)).toBe(undefined);
  // Only the latest round's agents count.
  expect(mergedFixFor(waiting(naming("PR #9", 2)), lookup)).toBe(undefined);
  // The verifier's finding blocks name it too.
  const set = {
    role: "verifier",
    round: 3,
    sessionId: "child-9",
    blocks: [
      {
        id: "q",
        kind: "question",
        title: "Which goes out?",
        size: "half",
        text: "Merge PR #13 as is, or fold in PR #9's idea?",
      },
    ],
  } as unknown as FindingsSet;
  expect(mergedFixFor(waiting({ findingSets: [set] }), lookup)).toMatchObject({
    number: 9,
    named: true,
  });
});

test("a fix merged already: none while the card is an agent's question or a setup problem", () => {
  const lookup = () => ({
    state: "MERGED" as const,
    updatedAt: AFTER,
    mergedAt: AFTER,
  });
  for (const kind of ["question", "setup"] as const) {
    const i = waiting();
    i.response!.needsYou!.kind = kind;
    expect(mergedFixFor(i, lookup)).toBe(undefined);
  }
  const working = waiting();
  working.state = "investigating";
  expect(mergedFixFor(working, lookup)).toBe(undefined);
});
