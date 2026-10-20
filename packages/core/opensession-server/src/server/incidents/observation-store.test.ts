import { beforeEach, expect, test } from "bun:test";
import { appendFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  __resetObservationsForTest,
  appendObservations,
  flushObservations,
  hydrateObservations,
  pruneObservations,
  queryObservations,
  recentObservations,
} from "./observation-store";
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
    "2026-10-19T23:59:00Z",
    "2026-10-20T00:01:00Z",
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
    "2026-10-20T00:01:00Z",
    "2026-10-20T00:03:00Z",
  ]);
});

test("hydration merges with observations appended before it, without duplicates", async () => {
  appendObservations("sig-a", [ob("2026-10-20T00:01:00Z")]);
  await flushObservations();
  __resetObservationsForTest();
  appendObservations("sig-a", [ob("2026-10-20T00:02:00Z", "fail")]);
  await hydrateObservations("sig-a", Date.parse("2026-10-20T00:05:00Z"));
  expect(recentObservations("sig-a").map((o) => o.at)).toEqual([
    "2026-10-20T00:01:00Z",
    "2026-10-20T00:02:00Z",
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
    "2026-10-19T12:00:00Z",
    "2026-10-20T12:00:00Z",
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
