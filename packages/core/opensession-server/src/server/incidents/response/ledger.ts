// "What the agents did": the incident response's ledger, capped, and the
// empty response record a fix loop starts from.
import { randomUUIDv7 } from "bun";
import type {
  IncidentResponse,
  LedgerEntry,
  ResponsePhase,
} from "../../../shared/incident-response";

export const LEDGER_CAP = 300;
const LEDGER_DETAIL_MAX = 500;

export function emptyResponse(input: {
  now: string;
  maxRounds: number;
  phase: ResponsePhase;
  coordinatorSessionId?: string;
  automationId?: string;
}): IncidentResponse {
  return {
    phase: input.phase,
    round: 1,
    maxRounds: input.maxRounds,
    ...(input.coordinatorSessionId
      ? { coordinatorSessionId: input.coordinatorSessionId }
      : {}),
    ...(input.automationId ? { automationId: input.automationId } : {}),
    agents: [],
    actionRuns: [],
    costUsd: 0,
    ownerTouched: false,
    next: { kind: "working", detail: "Starting" },
    ledger: [],
    droppedLedger: 0,
    startedAt: input.now,
    updatedAt: input.now,
  };
}

/**
 * What an incident's agents spent in a UTC month (`YYYY-MM`): each run's
 * cost counts in the month it was spent, when the run ended (as its
 * ledger entry records), or now while it is still working. An incident
 * that spans two months splits its spend between them.
 */
export function spendInMonth(
  r: IncidentResponse | undefined,
  month: string,
  now: number,
): number {
  let sum = 0;
  for (const run of r?.agents ?? []) {
    const working = run.status === "running" || run.status === "waiting";
    const at =
      (working ? undefined : (run.endedAt ?? run.startedAt)) ??
      new Date(now).toISOString();
    if (at.slice(0, 7) === month) sum += run.costUsd || 0;
  }
  return Math.round(sum * 100) / 100;
}

/** Appends one entry; over the cap the oldest go and are counted. */
export function appendLedger(
  r: IncidentResponse,
  entry: Omit<LedgerEntry, "id">,
): IncidentResponse {
  const ledger = [
    ...r.ledger,
    {
      ...entry,
      id: `led-${randomUUIDv7()}`,
      detail: entry.detail.slice(0, LEDGER_DETAIL_MAX),
    },
  ];
  const over = Math.max(0, ledger.length - LEDGER_CAP);
  return {
    ...r,
    ledger: over ? ledger.slice(over) : ledger,
    droppedLedger: r.droppedLedger + over,
  };
}
