// Resolves the references in an agent's findings blocks that point at data
// the incident already holds: observations, ledger entries, events, action
// runs, releases, pull requests, commits and other blocks. Each ref either
// resolves to the stored `FindingRef` or comes back as a one-line note for
// the agent. Tool-call refs are resolved elsewhere (they need the caller's
// transcript). All I/O goes through `RefDeps`, so this module does no work
// at import and its tests need no stores.

import type { FindingRef, SignalWindow } from "../../../shared/findings";
import type {
  AgentRole,
  IncidentResponse,
} from "../../../shared/incident-response";
import type { Incident } from "../../../shared/incidents";
import { OBSERVATION_RETENTION_DAYS } from "../observation-store";
import { parsePrUrl } from "../response/merge";

const DAY_MS = 86_400_000;

/**
 * A non-tool reference as the agent wrote it, already checked for shape.
 * Structurally `Exclude<RefInput, { type: "tool" }>` of `./validate`.
 */
export type DataRefInput =
  | { type: "observation"; signal: string; lane?: string; at: string }
  | { type: "ledger" | "event" | "action"; id: string }
  | { type: "release"; at: string; ref?: string }
  | { type: "pr"; number: number }
  | { type: "commit"; sha: string }
  | { type: "block"; id: string };

export interface RefDeps {
  lookupCommit: (
    sha: string,
    repo: string,
  ) => Promise<{ repo: string; sha: string; onDefaultBranch: boolean } | null>;
  observations: (
    signalId: string,
    fromMs: number,
    toMs: number,
    lane?: string,
  ) => Promise<Array<{ at: string }>>;
  releases: (project: string) => Promise<Array<{ at: string; ref?: string }>>;
  nowMs: number;
}

export interface RefScope {
  /** Ids, signalIds, events, and response ledger/actionRuns/agents/openPrs/candidate. */
  incident: Incident;
  role: AgentRole;
  /** Ids of the blocks in this call. */
  ownIds: ReadonlySet<string>;
  /** The round's investigator set (read by the verifier only). */
  investigatorIds: ReadonlySet<string>;
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
        : `No ledger entry ${ref.id} on this incident.`;
    case "event":
      return incident.events.some((e) => e.id === ref.id)
        ? { type: "event", id: ref.id }
        : `No event ${ref.id} on this incident.`;
    case "action":
      return (response?.actionRuns ?? []).some((a) => a.id === ref.id)
        ? { type: "action", id: ref.id }
        : `No action run ${ref.id} on this incident.`;
    case "observation":
      return resolveObservation(ref, scope, deps);
    case "release":
      return resolveRelease(ref, scope, deps);
    case "pr": {
      const owner = response ? prOwner(response, ref.number) : null;
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

async function resolveObservation(
  ref: Extract<DataRefInput, { type: "observation" }>,
  scope: RefScope,
  deps: RefDeps,
): Promise<FindingRef | string> {
  if (!scope.incident.signalIds.includes(ref.signal))
    return notOnIncident(ref.signal);
  const missing = `No observation of ${ref.signal} at ${ref.at}.`;
  const atMs = Date.parse(ref.at);
  if (!Number.isFinite(atMs)) return missing;
  const found = (
    await deps.observations(ref.signal, atMs, atMs, ref.lane)
  ).find((o) => Date.parse(o.at) === atMs);
  if (!found) return missing;
  return {
    type: "observation",
    signal: ref.signal,
    ...(ref.lane !== undefined ? { lane: ref.lane } : {}),
    at: found.at,
  };
}

async function resolveRelease(
  ref: Extract<DataRefInput, { type: "release" }>,
  scope: RefScope,
  deps: RefDeps,
): Promise<FindingRef | string> {
  const project = scope.incident.project;
  const atMs = Date.parse(ref.at);
  const found = Number.isFinite(atMs)
    ? (await deps.releases(project)).find(
        (r) =>
          Date.parse(r.at) === atMs &&
          (ref.ref === undefined || r.ref === ref.ref),
      )
    : undefined;
  if (!found)
    return ref.ref === undefined
      ? `No release at ${ref.at} in ${project}.`
      : `No release ${ref.ref} at ${ref.at} in ${project}.`;
  return {
    type: "release",
    at: found.at,
    ...(found.ref !== undefined ? { ref: found.ref } : {}),
  };
}

async function resolveCommit(
  sha: string,
  scope: RefScope,
  deps: RefDeps,
): Promise<FindingRef | string> {
  const project = scope.incident.project;
  const short = sha.toLowerCase().slice(0, 7);
  const found = await deps.lookupCommit(sha, project);
  if (!found) return `No commit ${short} in ${project}.`;
  if (found.repo !== project) return `Commit ${short} isn't in ${project}.`;
  if (!found.onDefaultBranch)
    return `Commit ${short} isn't on ${project}'s default branch.`;
  return { type: "commit", sha: found.sha.toLowerCase(), repo: found.repo };
}

function resolveBlock(id: string, scope: RefScope): FindingRef | string {
  if (scope.ownIds.has(id)) return { type: "block", id, role: scope.role };
  if (scope.role === "verifier") {
    if (scope.investigatorIds.has(id))
      return { type: "block", id, role: "investigator" };
    return `No block ${id} in your findings or the investigator's.`;
  }
  return `No block ${id} in your findings.`;
}

/**
 * The agent session that opened PR `number`: an agent run's `prUrl` first,
 * then the PRs recorded open at close, then the candidate's PR (owned by the
 * run that recorded it, else its round's current investigator).
 */
export function prOwner(
  response: IncidentResponse,
  number: number,
): { url: string; sessionId: string } | null {
  for (const run of response.agents) {
    if (run.prUrl !== undefined && parsePrUrl(run.prUrl)?.number === number)
      return { url: run.prUrl, sessionId: run.sessionId };
  }
  for (const pr of response.openPrs ?? []) {
    if (pr.number === number) return { url: pr.url, sessionId: pr.sessionId };
  }
  const candidate = response.candidate;
  if (
    candidate?.prUrl !== undefined &&
    parsePrUrl(candidate.prUrl)?.number === number
  ) {
    const investigators = response.agents.filter(
      (r) => r.role === "investigator" && r.round === candidate.round,
    );
    const owner =
      investigators.find((r) => r.supersededBy === undefined) ??
      investigators.at(-1);
    if (owner) return { url: candidate.prUrl, sessionId: owner.sessionId };
  }
  return null;
}

/** Signal windows: signal in incident.signalIds, overlaps retention, has ≥ 1 observation (lane when given). */
export async function checkWindow(
  w: SignalWindow,
  scope: RefScope,
  deps: RefDeps,
): Promise<true | string> {
  if (!scope.incident.signalIds.includes(w.signalId))
    return notOnIncident(w.signalId);
  const fromMs = Date.parse(w.from);
  const toMs = Date.parse(w.to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs)
    return "That window has no valid times.";
  const cutoff = deps.nowMs - OBSERVATION_RETENTION_DAYS * DAY_MS;
  if (toMs < cutoff)
    return `That window is older than the ${OBSERVATION_RETENTION_DAYS} days of kept observations.`;
  const found = await deps.observations(
    w.signalId,
    Math.max(fromMs, cutoff),
    toMs,
    w.lane,
  );
  if (found.length > 0) return true;
  const lane = w.lane !== undefined ? ` (lane ${w.lane})` : "";
  return `No observations of ${w.signalId} in that window${lane}.`;
}

function notOnIncident(signalId: string): string {
  return `Signal ${signalId} is not part of this incident.`;
}
