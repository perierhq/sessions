// The incident's own pull requests, as the PR cache sees them, while it
// waits on its owner: one merged outside Sessions moves it to the release
// watch, one closed without merging leaves the card (decide.ts
// `movedOutside`). Pure.
import type { IncidentResponse } from "../../../shared/incident-response";
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
