import { expect, test } from "bun:test";
import type { Observation } from "../../../shared/incidents";
import {
  WATCH_MAX_MS,
  baseRateWatchMs,
  releaseAfter,
  releaseObservable,
  samePart,
  spellStarts,
} from "./watch";

const T0 = Date.parse("2026-10-31T00:00:00.000Z");
const MIN = 60_000;
const HOUR = 3_600_000;
const at = (ms: number) => new Date(T0 + ms).toISOString();
const obs = (
  ms: number,
  result: Observation["result"],
  detail = "",
): Observation => ({
  at: at(ms),
  result,
  detail,
});

/** A spell of `n` failed checks a minute apart starting at `ms`, then a pass. */
function spell(ms: number, n: number): Observation[] {
  return [
    ...Array.from({ length: n }, (_, i) =>
      obs(ms + i * MIN, "fail", "search: slow"),
    ),
    obs(ms + n * MIN, "ok"),
  ];
}

const rule = { kind: "consecutive" as const, failures: 3 };

test("spells count only as long as the rule", () => {
  const checks = [...spell(0, 2), ...spell(HOUR, 3), ...spell(3 * HOUR, 4)];
  expect(spellStarts(checks, 3)).toEqual([T0 + HOUR, T0 + 3 * HOUR]);
  expect(spellStarts(checks, 1)).toEqual([T0, T0 + HOUR, T0 + 3 * HOUR]);
});

test("the watch lasts three of the signal's usual gaps, bounded", () => {
  // Spells every 2 h: a 6 h watch.
  const often = [0, 2, 4, 6].flatMap((h) => spell(h * HOUR, 3));
  expect(baseRateWatchMs(often, rule, 10 * MIN)).toBe(6 * HOUR);
  // No spell: the project's window.
  expect(baseRateWatchMs([obs(0, "ok")], rule, 10 * MIN)).toBe(10 * MIN);
  // One spell in 12 h of checks: three times the span, at most 48 h.
  const once = [...spell(0, 3), obs(12 * HOUR, "ok")];
  expect(baseRateWatchMs(once, rule, 10 * MIN)).toBe(36 * HOUR);
  const rare = [...spell(0, 3), obs(30 * HOUR, "ok")];
  expect(baseRateWatchMs(rare, rule, 10 * MIN)).toBe(WATCH_MAX_MS);
  // Never shorter than the project's window.
  const flapping = [0, 1, 2].flatMap((m) => spell(m * 5 * MIN, 3));
  expect(baseRateWatchMs(flapping, rule, HOUR)).toBe(HOUR);
});

test("only the part the incident opened on counts", () => {
  expect(samePart("search: slow", "search: slow, billing: down")).toBe(true);
  expect(samePart("search: slow", "billing: slow")).toBe(false);
  expect(samePart("HTTP 503", "HTTP 500")).toBe(true);
  expect(samePart("", "billing: slow")).toBe(true);
});

test("a release after the merge: the hook or a merged release pull request", () => {
  const merged = T0;
  const none = { releases: [], hook: false, releasePrs: [] };
  expect(releaseObservable(none)).toBe(false);
  expect(releaseObservable({ ...none, hook: true })).toBe(true);
  expect(releaseAfter({ ...none, hook: true }, merged)).toBeUndefined();
  expect(
    releaseAfter(
      {
        hook: true,
        releases: [
          { at: at(-HOUR), ref: "v1.0.0" },
          { at: at(2 * HOUR), ref: "v1.0.2" },
          { at: at(HOUR), ref: "v0.9.9", rollback: true },
        ],
        releasePrs: [],
      },
      merged,
    ),
  ).toEqual({ at: at(2 * HOUR), source: "hook", ref: "v1.0.2" });
  expect(
    releaseAfter(
      {
        ...none,
        releasePrs: [
          {
            url: "https://github.com/acme/web/pull/30",
            title: "chore(main): release web 1.18.0",
            state: "MERGED",
            updatedAt: at(HOUR),
          },
          {
            url: "https://github.com/acme/web/pull/31",
            title: "chore(main): release web 1.19.0",
            state: "OPEN",
            updatedAt: at(2 * HOUR),
          },
        ],
      },
      merged,
    ),
  ).toEqual({
    at: at(HOUR),
    source: "release-pr",
    ref: "chore(main): release web 1.18.0",
  });
});

test("the release that holds the fix: its release pull request touches the fix's app, not just the first after the merge", () => {
  const merged = T0;
  const fix = [
    "apps/web/src/lib/status/parts.ts",
    "packages/shared/src/status.ts",
  ];
  const search = {
    url: "https://github.com/acme/web/pull/40",
    title: "chore: release search-service 1.17.1",
    state: "MERGED" as const,
    updatedAt: at(4 * MIN),
    files: [
      ".release-please-manifest.json",
      "apps/search-service/CHANGELOG.md",
      "apps/search-service/package.json",
    ],
  };
  const web = {
    url: "https://github.com/acme/web/pull/41",
    title: "chore: release web 1.24.0",
    state: "MERGED" as const,
    updatedAt: at(24 * MIN),
    files: [
      ".release-please-manifest.json",
      "apps/web/CHANGELOG.md",
      "apps/web/package.json",
    ],
  };
  const src = { releases: [], hook: false, releasePrs: [search, web] };
  expect(releaseAfter(src, merged, fix)).toEqual({
    at: at(24 * MIN),
    source: "release-pr",
    ref: "chore: release web 1.24.0",
  });
  // Only the other app's release so far: not yet released.
  expect(
    releaseAfter({ ...src, releasePrs: [search] }, merged, fix),
  ).toBeUndefined();
  // Without its files, the title names the app.
  const titled = { ...web, files: undefined };
  expect(
    releaseAfter(
      { ...src, releasePrs: [{ ...search, files: undefined }, titled] },
      merged,
      fix,
    ),
  ).toMatchObject({ ref: "chore: release web 1.24.0" });
  // Neither can be told apart: the first after the merge, as before.
  const unknown = [
    { ...search, title: "chore: release main", files: null },
    { ...web, title: "chore: release main 2", files: null },
  ];
  expect(
    releaseAfter({ ...src, releasePrs: unknown }, merged, fix),
  ).toMatchObject({ at: at(4 * MIN) });
  // A single-package release bumps root files too: it holds every path.
  expect(
    releaseAfter(
      {
        ...src,
        releasePrs: [
          {
            ...web,
            title: "chore: release 2.0.0",
            files: [
              ".release-please-manifest.json",
              "CHANGELOG.md",
              "package.json",
              "src/version.ts",
            ],
          },
        ],
      },
      merged,
      ["lib/search.ts"],
    ),
  ).toMatchObject({ ref: "chore: release 2.0.0" });
  // The manifest alone is not a root release.
  expect(
    releaseAfter(
      {
        ...src,
        releasePrs: [
          {
            ...search,
            files: [
              ".release-please-manifest.json",
              "services/search/CHANGELOG.md",
            ],
          },
        ],
      },
      merged,
      fix,
    ),
  ).toBeUndefined();
  // A release hook's ref is read the same way.
  expect(
    releaseAfter(
      {
        hook: true,
        releasePrs: [],
        releases: [
          { at: at(4 * MIN), ref: "search-service-v1.17.1" },
          { at: at(24 * MIN), ref: "web-v1.24.0" },
        ],
      },
      merged,
      fix,
    ),
  ).toEqual({ at: at(24 * MIN), source: "hook", ref: "web-v1.24.0" });
});
