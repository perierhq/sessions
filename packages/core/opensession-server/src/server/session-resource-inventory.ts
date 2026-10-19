/**
 * What a session still has running on this host, for the session view and
 * host health, and "Stop everything" for an idle session.
 *
 * One list across the three owners of session workloads: host Portals
 * (portal-supervisor.ts), recorded setup (session-resources.ts) and labelled
 * containers and units (session-ownership.ts). Memory comes from systemd
 * (MemoryCurrent of a scope or unit) and the container CLIs' `stats`, and is
 * left out where neither can say cheaply (an unscoped process group).
 *
 * The container and unit listing and the memory figures are host-wide and
 * cost a few CLI calls, so every view shares one snapshot for
 * VIEW_TTL_MS (counted from when it finished). A stop anywhere marks it
 * stale. Runner and Sandbox sessions run elsewhere and list nothing here.
 */
import type {
  HostSessionResources,
  SessionResourceItem,
  SessionResourceList,
  SessionResourceOwnerState,
} from "../shared/session-resources";
import {
  sessionHostPortals,
  stopSessionHostPortals,
  type PortalOwnerSession,
} from "./portal-supervisor";
import {
  containersMemory,
  labelledStopGeneration,
  listLabelledResources,
  resourceInstanceId,
  unitsMemory,
  type LabelledResource,
} from "./session-ownership";
import {
  labelledReapReason,
  listSessionResources,
  sessionOwnedRecords,
  sessionResourceAlive,
  sessionResourceOwnerIds,
  stopSessionOwnedResources,
  type SessionResource,
  type SessionResourceOwner,
} from "./session-resources";
import type { UnifiedSession } from "./types";

export type InventoryOwner = PortalOwnerSession &
  SessionResourceOwner &
  Partial<Pick<UnifiedSession, "runner" | "sandbox">>;

/** How long the labelled listing and memory figures are reused. */
const VIEW_TTL_MS = 20_000;

type LabelledView = {
  rows: LabelledResource[];
  /** Memory of every labelled container, by full id. */
  containerMemory: Map<string, number>;
};

let labelledView: {
  /** When it finished; undefined while it runs (shared meanwhile). */
  at?: number;
  generation: number;
  value: Promise<LabelledView>;
} | null = null;

/** Every labelled container and unit on the host, with container memory:
 * one `ps` and one `stats --no-stream` per CLI, shared by every session's
 * view and host health for VIEW_TTL_MS, or until something is stopped. */
function labelledSnapshot(): Promise<LabelledView> {
  const generation = labelledStopGeneration();
  if (
    labelledView &&
    labelledView.generation === generation &&
    (labelledView.at === undefined ||
      Date.now() - labelledView.at < VIEW_TTL_MS)
  )
    return labelledView.value;
  const entry: NonNullable<typeof labelledView> = {
    generation,
    value: Promise.resolve({ rows: [], containerMemory: new Map() }),
  };
  entry.value = (async () => {
    try {
      const rows = await listLabelledResources();
      const containerMemory = await containersMemory(
        rows.filter((row) => row.kind === "container"),
      );
      return { rows, containerMemory };
    } finally {
      entry.at = Date.now();
    }
  })();
  labelledView = entry;
  return entry.value;
}

const unitMemoryCache = new Map<string, { at: number; bytes?: number }>();

/** unitsMemory, reusing each unit's figure for VIEW_TTL_MS. */
async function cachedUnitsMemory(
  units: readonly string[],
): Promise<Map<string, number>> {
  let now = Date.now();
  for (const [unit, entry] of unitMemoryCache)
    if (now - entry.at >= VIEW_TTL_MS) unitMemoryCache.delete(unit);
  const missing = [...new Set(units)].filter(
    (unit) => !unitMemoryCache.has(unit),
  );
  if (missing.length) {
    const fresh = await unitsMemory(missing);
    now = Date.now();
    for (const unit of missing)
      unitMemoryCache.set(unit, { at: now, bytes: fresh.get(unit) });
  }
  const result = new Map<string, number>();
  for (const unit of units) {
    const bytes = unitMemoryCache.get(unit)?.bytes;
    if (bytes !== undefined) result.set(unit, bytes);
  }
  return result;
}

