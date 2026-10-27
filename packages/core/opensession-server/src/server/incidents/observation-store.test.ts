import { beforeEach, expect, test } from "bun:test";
import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  __resetObservationsForTest,
  appendObservations,
  flushObservations,
  forgetObservations,
  hasObservation,
  hydrateObservations,
  hydrationLookbackMs,
  MAIN_LANE,
  nearestObservation,
  observationTimes,
  pruneObservations,
  queryObservations,
  recentObservations,
  scanObservations,
} from "./observation-store";
import type { Signal } from "../../shared/incidents";
import { useIncidentTestKernel } from "./testing/kernel-fixture";

const kit = useIncidentTestKernel();
beforeEach(() => __resetObservationsForTest());
const ob = (at: string, result: "ok" | "fail" = "ok", lane?: string) => ({
  at,
  result,
  detail: "",
  ...(lane ? { lane } : {}),
});
const dir = () =>
  join(kit.root(), ".opensession-incident-observations", "sig-a");

test("rings: main lane by default, lanes on request, caps", () => {
  appendObservations("sig-a", [
    ob("2026-10-20T10:00:00Z"),
    ob("2026-10-20T10:00:00Z", "fail", "API"),
  ]);
  expect(recentObservations("sig-a")).toHaveLength(1);
  expect(recentObservations("sig-a", "API")[0].result).toBe("fail");
  expect(recentObservations("sig-a", "*")).toHaveLength(2);
  appendObservations(
    "sig-a",
    Array.from({ length: 800 }, (_, i) =>
      ob(new Date(Date.parse("2026-10-20T10:00:00Z") + i * 1000).toISOString()),
    ),
  );
  expect(recentObservations("sig-a")).toHaveLength(720);
  appendObservations(
    "sig-a",
    Array.from({ length: 30 }, (_, i) =>
      ob("2026-10-20T11:00:00Z", "ok", `lane-${i}`),
    ),
  );
  expect(
    new Set(recentObservations("sig-a", "*").map((o) => o.lane ?? "")).size,
  ).toBe(25);
  expect(() => appendObservations("../x", [])).toThrow("Invalid signal id");
});

test("writes daily files and hydrates after a restart, skipping a torn line", async () => {
  appendObservations("sig-a", [
    ob("2026-10-19T23:59:00Z", "fail"),
    ob("2026-10-20T00:01:00Z"),
  ]);
  await flushObservations();
  expect(await readFile(join(dir(), "2026-10-19.jsonl"), "utf8")).toContain(
    '"fail"',
  );
  await appendFile(
    join(dir(), "2026-10-20.jsonl"),
    '{"at":"2026-10-20T00:02:00Z","res',
  );
  __resetObservationsForTest();
  await hydrateObservations("sig-a", Date.parse("2026-10-20T00:05:00Z"));
  expect(recentObservations("sig-a").map((o) => o.at)).toEqual([
    "2026-10-19T23:59:00.000Z",
    "2026-10-20T00:01:00.000Z",
  ]);
});

test("a line written after a torn line survives", async () => {
  appendObservations("sig-a", [ob("2026-10-20T00:01:00Z")]);
  await flushObservations();
  await appendFile(
    join(dir(), "2026-10-20.jsonl"),
    '{"at":"2026-10-20T00:02:00Z","res',
  );
  __resetObservationsForTest();
  appendObservations("sig-a", [ob("2026-10-20T00:03:00Z", "fail")]);
  await flushObservations();
  __resetObservationsForTest();
  await hydrateObservations("sig-a", Date.parse("2026-10-20T00:05:00Z"));
  expect(recentObservations("sig-a").map((o) => o.at)).toEqual([
    "2026-10-20T00:01:00.000Z",
    "2026-10-20T00:03:00.000Z",
  ]);
});

test("hydration merges with observations appended before it, without duplicates", async () => {
  appendObservations("sig-a", [ob("2026-10-20T00:01:00Z")]);
  await flushObservations();
  __resetObservationsForTest();
  appendObservations("sig-a", [ob("2026-10-20T00:02:00Z", "fail")]);
  await hydrateObservations("sig-a", Date.parse("2026-10-20T00:05:00Z"));
  expect(recentObservations("sig-a").map((o) => o.at)).toEqual([
    "2026-10-20T00:01:00.000Z",
    "2026-10-20T00:02:00.000Z",
  ]);
});

