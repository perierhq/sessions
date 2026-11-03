import { expect, test } from "bun:test";
import type { IncidentResponse } from "../../../shared/incident-response";
import { incidentPrUrls, knownPrs } from "./outside";

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
