// The incident engine. `decideIncidentOps` is pure: from one signal's state
// change and a snapshot of signals, evaluations and incidents it decides
// what should happen (open, attach, record, transition). `applyIncidentOps`
// carries those decisions out against the incident store, one at a time.
import {
  type FixedBy,
  type Incident,
  type IncidentFinding,
  type IncidentState,
  type Signal,
  type SignalEvaluation,
  type SignalState,
  isOpenIncident,
  isTerminalIncidentState,
} from "../../shared/incidents";
import {
  type NewIncident,
  createIncident,
  newFinding,
  updateIncident,
} from "./incident-store";
import { appendEvent, transitionIncident } from "./lifecycle";
import { PROBLEM_STATES, WARNING_STATES } from "./rules";

/** An open incident takes a new problem in its project for this long after
 *  its last reported problem. */
export const MERGE_WINDOW_MS = 1_800_000;
/** A signal that turns bad this soon after its incident closed reopens it. */
export const REOPEN_WINDOW_MS = 1_800_000;

export interface EngineSnapshot {
  signals: Map<string, Signal>;
  /** Already holds the current evaluation of the signal being decided. */
  evaluations: Map<string, SignalEvaluation>;
  /** Open incidents plus terminal ones closed within REOPEN_WINDOW_MS. */
  incidents: Incident[];
  now: number;
}

export type IncidentOp =
  | { op: "open"; incident: NewIncident }
  | {
      op: "attach";
      incidentId: string;
      signalId: string;
      signalState: SignalState;
      detail: string;
    }
  | {
      op: "transition";
      incidentId: string;
      to: IncidentState;
      detail: string;
      fixedBy?: FixedBy;
    }
  | {
      op: "event";
      incidentId: string;
      signalId: string;
      signalState: SignalState;
      detail: string;
    }
  | {
      op: "finding";
      incidentId: string;
      finding: Omit<IncidentFinding, "id">;
    }
  | {
      op: "resolve-finding";
      incidentId: string;
      kind: IncidentFinding["kind"];
      signalId?: string;
      againstSignalId?: string;
    };

const isProblem = (state: SignalState | undefined) =>
  state !== undefined && PROBLEM_STATES.has(state);
const isWarning = (state: SignalState | undefined) =>
  state !== undefined && WARNING_STATES.has(state);
const isBad = (state: SignalState | undefined) =>
  isProblem(state) || isWarning(state);

/** Newest `openedAt` first, so the first match of a filter is the tie winner. */
function newestFirst(incidents: Incident[]): Incident[] {
  return [...incidents].sort(
    (a, b) => b.openedAt.localeCompare(a.openedAt) || b.id.localeCompare(a.id),
  );
}

function since(iso: string | undefined, now: number): number {
  const at = iso === undefined ? Number.NaN : Date.parse(iso);
  return Number.isFinite(at) ? now - at : Number.POSITIVE_INFINITY;
}

/** Signals related to `signal` by a declared dependency, either direction,
 *  that still exist. */
function relatedSignalIds(
  signal: Signal,
  snapshot: EngineSnapshot,
): Set<string> {
  const related = new Set<string>();
  for (const id of signal.dependsOn ?? [])
    if (id !== signal.id && snapshot.signals.has(id)) related.add(id);
  for (const other of snapshot.signals.values())
    if (other.id !== signal.id && other.dependsOn?.includes(signal.id))
      related.add(other.id);
  return related;
}

type Target =
  | { kind: "own"; incident: Incident }
  | { kind: "merge"; incident: Incident }
  | { kind: "reopen"; incident: Incident };

function pickTarget(
  signal: Signal,
  snapshot: EngineSnapshot,
): Target | undefined {
  const incidents = newestFirst(snapshot.incidents);
  const open = incidents.filter(isOpenIncident);
  const own = open.find((i) => i.signalIds.includes(signal.id));
  if (own) return { kind: "own", incident: own };
  const related = relatedSignalIds(signal, snapshot);
  const dependency = open.find((i) =>
    i.signalIds.some((id) => related.has(id)),
  );
  if (dependency) return { kind: "merge", incident: dependency };
  const nearby = open.find(
    (i) =>
      i.project === signal.project &&
      since(i.lastProblemAt, snapshot.now) <= MERGE_WINDOW_MS,
  );
  if (nearby) return { kind: "merge", incident: nearby };
  const closed = incidents.find(
    (i) =>
      isTerminalIncidentState(i.state) &&
      i.signalIds.includes(signal.id) &&
      since(i.closedAt, snapshot.now) <= REOPEN_WINDOW_MS,
  );
  if (closed) return { kind: "reopen", incident: closed };
  return undefined;
}

/** Every attached signal that still exists and is not a provider is ok. */
function allOwnSignalsOk(
  incident: Incident,
  snapshot: EngineSnapshot,
): boolean {
  return incident.signalIds.every((id) => {
    const signal = snapshot.signals.get(id);
    if (!signal || signal.provider) return true;
    return snapshot.evaluations.get(id)?.state === "ok";
  });
}

function signalEvent(
  op: "event" | "attach",
  incidentId: string,
  signalId: string,
  current: SignalEvaluation,
): IncidentOp {
  return {
    op,
    incidentId,
    signalId,
    signalState: current.state,
    detail: current.reason,
  };
}