test("queries across days from files, bounded to 31 days", async () => {
  appendObservations("sig-a", [
    ob("2026-10-18T12:00:00Z"),
    ob("2026-10-19T12:00:00Z"),
    ob("2026-10-20T12:00:00Z"),
  ]);
  await flushObservations();
  __resetObservationsForTest();
  const got = await queryObservations(
    "sig-a",
    Date.parse("2026-10-18T13:00:00Z"),
    Date.parse("2026-10-20T12:00:00Z"),
  );
  expect(got.map((o) => o.at)).toEqual([
    "2026-10-19T12:00:00.000Z",
    "2026-10-20T12:00:00.000Z",
  ]);
  await expect(queryObservations("sig-a", 0, 32 * 86_400_000)).rejects.toThrow(
    RangeError,
  );
});

test("prune keeps 30 days", async () => {
  appendObservations("sig-a", [
    ob("2026-09-01T12:00:00Z"),
    ob("2026-10-20T12:00:00Z"),
  ]);
  appendObservations("sig-gone", [ob("2026-09-02T12:00:00Z")]);
  await flushObservations();
  expect(await pruneObservations(Date.parse("2026-10-20T13:00:00Z"))).toBe(2);
  expect(await readdir(dir())).toEqual(["2026-10-20.jsonl"]);
});

test("observation times are stored as ISO instants; unreadable ones are dropped", async () => {
  appendObservations("sig-a", [
    ob("2026-10-20T01:30:00+02:00"),
    ob("yesterday"),
    ob("2026-10-20T00:00:00Z"),
  ]);
  expect(recentObservations("sig-a").map((o) => o.at)).toEqual([
    "2026-10-19T23:30:00.000Z",
    "2026-10-20T00:00:00.000Z",
  ]);
  await flushObservations();
  expect((await readdir(dir())).sort()).toEqual([
    "2026-10-19.jsonl",
    "2026-10-20.jsonl",
  ]);
});

test("a flush waits for the writes queued before it, not for later ones", async () => {
  appendObservations("sig-a", [ob("2026-10-20T00:00:00Z")]);
  let stop = false;
  let n = 0;
  const pump = (async () => {
    while (!stop) {
      appendObservations("sig-a", [
        ob(new Date(Date.parse("2026-10-20T00:00:01Z") + n++).toISOString()),
      ]);
      // One append per turn of the event loop: some write is always queued.
      await new Promise((resolve) => setImmediate(resolve));
    }
  })();
  const flushed = await Promise.race([
    flushObservations().then(() => true),
    Bun.sleep(1000).then(() => false),
  ]);
  stop = true;
  await pump;
  expect(flushed).toBe(true);
  expect(await readFile(join(dir(), "2026-10-20.jsonl"), "utf8")).toContain(
    '"2026-10-20T00:00:00.000Z"',
  );
});

test("hydration reads back as far as the caller asks, at most 31 days", async () => {
  const now = Date.parse("2026-10-20T12:00:00Z");
  appendObservations("sig-a", [
    ob("2026-09-10T12:00:00Z", "fail"),
    ob("2026-10-15T12:00:00Z", "fail"),
    ob("2026-10-18T12:00:00Z"),
    ob("2026-10-20T11:00:00Z"),
  ]);
  await flushObservations();
  __resetObservationsForTest();
  await hydrateObservations("sig-a", now);
  expect(recentObservations("sig-a").map((o) => o.at)).toEqual([
    "2026-10-18T12:00:00.000Z",
    "2026-10-20T11:00:00.000Z",
  ]);
  __resetObservationsForTest();
  await hydrateObservations("sig-a", now, 6 * 86_400_000);
  expect(recentObservations("sig-a")).toHaveLength(3);
  __resetObservationsForTest();
  await hydrateObservations("sig-a", now, 365 * 86_400_000);
  expect(recentObservations("sig-a")).toHaveLength(3);
});

