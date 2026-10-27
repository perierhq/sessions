/**
 * Demo findings (OPENSESSION_DEMO=1 only, seeded with the demo incidents):
 * the blocks the demo's investigator and verifier would have shown on the
 * search and checkout incident pages. Built from the same times the demo's
 * scripted history uses, so every window lands on recorded observations and
 * the PR ref points at the demo investigator's own pull request. No log
 * blocks: demo sessions have no transcripts to quote from.
 */
import type { FindingBlock, FindingsSet } from "../../shared/findings";
import type { AgentRole } from "../../shared/incident-response";
import { DEMO_PR_NUMBER } from "./fixtures";

const MINUTE_MS = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** The demo agents' session ids (`agent()` in demo/incidents.ts). */
const sessionOf = (role: AgentRole) => `demo-incident-${role}`;

/** The claim the veto investigator's report makes and its verifier checks. */
export const DEMO_REPLICA_CLAIM =
  "The replica was removed in the release config";

export interface DemoFindingsInput {
  kind: "veto" | "needs-you";
  signalId: string;
  openedAt: number;
  now: number;
  prUrl?: string;
}

function set(
  role: AgentRole,
  updatedAt: number,
  calls: number,
  blocks: FindingBlock[],
): FindingsSet {
  return {
    role,
    round: 1,
    attempt: 1,
    sessionId: sessionOf(role),
    source: "tool",
    updatedAt: iso(updatedAt),
    calls,
    blocks,
    notes: [],
  };
}

/** The search incident: a release dropped the read replica; fix deploying. */
function vetoSets(input: DemoFindingsInput): FindingsSet[] {
  const { signalId, openedAt, now, prUrl } = input;
  // The scripted search failures start four minutes before the incident
  // opens (three failed checks two minutes apart); the release lands a
  // minute before the first one.
  const failingFrom = openedAt - 4 * MINUTE_MS;
  const releaseAt = failingFrom - MINUTE_MS;
  const found = openedAt + 14 * MINUTE_MS;
  const verified = openedAt + 26 * MINUTE_MS;
  const pr = prUrl
    ? ({
        type: "pr",
        number: DEMO_PR_NUMBER,
        url: prUrl,
        sessionId: sessionOf("investigator"),
      } as const)
    : null;

  const investigator: FindingBlock[] = [
    {
      id: "dropped-replica",
      kind: "hypothesis",
      title: "The release removed the read replica",
      size: "half",
      statement:
        "Search queries wait on the primary index until they time out, because the release set `search.replicas` to 0.",
      confidence: "high",
      evidence: [
        ...(pr ? [pr] : []),
        { type: "block", id: "search-window", role: "investigator" },
      ],
      claims: [DEMO_REPLICA_CLAIM],
    },
    {
      id: "why-zero",
      kind: "question",
      size: "half",
      text: "Why did the release config set the replica count to 0?",
      wouldAnswer:
        "The commit that changed `search.replicas`, or whoever owns the release config.",
    },
    {
      id: "when",
      kind: "timeline",
      title: "How it started",
      size: "full",
      events: [
        {
          at: iso(releaseAt),
          text: "The release ships with `search.replicas` set to 0",
        },
        {
          at: iso(failingFrom),
          text: "Search checks start timing out after 10 s",
        },
        {
          at: iso(found),
          text: "Fix opened: restore two read replicas",
          ...(pr ? { ref: pr } : {}),
        },
      ],
    },
    {
      id: "search-window",
      kind: "signal",
      title: "Search since the release",
      size: "full",
      signalId,
      from: iso(openedAt - 30 * MINUTE_MS),
      to: iso(now),
      markers: [{ at: iso(releaseAt), label: "release" }],
    },
  ];
  if (pr)
    investigator.push({
      id: "fix",
      kind: "change",
      title: "Restore the read replicas",
      size: "full",
      change: pr,
      why: "Puts `search.replicas` back to 2, so reads leave the primary again.",
    });

  const verifier: FindingBlock[] = [
    {
      id: "before-after",
      kind: "compare",
      title: "Search before and after the release",
      size: "full",
      sides: [
        {
          label: "before the release",
          signal: {
            signalId,
            from: iso(releaseAt - 30 * MINUTE_MS),
            to: iso(releaseAt),
          },
        },
        {
          label: "after",
          signal: { signalId, from: iso(releaseAt), to: iso(now) },
        },
      ],
    },
  ];

  return [
    set("investigator", found, 4, investigator),
    set("verifier", verified, 1, verifier),
  ];
}

/** The checkout incident: a migration renamed a column; needs the owner. */
function needsYouSets(input: DemoFindingsInput): FindingsSet[] {
  const found = input.openedAt + 22 * MINUTE_MS;
  return [
    set("investigator", found, 2, [
      {
        id: "renamed-column",
        kind: "hypothesis",
        title: "Checkout reads a column the migration renamed",
        size: "half",
        statement:
          "The payments migration renamed the `currency` column, and the checkout service still reads the old name.",
        confidence: "medium",
        evidence: [],
        claims: [],
      },
      {
        id: "migration-order",
        kind: "question",
        size: "half",
        text: "Can the migration be applied before the deploy?",
        wouldAnswer:
          "Whoever runs payments migrations: whether it can go out ahead of the checkout deploy.",
      },
    ]),
  ];
}

/** The demo's findings for one incident, investigator set first. */
export function demoFindingSets(input: DemoFindingsInput): FindingsSet[] {
  return input.kind === "veto" ? vetoSets(input) : needsYouSets(input);
}
