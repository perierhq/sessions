// Storage of the incident agents' findings: one set per (role, round) on
// the incident document, written with a CAS update that touches only
// `response.findingSets` and `incident.updatedAt`, so the fix loop
// (`responseMoved`) never wakes on it. Calls from one agent session run in
// order through a lazily created per-session queue; no timers, no work at
// import.

import { FINDINGS_LIMITS, type FindingsSet } from "../../../shared/findings";
import { updateIncident } from "../incident-store";

let queues: Map<string, Promise<unknown>> | undefined;

/**
 * Runs `fn` after every earlier call queued for `sessionId` has settled
 * (resolved or thrown); calls for other sessions run in parallel. The
 * session's entry is removed once its last call settles.
 */
export function withSessionQueue<T>(
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  queues ??= new Map();
  const map = queues;
  const previous = map.get(sessionId) ?? Promise.resolve();
  const run = previous.then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  map.set(sessionId, tail);
  void tail.then(() => {
    if (map.get(sessionId) === tail) map.delete(sessionId);
  });
  return run;
}

/** How many sessions have calls queued or running (tests only). */
export function __queuedSessionsForTest(): number {
  return queues?.size ?? 0;
}

/** The sets after an upsert, the set as saved (null when refused) and the
 *  notes for the agent. */
export interface UpsertResult {
  sets: FindingsSet[];
  saved: FindingsSet | null;
  notes: string[];
}

/** The set as saved (null when nothing was written) and the notes. */
export interface SaveResult {
  saved: FindingsSet | null;
  notes: string[];
}

const ROLE_ORDER = { investigator: 0, verifier: 1 } as const;

function bytes(value: FindingsSet | readonly FindingsSet[]): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function bySetOrder(a: FindingsSet, b: FindingsSet): number {
  return a.round - b.round || ROLE_ORDER[a.role] - ROLE_ORDER[b.role];
}

/**
 * Puts `next` in its (role, round) slot. A newer attempt replaces the slot;
 * an older one is refused. `saved.calls` counts this attempt's calls (the
 * caller passes 0). Blocks are dropped from the end while the set is over
 * 64 KB; the oldest rounds' sets go first while there are more than 12 sets
 * or more than 256 KB, never a set of the newest round or of `next`'s.
 */
export function upsertFindingSet(
  sets: readonly FindingsSet[] | undefined,
  next: FindingsSet,
): UpsertResult {
  const current = [...(sets ?? [])];
  const existing = current.find(
    (s) => s.role === next.role && s.round === next.round,
  );
  if (existing && existing.attempt > next.attempt)
    return {
      sets: current,
      saved: null,
      notes: [
        `A newer attempt owns round ${next.round}'s findings; nothing saved.`,
      ],
    };
  const previousCalls =
    existing && existing.attempt === next.attempt ? existing.calls : 0;
  if (previousCalls >= FINDINGS_LIMITS.callsPerSet)
    return {
      sets: current,
      saved: null,
      notes: [
        `You've updated the findings ${FINDINGS_LIMITS.callsPerSet} times this round. Put anything else in your report.`,
      ],
    };

  const blocks = [...next.blocks];
  const notes: string[] = [];
  const build = (): FindingsSet => ({
    ...next,
    calls: previousCalls + 1,
    blocks: [...blocks],
    notes: [...next.notes, ...notes].slice(0, FINDINGS_LIMITS.notes),
  });
  let saved = build();
  while (bytes(saved) > FINDINGS_LIMITS.setBytes && blocks.length > 0) {
    const dropped = blocks.pop();
    notes.push(
      `Dropped block \`${dropped?.id}\`: the findings are over ${FINDINGS_LIMITS.setBytes / 1024} KB.`,
    );
    saved = build();
  }

  const out = current.filter((s) => s !== existing);
  out.push(saved);
  out.sort(bySetOrder);
  const newestRound = Math.max(...out.map((s) => s.round));
  const droppable = (s: FindingsSet) =>
    s !== saved && s.round !== newestRound && s.round !== saved.round;
  while (
    out.length > FINDINGS_LIMITS.sets ||
    bytes(out) > FINDINGS_LIMITS.totalBytes
  ) {
    const oldest = out.findIndex(droppable);
    if (oldest < 0) break;
    out.splice(oldest, 1);
  }
  return { sets: out, saved, notes };
}

/**
 * Saves `next` on the incident through a CAS update that writes only
 * `response.findingSets` and `incident.updatedAt` (never
 * `response.updatedAt`, the ledger or events). A refused set writes nothing.
 */
export async function saveFindingSet(
  incidentId: string,
  next: FindingsSet,
  deps: { updateIncident: typeof updateIncident } = { updateIncident },
): Promise<SaveResult> {
  let result: SaveResult = { saved: null, notes: [] };
  const committed = await deps.updateIncident(incidentId, (current) => {
    const response = current.response;
    if (!response) {
      result = { saved: null, notes: ["This incident has no agents yet."] };
      return { error: "no-response" };
    }
    const upserted = upsertFindingSet(response.findingSets, next);
    result = { saved: upserted.saved, notes: upserted.notes };
    if (!upserted.saved) return { error: "refused" };
    response.findingSets = upserted.sets;
    current.updatedAt = next.updatedAt;
    return current;
  });
  if (committed === null)
    return { saved: null, notes: [`No incident ${incidentId}.`] };
  return result;
}