test("hydration lookback per signal", () => {
  const DAY = 86_400_000;
  const now = Date.parse("2026-10-20T12:00:00Z");
  const signal = (rule: Signal["rule"], kind = "heartbeat") =>
    ({ rule, source: { kind } }) as Signal;
  expect(
    hydrationLookbackMs(
      signal({ kind: "consecutive", failures: 3 }, "http"),
      now,
    ),
  ).toBe(2 * DAY);
  expect(
    hydrationLookbackMs(
      signal({ kind: "missing", everyMs: 3_600_000, graceMs: 0 }),
      now,
    ),
  ).toBe(2 * DAY);
  expect(
    hydrationLookbackMs(
      signal({ kind: "missing", everyMs: 5 * DAY, graceMs: DAY }),
      now,
    ),
  ).toBe(6 * DAY);
  expect(
    hydrationLookbackMs(
      signal({ kind: "missing", everyMs: 31 * DAY, graceMs: DAY }),
      now,
    ),
  ).toBe(31 * DAY);
  expect(
    hydrationLookbackMs(
      signal({ kind: "missing", cron: "0 3 * * 1", graceMs: 3_600_000 }),
      now,
    ),
  ).toBe(7 * DAY + 3_600_000);
  expect(
    hydrationLookbackMs(
      signal({ kind: "missing", cron: "0 3 1 * *", graceMs: 0 }),
      now,
    ),
  ).toBe(31 * DAY);
});

test("range queries stream day files, filtered by lane while reading", async () => {
  await mkdir(dir(), { recursive: true });
  const long = "x".repeat(500);
  const lines: string[] = [];
  for (let i = 0; i < 400; i++)
    lines.push(
      JSON.stringify({
        at: new Date(
          Date.parse("2026-10-20T00:00:00Z") + i * 60_000,
        ).toISOString(),
        result: i % 2 ? "fail" : "ok",
        detail: long,
        ...(i % 4 === 1 ? { lane: "API" } : {}),
      }),
    );
  await writeFile(
    join(dir(), "2026-10-20.jsonl"),
    `${lines.join("\n")}\ngarbage\n{"at":"2026-10-20T23:59:00Z","result":"ok","detail":"é"}`,
  );
  const from = Date.parse("2026-10-20T00:00:00Z");
  const to = Date.parse("2026-10-20T23:59:59Z");
  expect(await queryObservations("sig-a", from, to)).toHaveLength(401);
  const api = await queryObservations("sig-a", from, to, { lane: "API" });
  expect(api).toHaveLength(100);
  expect(api.every((o) => o.lane === "API")).toBe(true);
  const main = await queryObservations("sig-a", from, to, { lane: "" });
  expect(main).toHaveLength(301);
  expect(main.at(-1)?.detail).toBe("é");
  let seen = 0;
  const result = await scanObservations(
    "sig-a",
    from,
    Date.parse("2026-10-20T00:09:00Z"),
    () => {
      seen++;
    },
  );
  expect(result).toBeUndefined();
  expect(seen).toBe(10);
});

test("a failed write checks the file tail again next time", async () => {
  await mkdir(dir(), { recursive: true });
  const file = join(dir(), "2026-10-20.jsonl");
  await writeFile(
    file,
    '{"at":"2026-10-20T00:00:00Z","result":"ok","detail":""}\n{"at":"torn',
  );
  await chmod(file, 0o400);
  const error = console.error;
  console.error = () => {};
  try {
    appendObservations("sig-a", [ob("2026-10-20T00:01:00Z")]);
    await flushObservations();
  } finally {
    console.error = error;
  }
  await chmod(file, 0o600);
  appendObservations("sig-a", [ob("2026-10-20T00:02:00Z")]);
  await flushObservations();
  __resetObservationsForTest();
  await hydrateObservations("sig-a", Date.parse("2026-10-20T00:05:00Z"));
  expect(recentObservations("sig-a").map((o) => o.at)).toEqual([
    "2026-10-20T00:00:00.000Z",
    "2026-10-20T00:02:00.000Z",
  ]);
});

test("forgetting a signal drops its memory, not its files", async () => {
  appendObservations("sig-a", [ob("2026-10-20T00:01:00Z")]);
  await hydrateObservations("sig-a", Date.parse("2026-10-20T00:05:00Z"));
  forgetObservations("sig-a");
  forgetObservations("../x");
  expect(recentObservations("sig-a")).toEqual([]);
  expect(
    await queryObservations(
      "sig-a",
      Date.parse("2026-10-20T00:00:00Z"),
      Date.parse("2026-10-20T00:05:00Z"),
    ),
  ).toHaveLength(1);
});