/** Drop the shared snapshot and memory figures (after a stop, and tests). */
export function forgetSessionResourceView(): void {
  labelledView = null;
  unitMemoryCache.clear();
}

/** Runner and Sandbox sessions run on another machine: nothing of theirs
 * is on this host to list or stop. */
function runsElsewhere(session: InventoryOwner): boolean {
  return !!session.runner || !!session.sandbox?.sandboxId;
}

function scopeName(unit: string): string {
  return unit.endsWith(".scope") || unit.endsWith(".service")
    ? unit
    : `${unit}.scope`;
}

function labelledItem(
  resource: LabelledResource,
  memory: Map<string, number>,
): SessionResourceItem {
  const memoryBytes =
    resource.kind === "unit"
      ? resource.memoryBytes
      : memory.get(resource.handle);
  return {
    kind: resource.kind,
    id: `${resource.kind}:${resource.handle}`,
    label:
      resource.kind === "container"
        ? resource.label || resource.handle.slice(0, 12)
        : unitLabel(resource),
    ...(resource.runtime ? { runtime: resource.runtime } : {}),
    ...(memoryBytes !== undefined ? { memoryBytes } : {}),
    ...(resource.startedAtMs !== undefined
      ? { startedAt: new Date(resource.startedAtMs).toISOString() }
      : {}),
  };
}

/** A unit's description without its labels: what it is, then its name. */
function unitLabel(resource: LabelledResource): string {
  const what = resource.label
    .replace(/(?:^|\s)opensession\.(session|instance)=\S+/g, "")
    .trim();
  return what ? `${what} · ${resource.handle}` : resource.handle;
}

function recordItem(
  record: SessionResource,
  memory: Map<string, number>,
): SessionResourceItem {
  const memoryBytes = record.unit
    ? memory.get(scopeName(record.unit))
    : undefined;
  return {
    kind: "setup",
    id: `setup:${record.id}`,
    label: record.label ?? "Worktree setup",
    ...(memoryBytes !== undefined ? { memoryBytes } : {}),
    startedAt: record.startedAt,
  };
}

function sumMemory(items: readonly SessionResourceItem[]): number | undefined {
  const known = items.filter((item) => item.memoryBytes !== undefined);
  return known.length
    ? known.reduce((sum, item) => sum + item.memoryBytes!, 0)
    : undefined;
}

/**
 * Everything `session` still has running here: host Portals with a process,
 * recorded setup it owns (still alive), and containers and units carrying
 * its label. `sessions` is the session list, which decides whether a live
 * sibling keeps a shared worktree's setup.
 */
export async function sessionResourceList(
  session: InventoryOwner,
  sessions: readonly SessionResourceOwner[],
): Promise<SessionResourceList> {
  if (runsElsewhere(session)) return { items: [] };
  const ids = new Set(sessionResourceOwnerIds(session));
  const [portals, records, labelled] = await Promise.all([
    sessionHostPortals(session),
    sessionOwnedRecords(session, sessions),
    labelledSnapshot(),
  ]);
  const alive: SessionResource[] = [];
  for (const record of records)
    if (await sessionResourceAlive(record)) alive.push(record);
  const owned = labelled.rows.filter((resource) => ids.has(resource.sessionId));
  const containerMemory = labelled.containerMemory;
  const unitMemory = await cachedUnitsMemory([
    ...portals
      .map(({ record }) => record.scopeUnit)
      .filter((unit): unit is string => !!unit)
      .map(scopeName),
    ...alive
      .map((record) => record.unit)
      .filter((unit): unit is string => !!unit)
      .map(scopeName),
  ]);
  const items: SessionResourceItem[] = [
    ...portals.map(({ record }) => {
      const memoryBytes = record.scopeUnit
        ? unitMemory.get(scopeName(record.scopeUnit))
        : undefined;
      return {
        kind: "portal" as const,
        id: `portal:${record.name}`,
        label: record.description || record.name,
        ...(memoryBytes !== undefined ? { memoryBytes } : {}),
        ...(record.startedAt ? { startedAt: record.startedAt } : {}),
      };
    }),
    ...alive.map((record) => recordItem(record, unitMemory)),
    ...owned.map((resource) => labelledItem(resource, containerMemory)),
  ];
  const memoryBytes = sumMemory(items);
  return { items, ...(memoryBytes !== undefined ? { memoryBytes } : {}) };
}

