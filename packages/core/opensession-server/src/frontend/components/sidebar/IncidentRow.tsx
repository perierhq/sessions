import type { IncidentSummary } from "../../../shared/incidents";
import { incidentStateWord } from "../../lib/incidents/tone";
import {
  SIDEBAR_INCIDENT_ROW,
  SIDEBAR_INCIDENT_STATE,
} from "../../lib/incident-classes";
import {
  SIDEBAR_HOVER_LAYER,
  SIDEBAR_RAIL,
  SIDEBAR_REPO_TILE,
} from "../../lib/sidebar-classes";
import { shortTime } from "../../lib/time";
import { cn } from "../../ui/cn";
import { Popover } from "../../ui/popover";
import { RepoTile } from "../RepoTile";
import { CardFooter, RowCardPopup, useRowHoverCard } from "../SidebarRowCards";
import { SIDEBAR_ROW, SIDEBAR_ROW_TITLE } from "./SidebarItem";

/**
 * One incident in the sidebar band, built like the automation report row:
 * the project's tile, the title, and the state in words at the end ("needs
 * you", "deploys 12:37", "fixed"), never colour alone. A pointer that rests
 * on it gets the headline and the facts.
 */
export function IncidentRow({
  incident,
  headline,
  facts,
  active,
  onOpen,
}: {
  incident: IncidentSummary;
  headline: string;
  facts: string[];
  active: boolean;
  onOpen: () => void;
}) {
  const card = useRowHoverCard();
  const word = incidentStateWord(incident);
  const at = incident.closedAt ?? incident.updatedAt;
  return (
    <Popover.Root {...card.rootProps}>
      <Popover.Trigger
        {...card.triggerProps}
        render={
          <button
            type="button"
            className={cn(
              SIDEBAR_ROW,
              SIDEBAR_INCIDENT_ROW,
              SIDEBAR_HOVER_LAYER,
              active && "bg-selected",
            )}
            data-sidebar-row=""
            data-selected={active || undefined}
            aria-current={active ? "page" : undefined}
            onClick={onOpen}
            aria-label={`Incident: ${incident.title}, ${word.text}`}
          />
        }
      >
        <span className={SIDEBAR_RAIL}>
          <RepoTile name={incident.project} className={SIDEBAR_REPO_TILE} />
        </span>
        <span className={SIDEBAR_ROW_TITLE}>{incident.title}</span>
        <span
          className={cn(
            SIDEBAR_INCIDENT_STATE,
            word.tone === "info" ? "text-blue" : "text-faint",
          )}
        >
          {word.text}
        </span>
      </Popover.Trigger>
      <RowCardPopup>
        <div className="text-sm font-medium text-fg">{headline}</div>
        {facts.length > 0 && (
          <p className="mt-1.5 text-xs leading-[1.5] text-dim">
            {facts.join(" · ")}
          </p>
        )}
        <CardFooter
          time={shortTime(at)}
          timeTitle={new Date(at).toLocaleString()}
        />
      </RowCardPopup>
    </Popover.Root>
  );
}
