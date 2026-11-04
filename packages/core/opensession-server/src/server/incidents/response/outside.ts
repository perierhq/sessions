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
) => Pick<KnownPr, "state" | "updatedAt" | "headSha"> | undefined;

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
  const merged = fresh
    .filter((p) => p.state === "MERGED" && Date.parse(p.updatedAt) >= since)
    .sort(
      (a, b) =>
        b.round - a.round || Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
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

/** What the latest round's investigator and verifier said: their reports
 *  and finding sets, as text. */
function latestRoundText(r: IncidentResponse): string {
  const parts: unknown[] = [];
  for (const run of r.agents)
    if (run.round === r.round && !run.check && run.report)
      parts.push(run.report);
  for (const set of r.findingSets ?? [])
    if (set.round === r.round && !set.check) parts.push(set.blocks);
  return parts.map((p) => JSON.stringify(p)).join("\n");
}

/**
 * A fix already merged that the owner may say they released, for Sessions
 * to watch after: the incident's own pull request (newest round first), or
 * else one the latest round's agents named (an earlier incident's fix,
 * say) in the same repository, merged since the incident opened (newest
 * merge first). Ones Sessions already acted on are left out. Undefined
 * unless the incident waits on its owner with a card that takes options.
 */
export function mergedFixFor(
  incident: Incident,
  lookup: PrLookup,
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
    at: known!.updatedAt,
    ...(known!.headSha ? { headSha: known!.headSha } : {}),
    ...(named ? { named: true as const } : {}),
  });
  const own = knownPrs(r, lookup)
    .filter(
      (p) =>
        p.state === "MERGED" && !settled.has(p.url) && !mergedByRecord(r, p),
    )
    .sort((a, b) => b.round - a.round);
  if (own[0]) return fix(own[0], own[0], false);
  const repo = repoOf(r);
  if (!repo) return undefined;
  const mine = new Set(incidentPrUrls(r).map((p) => p.number));
  const opened = Date.parse(incident.openedAt);
  let best: MergedFix | undefined;
  for (const number of namedNumbers(latestRoundText(r), repo)) {
    if (mine.has(number)) continue;
    const url = `https://github.com/${repo}/pull/${number}`;
    if (settled.has(url)) continue;
    let known: ReturnType<PrLookup>;
    try {
      known = lookup(url);
    } catch {
      known = undefined;
    }
    if (known?.state !== "MERGED") continue;
    if (!(Date.parse(known.updatedAt) >= opened)) continue;
    if (best && Date.parse(best.at) >= Date.parse(known.updatedAt)) continue;
    best = fix({ url, number }, known, true);
  }
  return best;
}

/** Whether the merged fix the card offers is not the one there is now
 *  (one appeared, went or changed), so the tick should read it again. */
export function mergedFixMoved(incident: Incident, lookup: PrLookup): boolean {
  const had = incident.response?.needsYou?.mergedFix;
  const now = mergedFixFor(incident, lookup);
  return had?.url !== now?.url || had?.at !== now?.at;
}
