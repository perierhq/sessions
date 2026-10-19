/**
 * Wire shapes for what a session still has running on the host
 * (server/session-resource-inventory.ts).
 */

export type SessionResourceItemKind = "portal" | "setup" | "container" | "unit";

export type SessionResourceItem = {
  kind: SessionResourceItemKind;
  /** Stable key: `<kind>:<name, record id, container id or unit>`. */
  id: string;
  /** Container name and image, Portal name, setup step or unit. */
  label: string;
  /** The container CLI, for containers. */
  runtime?: "podman" | "docker";
  /** Memory in use, where it can be read cheaply. */
  memoryBytes?: number;
  startedAt?: string;
};

/** GET /api/sessions/:id/resources */
export type SessionResourceList = {
  items: SessionResourceItem[];
  /** Sum over the items whose memory is known. */
  memoryBytes?: number;
};

/** POST /api/sessions/:id/resources/stop */
export type StopSessionResourcesResult = { stopped: number };

/** Live, archived, missing from the session list, or untagged. */
export type SessionResourceOwnerState =
  | "live"
  | "archived"
  | "missing"
  | "unknown";

/** GET /api/host/session-resources */
export type HostSessionResources = {
  /** Session workloads by the state of their owner (Portals not included). */
  counts: Record<SessionResourceOwnerState, number>;
  byKind: { setup: number; container: number; unit: number };
  memoryBytes: number;
  /** Memory held by archived and missing sessions' workloads. */
  leftoverMemoryBytes: number;
  /** Archived and missing sessions' workloads, at most 50. */
  leftovers: Array<
    SessionResourceItem & {
      sessionId?: string;
      owner: Extract<SessionResourceOwnerState, "archived" | "missing">;
    }
  >;
};
