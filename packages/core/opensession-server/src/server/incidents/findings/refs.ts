// Resolves the references in an agent's findings blocks that point at data
// the incident already holds: observations, ledger entries, events, action
// runs, releases, pull requests, commits and other blocks. Each ref either
// resolves to the stored `FindingRef` or comes back as a one-line note for
// the agent. Tool-call refs are resolved elsewhere (they need the caller's
// transcript). All I/O goes through `RefDeps`, so this module does no work
// at import and its tests need no stores. Every lookup is an existence check
// that stops at the first match, and one call (one `RefMemo`) asks each
// question once.

import {
  FINDINGS_LIMITS,
  type FindingRef,
  type SignalWindow,
} from "../../../shared/findings";
import type {
  AgentRole,
  IncidentResponse,
} from "../../../shared/incident-response";
import type { Incident } from "../../../shared/incidents";
import { isCommitSha } from "../../commit-lookup";
import { MAIN_LANE, OBSERVATION_RETENTION_DAYS } from "../observation-store";
import { parsePrUrl } from "../response/merge";
import type { RefInput } from "./validate";

const DAY_MS = 86_400_000;
/** How far from an observation's stored time a ref's `at` may be. */
export const OBSERVATION_TOLERANCE_MS = 1_000;
/** Distinct commits one call may look up. */
export const COMMITS_PER_CALL = 12;
/** Distinct (signal, lane, UTC day) observation scans one call may make;
 *  every observation ref on a day already scanned is answered from it. */
export const OBSERVATIONS_PER_CALL = 12;
/** Longest agent value quoted back in a note. */
const SHOWN_MAX = 60;

/** A non-tool reference as the agent wrote it, already checked for shape. */
export type DataRefInput = Exclude<RefInput, { type: "tool" }>;

export interface RefDeps {
  /** `lookupCommitIn(sha, repoId)` (commit-lookup.ts): that repo's own
   *  checkout only, never another repo's. */
  lookupCommitIn: (
    sha: string,
    repoId: string,
  ) => Promise<{ sha: string; onDefaultBranch: boolean } | null>;
  /** `hasObservation` (observation-store.ts): any observation of `lane`
   *  in `[fromMs, toMs]`; `lane` is {@link MAIN_LANE} for the main lane. */
  hasObservation: (
    signalId: string,
    fromMs: number,
    toMs: number,
    lane: string,
  ) => Promise<boolean>;
  /** `observationTimes` (observation-store.ts): the sorted epoch-ms times
   *  of `lane`'s observations on the UTC day holding `dayMs`. */
  observationTimes: (
    signalId: string,
    dayMs: number,
    lane: string,
  ) => Promise<readonly number[]>;
  releases: (project: string) => Promise<Array<{ at: string; ref?: string }>>;
  nowMs: number;
}

/**
 * One call's answers, by question (observation, window, commit, release
 * list), so a ref repeated across blocks is looked up once and the commit
 * cap counts distinct commits. Make one per `show_findings` call with
 * {@link createRefMemo} and put it in every {@link RefScope} of that call.
 */
export type RefMemo = Map<string, Promise<unknown>>;

export function createRefMemo(): RefMemo {
  return new Map();
}

export interface RefScope {
  /** Ids, signalIds, events, and response ledger/actionRuns/agents/openPrs/candidate. */
  incident: Incident;
  role: AgentRole;
  /** Ids of the blocks in this call. */
  ownIds: ReadonlySet<string>;
  /** The round's investigator set (read by the verifier only). */
  investigatorIds: ReadonlySet<string>;
  /** The project's GitHub repo, `owner/name` (`getRepo(project).ghRepo`).
   *  A PR in any other repo never resolves; without one, no PR does. */
  ghRepo: string | undefined;
  /** This call's memo, shared by every ref and window it checks. */
  memo: RefMemo;
}

/** An agent-provided value for a note: whitespace collapsed, clipped to
 *  about 60 characters, quoted. */
export function shown(value: string): string {
  const flat = [...value.replace(/\s+/g, " ").trim()];
  const clipped =
    flat.length > SHOWN_MAX
      ? `${flat.slice(0, SHOWN_MAX - 1).join("")}…`
      : flat.join("");
  return JSON.stringify(clipped);
}

const ISO_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/i;