/**
 * Stop everything `session` started here ("Stop everything"): its host
 * Portals, the setup it owns, and its labelled containers and units.
 * `stillIdle` is asked before each stop: a run that starts meanwhile keeps
 * what has not been stopped yet (its dev server, its command scopes), and
 * `interrupted` says so. Returns how many were stopped.
 */
export async function stopSessionWorkloads(
  session: InventoryOwner,
  sessions: readonly SessionResourceOwner[],
  options: { stillIdle?: () => boolean } = {},
): Promise<{ stopped: number; interrupted: boolean }> {
  if (runsElsewhere(session)) return { stopped: 0, interrupted: false };
  let interrupted = false;
  const shouldContinue = () => {
    if (!interrupted && options.stillIdle && !options.stillIdle())
      interrupted = true;
    return !interrupted;
  };
  try {
    const portals = await stopSessionHostPortals(session, { shouldContinue });
    const resources = shouldContinue()
      ? await stopSessionOwnedResources(session, sessions, {
          reason: "stopped",
          shouldContinue,
        })
      : [];
    return { stopped: portals + resources.length, interrupted };
  } finally {
    forgetSessionResourceView();
  }
}

const LEFTOVER_LIMIT = 50;

/**
 * Host health's view: every labelled container and unit, and every recorded
 * resource still alive, grouped by whether its session is live, archived or
 * missing from `sessions`. Archived and missing ones are leftovers the
 * reaper has not stopped yet (or could not), listed individually.
 */
export async function hostSessionResources(
  sessions: readonly SessionResourceOwner[],
): Promise<HostSessionResources> {
  const archivedById = new Map<string, boolean>();
  for (const session of sessions)
    for (const id of sessionResourceOwnerIds(session))
      archivedById.set(id, session.archived === true);
  const state = (id: string | undefined): SessionResourceOwnerState =>
    id === undefined
      ? "unknown"
      : archivedById.has(id)
        ? archivedById.get(id)
          ? "archived"
          : "live"
        : "missing";

  const { rows: labelled, containerMemory } = await labelledSnapshot();
  const records: SessionResource[] = [];
  for (const record of listSessionResources())
    if (await sessionResourceAlive(record)) records.push(record);
  const recordMemory = await cachedUnitsMemory(
    records
      .map((record) => record.unit)
      .filter((unit): unit is string => !!unit)
      .map(scopeName),
  );

  const counts = { live: 0, archived: 0, missing: 0, unknown: 0 };
  const byKind = { setup: 0, container: 0, unit: 0 };
  const leftovers: HostSessionResources["leftovers"] = [];
  const leftoverReach = { reaper: 0, manual: 0 };
  let memoryBytes = 0;
  let leftoverMemoryBytes = 0;
  const add = (
    item: SessionResourceItem,
    sessionId: string | undefined,
    reaped: boolean,
  ): void => {
    const owner = state(sessionId);
    counts[owner]++;
    if (item.kind !== "portal") byKind[item.kind]++;
    memoryBytes += item.memoryBytes ?? 0;
    if (owner === "archived" || owner === "missing") {
      leftoverMemoryBytes += item.memoryBytes ?? 0;
      leftoverReach[reaped ? "reaper" : "manual"]++;
      if (leftovers.length < LEFTOVER_LIMIT)
        leftovers.push({
          ...item,
          ...(sessionId ? { sessionId } : {}),
          owner,
          reaped,
        });
    }
  };
  const instance = resourceInstanceId();
  for (const resource of labelled)
    add(
      labelledItem(resource, containerMemory),
      resource.sessionId,
      // Whether the reaper would stop it once its grace has passed: not
      // another instance's, nor a missing session's without this
      // instance's label or a readable start time.
      labelledReapReason(resource, {
        ownerArchived: archivedById.get(resource.sessionId),
        sessionsKnown: sessions.length > 0,
        instance,
        now: Number.POSITIVE_INFINITY,
      }) !== null,
    );
  // The reaper stops setup whose owners are all archived or gone.
  for (const record of records)
    add(recordItem(record, recordMemory), record.sessionId, true);
  return {
    counts,
    byKind,
    memoryBytes,
    leftoverMemoryBytes,
    leftoverReach,
    leftovers,
  };
}
