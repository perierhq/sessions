// The incident's own pull requests, as the PR cache sees them, while it
// waits on its owner: one merged outside Sessions moves it to the release
// watch, one closed without merging leaves the card (decide.ts
// `movedOutside`). Pure.
import type {
  IncidentResponse,
  MergedFix,
} from "../../../shared/incident-response";
import type { Incident } from "../../../shared/incidents";
import type { KnownPr } from "./steps";
import { parsePrUrl } from "./merge";
import { failingParts } from "./watch";

/** The incident's pull requests, each once: every agent's (any round's)
 *  and the candidate's, with the round that opened it. */
export function incidentPrUrls(
  r: IncidentResponse,
): Array<{ url: string; number: number; round: number }> {
  const out: Array<{ url: string; number: number; round: number }> = [];
  const seen = new Set<string>();
  const add = (url: string | undefined, round: number) => {
    if (!url || seen.has(url)) return;
    const pr = parsePrUrl(url);
    if (!pr) return;
    seen.add(url);
    out.push({ url, number: pr.number, round });
  };
  for (const run of r.agents) add(run.prUrl, run.round);
  const c = r.candidate;
  if (c) add(c.prUrl ?? c.pr?.url, c.round);
  return out;
}

/** What the PR cache says about one pull request; undefined when it
 *  doesn't know it. */
export type PrLookup = (
  url: string,
) => Pick<KnownPr, "state" | "updatedAt" | "mergedAt" | "headSha"> | undefined;

/** The incident's pull requests the PR cache knows. */
export function knownPrs(r: IncidentResponse, lookup: PrLookup): KnownPr[] {
  const out: KnownPr[] = [];
  for (const pr of incidentPrUrls(r)) {
    let known: ReturnType<PrLookup>;
    try {
      known = lookup(pr.url);
    } catch {
      known = undefined;
    }
    if (known) out.push({ ...pr, ...known });
  }
  return out;
}

/** The URL of the pull request this incident's merge record names. */
function mergedByRecord(r: IncidentResponse, pr: KnownPr): boolean {
  return r.merge?.status === "merged" && r.merge.number === pr.number;
}

/** What moved outside Sessions since the owner's card went up: the
 *  incident's pull requests merged since (newest round first), and those
 *  closed without merging that the card still shows. Ones Sessions
 *  already acted on (`settledPrs`, the merge record) are left out. */
export function movedPrs(
  incident: Incident,
  prs: readonly KnownPr[],
): { merged: KnownPr[]; closed: KnownPr[] } {
  const r = incident.response;
  const ny = r?.needsYou;
  if (incident.state !== "needs-you" || !r || !ny || ny.kind === "question")
    return { merged: [], closed: [] };
  const settled = new Set(r.settledPrs ?? []);
  const fresh = prs.filter((p) => !settled.has(p.url) && !mergedByRecord(r, p));
  const since = Date.parse(ny.since);
  // Its merge time, never its last update: a later comment on a pull
  // request merged long ago is not a merge.
  const merged = fresh
    .filter(
      (p) =>
        p.state === "MERGED" && !!p.mergedAt && Date.parse(p.mergedAt) >= since,
    )
    .sort(
      (a, b) =>
        b.round - a.round || Date.parse(b.mergedAt!) - Date.parse(a.mergedAt!),
    );
  const shown = new Set([
    ...(ny.prs ?? []).map((p) => p.url),
    ...(r.candidate?.prUrl ? [r.candidate.prUrl] : []),
    ...(r.candidate?.pr?.url ? [r.candidate.pr.url] : []),
  ]);
  const closed = fresh.filter((p) => p.state === "CLOSED" && shown.has(p.url));
  return { merged, closed };
}

/** Whether the tick should read a waiting incident again because one of
 *  its pull requests moved outside Sessions. */
export function prsMovedOutside(
  incident: Incident,
  prs: readonly KnownPr[],
): boolean {
  const { merged, closed } = movedPrs(incident, prs);
  return merged.length > 0 || closed.length > 0;
}

/** The pull requests `text` names in the repository `ghRepo`: `#N`, or
 *  its pull request URL. */
function namedNumbers(text: string, ghRepo: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(/(?<![\w/&])#(\d{1,7})\b/g))
    out.add(Number(m[1]));
  for (const m of text.matchAll(
    /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d{1,7})\b/g,
  ))
    if (m[1]!.toLowerCase() === ghRepo.toLowerCase()) out.add(Number(m[2]));
  return out;
}

/** The repository of the incident's pull requests. */
function repoOf(r: IncidentResponse): string | undefined {
  if (r.candidate?.pr?.ghRepo) return r.candidate.pr.ghRepo;
  for (const pr of incidentPrUrls(r)) {
    const parsed = parsePrUrl(pr.url);
    if (parsed) return parsed.ghRepo;
  }
  return undefined;
}

/** What the latest round's investigator and verifier said about this
 *  incident's fix: their reports and finding sets, as text. The
 *  investigator's readFirst and attempts are left out: they list what it
 *  looked through (another incident's open pull requests, say), not this
 *  incident's fix. */
function latestRoundText(r: IncidentResponse): string {
  const parts: unknown[] = [];
  for (const run of r.agents)
    if (run.round === r.round && !run.check && run.report) {
      if (run.report.role === "investigator") {
        const { readFirst: _read, attempts: _attempts, ...own } = run.report;
        parts.push(own);
      } else parts.push(run.report);
    }
  for (const set of r.findingSets ?? [])
    if (set.round === r.round && !set.check) parts.push(set.blocks);
  return parts.map((p) => JSON.stringify(p)).join("\n");
}