function daysIn(year: number, month: number): number {
  if (month === 2)
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * Epoch ms of a strict ISO 8601 time with a time zone (`Z` or `±hh:mm`),
 * like `2026-10-27T10:00:00Z` or `2026-10-27T12:00:00.5+02:00`; seconds and
 * fractions are optional. Null for anything else, including a time without
 * a zone (which `Date.parse` would read as local time), an impossible date
 * and surrounding spaces.
 */
export function parseIsoTime(value: string): number | null {
  const match = ISO_TIME.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi, s = "0", fraction = "", zone = "Z"] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  if (month < 1 || month > 12 || day < 1 || day > daysIn(year, month))
    return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  let offsetMinutes = 0;
  if (zone.toUpperCase() !== "Z") {
    const zoneHours = Number(zone.slice(1, 3));
    const zoneMinutes = Number(zone.slice(4, 6));
    if (zoneHours > 23 || zoneMinutes > 59) return null;
    offsetMinutes =
      (zone.startsWith("-") ? -1 : 1) * (zoneHours * 60 + zoneMinutes);
  }
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(
    hour,
    minute,
    second,
    Number(fraction.padEnd(3, "0").slice(0, 3)),
  );
  const ms = date.getTime() - offsetMinutes * 60_000;
  return Number.isFinite(ms) ? ms : null;
}

function badTime(value: string): string {
  return `Time ${shown(value)} must be ISO 8601 with a time zone, like 2026-10-27T10:00:00Z.`;
}

function cantCheck(what: string): string {
  return `Couldn't check ${what} right now.`;
}

/** `run()`'s answer, asked once per memo; a dependency that throws (or
 *  rejects) answers `failed`. */
function once<T>(
  memo: RefMemo,
  key: string,
  run: () => Promise<T>,
  failed: T,
): Promise<T> {
  const known = memo.get(key);
  if (known) {
    // SAFETY: each key names one question, always asked with the same T.
    return known as Promise<T>;
  }
  const answer = (async () => {
    try {
      return await run();
    } catch {
      return failed;
    }
  })();
  memo.set(key, answer);
  return answer;
}

function memoKey(...parts: Array<string | number>): string {
  return JSON.stringify(parts);
}

/** How many questions of `kind` the memo has asked. */
function askedOf(memo: RefMemo, kind: string): number {
  const prefix = `[${JSON.stringify(kind)},`;
  let asked = 0;
  for (const key of memo.keys()) if (key.startsWith(prefix)) asked++;
  return asked;
}

/** Start (epoch ms) of every UTC day that `[fromMs, toMs]` touches. */
function utcDays(fromMs: number, toMs: number): number[] {
  const days: number[] = [];
  for (
    let day = Math.floor(fromMs / DAY_MS) * DAY_MS;
    day <= toMs;
    day += DAY_MS
  )
    days.push(day);
  return days;
}

/** The time in sorted `times` closest to `atMs`, at most `toleranceMs`
 *  away (the earlier one on a tie), or null. */
function nearestTime(
  times: readonly number[],
  atMs: number,
  toleranceMs: number,
): number | null {
  let low = 0;
  let high = times.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (times[mid]! < atMs) low = mid + 1;
    else high = mid;
  }
  let best: number | null = null;
  for (const t of [times[low - 1], times[low]]) {
    if (t === undefined || Math.abs(t - atMs) > toleranceMs) continue;
    if (best === null || Math.abs(t - atMs) < Math.abs(best - atMs)) best = t;
  }
  return best;
}

/** Resolves every non-tool ref; tool refs are A5's (they need the transcript). */
export async function resolveRef(
  ref: DataRefInput,
  scope: RefScope,
  deps: RefDeps,
): Promise<FindingRef | string> {
  const { incident } = scope;
  const response = incident.response;
  switch (ref.type) {
    case "ledger":
      return (response?.ledger ?? []).some((e) => e.id === ref.id)
        ? { type: "ledger", id: ref.id }
        : `No ledger entry ${shown(ref.id)} on this incident.`;
    case "event":
      return incident.events.some((e) => e.id === ref.id)
        ? { type: "event", id: ref.id }
        : `No event ${shown(ref.id)} on this incident.`;
    case "action":
      return (response?.actionRuns ?? []).some((a) => a.id === ref.id)
        ? { type: "action", id: ref.id }
        : `No action run ${shown(ref.id)} on this incident.`;
    case "observation":
      return resolveObservation(ref, scope, deps);
    case "release":
      return resolveRelease(ref, scope, deps);
    case "pr": {
      const owner = response
        ? prOwner(response, ref.number, scope.ghRepo)
        : null;
      return owner
        ? { type: "pr", number: ref.number, ...owner }
        : `PR #${ref.number} isn't one this incident's agents opened.`;
    }
    case "commit":
      return resolveCommit(ref.sha, scope, deps);
    case "block":
      return resolveBlock(ref.id, scope);
  }
}

