/**
 * What a session still has running on this host, for the session view and
 * host health, and "Stop everything" for an idle session.
 *
 * One list across the three owners of session workloads: host Portals
 * (portal-supervisor.ts), recorded setup (session-resources.ts) and labelled
 * containers and units (session-ownership.ts). Memory comes from systemd
 * (MemoryCurrent of a scope or unit) and the container CLIs' `stats`, and is
 * left out where neither can say cheaply (an unscoped process group).
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
  listLabelledResources,
  unitsMemory,
  type LabelledResource,
} from "./session-ownership";
import {
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
  const ids = new Set(sessionResourceOwnerIds(session));
  const [portals, records, labelled] = await Promise.all([
    sessionHostPortals(session),
    sessionOwnedRecords(session, sessions),
    listLabelledResources(),
  ]);
  const alive: SessionResource[] = [];
  for (const record of records)
    if (await sessionResourceAlive(record)) alive.push(record);
  const owned = labelled.filter((resource) => ids.has(resource.sessionId));
  const [unitMemory, containerMemory] = await Promise.all([
    unitsMemory([
      ...portals
        .map(({ record }) => record.scopeUnit)
        .filter((unit): unit is string => !!unit)
        .map(scopeName),
      ...alive
        .map((record) => record.unit)
        .filter((unit): unit is string => !!unit)
        .map(scopeName),
    ]),
    containersMemory(owned.filter((resource) => resource.kind === "container")),
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
 * Portals, the setup it owns, and its labelled containers and units. The
 * caller checks the session is idle. Returns how many were stopped.
 */
export async function stopSessionWorkloads(
  session: InventoryOwner,
  sessions: readonly SessionResourceOwner[],
): Promise<number> {
  const portals = await stopSessionHostPortals(session);
  const resources = await stopSessionOwnedResources(session, sessions, {
    reason: "stopped",
  });
  return portals + resources.length;
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

  const labelled = await listLabelledResources();
  const containerMemory = await containersMemory(
    labelled.filter((resource) => resource.kind === "container"),
  );
  const records: SessionResource[] = [];
  for (const record of listSessionResources())
    if (await sessionResourceAlive(record)) records.push(record);
  const recordMemory = await unitsMemory(
    records
      .map((record) => record.unit)
      .filter((unit): unit is string => !!unit)
      .map(scopeName),
  );

  const counts = { live: 0, archived: 0, missing: 0, unknown: 0 };
  const byKind = { setup: 0, container: 0, unit: 0 };
  const leftovers: HostSessionResources["leftovers"] = [];
  let memoryBytes = 0;
  let leftoverMemoryBytes = 0;
  const add = (
    item: SessionResourceItem,
    sessionId: string | undefined,
  ): void => {
    const owner = state(sessionId);
    counts[owner]++;
    if (item.kind !== "portal") byKind[item.kind]++;
    memoryBytes += item.memoryBytes ?? 0;
    if (owner === "archived" || owner === "missing") {
      leftoverMemoryBytes += item.memoryBytes ?? 0;
      if (leftovers.length < LEFTOVER_LIMIT)
        leftovers.push({
          ...item,
          ...(sessionId ? { sessionId } : {}),
          owner,
        });
    }
  };
  for (const resource of labelled)
    add(labelledItem(resource, containerMemory), resource.sessionId);
  for (const record of records)
    add(recordItem(record, recordMemory), record.sessionId);
  return {
    counts,
    byKind,
    memoryBytes,
    leftoverMemoryBytes,
    leftovers,
  };
}
