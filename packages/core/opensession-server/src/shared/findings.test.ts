import { describe, expect, test } from "bun:test";
import {
  FINDING_ID,
  FINDINGS_COPY,
  FINDINGS_LIMITS,
  claimKey,
  droppedLinesCopy,
  findingSetOf,
  previousFindingSet,
  provenanceLabel,
  type FindingsSet,
} from "./findings";
import type { AgentRole } from "./incident-response";

function set(role: AgentRole, round: number): FindingsSet {
  return {
    role,
    round,
    attempt: 1,
    sessionId: `os-${role}-${round}`,
    source: "tool",
    updatedAt: "2026-10-27T14:32:00Z",
    calls: 1,
    blocks: [
      {
        id: "unknown",
        kind: "question",
        size: "full",
        text: "Why does checkout on acme.example.test time out?",
        wouldAnswer: "The upstream's response times around 14:00.",
      },
    ],
    notes: [],
  };
}

describe("shared findings contracts", () => {
  test("findingSetOf picks by role and round", () => {
    const r = {
      findingSets: [
        set("investigator", 1),
        set("verifier", 1),
        set("investigator", 2),
      ],
    };
    expect(findingSetOf(r, "investigator", 2)).toBe(r.findingSets[2]);
    expect(findingSetOf(r, "verifier", 2)).toBeUndefined();
    expect(findingSetOf(undefined, "investigator", 1)).toBeUndefined();
    expect(previousFindingSet(r, "investigator", 3)).toBe(r.findingSets[2]);
    expect(previousFindingSet(r, "investigator", 1)).toBeUndefined();
  });

  test("claimKey reads quotes, case, spacing and a closing stop alike", () => {
    expect(claimKey("The \u201cpool\u201d is  small.")).toBe(
      claimKey('the "pool" is small'),
    );
  });

  test("limits are the spec's numbers", () => {
    expect(FINDINGS_LIMITS.blocks).toBe(12);
    expect(FINDINGS_LIMITS.setBytes).toBe(65536);
    expect(FINDINGS_LIMITS.totalBytes).toBe(262144);
    expect(FINDINGS_LIMITS.inputBytes).toBe(131072);
    expect(FINDINGS_LIMITS.windowMs).toBe(31 * 86_400_000);
    expect(FINDINGS_LIMITS.callsPerSet).toBe(60);
    expect(FINDINGS_LIMITS.sets).toBe(12);
    expect(FINDINGS_LIMITS.logLines).toBe(40);
    expect(FINDINGS_LIMITS.logLineChars).toBe(500);
    expect(FINDINGS_LIMITS.timelineEvents).toBe(30);
    expect(FINDINGS_LIMITS.eventText).toBe(140);
    expect(FINDINGS_LIMITS.markers).toBe(10);
    expect(FINDINGS_LIMITS.markerLabel).toBe(40);
    expect(FINDINGS_LIMITS.title).toBe(80);
    expect(FINDINGS_LIMITS.prose).toBe(600);
    expect(FINDINGS_LIMITS.quoteMinChars).toBe(8);
  });

  test("ids are short slugs", () => {
    for (const id of ["slow-db", "a", "x".repeat(40)])
      expect(FINDING_ID.test(id)).toBe(true);
    for (const id of ["Slow", "-a", "a_b", "x".repeat(41), ""]) {
      expect(FINDING_ID.test(id)).toBe(false);
    }
    // The pattern follows the limit, so the two can't drift apart.
    expect(FINDING_ID.test("x".repeat(FINDINGS_LIMITS.idMax))).toBe(true);
    expect(FINDING_ID.test("x".repeat(FINDINGS_LIMITS.idMax + 1))).toBe(false);
  });

  test("provenance labels", () => {
    expect(provenanceLabel({ kind: "host", label: "prod-1" })).toEqual({
      text: "from prod-1",
      quiet: false,
    });
    expect(provenanceLabel({ kind: "web" })).toEqual({
      text: "from the web",
      quiet: false,
    });
    expect(provenanceLabel({ kind: "shell" })).toEqual({
      text: "from the agent's shell",
      quiet: true,
    });
    expect(provenanceLabel({ kind: "workspace" })).toEqual({
      text: "from the agent's workspace",
      quiet: true,
    });
    expect(provenanceLabel({ kind: "tool", label: "Task" })).toEqual({
      text: "from Task",
      quiet: true,
    });
    expect(provenanceLabel({ kind: "connector", label: "Datadog" })).toEqual({
      text: "from Datadog",
      quiet: false,
    });
  });

  test("dropped lines copy", () => {
    expect(droppedLinesCopy(1)).toBe("1 line couldn't be found in the source");
    expect(droppedLinesCopy(3)).toBe("3 lines couldn't be found in the source");
  });

  test("copy", () => {
    expect(FINDINGS_COPY.underWay(2)).toBe("Round 2 under way");
    expect(FINDINGS_COPY.byline("verifier", "14:32")).toBe(
      "from the verifier, 14:32",
    );
    expect(FINDINGS_COPY.earlierRow(1)).toBe("Round 1 findings");
    expect(FINDINGS_COPY.status).toEqual({
      verified: "Verified",
      refuted: "Refuted",
      "cant-tell": "Can't tell",
      unchecked: "Not checked yet",
    });
  });

  test("copy is frozen", () => {
    expect(Object.isFrozen(FINDINGS_COPY)).toBe(true);
    expect(Object.isFrozen(FINDINGS_COPY.status)).toBe(true);
  });
});