function laneNote(lane: string): string {
  return lane === MAIN_LANE ? "" : ` (lane ${shown(lane)})`;
}

function resolveObservation(
  ref: Extract<DataRefInput, { type: "observation" }>,
  scope: RefScope,
  deps: RefDeps,
): Promise<FindingRef | string> {
  if (!scope.incident.signalIds.includes(ref.signal))
    return Promise.resolve(notOnIncident(ref.signal));
  const atMs = parseIsoTime(ref.at);
  if (atMs === null) return Promise.resolve(badTime(ref.at));
  const lane = ref.lane ?? MAIN_LANE;
  const key = memoKey("observation", ref.signal, lane, atMs);
  const days = utcDays(
    atMs - OBSERVATION_TOLERANCE_MS,
    atMs + OBSERVATION_TOLERANCE_MS,
  );
  const dayKey = (day: number) =>
    memoKey("observation-day", ref.signal, lane, day);
  if (!scope.memo.has(key)) {
    const unread = days.filter((day) => !scope.memo.has(dayKey(day))).length;
    if (
      unread > 0 &&
      askedOf(scope.memo, "observation-day") + unread > OBSERVATIONS_PER_CALL
    )
      return Promise.resolve(
        `Observation of ${shown(ref.signal)}${laneNote(lane)} at ${shown(ref.at)} wasn't checked: one call reads at most ${OBSERVATIONS_PER_CALL} days of observations.`,
      );
  }
  return once<FindingRef | string>(
    scope.memo,
    key,
    async () => {
      // Each day is scanned once per call; every `at` on it is answered
      // from that scan. The day keys are set before the first await, so
      // the cap above counts them in call order.
      const scans = await Promise.all(
        days.map((day) =>
          once<readonly number[] | null>(
            scope.memo,
            dayKey(day),
            () => deps.observationTimes(ref.signal, day, lane),
            null,
          ),
        ),
      );
      if (scans.some((times) => times === null))
        return cantCheck(`observations of ${shown(ref.signal)}`);
      const found = nearestTime(
        scans.flatMap((times) => times ?? []),
        atMs,
        OBSERVATION_TOLERANCE_MS,
      );
      if (found === null)
        return `No observation of ${shown(ref.signal)}${laneNote(lane)} at ${shown(ref.at)}.`;
      // No lane on the stored ref means the main lane, as on a window. The
      // store keeps `at` as an ISO instant, so this is its stored text.
      const stored: FindingRef = {
        type: "observation",
        signal: ref.signal,
        at: new Date(found).toISOString(),
      };
      if (lane !== MAIN_LANE) stored.lane = lane;
      return stored;
    },
    cantCheck(`observations of ${shown(ref.signal)}`),
  );
}

async function resolveRelease(
  ref: Extract<DataRefInput, { type: "release" }>,
  scope: RefScope,
  deps: RefDeps,
): Promise<FindingRef | string> {
  const project = scope.incident.project;
  const atMs = parseIsoTime(ref.at);
  if (atMs === null) return badTime(ref.at);
  const releases = await once<Array<{ at: string; ref?: string }> | null>(
    scope.memo,
    memoKey("releases", project),
    () => deps.releases(project),
    null,
  );
  if (!releases) return cantCheck(`${project}'s releases`);
  const found = releases.find(
    (r) =>
      Date.parse(r.at) === atMs && (ref.ref === undefined || r.ref === ref.ref),
  );
  if (!found)
    return ref.ref === undefined
      ? `No release at ${shown(ref.at)} in ${project}.`
      : `No release ${shown(ref.ref)} at ${shown(ref.at)} in ${project}.`;
  const stored: FindingRef = { type: "release", at: found.at };
  if (found.ref !== undefined) stored.ref = found.ref;
  return stored;
}

