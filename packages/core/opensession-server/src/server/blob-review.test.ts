/**
 * The Blob review's aggregation: owner turns read off a supervisor
 * transcript, latency percentiles, re-asks, interruptions, the inbox and
 * ledger counts, the sampled turn ids, and which sessions a review reads.
 * Pure functions and fake sources; no store.
 */
import { describe, expect, test } from "bun:test";
import type { TranscriptEntry } from "@tellahq/opensession-protocol/session";
import type { BlobTurnMetric } from "./blob-metrics";
import {
  aggregateBlobReview,
  buildBlobReview,
  distribution,
  ledgerEntriesSince,
  localHour,
  MAX_REVIEW_SESSIONS,
  transcriptTurns,
  type BlobReviewSources,
} from "./blob-review";
import type { SupervisorItem } from "./supervisor-inbox";

const NOW = Date.parse("2026-07-01T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const iso = (at: number) => new Date(at).toISOString();

function entry(
  id: string,
  type: TranscriptEntry["type"],
  at: number,
  content = "",
  extra: Partial<TranscriptEntry> = {},
): TranscriptEntry {
  return { id, type, content, timestamp: iso(at), ...extra };
}

function metric(overrides: Partial<BlobTurnMetric>): BlobTurnMetric {
  return {
    turnId: "t",
    startedAt: NOW - 60_000,
    input: "voice",
    outcome: "answered",
    ...overrides,
  };
}

function item(overrides: Partial<SupervisorItem>): SupervisorItem {
  return {
    id: "i",
    user: "Ada",
    source: "supervisor",
    kind: "needs-you",
    title: "t",
    body: "",
    createdAt: NOW - DAY,
    updatedAt: NOW - DAY,
    state: "open",
    ...overrides,
  };
}

const base = NOW - 2 * DAY;
const transcript: TranscriptEntry[] = [
  entry("u1", "user", base, "what shipped this week?"),
  entry("r1", "assistant", base + 500, "thinking", { isReasoning: true }),
  entry("tu1", "tool_use", base + 800, "", { toolName: "list_sessions" }),
  entry("tr1", "tool_result", base + 900, "", { isError: true }),
  entry("tu2", "tool_use", base + 1000, "", { toolName: "list_sessions" }),
  entry("a1", "assistant", base + 4000, "Two PRs merged."),
  // Asked again, about the same length, 20 s after the reply.
  entry("u2", "user", base + 24_000, "what shipped this week??"),
  entry("a2", "assistant", base + 26_000, "Two PRs merged, both green."),
  // A system-triggered turn: its tools are not the owner's.
  entry("b1", "user", base + 60_000, "", { turnBoundary: true }),
  entry("tu3", "tool_use", base + 61_000, "", { toolName: "read_ledger" }),
  // Never answered.
  entry("u3", "user", base + 3_600_000, "and the deploy?"),
];

describe("transcriptTurns", () => {
  test("reads owner turns, their tools, replies and re-asks", () => {
    const turns = transcriptTurns({ sessionId: "os-sup", entries: transcript });
    expect(turns.map((turn) => turn.entryId)).toEqual(["u1", "u2", "u3"]);
    expect(turns[0]).toMatchObject({
      firstReplyMs: 4000,
      durationMs: 4000,
      replyEntryId: "a1",
      replyChars: "Two PRs merged.".length,
      tools: ["list_sessions", "list_sessions"],
      toolErrors: 1,
      reasked: false,
    });
    expect(turns[1]!.reasked).toBe(true);
    expect(turns[1]!.tools).toEqual([]);
    expect(turns[2]).toMatchObject({ replyEntryId: null, reasked: false });
  });
});

describe("aggregateBlobReview", () => {
  const review = aggregateBlobReview({
    now: NOW,
    days: 14,
    timeZone: "Europe/Warsaw",
    sessions: [{ sessionId: "os-sup", entries: transcript }],
    metrics: [
      metric({
        turnId: "slow",
        startedAt: base,
        sendToAcceptedMs: 100,
        acceptedToFirstTokenMs: 3900,
        firstTokenToFirstAudioMs: 800,
        transcriber: "apple",
        transcribeMs: 200,
        transcriberReason: "parakeet-loading-timeout",
        parakeetLoadMs: 3000,
        endOfSpeech: "tap",
        sentencesSpoken: 2,
        interrupted: "tap",
        replyChars: 15,
        blocks: ["metrics"],
        voice: "fish:s2.1-pro",
      }),
      metric({
        turnId: "fast",
        startedAt: base + 24_000,
        input: "typed",
        sendToAcceptedMs: 50,
        acceptedToFirstTokenMs: 1950,
        sentencesSpoken: 1,
        reasked: true,
        replyEntryId: "a2",
      }),
      metric({
        turnId: "lost",
        startedAt: base + 3_600_000,
        outcome: "failed",
      }),
      metric({ turnId: "ancient", startedAt: NOW - 30 * DAY }),
    ],
    items: [
      item({
        id: "a",
        state: "answered",
        options: ["Approve", "Not now"],
        answer: "approve",
        answeredAt: NOW - DAY + 600_000,
        answeredBy: "owner",
        source: "lead:acme",
        project: "acme",
      }),
      item({ id: "b", state: "dismissed", kind: "fyi" }),
      item({ id: "c", state: "open" }),
      item({
        id: "old",
        state: "answered",
        createdAt: NOW - 40 * DAY,
        updatedAt: NOW - 40 * DAY,
      }),
    ],
    ledger: [
      "# Ledger",
      "## 2026-06-30 09:00 UTC",
      "Prefers short replies.",
      "## 2026-05-01 09:00 UTC",
      "Old.",
    ].join("\n"),
  });

  test("counts only the window", () => {
    expect(review.app.turns).toBe(3);
    expect(review.inbox.items).toBe(3);
    expect(review.ledger.entries).toBe(1);
  });

  test("reports app latencies, modes and annoyances", () => {
    expect(review.app.byInput).toEqual({ voice: 2, typed: 1 });
    expect(review.app.byOutcome).toEqual({ answered: 2, failed: 1 });
    expect(review.app.latencyMs.sendToFirstToken).toMatchObject({
      n: 2,
      p50: 2000,
      max: 4000,
    });
    expect(review.app.transcribers.apple).toMatchObject({ turns: 1 });
    expect(review.app.interruptions).toEqual({ rate: 0.5, byKind: { tap: 1 } });
    expect(review.app.reasks.count).toBe(1);
    expect(review.app.voices).toEqual({ "fish:s2.1-pro": 1 });
    expect(review.app.blocks).toEqual({ metrics: 1 });
  });

  test("reports why voice turns used their transcriber", () => {
    const voice = (
      turnId: string,
      at: number,
      fields: Partial<BlobTurnMetric>,
    ): BlobTurnMetric =>
      metric({ turnId, startedAt: base + at, input: "voice", ...fields });
    const stt = aggregateBlobReview({
      now: NOW,
      days: 14,
      timeZone: "UTC",
      sessions: [],
      items: [],
      ledger: "",
      metrics: [
        voice("p1", 0, {
          transcriber: "parakeet",
          transcriberReason: "parakeet",
          parakeetLoadMs: 1000,
        }),
        voice("p2", 1000, {
          transcriber: "parakeet",
          transcriberReason: "parakeet",
          parakeetLoadMs: 2000,
          parakeetWaitMs: 1500,
        }),
        voice("a1", 2000, {
          transcriber: "apple",
          transcriberReason: "parakeet-loading-timeout",
          parakeetLoadMs: 5000,
          parakeetWaitMs: 15000,
        }),
        voice("a2", 3000, {
          transcriber: "apple",
          transcriberReason: "too-short",
        }),
        voice("f1", 3500, {
          transcriber: "fish",
          transcribeMs: 900,
          transcriberReason: "fish",
          parakeetMiss: "parakeet-loading-timeout",
        }),
        voice("f2", 3600, {
          transcriber: "apple",
          transcriberReason: "fish-missed",
          parakeetMiss: "parakeet-absent",
        }),
        voice("old", 4000, {
          transcriber: "apple",
          transcribeMs: 7000,
          parakeetLoadMs: 8000,
          parakeetWaitMs: 8000,
        }),
        metric({
          turnId: "typed",
          startedAt: base + 5000,
          input: "typed",
          parakeetLoadMs: 9000,
        }),
      ],
    });
    expect(stt.app.transcriberReasons).toEqual({
      parakeet: 2,
      "parakeet-loading-timeout": 1,
      "too-short": 1,
      fish: 1,
      "fish-missed": 1,
    });
    expect(stt.app.parakeetMisses).toEqual({
      "parakeet-loading-timeout": 2,
      "parakeet-absent": 1,
    });
    // The old build's whole-chain timing stays out of the timings.
    expect(stt.app.untimedVoiceTurns).toBe(1);
    expect(stt.app.transcribers.apple!.turns).toBe(4);
    expect(stt.app.transcribers.apple!.ms.max).not.toBe(7000);
    expect(stt.app.latencyMs.transcribe.max).toBe(900);
    expect(stt.app.parakeetLoadMs).toMatchObject({
      n: 3,
      p50: 2000,
      p90: 5000,
      max: 5000,
    });
    // Old builds' waits stay out too.
    expect(stt.app.parakeetWaitMs).toMatchObject({ n: 2, max: 15000 });
  });

  test("reports transcript turns, tools and hours", () => {
    expect(review.transcript.ownerMessages).toBe(3);
    expect(review.transcript.unanswered).toBe(1);
    expect(review.transcript.reasks.count).toBe(1);
    expect(review.transcript.topTools).toEqual([
      { name: "list_sessions", calls: 2, turns: 1 },
    ]);
    expect(review.transcript.toolErrors).toBe(1);
    // 12:00 UTC in Warsaw summer time is 14:00.
    expect(review.transcript.busiestHours[0]!.hour).toBe(
      localHour(base, "Europe/Warsaw"),
    );
    expect(localHour(base, "Europe/Warsaw")).toBe(14);
  });

  test("reports inbox answer rates and lead outcomes", () => {
    expect(review.inbox.answerRate).toBe(0.5);
    expect(review.inbox.recommendedChosenRate).toBe(1);
    expect(review.inbox.timeToAnswerMs.p50).toBe(600_000);
    expect(review.inbox.leads).toMatchObject({
      proposals: 1,
      byState: { answered: 1 },
    });
    expect(review.inbox.bySource).toEqual({ lead: 1, supervisor: 2 });
  });

  test("samples turn ids linked to the transcript, never text", () => {
    expect(review.samples.slowest[0]).toMatchObject({
      turnId: "slow",
      sessionId: "os-sup",
      entryId: "u1",
      timeToFirstTokenMs: 4000,
    });
    expect(review.samples.failed[0]).toMatchObject({
      turnId: "lost",
      entryId: "u3",
    });
    expect(review.samples.interruptedOrReasked.map((s) => s.turnId)).toEqual([
      "fast",
      "slow",
    ]);
    expect(review.samples.interruptedOrReasked[0]!.entryId).toBe("u2");
    expect(review.samples.unansweredTranscript[0]!.entryId).toBe("u3");
    const json = JSON.stringify(review);
    for (const text of ["shipped", "Two PRs", "deploy", "Prefers", "Approve"])
      expect(json).not.toContain(text);
  });
});

describe("helpers", () => {
  test("distribution is nearest-rank", () => {
    expect(distribution([5, 1, 3, 2, 4])).toEqual({
      n: 5,
      p50: 3,
      p90: 5,
      p99: 5,
      max: 5,
    });
    expect(distribution([])).toEqual({
      n: 0,
      p50: null,
      p90: null,
      p99: null,
      max: null,
    });
  });

  test("ledgerEntriesSince reads dated headings", () => {
    expect(
      ledgerEntriesSince("## 2026-06-30 10:00 UTC\nx\n## bad\n", NOW - 2 * DAY),
    ).toBe(1);
  });
});

describe("buildBlobReview", () => {
  test("reads the owner's sessions newest first and stops at the window", async () => {
    const read: string[] = [];
    const opened: string[] = [];
    const activity: Record<string, number | null> = {
      current: NOW - 1000,
      gone: null,
      lastWeek: NOW - 8 * DAY,
      monthAgo: NOW - 30 * DAY,
      older: NOW - 40 * DAY,
    };
    const sources: Partial<BlobReviewSources> = {
      now: () => NOW,
      metrics: async () => [],
      supervisorSessionIds: async (user) => {
        expect(user).toBe("Ada");
        return ["current", "gone", "lastWeek", "monthAgo", "older"];
      },
      session: async (id) => {
        opened.push(id);
        const lastActivity = activity[id];
        if (lastActivity == null) return null;
        return {
          lastActivity,
          transcript: async () => {
            read.push(id);
            return id === "current" ? transcript : [];
          },
        };
      },
      inbox: async () => ({ items: [], truncated: false }),
      ledger: async () => "",
      timeZone: async () => "UTC",
    };
    const review = await buildBlobReview("Ada", 14, sources);
    expect(read).toEqual(["current", "lastWeek"]);
    expect(opened).toEqual(["current", "gone", "lastWeek", "monthAgo"]);
    expect(review.sources.supervisorSessions).toEqual(["current", "lastWeek"]);
    expect(review.sources.sessionsTruncated).toBe(false);
    expect(review.transcript.ownerMessages).toBe(3);
  });

  test("reports a capped session list and a capped inbox", async () => {
    const ids = Array.from(
      { length: MAX_REVIEW_SESSIONS + 2 },
      (_, i) => `s${i}`,
    );
    const review = await buildBlobReview("Ada", 14, {
      now: () => NOW,
      metrics: async () => [],
      supervisorSessionIds: async () => ids,
      session: async () => ({
        lastActivity: NOW - 1000,
        transcript: async () => [],
      }),
      inbox: async () => ({ items: [item({ id: "a" })], truncated: true }),
      ledger: async () => "",
      timeZone: async () => "UTC",
    });
    expect(review.sources.supervisorSessions).toHaveLength(MAX_REVIEW_SESSIONS);
    expect(review.sources.sessionsTruncated).toBe(true);
    expect(review.sources.inboxTruncated).toBe(true);
    expect(review.inbox.truncated).toBe(true);
  });
});
