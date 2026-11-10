/**
 * Blob turn metrics: what a batch may hold, how one person's days stay
 * bounded and expire, and the two routes (the batch post with its size cap
 * and rate limit, the owner-only review). Runs on the in-memory kernel
 * store with a fixed clock.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionKernelStore,
  __setSessionKernelStoreForTest,
} from "./session-kernel";
import type { RouteContext } from "./routes/context";

const root = mkdtempSync(join(tmpdir(), "blob-metrics-test-"));
const prior = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = root;

type Metrics = typeof import("./blob-metrics");
type Routes = typeof import("./routes/blob-metrics");
let metrics: Metrics;
let routes: Routes;

beforeAll(async () => {
  // The review reads transcripts through modules that read the config.
  await (await import("./config")).getConfigAsync();
  metrics = await import("./blob-metrics");
  routes = await import("./routes/blob-metrics");
});

afterAll(() => {
  if (prior === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = prior;
  rmSync(root, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-07-01T12:00:00Z");
let store: SessionKernelStore;
let previousStore: SessionKernelStore | undefined;
let restoreRoutes: () => void = () => {};
let signIn = false;
let owner = true;

beforeEach(() => {
  rmSync(join(root, ".opensession-blob-metrics"), {
    recursive: true,
    force: true,
  });
  store = new SessionKernelStore(":memory:");
  previousStore = __setSessionKernelStoreForTest(store);
  metrics.resetBlobMetricsRateLimit();
  signIn = false;
  owner = true;
  restoreRoutes = routes.__setBlobMetricsRouteDepsForTest({
    now: () => NOW,
    signInRequired: () => signIn,
    isOwner: () => owner,
  });
});

afterEach(() => {
  restoreRoutes();
  __setSessionKernelStoreForTest(previousStore);
  store.close();
});

function turn(overrides: Record<string, unknown> = {}) {
  return {
    turnId: `t-${Math.random().toString(36).slice(2)}`,
    startedAt: NOW - 60_000,
    input: "voice",
    outcome: "answered",
    transcriber: "apple",
    transcribeMs: 180,
    endOfSpeech: "tap",
    speechMs: 2400,
    sendToAcceptedMs: 90,
    acceptedToFirstTokenMs: 1800,
    firstTokenToFirstAudioMs: 700,
    voice: "fish:s2.1-pro",
    sentencesSpoken: 2,
    replyChars: 240,
    inputChars: 32,
    blocks: ["metrics", "list"],
    thinkingSteps: 3,
    appVersion: "1.4.0",
    build: "212",
    posture: "closed",
    ...overrides,
  };
}

function ctx(
  path: string,
  method: string,
  body?: unknown,
  authUser: RouteContext["authUser"] = null,
  raw?: string,
): RouteContext {
  const url = new URL(`http://example.test${path}`);
  return {
    req: new Request(url, {
      method,
      ...(body === undefined && raw === undefined
        ? {}
        : {
            body: raw ?? JSON.stringify(body),
            headers: { "Content-Type": "application/json" },
          }),
    }),
    url,
    path: url.pathname,
    publicPrefix: "",
    authUser,
  };
}

describe("cleanTurnMetric", () => {
  test("keeps a full turn as sent", () => {
    const raw = turn({
      reasked: true,
      interrupted: "hush",
      replyEntryId: "e-1",
    });
    expect(metrics.cleanTurnMetric(raw, NOW)).toEqual({
      ...raw,
      reasked: true,
    } as never);
  });

  test("rejects a turn without id, mode, outcome or a start in the window", () => {
    for (const bad of [
      turn({ turnId: "" }),
      turn({ turnId: "has spaces" }),
      turn({ input: "telepathy" }),
      turn({ outcome: "maybe" }),
      turn({ startedAt: "yesterday" }),
      turn({ startedAt: NOW - 91 * DAY }),
      turn({ startedAt: NOW + 60 * 60_000 }),
      null,
      [],
      "turn",
    ])
      expect(metrics.cleanTurnMetric(bad, NOW)).toBeNull();
  });

  test("drops free text and out-of-shape fields instead of guessing", () => {
    const clean = metrics.cleanTurnMetric(
      turn({
        voice: "a voice with words in it",
        transcriber: "whisper",
        transcribeMs: -5,
        speechMs: Number.NaN,
        blocks: ["metrics", "Not A Kind", 7, "metrics"],
        reasked: "yes",
        text: "what shipped this week?",
        posture: "flat",
      }),
      NOW,
    )!;
    expect(clean.voice).toBeUndefined();
    expect(clean.transcriber).toBeUndefined();
    expect(clean.transcribeMs).toBeUndefined();
    expect(clean.speechMs).toBeUndefined();
    expect(clean.blocks).toEqual(["metrics"]);
    expect(clean.reasked).toBeUndefined();
    expect(clean.posture).toBeUndefined();
    expect(JSON.stringify(clean)).not.toContain("shipped");
  });

  test("caps durations at an hour", () => {
    expect(
      metrics.cleanTurnMetric(turn({ acceptedToFirstTokenMs: 9e9 }), NOW)!
        .acceptedToFirstTokenMs,
    ).toBe(60 * 60 * 1000);
  });
});

describe("parseMetricsBatch", () => {
  test("needs a turns array of at most MAX_BATCH", () => {
    expect(metrics.parseMetricsBatch({}, NOW).ok).toBe(false);
    expect(metrics.parseMetricsBatch({ turns: "x" }, NOW).ok).toBe(false);
    const big = Array.from({ length: metrics.MAX_BATCH + 1 }, () => turn());
    expect(metrics.parseMetricsBatch({ turns: big }, NOW).ok).toBe(false);
  });

  test("keeps the good turns and counts the rest", () => {
    const result = metrics.parseMetricsBatch(
      { turns: [turn(), { turnId: "x" }, turn()] },
      NOW,
    );
    expect(result.ok && result.turns.length).toBe(2);
    expect(result.ok && result.rejected).toBe(1);
  });

  test("keeps only the batch's newest MAX_DAYS_PER_BATCH days", () => {
    const turns = Array.from(
      { length: metrics.MAX_DAYS_PER_BATCH + 2 },
      (_, back) => turn({ turnId: `d${back}`, startedAt: NOW - back * DAY }),
    );
    const result = metrics.parseMetricsBatch({ turns }, NOW);
    expect(result.ok && result.turns.map((t) => t.turnId)).toEqual(
      turns.slice(0, metrics.MAX_DAYS_PER_BATCH).map((t) => t.turnId),
    );
    expect(result.ok && result.rejected).toBe(2);
  });
});

describe("storage", () => {
  test("stores per person per UTC day and reads the window back", async () => {
    const today = metrics.cleanTurnMetric(turn({ turnId: "a" }), NOW)!;
    const earlier = metrics.cleanTurnMetric(
      turn({ turnId: "b", startedAt: NOW - 3 * DAY }),
      NOW,
    )!;
    const old = metrics.cleanTurnMetric(
      turn({ turnId: "c", startedAt: NOW - 20 * DAY }),
      NOW,
    )!;
    expect(
      await metrics.appendBlobMetrics("Ada", [today, earlier, old], NOW),
    ).toBe(3);
    // Another spelling of the same person reads the same documents.
    const read = await metrics.readBlobMetrics("ada", 14, NOW);
    expect(read.map((t) => t.turnId)).toEqual(["b", "a"]);
    expect(await metrics.blobMetricsDays("Ada")).toEqual([
      metrics.utcDay(NOW - 20 * DAY),
      metrics.utcDay(NOW - 3 * DAY),
      metrics.utcDay(NOW),
    ]);
    expect(await metrics.readBlobMetrics("Grace", 14, NOW)).toEqual([]);
  });

  test("a re-sent turn replaces the stored one", async () => {
    const first = metrics.cleanTurnMetric(turn({ turnId: "same" }), NOW)!;
    await metrics.appendBlobMetrics("Ada", [first], NOW);
    await metrics.appendBlobMetrics(
      "Ada",
      [{ ...first, outcome: "failed" }],
      NOW,
    );
    const read = await metrics.readBlobMetrics("Ada", 1, NOW);
    expect(read).toHaveLength(1);
    expect(read[0]!.outcome).toBe("failed");
  });

  test("a day keeps only its newest MAX_TURNS_PER_DAY turns", () => {
    const many = Array.from(
      { length: metrics.MAX_TURNS_PER_DAY + 5 },
      (_, index) =>
        metrics.cleanTurnMetric(
          turn({ turnId: `t${index}`, startedAt: NOW - 1_000_000 + index }),
          NOW,
        )!,
    );
    const merged = metrics.mergeTurns([], many);
    expect(merged).toHaveLength(metrics.MAX_TURNS_PER_DAY);
    expect(merged[0]!.turnId).toBe("t5");
    expect(merged.at(-1)!.turnId).toBe(`t${metrics.MAX_TURNS_PER_DAY + 4}`);
  });

  test("days past retention are deleted on the next append", async () => {
    const start = NOW - 80 * DAY;
    await metrics.appendBlobMetrics(
      "Ada",
      [
        metrics.cleanTurnMetric(
          turn({ turnId: "old", startedAt: start }),
          start,
        )!,
      ],
      start,
    );
    const later = NOW + 15 * DAY;
    await metrics.appendBlobMetrics(
      "Ada",
      [
        metrics.cleanTurnMetric(
          turn({ turnId: "new", startedAt: later }),
          later,
        )!,
      ],
      later,
    );
    expect(await metrics.blobMetricsDays("Ada")).toEqual([
      metrics.utcDay(later),
    ]);
    const oldKey = `${metrics.blobMetricsPersonKey("Ada")}.${metrics.utcDay(start)}`;
    const { catalogDocuments } = await import("./catalog-documents");
    expect(
      await catalogDocuments(metrics.BLOB_METRICS_NAMESPACE).get(oldKey),
    ).toBeNull();
  });

  test("days past retention are deleted on read too", async () => {
    const start = NOW - 80 * DAY;
    await metrics.appendBlobMetrics(
      "Ada",
      [
        metrics.cleanTurnMetric(
          turn({ turnId: "old", startedAt: start }),
          start,
        )!,
      ],
      start,
    );
    const later = NOW + 15 * DAY;
    expect(await metrics.readBlobMetrics("Ada", 14, later)).toEqual([]);
    expect(await metrics.blobMetricsDays("Ada")).toEqual([]);
    const oldKey = `${metrics.blobMetricsPersonKey("Ada")}.${metrics.utcDay(start)}`;
    const { catalogDocuments } = await import("./catalog-documents");
    expect(
      await catalogDocuments(metrics.BLOB_METRICS_NAMESPACE).get(oldKey),
    ).toBeNull();
  });
});

describe("POST /api/blob/metrics", () => {
  test("stores a batch for the signed-in person", async () => {
    const res = await routes.handleBlobMetricsRoutes(
      ctx(
        "/api/blob/metrics",
        "POST",
        { user: "Mallory", turns: [turn(), { bad: 1 }] },
        {
          login: "ada",
          name: "Ada Lovelace",
        },
      ),
    );
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ stored: 1, rejected: 1 });
    expect(await metrics.readBlobMetrics("Ada", 1, NOW)).toHaveLength(1);
    expect(await metrics.readBlobMetrics("Mallory", 1, NOW)).toHaveLength(0);
  });

  test("refuses bad shapes, a missing user and oversized bodies", async () => {
    const post = (body?: unknown, raw?: string) =>
      routes.handleBlobMetricsRoutes(
        ctx("/api/blob/metrics", "POST", body, null, raw),
      );
    expect((await post({ user: "Ada" }))!.status).toBe(400);
    expect((await post({ turns: [turn()] }))!.status).toBe(400);
    expect((await post(undefined, "{not json"))!.status).toBe(400);
    const huge = JSON.stringify({
      user: "Ada",
      turns: [turn({ pad: "x".repeat(metrics.MAX_BODY_BYTES) })],
    });
    expect((await post(undefined, huge))!.status).toBe(413);
  });

  test("limits batches per person per minute", async () => {
    let last: Response | undefined;
    for (let index = 0; index <= metrics.METRICS_PER_MINUTE; index++)
      last = await routes.handleBlobMetricsRoutes(
        ctx("/api/blob/metrics", "POST", { user: "Ada", turns: [] }),
      );
    expect(last!.status).toBe(429);
    const other = await routes.handleBlobMetricsRoutes(
      ctx("/api/blob/metrics", "POST", { user: "Grace", turns: [] }),
    );
    expect(other!.status).toBe(200);
  });
});

describe("GET /api/blob/review", () => {
  test("is the instance owner's only when sign-in is on", async () => {
    signIn = true;
    const signedOut = await routes.handleBlobMetricsRoutes(
      ctx("/api/blob/review", "GET"),
    );
    expect(signedOut!.status).toBe(401);
    owner = false;
    const teammate = await routes.handleBlobMetricsRoutes(
      ctx("/api/blob/review", "GET", undefined, {
        login: "grace",
        name: "Grace",
      }),
    );
    expect(teammate!.status).toBe(403);
  });

  test("aggregates the owner's own turns, without text", async () => {
    signIn = true;
    await metrics.appendBlobMetrics(
      "Ada",
      [
        metrics.cleanTurnMetric(turn({ turnId: "fast" }), NOW)!,
        metrics.cleanTurnMetric(
          turn({
            turnId: "slow",
            acceptedToFirstTokenMs: 9000,
            outcome: "failed",
          }),
          NOW,
        )!,
      ],
      NOW,
    );
    const res = await routes.handleBlobMetricsRoutes(
      ctx("/api/blob/review?days=7&user=Grace", "GET", undefined, {
        login: "ada",
        name: "Ada",
      }),
    );
    expect(res!.status).toBe(200);
    const review = await res!.json();
    expect(review.window.days).toBe(7);
    expect(review.app.turns).toBe(2);
    expect(review.app.byOutcome).toEqual({ answered: 1, failed: 1 });
    expect(review.samples.slowest[0].turnId).toBe("slow");
    expect(review.samples.failed[0].turnId).toBe("slow");
  });

  test("reads the claimed user when sign-in is off", async () => {
    const missing = await routes.handleBlobMetricsRoutes(
      ctx("/api/blob/review", "GET"),
    );
    expect(missing!.status).toBe(400);
    const res = await routes.handleBlobMetricsRoutes(
      ctx("/api/blob/review?user=Ada&days=400", "GET"),
    );
    expect((await res!.json()).window.days).toBe(90);
  });

  test("limits reviews per person per minute", async () => {
    for (let i = 0; i < metrics.REVIEWS_PER_MINUTE; i++)
      metrics.blobReviewRateLimited("Ada", NOW);
    const res = await routes.handleBlobMetricsRoutes(
      ctx("/api/blob/review?user=Ada", "GET"),
    );
    expect(res!.status).toBe(429);
  });
});