function resolveCommit(
  input: string,
  scope: RefScope,
  deps: RefDeps,
): Promise<FindingRef | string> {
  const sha = input.trim().toLowerCase();
  if (!isCommitSha(sha))
    return Promise.resolve(`${shown(input)} isn't a commit sha.`);
  const project = scope.incident.project;
  const short = sha.slice(0, 7);
  const key = memoKey("commit", sha);
  if (!scope.memo.has(key)) {
    if (askedOf(scope.memo, "commit") >= COMMITS_PER_CALL)
      return Promise.resolve(
        `Commit ${short} wasn't checked: one call checks at most ${COMMITS_PER_CALL} commits.`,
      );
  }
  return once<FindingRef | string>(
    scope.memo,
    key,
    async () => {
      const found = await deps.lookupCommitIn(sha, project);
      const full = found?.sha.toLowerCase();
      if (!found?.onDefaultBranch || !full?.startsWith(sha))
        return `No commit ${short} on ${project}'s default branch.`;
      return { type: "commit", sha: full, repo: project };
    },
    cantCheck(`commit ${short}`),
  );
}

function resolveBlock(id: string, scope: RefScope): FindingRef | string {
  if (scope.ownIds.has(id)) return { type: "block", id, role: scope.role };
  if (scope.role === "verifier") {
    if (scope.investigatorIds.has(id))
      return { type: "block", id, role: "investigator" };
    return `No block ${shown(id)} in your findings or the investigator's.`;
  }
  return `No block ${shown(id)} in your findings.`;
}

/**
 * The agent session that opened PR `number` in `ghRepo` (the project's
 * repo; a PR elsewhere never matches, nor does any PR without one): an
 * agent run's `prUrl` first, then the PRs recorded open at close, then the
 * candidate's PR (`prUrl`, else its snapshot's URL), owned by the run that
 * recorded it, else its round's current investigator.
 */
export function prOwner(
  response: IncidentResponse,
  number: number,
  ghRepo: string | undefined,
): { url: string; sessionId: string } | null {
  const repo = ghRepo?.toLowerCase();
  if (!repo) return null;
  const isIt = (url: string | undefined): url is string => {
    const pr = url === undefined ? null : parsePrUrl(url);
    return pr?.number === number && pr.ghRepo.toLowerCase() === repo;
  };
  for (const run of response.agents) {
    if (isIt(run.prUrl)) return { url: run.prUrl, sessionId: run.sessionId };
  }
  for (const pr of response.openPrs ?? []) {
    if (isIt(pr.url)) return { url: pr.url, sessionId: pr.sessionId };
  }
  const candidate = response.candidate;
  const url = candidate?.prUrl ?? candidate?.pr?.url;
  if (candidate && isIt(url)) {
    const investigators = response.agents.filter(
      (r) => r.role === "investigator" && r.round === candidate.round,
    );
    const owner =
      investigators.find((r) => r.supersededBy === undefined) ??
      investigators.at(-1);
    if (owner) return { url, sessionId: owner.sessionId };
  }
  return null;
}

/**
 * Signal windows: the signal is one of the incident's, and its stated lane
 * (the main lane when none is stated) has at least one observation in the
 * window clamped to the kept observations, the findings window limit and
 * now.
 */
export async function checkWindow(
  w: SignalWindow,
  scope: RefScope,
  deps: RefDeps,
): Promise<true | string> {
  if (!scope.incident.signalIds.includes(w.signalId))
    return notOnIncident(w.signalId);
  const fromMs = parseIsoTime(w.from);
  const statedTo = parseIsoTime(w.to);
  if (fromMs === null || statedTo === null || statedTo <= fromMs)
    return "That window has no valid times.";
  const cutoff = deps.nowMs - OBSERVATION_RETENTION_DAYS * DAY_MS;
  const toMs = Math.min(statedTo, deps.nowMs);
  if (toMs < cutoff)
    return `That window is older than the ${OBSERVATION_RETENTION_DAYS} days of kept observations.`;
  if (fromMs > toMs) return "That window hasn't started yet.";
  const from = Math.max(fromMs, toMs - FINDINGS_LIMITS.windowMs, cutoff);
  const lane = w.lane ?? MAIN_LANE;
  const found = await once<boolean | null>(
    scope.memo,
    memoKey("window", w.signalId, lane, from, toMs),
    () => deps.hasObservation(w.signalId, from, toMs, lane),
    null,
  );
  if (found === null) return cantCheck(`observations of ${shown(w.signalId)}`);
  if (found) return true;
  return `No observations of ${shown(w.signalId)} in that window${laneNote(lane)}.`;
}

function notOnIncident(signalId: string): string {
  return `Signal ${shown(signalId)} is not part of this incident.`;
}
