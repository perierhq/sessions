import { useState } from "react";
import type { IncidentSummary } from "../../../shared/incidents";
import {
  PAST_PAGE,
  pastIncidentRow,
  showMoreCount,
} from "../../lib/incidents/home";
import {
  PAST_CELL,
  PAST_HEAD,
  PAST_NUMBER,
  PAST_ROW,
  PAST_TITLE_BUTTON,
} from "../../lib/incident-classes";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { EmptyState } from "../../ui/state";
import { RepoTile } from "../RepoTile";

/**
 * Past incidents as a table: title, how it was fixed and in how long, the
 * agents' cost and the date, newest first. A phone drops the header and
 * folds Fixed by and Cost under the title. The title's button covers its
 * row, so the whole row opens the incident.
 */
export function PastIncidents({
  incidents,
  onOpen,
  now = Date.now(),
}: {
  incidents: IncidentSummary[];
  onOpen: (id: string) => void;
  now?: number;
}) {
  const [shown, setShown] = useState(PAST_PAGE);
  if (!incidents.length)
    return (
      <EmptyState
        placement="row"
        className="px-2 py-3"
        title="No incidents yet"
      />
    );
  const more = showMoreCount(incidents.length, shown);
  return (
    <div className="flex min-w-0 flex-col items-start gap-3">
      <table className="w-full table-fixed border-collapse">
        <thead>
          <tr>
            <th
              scope="col"
              className={cn(PAST_HEAD, PAST_CELL, "h-8 text-left")}
            >
              Incident
            </th>
            <th
              scope="col"
              className={cn(PAST_HEAD, PAST_CELL, "h-8 w-[38%] text-left")}
            >
              Fixed by
            </th>
            <th
              scope="col"
              className={cn(PAST_HEAD, PAST_CELL, "h-8 w-20 text-right")}
            >
              Cost
            </th>
            <th
              scope="col"
              className={cn(
                PAST_HEAD,
                PAST_CELL,
                "h-8 w-20 text-right phone:w-24",
              )}
            >
              Date
            </th>
          </tr>
        </thead>
        <tbody>
          {incidents.slice(0, shown).map((incident) => {
            const row = pastIncidentRow(incident, now);
            return (
              <tr key={incident.id} className={PAST_ROW}>
                <td className={PAST_CELL}>
                  <div className="flex min-w-0 items-center gap-3">
                    <RepoTile name={incident.project} />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <button
                        type="button"
                        className={PAST_TITLE_BUTTON}
                        onClick={() => onOpen(incident.id)}
                      >
                        {row.title}
                      </button>
                      <span className="truncate text-meta text-dim desktop:hidden">
                        {row.fixedBy} · {row.cost}
                      </span>
                    </div>
                  </div>
                </td>
                <td
                  className={cn(
                    PAST_CELL,
                    "w-[38%] truncate text-supporting text-dim phone:hidden",
                  )}
                >
                  {row.fixedBy}
                </td>
                <td
                  className={cn(
                    PAST_CELL,
                    PAST_NUMBER,
                    "w-20 text-fg phone:hidden",
                  )}
                >
                  {row.cost}
                </td>
                <td className={cn(PAST_CELL, PAST_NUMBER, "w-20 phone:w-24")}>
                  {row.date}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {more > 0 && (
        <Button
          className="ml-2"
          variant="soft"
          size="sm"
          onClick={() => setShown(shown + PAST_PAGE)}
        >
          Show {more} more
        </Button>
      )}
    </div>
  );
}
