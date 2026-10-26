// Incidents on the `incidents` application catalog namespace. Updates run
// through the catalog's compare-and-swap, every committed change is audited
// by diffing the two versions, and change listeners (the seam the fix loop
// subscribes to) hear about it afterwards.
import { randomUUIDv7 } from "bun";
import {
  type Incident,
  type IncidentFinding,
  type IncidentOpener,
  type IncidentSummary,
  type Severity,
  isOpenIncident,
} from "../../shared/incidents";
import { catalogDocuments } from "../catalog-documents";
import { incidentAudit } from "./audit-sink";

const NAMESPACE = "incidents";

export interface NewIncident {
  project: string;
  title: string;
  state: "heads-up" | "investigating" | "waiting-on-provider";
  severity: Severity;
  owner: string;
  openedBy: IncidentOpener;
  signalIds: string[];
  primarySignalId: string;
  at: string;
  detail: string;
  findings?: Array<Omit<IncidentFinding, "id">>;
}

/** May be async; what it returns is never awaited by the write. */
export type IncidentListener = (
  next: Incident,
  previous: Incident | null,
) => void;

// Bound on first use, never at import: the catalog client is a live effect.
let documents: ReturnType<typeof catalogDocuments> | undefined;
function incidentDocuments(): ReturnType<typeof catalogDocuments> {
  return (documents ??= catalogDocuments(NAMESPACE));
}

const listeners = new Set<IncidentListener>();

/** Ids the catalog accepts as keys; anything else was never stored. */
function isIncidentId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= 256 &&
    id !== "." &&
    id !== ".." &&
    !/[\\/\u0000-\u001f]/.test(id)
  );
}

function isIncidentRecord(value: unknown): value is Incident {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as Incident).id === "string" &&
    typeof (value as Incident).state === "string" &&
    Array.isArray((value as Incident).signalIds) &&
    Array.isArray((value as Incident).events) &&
    Array.isArray((value as Incident).findings)
  );
}

export function newFinding(
  finding: Omit<IncidentFinding, "id">,
): IncidentFinding {
  return { id: `fnd-${randomUUIDv7()}`, ...finding };
}

