import { useEffect, useRef } from "react";
import { isOpenIncident } from "../../../shared/incidents";
import { useIncidents, useSignals } from "../../hooks/useIncidents";
import { incidentFacts, incidentHeadline } from "../../lib/incidents/copy";
import { sidebarIncidents } from "../../lib/incidents/sidebar";
import { SIDEBAR_INCIDENTS_ALL } from "../../lib/incident-classes";
import {
  SIDEBAR_AUTO_COG,
  SIDEBAR_BAND_CHEVRON,
  SIDEBAR_BAND_CHEVRON_COLLAPSED,
  SIDEBAR_BAND_LABEL,
  SIDEBAR_BAND_TOGGLE,
  SIDEBAR_BAND_TOGGLE_INSET,
  SIDEBAR_GROUP_COUNT,
  SIDEBAR_INDEPENDENT_SCROLL,
  SIDEBAR_INDEPENDENT_SECTION,
} from "../../lib/sidebar-classes";
import { cn } from "../../ui/cn";
import { IconChevronDown, IconChevronRight } from "../icons";
import { IncidentRow } from "./IncidentRow";

/**
 * The sidebar's Incidents band (spec 4.4), first under the tools: open
 * incidents by urgency, then those fixed in the last twelve hours. It hides
 * when there is nothing to list, and never shows a load error: the sidebar
 * is not the place to report that the incident list failed.
 */
export function IncidentsBand({
  open,
  onToggleBand,
  activeId,
  onOpenIncident,
  onOpenAll,
}: {
  open: boolean;
  onToggleBand: () => void;
  activeId?: string | null;
  onOpenIncident: (id: string) => void;
  onOpenAll: () => void;
}) {
  const list = useIncidents({ status: "all" });
  const signals = useSignals().data ?? [];
  const warned = useRef(false);
  const error = list.error;
  useEffect(() => {
    if (!error || warned.current) return;
    warned.current = true;
    console.warn("Incidents band: the incident list failed to load", error);
  }, [error]);

  const now = Date.now();
  const incidents = sidebarIncidents(list.data ?? [], now);
  if (error || incidents.length === 0) return null;
  const openCount = incidents.filter(isOpenIncident).length;

  return (
    <div className={cn(SIDEBAR_INDEPENDENT_SECTION, "mt-2")}>
      <div className={cn(SIDEBAR_BAND_LABEL, "py-0 pl-0 pr-2 desktop:pr-0")}>
        <button
          type="button"
          className={cn(SIDEBAR_BAND_TOGGLE, SIDEBAR_BAND_TOGGLE_INSET)}
          onClick={onToggleBand}
          aria-expanded={open}
          title={open ? "Collapse incidents" : "Expand incidents"}
        >
          <span className="min-w-0 truncate">Incidents</span>
          {openCount > 0 && (
            <span className={SIDEBAR_GROUP_COUNT}>{openCount}</span>
          )}
          <IconChevronDown
            className={cn(
              SIDEBAR_BAND_CHEVRON,
              "group-hover/band:visible group-hover/band:text-dim",
              !open && SIDEBAR_BAND_CHEVRON_COLLAPSED,
            )}
            size={18}
            style={{ transform: open ? "none" : "rotate(-90deg)" }}
          />
          {/* A span, not a button: it sits inside the heading's button, as
              the Automations settings glyph does, and takes the row's full
              height as its target. */}
          <span
            role="button"
            tabIndex={0}
            className={cn(SIDEBAR_AUTO_COG, SIDEBAR_INCIDENTS_ALL)}
            title="All incidents"
            aria-label="All incidents"
            onClick={(event) => {
              event.stopPropagation();
              onOpenAll();
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              event.stopPropagation();
              onOpenAll();
            }}
          >
            <IconChevronRight size={20} />
          </span>
        </button>
      </div>
      {open && (
        <div className={SIDEBAR_INDEPENDENT_SCROLL}>
          {incidents.map((incident) => {
            const primary = signals.find(
              (s) => s.id === incident.primarySignalId,
            );
            const sources = incident.signalIds.flatMap((id) => {
              const signal = signals.find((s) => s.id === id);
              return signal ? [signal.name] : [];
            });
            return (
              <IncidentRow
                key={incident.id}
                incident={incident}
                headline={incidentHeadline({
                  title: primary?.name ?? incident.title,
                  state: incident.state,
                  primary: primary?.evaluation?.state ?? null,
                  reason: primary?.evaluation?.reason,
                })}
                facts={incidentFacts({ incident, sources, now })}
                active={incident.id === activeId}
                onOpen={() => onOpenIncident(incident.id)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
