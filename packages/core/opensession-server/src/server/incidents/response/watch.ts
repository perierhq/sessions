// How long the watch after a release lasts and what counts as the problem
// coming back during it, from the incident's own signal. A fix released by
// hand on a signal that fails several times a day proves nothing in ten
// minutes, so the watch lasts a few of the signal's usual gaps between
// failures (bounded), and only a failure of the same part the incident
// opened on counts. Pure.
import type { Observation, SignalRule } from "../../../shared/incidents";

/** The longest watch after a release. */
export const WATCH_MAX_MS = 48 * 3_600_000;
/** How many of the signal's usual gaps between failures a watch lasts. */
export const WATCH_GAPS = 3;

/** How many failed checks in a row make a spell count, from the signal's
 *  rule; 1 for rules that don't count checks in a row. */
export function spellLength(rule: SignalRule | undefined): number {
  return rule?.kind === "consecutive" ? Math.max(1, rule.failures) : 1;
}

/** When each spell of at least `length` failed checks in a row started, in
 *  the main lane, oldest first. */
export function spellStarts(
  observations: readonly Observation[],
  length: number,
): number[] {
  const starts: number[] = [];
  let run = 0;
  let start = 0;
  for (const o of observations) {
    if (o.lane !== undefined) continue;
    if (o.result === "fail") {
      if (run === 0) start = Date.parse(o.at);
      run++;
      if (run === length) starts.push(start);
    } else if (o.result === "ok") run = 0;
  }
  return starts;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The watch for a fix released on this signal: `WATCH_GAPS` times the
 * median gap between its recent spells, or the whole span its checks
 * cover when they hold only one spell, never shorter than `minMs` nor
 * longer than `WATCH_MAX_MS`. A signal with no spell in its recent checks
 * gets `minMs`.
 */
export function baseRateWatchMs(
  observations: readonly Observation[],
  rule: SignalRule | undefined,
  minMs: number,
): number {
  const starts = spellStarts(observations, spellLength(rule));
  if (starts.length === 0) return minMs;
  let gap: number;
  if (starts.length === 1) {
    const times = observations
      .filter((o) => o.lane === undefined)
      .map((o) => Date.parse(o.at))
      .filter(Number.isFinite);
    gap = times.length ? Math.max(...times) - Math.min(...times) : 0;
  } else {
    const gaps: number[] = [];
    for (let i = 1; i < starts.length; i++)
      gaps.push(starts[i]! - starts[i - 1]!);
    gap = median(gaps);
  }
  return Math.min(WATCH_MAX_MS, Math.max(minMs, WATCH_GAPS * gap));
}

/** The parts a status page's worst-lane detail names as failing
 *  ("search: slow, billing: down"), lower-cased; empty when the detail
 *  is not such a list (a plain check's "HTTP 503"). */
export function failingParts(detail: string): string[] {
  const pieces = detail.split(", ");
  const parts: string[] = [];
  for (const piece of pieces) {
    const at = piece.indexOf(": ");
    if (at <= 0) return [];
    parts.push(piece.slice(0, at).trim().toLowerCase());
  }
  return parts;
}

/** Whether a failed check is the incident's own problem: it names a part
 *  the incident opened on, or either side names no parts. */
export function samePart(openedOn: string, detail: string): boolean {
  const cause = failingParts(openedOn);
  const parts = failingParts(detail);
  if (!cause.length || !parts.length) return true;
  return parts.some((p) => cause.includes(p));
}

/** The failed checks of the main lane after `sinceMs`, oldest first. */
export function failuresSince(
  observations: readonly Observation[],
  sinceMs: number,
): Observation[] {
  return observations.filter(
    (o) =>
      o.lane === undefined && o.result === "fail" && Date.parse(o.at) > sinceMs,
  );
}

/** What a release after `sinceMs` can be seen from. */
export interface ReleaseSources {
  /** The project's recorded releases (the release hook, actions). */
  releases: ReadonlyArray<{ at: string; ref?: string; rollback?: true }>;
  /** Whether the project has a release hook set up. */
  hook: boolean;
  /** The project's release pull requests the PR cache knows, with the
   *  files each changed when Sessions read them (null: they couldn't be
   *  read). */
  releasePrs: ReadonlyArray<{
    url: string;
    title: string;
    state: "OPEN" | "MERGED" | "CLOSED";
    updatedAt: string;
    files?: readonly string[] | null;
  }>;
}

/** Whether a release of the project can be seen at all: a release hook,
 *  releases recorded before, or release pull requests. Without any, the
 *  merge is the release. */
export function releaseObservable(src: ReleaseSources): boolean {
  return src.hook || src.releases.length > 0 || src.releasePrs.length > 0;
}

/** A release title's or ref's words without their versions: "chore:
 *  release web 1.24.0" and "web-v1.24.0" both name "web". */
function releaseWords(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[\s:(),]+/)
    .map((w) => w.replace(/[-@_]?v?\d+(\.\d+)*.*$/, ""))
    .filter(Boolean);
}

/**
 * Whether a release holds a fix that changed `fixFiles`. True when its
 * release pull request changed files in a directory the fix changed (an
 * app's or package's own changelog and version), or its title or ref
 * names one of the fix's directories ("release web 1.24.0" for
 * apps/web); false when its files show it released other directories
 * only; undefined when that can't be told.
 */
export function releaseHolds(
  release: { name?: string; files?: readonly string[] | null },
  fixFiles: readonly string[],
): boolean | undefined {
  if (!fixFiles.length) return undefined;
  const dirs = new Set<string>();
  for (const f of release.files ?? []) {
    const at = f.lastIndexOf("/");
    if (at > 0) dirs.add(f.slice(0, at));
  }
  if (dirs.size)
    return fixFiles.some((f) => [...dirs].some((d) => f.startsWith(`${d}/`)));
  const segments = new Set(
    fixFiles.flatMap((f) => f.toLowerCase().split("/").slice(0, -1)),
  );
  return releaseWords(release.name ?? "").some((w) => segments.has(w))
    ? true
    : undefined;
}

/**
 * The first release after `sinceMs` that holds the fix: a recorded one
 * (not a rollback), or a release pull request merged since. With the
 * fix's files, a release that holds them wins over an earlier one that
 * can't be told, and one that released other directories only never
 * counts. Undefined until there is one.
 */
export function releaseAfter(
  src: ReleaseSources,
  sinceMs: number,
  fixFiles: readonly string[] = [],
): { at: string; source: "hook" | "release-pr"; ref?: string } | undefined {
  const seen = [
    ...src.releases
      .filter((r) => !r.rollback && Date.parse(r.at) >= sinceMs)
      .map((r) => ({
        release: {
          at: r.at,
          source: "hook" as const,
          ...(r.ref ? { ref: r.ref } : {}),
        },
        holds: releaseHolds({ name: r.ref }, fixFiles),
      })),
    ...src.releasePrs
      .filter((p) => p.state === "MERGED" && Date.parse(p.updatedAt) >= sinceMs)
      .map((p) => ({
        release: {
          at: p.updatedAt,
          source: "release-pr" as const,
          ref: p.title,
        },
        holds: releaseHolds({ name: p.title, files: p.files }, fixFiles),
      })),
  ].sort((a, b) => Date.parse(a.release.at) - Date.parse(b.release.at));
  return (
    seen.find((s) => s.holds === true) ??
    seen.find((s) => s.holds === undefined)
  )?.release;
}