/** Subscribe to committed changes; returns the unsubscribe function. */
export function onIncidentChange(listener: IncidentListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Tell every listener, each on its own microtask: a listener that throws,
 * rejects or never settles cannot fail the write or hold up the engine.
 */
function notify(next: Incident, previous: Incident | null): void {
  for (const listener of [...listeners])
    void Promise.resolve()
      .then(() => listener(next, previous))
      .catch((error: unknown) => {
        console.warn(
          "[incidents] change listener failed:",
          error instanceof Error ? error.message : error,
        );
      });
}

function findingAudit(
  incidentId: string,
  finding: IncidentFinding,
): Record<string, unknown> {
  return {
    kind: "incident_finding",
    incidentId,
    findingKind: finding.kind,
    signalId: finding.signalId,
    ...(finding.againstSignalId === undefined
      ? {}
      : { againstSignalId: finding.againstSignalId }),
    ...(finding.count === undefined ? {} : { count: finding.count }),
  };
}

/** Audit what changed between two committed versions. */
function auditChange(previous: Incident, next: Incident): void {
  const id = next.id;
  if (previous.state !== next.state) {
    const moved = next.events.findLast(
      (e) => e.kind === "state" || e.kind === "reopened",
    );
    incidentAudit({
      kind: "incident_state",
      incidentId: id,
      from: previous.state,
      to: next.state,
      by: moved?.by ?? "sessions",
      detail: moved?.detail ?? "",
    });
  }
  const attached = new Set(previous.signalIds);
  for (const signalId of next.signalIds)
    if (!attached.has(signalId)) {
      attached.add(signalId);
      incidentAudit({
        kind: "incident_signal_attached",
        incidentId: id,
        signalId,
      });
    }
  const before = new Map(previous.findings.map((f) => [f.id, f]));
  for (const finding of next.findings) {
    const old = before.get(finding.id);
    if (!old || (old.resolvedAt && !finding.resolvedAt))
      incidentAudit(findingAudit(id, finding));
    if (finding.resolvedAt && !old?.resolvedAt)
      incidentAudit({
        kind: "incident_finding_resolved",
        incidentId: id,
        findingKind: finding.kind,
        signalId: finding.signalId,
        ...(finding.againstSignalId === undefined
          ? {}
          : { againstSignalId: finding.againstSignalId }),
      });
  }
}

export async function createIncident(init: NewIncident): Promise<Incident> {
  const incident: Incident = {
    id: `inc-${randomUUIDv7()}`,
    project: init.project,
    title: init.title,
    state: init.state,
    severity: init.severity,
    owner: init.owner,
    openedBy: init.openedBy,
    signalIds: [...init.signalIds],
    primarySignalId: init.primarySignalId,
    openedAt: init.at,
    updatedAt: init.at,
    lastProblemAt: init.at,
    // Opened already waiting: once the provider is back, work resumes.
    ...(init.state === "waiting-on-provider"
      ? { resumeState: "investigating" as const }
      : {}),
    findings: (init.findings ?? []).map(newFinding),
    events: [
      {
        id: `evt-${randomUUIDv7()}`,
        at: init.at,
        kind: "opened",
        by: "sessions",
        detail: init.detail.slice(0, 2000),
        to: init.state,
        signalId: init.primarySignalId,
        marker: "detected",
      },
    ],
    droppedEvents: 0,
  };
  await incidentDocuments().set(incident.id, incident);
  incidentAudit({
    kind: "incident_opened",
    incidentId: incident.id,
    project: incident.project,
    signalId: incident.primarySignalId,
    state: incident.state,
    owner: incident.owner,
  });
  for (const finding of incident.findings)
    incidentAudit(findingAudit(incident.id, finding));
  notify(incident, null);
  return incident;
}

export async function getIncident(id: string): Promise<Incident | null> {
  if (!isIncidentId(id)) return null;
  const value = await incidentDocuments().get(id);
  return isIncidentRecord(value) ? value : null;
}

/** Newest `openedAt` first. */
export async function listIncidents(
  filter: {
    open?: boolean;
    project?: string;
    signalId?: string;
    /** Closed incidents only when they closed at or after this time (ms);
     *  open ones are unaffected. */
    closedSince?: number;
  } = {},
): Promise<Incident[]> {
  const out: Incident[] = [];
  for (const { value } of await incidentDocuments().list()) {
    if (!isIncidentRecord(value)) continue;
    if (filter.open !== undefined && isOpenIncident(value) !== filter.open)
      continue;
    if (
      filter.closedSince !== undefined &&
      !isOpenIncident(value) &&
      !(Date.parse(value.closedAt ?? "") >= filter.closedSince)
    )
      continue;
    if (filter.project !== undefined && value.project !== filter.project)
      continue;
    if (
      filter.signalId !== undefined &&
      !value.signalIds.includes(filter.signalId)
    )
      continue;
    out.push(value);
  }
  out.sort(
    (a, b) => b.openedAt.localeCompare(a.openedAt) || b.id.localeCompare(a.id),
  );
  return out;
}

/**
 * Apply `mutate` to the freshest stored incident (re-run on a CAS conflict).
 * Resolves null for an incident that does not exist; a returned `{ error }`
 * aborts without writing and is surfaced as is.
 */
export async function updateIncident(
  id: string,
  mutate: (current: Incident) => Incident | { error: string },
): Promise<Incident | { error: string } | null> {
  if (!isIncidentId(id)) return null;
  if ((await getIncident(id)) === null) return null;
  let seen: Incident | null = null;
  let failure: { error: string } | undefined;
  const committed = await incidentDocuments().update<Incident>(id, (value) => {
    failure = undefined;
    seen = null;
    // Deleted meanwhile: leave it deleted.
    if (value === null) return null;
    if (!isIncidentRecord(value))
      throw new Error(`Incident ${id} record is malformed`);
    seen = value;
    const next = mutate(structuredClone(value));
    if ("error" in next) {
      failure = next;
      return value;
    }
    return next;
  });
  if (failure) return failure;
  if (committed === null || seen === null) return null;
  const previous: Incident = seen;
  if (JSON.stringify(previous) === JSON.stringify(committed)) return committed;
  auditChange(previous, committed);
  notify(committed, previous);
  return committed;
}

export function summarizeIncident(incident: Incident): IncidentSummary {
  const { events, ...rest } = incident;
  const lastEvent = events.at(-1);
  return {
    ...rest,
    eventCount: events.length,
    ...(lastEvent ? { lastEvent } : {}),
  };
}