function decideBad(
  signal: Signal,
  current: SignalEvaluation,
  snapshot: EngineSnapshot,
): IncidentOp[] {
  const problem = isProblem(current.state);
  const target = pickTarget(signal, snapshot);
  if (!target)
    return [
      {
        op: "open",
        incident: {
          project: signal.project,
          title: signal.name,
          state: problem ? "investigating" : "heads-up",
          severity: signal.severity,
          owner: signal.createdBy,
          openedBy: { kind: "rule", ref: signal.id },
          signalIds: [signal.id],
          primarySignalId: signal.id,
          at: new Date(snapshot.now).toISOString(),
          detail: current.reason,
        },
      },
    ];
  const incident = target.incident;
  if (target.kind === "reopen")
    return [
      {
        op: "transition",
        incidentId: incident.id,
        to: problem ? "investigating" : "heads-up",
        detail: current.reason,
      },
    ];
  const ops: IncidentOp[] = [
    signalEvent(
      target.kind === "own" ? "event" : "attach",
      incident.id,
      signal.id,
      current,
    ),
  ];
  if (problem && incident.state === "heads-up")
    ops.push({
      op: "transition",
      incidentId: incident.id,
      to: "investigating",
      detail: current.reason,
    });
  return ops;
}

export function decideIncidentOps(
  signal: Signal,
  previous: SignalEvaluation | null,
  current: SignalEvaluation,
  snapshot: EngineSnapshot,
): IncidentOp[] {
  // Providers correlate with own signals; they never drive incidents here.
  if (signal.provider) return [];
  if (current.inMaintenance) return [];
  if (previous && previous.state === current.state) return [];
  const open = newestFirst(snapshot.incidents).filter(isOpenIncident);
  const containing = open.filter((i) => i.signalIds.includes(signal.id));
  // After a restart only a bad signal nothing covers yet opens anything.
  if (previous === null && (!isBad(current.state) || containing.length))
    return [];

  if (isBad(current.state)) return decideBad(signal, current, snapshot);

  const ops: IncidentOp[] = [];
  for (const incident of containing) {
    ops.push(signalEvent("event", incident.id, signal.id, current));
    if (
      current.state === "ok" &&
      incident.state === "heads-up" &&
      allOwnSignalsOk(incident, snapshot)
    )
      ops.push({
        op: "transition",
        incidentId: incident.id,
        to: "closed-without-action",
        detail: "Signals back to normal",
      });
  }
  return ops;
}

function sameFinding(
  a: Pick<IncidentFinding, "kind" | "signalId" | "againstSignalId">,
  b: Pick<IncidentFinding, "kind" | "signalId" | "againstSignalId">,
): boolean {
  return (
    a.kind === b.kind &&
    a.signalId === b.signalId &&
    a.againstSignalId === b.againstSignalId
  );
}

/** One op against the stored incident, or an error to skip it. */
function applyOp(
  incident: Incident,
  op: Exclude<IncidentOp, { op: "open" }>,
  at: string,
): Incident | { error: string } {
  switch (op.op) {
    case "attach":
    case "event": {
      const attaching =
        op.op === "attach" && !incident.signalIds.includes(op.signalId);
      const next = appendEvent(
        attaching
          ? { ...incident, signalIds: [...incident.signalIds, op.signalId] }
          : incident,
        {
          at,
          kind: attaching ? "signal-attached" : "signal-state",
          by: "sessions",
          detail: op.detail,
          signalId: op.signalId,
          signalState: op.signalState,
        },
      );
      return isBad(op.signalState) ? { ...next, lastProblemAt: at } : next;
    }
    case "transition": {
      const moved = transitionIncident(incident, op.to, {
        by: "sessions",
        detail: op.detail,
        at,
        ...(op.fixedBy ? { fixedBy: op.fixedBy } : {}),
      });
      // The engine reopens only for a problem or warning: the merge window
      // counts from now, not from before the incident closed.
      return "error" in moved || !isTerminalIncidentState(incident.state)
        ? moved
        : { ...moved, lastProblemAt: at };
    }
    case "finding": {
      if (
        incident.findings.some(
          (f) => !f.resolvedAt && sameFinding(f, op.finding),
        )
      )
        return incident;
      return appendEvent(
        {
          ...incident,
          findings: [...incident.findings, newFinding(op.finding)],
        },
        {
          at,
          kind: "finding",
          by: "sessions",
          detail: op.finding.detail,
          signalId: op.finding.signalId,
        },
      );
    }
    case "resolve-finding": {
      let changed = false;
      const findings = incident.findings.map((f) => {
        if (
          f.resolvedAt ||
          f.kind !== op.kind ||
          (op.signalId !== undefined && f.signalId !== op.signalId) ||
          (op.againstSignalId !== undefined &&
            f.againstSignalId !== op.againstSignalId)
        )
          return f;
        changed = true;
        return { ...f, resolvedAt: at };
      });
      return changed ? { ...incident, findings, updatedAt: at } : incident;
    }
  }
}

/** Apply ops in order. Resolves the incidents created or changed, each once
 *  in its latest version. */
export async function applyIncidentOps(
  ops: IncidentOp[],
  at: string,
): Promise<Incident[]> {
  const touched = new Map<string, Incident>();
  for (const op of ops) {
    if (op.op === "open") {
      const created = await createIncident(op.incident);
      touched.set(created.id, created);
      continue;
    }
    const result = await updateIncident(op.incidentId, (current) =>
      applyOp(current, op, at),
    );
    if (result === null) continue;
    if ("error" in result) {
      // The incident moved since the decision; the op no longer applies.
      console.warn(
        `[incidents] skipped ${op.op} on ${op.incidentId}: ${result.error}`,
      );
      continue;
    }
    touched.set(result.id, result);
  }
  return [...touched.values()];
}
