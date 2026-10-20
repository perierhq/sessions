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
 *  its last reported problem, and for as long as an attached signal is still
 *  bad. */
export const MERGE_WINDOW_MS = 1_800_000;
/** A signal that turns bad this soon after its incident closed reopens it. */
export const REOPEN_WINDOW_MS = 1_800_000;

export interface EngineSnapshot {
  signals: Map<string, Signal>;
  /** Already holds the current evaluation of the signal being decided. */
  evaluations: Map<string, SignalEvaluation>;
  /** Open incidents, terminal ones closed within REOPEN_WINDOW_MS, and
   *  terminal ones with the changed signal closed at or after its current
   *  evaluation's `since` (however long ago). */
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

/** Inside the merge window: a problem reported recently, or an attached
 *  signal that is still bad (a continuous outage reports nothing new). */
function inMergeWindow(incident: Incident, snapshot: EngineSnapshot): boolean {
  return (
    since(incident.lastProblemAt, snapshot.now) <= MERGE_WINDOW_MS ||
    incident.signalIds.some(
      (id) =>
        snapshot.signals.has(id) && isBad(snapshot.evaluations.get(id)?.state),
    )
  );
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
    (i) => i.project === signal.project && inMergeWindow(i, snapshot),
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

/** Ops for one decision, kept in the order they must apply per incident:
 *  events and attaches, then findings, then transitions. */
class OpList {
  private readonly head: IncidentOp[] = [];
  private readonly findings: IncidentOp[] = [];
  private readonly transitions: IncidentOp[] = [];

  add(op: IncidentOp): void {
    if (op.op === "finding" || op.op === "resolve-finding")
      this.findings.push(op);
    else if (op.op === "transition") this.transitions.push(op);
    else this.head.push(op);
  }

  /** A transition that must happen before anything else (a reopen). */
  first(op: IncidentOp): void {
    this.head.push(op);
  }

  list(): IncidentOp[] {
    return [...this.head, ...this.findings, ...this.transitions];
  }
}

const isOwn = (signal: Signal | undefined): signal is Signal =>
  !!signal && !signal.provider;

/** Provider `p` speaks for own signal `s`. */
function providerFor(p: Signal, s: Signal): boolean {
  return (
    !!p.provider &&
    p.enabled &&
    (p.project === s.project || !!s.dependsOn?.includes(p.id))
  );
}

/** Providers for `s` whose current evaluation is `external`. */
function externalProvidersFor(s: Signal, snapshot: EngineSnapshot): Signal[] {
  const out: Signal[] = [];
  for (const p of snapshot.signals.values())
    if (
      p.id !== s.id &&
      providerFor(p, s) &&
      snapshot.evaluations.get(p.id)?.state === "external"
    )
      out.push(p);
  return out;
}

function hasUnresolved(
  incident: Incident,
  finding: Pick<IncidentFinding, "kind" | "signalId" | "againstSignalId">,
): boolean {
  return incident.findings.some(
    (f) => !f.resolvedAt && sameFinding(f, finding),
  );
}

function externalFinding(
  p: Signal,
  snapshot: EngineSnapshot,
): Omit<IncidentFinding, "id"> {
  return {
    kind: "external",
    at: new Date(snapshot.now).toISOString(),
    signalId: p.id,
    detail: `${p.name} reports a problem`,
  };
}

/** Self-reported signals in `s`'s project that say ok while `s` is bad. */
function disagreementsWith(
  s: Signal,
  state: SignalState,
  snapshot: EngineSnapshot,
): Array<Omit<IncidentFinding, "id">> {
  if (s.selfReported) return [];
  const out: Array<Omit<IncidentFinding, "id">> = [];
  for (const r of snapshot.signals.values())
    if (
      r.id !== s.id &&
      r.selfReported &&
      !r.provider &&
      r.enabled &&
      r.project === s.project &&
      snapshot.evaluations.get(r.id)?.state === "ok"
    )
      out.push(disagreement(r, s, state, snapshot));
  return out;
}

function disagreement(
  r: Signal,
  s: Signal,
  state: SignalState,
  snapshot: EngineSnapshot,
): Omit<IncidentFinding, "id"> {
  return {
    kind: "disagreement",
    at: new Date(snapshot.now).toISOString(),
    signalId: r.id,
    againstSignalId: s.id,
    detail: `${r.name} reports ok while ${s.name} is ${state}`,
  };
}

/** Attach providers and record their findings on an existing incident. */
function recordProviders(
  ops: OpList,
  incident: Incident,
  providers: Signal[],
  snapshot: EngineSnapshot,
): void {
  for (const p of providers) {
    const finding = externalFinding(p, snapshot);
    if (!incident.signalIds.includes(p.id))
      ops.add({
        op: "attach",
        incidentId: incident.id,
        signalId: p.id,
        signalState: "external",
        detail: finding.detail,
      });
    if (!hasUnresolved(incident, finding))
      ops.add({ op: "finding", incidentId: incident.id, finding });
  }
}

/** An own signal turned problem or warning. */
function decideBad(
  ops: OpList,
  signal: Signal,
  current: SignalEvaluation,
  snapshot: EngineSnapshot,
): void {
  const problem = isProblem(current.state);
  const providers = problem ? externalProvidersFor(signal, snapshot) : [];
  const disagreements = problem
    ? disagreementsWith(signal, current.state, snapshot)
    : [];
  const target = pickTarget(signal, snapshot);
  if (!target) {
    const findings = [
      ...providers.map((p) => externalFinding(p, snapshot)),
      ...disagreements,
    ];
    ops.add({
      op: "open",
      incident: {
        project: signal.project,
        title: signal.name,
        state: providers.length
          ? "waiting-on-provider"
          : problem
            ? "investigating"
            : "heads-up",
        severity: signal.severity,
        owner: signal.createdBy,
        openedBy: { kind: "rule", ref: signal.id },
        signalIds: [signal.id, ...providers.map((p) => p.id)],
        primarySignalId: signal.id,
        at: new Date(snapshot.now).toISOString(),
        detail: current.reason,
        ...(findings.length ? { findings } : {}),
      },
    });
    return;
  }
  const incident = target.incident;
  // What the incident's state will be once the first ops have applied.
  let state = incident.state;
  if (target.kind === "reopen") {
    state = problem ? "investigating" : "heads-up";
    ops.first({
      op: "transition",
      incidentId: incident.id,
      to: state,
      detail: current.reason,
    });
  } else
    ops.add(
      signalEvent(
        target.kind === "own" ? "event" : "attach",
        incident.id,
        signal.id,
        current,
      ),
    );
  recordProviders(ops, incident, providers, snapshot);
  for (const finding of disagreements)
    if (!hasUnresolved(incident, finding))
      ops.add({ op: "finding", incidentId: incident.id, finding });
  if (providers.length && (state === "heads-up" || state === "investigating"))
    ops.add({
      op: "transition",
      incidentId: incident.id,
      to: "waiting-on-provider",
      detail: `Waiting on ${providers[0]!.name}`,
    });
  else if (problem && state === "heads-up")
    ops.add({
      op: "transition",
      incidentId: incident.id,
      to: "investigating",
      detail: current.reason,
    });
}

/** An own signal turned ok or unknown. */
function decideRecovery(
  ops: OpList,
  signal: Signal,
  current: SignalEvaluation,
  snapshot: EngineSnapshot,
  open: Incident[],
): void {
  const ok = current.state === "ok";
  for (const incident of open) {
    if (!incident.signalIds.includes(signal.id)) continue;
    ops.add(signalEvent("event", incident.id, signal.id, current));
    if (ok) {
      const against = {
        kind: "disagreement" as const,
        againstSignalId: signal.id,
      };
      if (
        incident.findings.some(
          (f) =>
            !f.resolvedAt &&
            f.kind === against.kind &&
            f.againstSignalId === signal.id,
        )
      )
        ops.add({ op: "resolve-finding", incidentId: incident.id, ...against });
    }
    if (!ok || !allOwnSignalsOk(incident, snapshot)) continue;
    if (incident.state === "heads-up")
      ops.add({
        op: "transition",
        incidentId: incident.id,
        to: "closed-without-action",
        detail: "Signals back to normal",
      });
    else if (incident.state === "waiting-on-provider") {
      // Resolved: the providers' outages are no longer this incident's.
      if (incident.findings.some((f) => !f.resolvedAt && f.kind === "external"))
        ops.add({
          op: "resolve-finding",
          incidentId: incident.id,
          kind: "external",
        });
      ops.add({
        op: "transition",
        incidentId: incident.id,
        to: "resolved",
        fixedBy: "provider-recovered",
        detail: "Recovered while a provider had a problem",
      });
    }
  }
  if (!signal.selfReported || !ok) return;
  // Self-reported ok while a real check in its project is failing.
  for (const incident of open) {
    if (incident.project !== signal.project) continue;
    for (const id of incident.signalIds) {
      const s = snapshot.signals.get(id);
      const state = snapshot.evaluations.get(id)?.state;
      if (!isOwn(s) || s.selfReported || s.id === signal.id) continue;
      // A signal merged in from another project is not this one's to vouch for.
      if (s.project !== signal.project) continue;
      if (!state || !isProblem(state)) continue;
      const finding = disagreement(signal, s, state, snapshot);
      if (!hasUnresolved(incident, finding))
        ops.add({ op: "finding", incidentId: incident.id, finding });
    }
  }
}

/** A self-reported signal stopped saying ok: its disagreements are over. */
function resolveSelfReported(
  ops: OpList,
  signal: Signal,
  open: Incident[],
): void {
  for (const incident of open)
    if (
      incident.project === signal.project &&
      incident.findings.some(
        (f) =>
          !f.resolvedAt &&
          f.kind === "disagreement" &&
          f.signalId === signal.id,
      )
    )
      ops.add({
        op: "resolve-finding",
        incidentId: incident.id,
        kind: "disagreement",
        signalId: signal.id,
      });
}

/**
 * A provider signal changed state (`previous = null`: replayed at boot).
 * Providers never open incidents. Only `ok` is a recovery: `unknown` says
 * nothing new, so it neither resolves a finding nor moves an incident.
 */
function decideProvider(
  provider: Signal,
  previous: SignalEvaluation | null,
  current: SignalEvaluation,
  snapshot: EngineSnapshot,
  open: Incident[],
): IncidentOp[] {
  const ops = new OpList();
  const external = current.state === "external";
  for (const incident of open) {
    const own = incident.signalIds
      .map((id) => snapshot.signals.get(id))
      .filter(isOwn);
    const attached = incident.signalIds.includes(provider.id);
    if (external) {
      const affected = own.some(
        (s) =>
          isProblem(snapshot.evaluations.get(s.id)?.state) &&
          providerFor(provider, s),
      );
      if (attached)
        ops.add(signalEvent("event", incident.id, provider.id, current));
      if (!affected) continue;
      recordProviders(ops, incident, [provider], snapshot);
      if (incident.state === "heads-up" || incident.state === "investigating")
        ops.add({
          op: "transition",
          incidentId: incident.id,
          to: "waiting-on-provider",
          detail: `Waiting on ${provider.name}`,
        });
      continue;
    }
    if (attached && previous)
      ops.add(signalEvent("event", incident.id, provider.id, current));
    // Resolve whatever finding is outstanding, whatever the previous state:
    // a restart may have replayed the provider unknown in between.
    if (current.state !== "ok") continue;
    const outstanding = incident.findings.filter(
      (f) => !f.resolvedAt && f.kind === "external",
    );
    if (!outstanding.some((f) => f.signalId === provider.id)) continue;
    ops.add({
      op: "resolve-finding",
      incidentId: incident.id,
      kind: "external",
      signalId: provider.id,
    });
    if (
      incident.state !== "waiting-on-provider" ||
      outstanding.some((f) => f.signalId !== provider.id)
    )
      continue;
    const stillBad = own.find((s) =>
      isProblem(snapshot.evaluations.get(s.id)?.state),
    );
    if (allOwnSignalsOk(incident, snapshot))
      ops.add({
        op: "transition",
        incidentId: incident.id,
        to: "resolved",
        fixedBy: "provider-recovered",
        detail: `${provider.name} recovered`,
      });
    else
      ops.add({
        op: "transition",
        incidentId: incident.id,
        to: "investigating",
        detail: stillBad
          ? `${provider.name} recovered, ${stillBad.name} still failing`
          : `${provider.name} recovered`,
      });
  }
  return ops.list();
}

/**
 * An incident with the signal was closed after its current bad run began:
 * someone closed it knowing. Without a restart nothing would have moved, so
 * a boot replay of the same run moves nothing either.
 */
function closedDuringRun(
  signal: Signal,
  current: SignalEvaluation,
  snapshot: EngineSnapshot,
): boolean {
  const started = Date.parse(current.since);
  if (!Number.isFinite(started)) return false;
  return snapshot.incidents.some(
    (i) =>
      isTerminalIncidentState(i.state) &&
      i.signalIds.includes(signal.id) &&
      i.closedAt !== undefined &&
      started <= Date.parse(i.closedAt),
  );
}

export function decideIncidentOps(
  signal: Signal,
  previous: SignalEvaluation | null,
  current: SignalEvaluation,
  snapshot: EngineSnapshot,
): IncidentOp[] {
  if (current.inMaintenance) return [];
  if (previous && previous.state === current.state) return [];
  const open = newestFirst(snapshot.incidents).filter(isOpenIncident);
  if (signal.provider)
    // At boot a provider takes its state back; only a recovery while the
    // server was down acts, resolving what it left outstanding.
    return previous === null && current.state !== "ok"
      ? []
      : decideProvider(signal, previous, current, snapshot, open);
  const ops = new OpList();
  // A self-reported signal that is not ok vouches for nothing, whatever it
  // said before: a restart may have replayed its change from ok unseen.
  if (signal.selfReported && current.state !== "ok")
    resolveSelfReported(ops, signal, open);
  const containing = open.filter((i) => i.signalIds.includes(signal.id));
  // After a restart only a bad signal nothing covers yet opens anything.
  if (
    previous === null &&
    (!isBad(current.state) ||
      containing.length ||
      closedDuringRun(signal, current, snapshot))
  )
    return ops.list();
  if (isBad(current.state)) decideBad(ops, signal, current, snapshot);
  else decideRecovery(ops, signal, current, snapshot, open);
  return ops.list();
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