/** What tells this incident's fix from other pull requests: the ones
 *  other incidents opened (never this incident's fix), and the files a
 *  merged pull request changed when Sessions read them. */
export interface FixContext {
  /** Other incidents' own pull request URLs. */
  claimed?: ReadonlySet<string>;
  /** The files a pull request changed; undefined while not read, null
   *  when they couldn't be. */
  files?: (url: string) => readonly string[] | null | undefined;
}

/** The pull requests the latest round's agents named, merged since the
 *  incident opened, that may be this incident's fix: not its own, not
 *  another incident's, not settled. In the order named. */
export function namedMergedPrs(
  incident: Incident,
  lookup: PrLookup,
  claimed: ReadonlySet<string> = new Set(),
): Array<{
  url: string;
  number: number;
  known: NonNullable<ReturnType<PrLookup>>;
}> {
  const r = incident.response;
  if (!r) return [];
  const repo = repoOf(r);
  if (!repo) return [];
  const settled = new Set(r.settledPrs ?? []);
  const mine = new Set(incidentPrUrls(r).map((p) => p.number));
  const opened = Date.parse(incident.openedAt);
  const out: Array<{
    url: string;
    number: number;
    known: NonNullable<ReturnType<PrLookup>>;
  }> = [];
  for (const number of namedNumbers(latestRoundText(r), repo)) {
    if (mine.has(number)) continue;
    const url = `https://github.com/${repo}/pull/${number}`;
    if (settled.has(url) || claimed.has(url)) continue;
    let known: ReturnType<PrLookup>;
    try {
      known = lookup(url);
    } catch {
      known = undefined;
    }
    if (known?.state !== "MERGED" || !known.mergedAt) continue;
    if (!(Date.parse(known.mergedAt) >= opened)) continue;
    out.push({ url, number, known });
  }
  return out;
}

/** Whether a pull request's files touch this incident: a file of its
 *  earlier fix, or a path naming the part it opened on (search for
 *  apps/search-service/…). */
function touchesIncident(
  r: IncidentResponse,
  files: readonly string[] | null | undefined,
): boolean {
  if (!files?.length) return false;
  const earlier = new Set(r.candidate?.pr?.files ?? []);
  if (files.some((f) => earlier.has(f))) return true;
  const parts = failingParts(r.openedOn?.detail ?? "");
  if (!parts.length) return false;
  return files.some((f) =>
    f
      .toLowerCase()
      .split("/")
      .some((segment) =>
        parts.some(
          (p) =>
            segment === p ||
            segment.replace(/\.[^.]*$/, "") === p ||
            segment.split(/[-_.]/).includes(p),
        ),
      ),
  );
}

/**
 * A fix already merged that the owner may say they released, for Sessions
 * to watch after: the incident's own pull request (newest round first), or
 * else one the latest round's agents named (an earlier incident's fix,
 * say) in the same repository, merged since the incident opened. Another
 * open or closed incident's own pull request is never this one's fix. Of
 * those named, one whose files touch this incident (its earlier fix's
 * files, or its part) comes first, then the newest merge. Ones Sessions
 * already acted on are left out. Undefined unless the incident waits on
 * its owner with a card that takes options.
 */
export function mergedFixFor(
  incident: Incident,
  lookup: PrLookup,
  context: FixContext = {},
): MergedFix | undefined {
  const r = incident.response;
  const ny = r?.needsYou;
  if (incident.state !== "needs-you" || !r || !ny) return undefined;
  if (ny.kind === "question" || ny.kind === "setup") return undefined;
  const settled = new Set(r.settledPrs ?? []);
  const fix = (
    pr: { url: string; number: number },
    known: ReturnType<PrLookup>,
    named: boolean,
  ): MergedFix => ({
    url: pr.url,
    number: pr.number,
    at: known!.mergedAt!,
    ...(known!.headSha ? { headSha: known!.headSha } : {}),
    ...(named ? { named: true as const } : {}),
  });
  const own = knownPrs(r, lookup)
    .filter(
      (p) =>
        p.state === "MERGED" &&
        !!p.mergedAt &&
        !settled.has(p.url) &&
        !mergedByRecord(r, p),
    )
    .sort((a, b) => b.round - a.round);
  if (own[0]) return fix(own[0], own[0], false);
  const files = context.files ?? (() => undefined);
  const best = namedMergedPrs(incident, lookup, context.claimed)
    .map((p) => ({ ...p, touches: touchesIncident(r, files(p.url)) }))
    .sort(
      (a, b) =>
        Number(b.touches) - Number(a.touches) ||
        Date.parse(b.known.mergedAt!) - Date.parse(a.known.mergedAt!),
    )[0];
  return best ? fix(best, best.known, true) : undefined;
}

/** Whether the merged fix the card offers is not the one there is now
 *  (one appeared, went or changed), so the tick should read it again. */
export function mergedFixMoved(
  incident: Incident,
  lookup: PrLookup,
  context: FixContext = {},
): boolean {
  const had = incident.response?.needsYou?.mergedFix;
  const now = mergedFixFor(incident, lookup, context);
  return had?.url !== now?.url || had?.at !== now?.at;
}
