import { relativeTime } from "../lib/api/request";
import { BASE_PATH } from "../lib/base";
import { cn } from "../ui/cn";
import { AgentName } from "./AgentIdentity";

const LINK = "cursor-pointer text-link no-underline hover:underline";

/** One line of a run ledger. `meta` reads after the time, in order. */
export interface RunLedgerEntry {
  key: string;
  status: "running" | "ok" | "error";
  at: string;
  meta: string[];
  error?: string;
  sessionId?: string;
  /** Offered once the run has finished. */
  action?: { label: string; title: string; onClick: () => void };
}

/** A run history, newest first: status mark, when, what, the agent's
 *  session, and an optional action on a finished run. */
export function RunLedger({
  entries,
  onOpenSession,
}: {
  entries: RunLedgerEntry[];
  onOpenSession: (sessionId: string) => void;
}) {
  return (
    <div className="mt-2.5 border-t border-line pt-2 flex flex-col gap-1">
      {entries.map((entry) => (
        <div
          key={entry.key}
          className="flex items-baseline gap-2 text-label text-dim min-w-0 phone:flex-wrap"
        >
          {entry.status === "running" ? (
            <span className="text-yellow shrink-0">●</span>
          ) : entry.status === "ok" ? (
            <span className="text-green shrink-0">✓</span>
          ) : (
            <span className="text-red shrink-0" title={entry.error}>
              ✗
            </span>
          )}
          <span
            className="shrink-0"
            title={new Date(entry.at).toLocaleString()}
          >
            {relativeTime(entry.at)}
          </span>
          {entry.meta.map((item, i) => (
            <span key={i} className="text-faint shrink-0">
              {item}
            </span>
          ))}
          {entry.error && (
            <span className="text-red truncate" title={entry.error}>
              {entry.error}
            </span>
          )}
          {entry.sessionId && (
            <a
              className={cn(
                LINK,
                "ml-auto max-w-full truncate phone:inline-flex phone:min-h-11 phone:items-center",
              )}
              href={`${BASE_PATH}/session/${entry.sessionId}`}
              onClick={(e) => {
                e.preventDefault();
                onOpenSession(entry.sessionId!);
              }}
            >
              <AgentName sessionId={entry.sessionId} />
            </a>
          )}
          {entry.status !== "running" && entry.action && (
            <button
              className={cn(LINK, "shrink-0 text-label")}
              title={entry.action.title}
              onClick={entry.action.onClick}
            >
              {entry.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
