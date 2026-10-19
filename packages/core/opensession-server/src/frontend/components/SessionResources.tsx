import { useState } from "react";
import { stopSessionResources } from "../lib/api";
import { useSessionResourcesResource } from "../hooks/useApiResources";
import { errorMessage } from "../lib/error-message";
import { formatBytes } from "../lib/images";
import { cn } from "../ui/cn";
import type {
  SessionResourceItem,
  SessionResourceItemKind,
} from "../../shared/session-resources";
import {
  WS_SUMMARY_ACTION,
  WS_SUMMARY_COUNT,
  WS_SUMMARY_ICON,
  WS_SUMMARY_LABEL,
  WS_SUMMARY_RAIL,
  WS_SUMMARY_ROW,
  WS_SUMMARY_SECTION,
  WS_SUMMARY_STATE,
} from "../lib/workspace-summary-classes";
import { IconBox, IconGlobe, IconTerminal, IconWrench } from "./icons";

/** How often the list refreshes while it is on screen. */
const RESOURCES_REFRESH_MS = 30_000;
/** Rows before the rest fold into one "+N more" line. */
const VISIBLE_ROWS = 4;

const KIND_ICON: Record<SessionResourceItemKind, typeof IconBox> = {
  portal: IconGlobe,
  setup: IconWrench,
  container: IconBox,
  unit: IconTerminal,
};

const KIND_NAME: Record<SessionResourceItemKind, string> = {
  portal: "Portal",
  setup: "Setup",
  container: "Container",
  unit: "Background process",
};

/** "2 containers · 1 Portal", in a fixed order. */
export function sessionResourceSummary(
  items: readonly SessionResourceItem[],
): string {
  const order: SessionResourceItemKind[] = [
    "portal",
    "container",
    "unit",
    "setup",
  ];
  const plural: Record<SessionResourceItemKind, string> = {
    portal: "Portals",
    setup: "setups",
    container: "containers",
    unit: "background processes",
  };
  const singular: Record<SessionResourceItemKind, string> = {
    portal: "Portal",
    setup: "setup",
    container: "container",
    unit: "background process",
  };
  return order
    .map((kind) => {
      const count = items.filter((item) => item.kind === kind).length;
      return count
        ? `${count} ${count === 1 ? singular[kind] : plural[kind]}`
        : null;
    })
    .filter(Boolean)
    .join(" · ");
}

/**
 * The workspace summary's "Running" band: what this session still has
 * running on the host (Portals, setup, containers, background processes),
 * with memory where the server could read it, and "Stop everything" once
 * the session is idle. Renders nothing while nothing runs.
 */
export function SessionResourcesSection({
  sessionId,
  running,
  archived,
  groupClass,
  refreshTick,
}: {
  sessionId: string;
  running: boolean;
  archived?: boolean;
  groupClass: string;
  refreshTick?: number;
}) {
  const resource = useSessionResourcesResource(sessionId, {
    refreshInterval: RESOURCES_REFRESH_MS,
    revision: `${running ? 1 : 0}\0${archived ? 1 : 0}\0${refreshTick ?? 0}`,
  });
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const items = resource.data?.items ?? [];
  if (!items.length) return null;
  const memory = resource.data?.memoryBytes;
  const visible = items.slice(0, VISIBLE_ROWS);
  const hidden = items.length - visible.length;

  async function stopEverything() {
    setStopping(true);
    setError(null);
    const failure = await stopSessionResources(sessionId).then(
      () => null,
      (cause: unknown) =>
        errorMessage(cause, "Couldn't stop the session's work"),
    );
    if (failure) setError(failure);
    await resource.mutate();
    setStopping(false);
  }

  return (
    <div className={groupClass}>
      <div className={cn(WS_SUMMARY_SECTION, "gap-1.5")}>
        <span>Running</span>
        <span className={cn(WS_SUMMARY_COUNT, "text-faint")}>
          {items.length}
        </span>
        {memory !== undefined && (
          <span className="ml-auto text-meta tabular-nums text-faint">
            {formatBytes(memory)}
          </span>
        )}
      </div>
      {visible.map((item) => {
        const Icon = KIND_ICON[item.kind];
        return (
          <div
            key={item.id}
            className={cn(
              WS_SUMMARY_ROW,
              "cursor-default hover:bg-transparent",
            )}
            title={`${KIND_NAME[item.kind]}${item.runtime ? ` (${item.runtime})` : ""} · ${item.label}`}
          >
            <span className={WS_SUMMARY_RAIL}>
              <Icon size={20} className={WS_SUMMARY_ICON} />
            </span>
            <span className={WS_SUMMARY_LABEL}>{item.label}</span>
            {item.memoryBytes !== undefined && (
              <span className={cn(WS_SUMMARY_STATE, "tabular-nums text-faint")}>
                {formatBytes(item.memoryBytes)}
              </span>
            )}
          </div>
        );
      })}
      {hidden > 0 && (
        <div
          className={cn(
            WS_SUMMARY_ROW,
            "cursor-default text-faint hover:bg-transparent",
          )}
          title={sessionResourceSummary(items)}
        >
          <span className={WS_SUMMARY_RAIL} />
          <span className={WS_SUMMARY_LABEL}>+{hidden} more</span>
        </div>
      )}
      <div className="mx-2 flex min-w-0 items-center justify-between gap-2 px-2 py-1">
        <span className="min-w-0 truncate text-meta text-faint">
          {running
            ? "Stops are available once the run ends"
            : sessionResourceSummary(items)}
        </span>
        <button
          type="button"
          className={cn(
            WS_SUMMARY_ACTION,
            "focus-ring shrink-0 cursor-pointer rounded-row border-none bg-transparent px-2 hover:bg-hover hover:text-red disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-inherit",
          )}
          onClick={() => void stopEverything()}
          disabled={running || stopping}
          title={
            running
              ? "The session is running. Stop the run first."
              : "Stop the Portals, setup, containers and background processes this session started"
          }
        >
          {stopping ? "Stopping…" : "Stop everything"}
        </button>
      </div>
      {error && (
        <div className="px-4 py-1 text-meta font-medium text-red" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