test("a scan stops reading once the caller has what it needs", async () => {
  await mkdir(dir(), { recursive: true });
  const day = (date: string) =>
    Array.from({ length: 300 }, (_, i) =>
      JSON.stringify({
        at: new Date(
          Date.parse(`${date}T00:00:00Z`) + i * 60_000,
        ).toISOString(),
        result: "ok",
        detail: "x".repeat(400),
      }),
    ).join("\n");
  await writeFile(join(dir(), "2026-10-20.jsonl"), day("2026-10-20"));
  await writeFile(join(dir(), "2026-10-21.jsonl"), day("2026-10-21"));
  let seen = 0;
  await scanObservations(
    "sig-a",
    Date.parse("2026-10-20T00:00:00Z"),
    Date.parse("2026-10-21T23:59:59Z"),
    () => {
      seen++;
    },
    { until: () => seen >= 3 },
  );
  expect(seen).toBe(3);

  // The in-memory path stops the same way.
  appendObservations("sig-a", [
    ob("2026-10-22T00:00:00Z"),
    ob("2026-10-22T00:01:00Z"),
    ob("2026-10-22T00:02:00Z"),
  ]);
  await hydrateObservations("sig-a", Date.parse("2026-10-22T00:05:00Z"));
  seen = 0;
  await scanObservations(
    "sig-a",
    Date.parse("2026-10-22T00:00:00Z"),
    Date.parse("2026-10-22T00:05:00Z"),
    () => {
      seen++;
    },
    { until: () => seen >= 1 },
  );
  expect(seen).toBe(1);
});

test("hasObservation answers from memory first, then the day files, per lane", async () => {
  appendObservations("sig-a", [
    ob("2026-10-20T10:00:00Z"),
    ob("2026-10-20T11:00:00Z", "fail", "API"),
  ]);
  await flushObservations();
  const from = Date.parse("2026-10-20T09:00:00Z");
  const to = Date.parse("2026-10-20T12:00:00Z");
  // Memory answers without reading the files.
  await chmod(dir(), 0o000);
  try {
    expect(await hasObservation("sig-a", from, to, MAIN_LANE)).toBe(true);
    expect(await hasObservation("sig-a", from, to, "API")).toBe(true);
  } finally {
    await chmod(dir(), 0o700);
  }
  __resetObservationsForTest();
  expect(await hasObservation("sig-a", from, to, MAIN_LANE)).toBe(true);
  expect(await hasObservation("sig-a", from, to, "API")).toBe(true);
  expect(await hasObservation("sig-a", from, to, "web")).toBe(false);
  expect(
    await hasObservation(
      "sig-a",
      Date.parse("2026-10-20T10:30:00Z"),
      to,
      MAIN_LANE,
    ),
  ).toBe(false);
});

test("nearestObservation picks the closest within the tolerance, per lane", async () => {
  appendObservations("sig-a", [
    ob("2026-10-20T10:00:00.000Z"),
    ob("2026-10-20T10:00:00.800Z"),
    ob("2026-10-20T10:00:00.700Z", "fail", "API"),
  ]);
  await flushObservations();
  for (const reset of [false, true]) {
    if (reset) __resetObservationsForTest();
    const at = Date.parse("2026-10-20T10:00:00.600Z");
    expect((await nearestObservation("sig-a", at, 1000, MAIN_LANE))?.at).toBe(
      "2026-10-20T10:00:00.800Z",
    );
    expect((await nearestObservation("sig-a", at, 1000, "API"))?.at).toBe(
      "2026-10-20T10:00:00.700Z",
    );
    expect(
      await nearestObservation(
        "sig-a",
        Date.parse("2026-10-20T10:00:05Z"),
        1000,
        MAIN_LANE,
      ),
    ).toBeNull();
  }
});

test("observationTimes lists one lane's times on one UTC day, from memory or files", async () => {
  appendObservations("sig-a", [
    ob("2026-10-19T23:59:59.900Z"),
    ob("2026-10-20T10:00:00.800Z"),
    ob("2026-10-20T00:00:00.000Z"),
    ob("2026-10-20T10:00:00.700Z", "fail", "API"),
    ob("2026-10-21T00:00:00.000Z"),
  ]);
  await flushObservations();
  const day = Date.parse("2026-10-20T13:00:00Z");
  for (const reset of [false, true]) {
    if (reset) __resetObservationsForTest();
    expect(await observationTimes("sig-a", day, MAIN_LANE)).toEqual([
      Date.parse("2026-10-20T00:00:00.000Z"),
      Date.parse("2026-10-20T10:00:00.800Z"),
    ]);
    expect(await observationTimes("sig-a", day, "API")).toEqual([
      Date.parse("2026-10-20T10:00:00.700Z"),
    ]);
    expect(
      await observationTimes(
        "sig-a",
        Date.parse("2026-10-22T00:00:00Z"),
        MAIN_LANE,
      ),
    ).toEqual([]);
  }
});
