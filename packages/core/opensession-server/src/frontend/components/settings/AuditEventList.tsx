import { BASE_PATH } from "../../lib/base";
import {
  auditSessionId,
  auditSummary,
  type AuditEvent,
} from "../../lib/audit-events";
import { AgentName } from "../AgentIdentity";

/**
 * Audit events as rows: time, type, a one-line summary and the session's
 * agent, each row opening to the raw event. Settings → Audit log shows a
 * day of everything; a credential's history shows the same rows filtered.
 */
export function AuditEventList({
  events,
  expanded,
  onToggle,
}: {
  events: AuditEvent[];
  expanded: number | null;
  onToggle: (index: number | null) => void;
}) {
  return (
    <>
      {events.map((e, i) => {
        const time = String(e.time || "").slice(11, 19);
        const t = String(e.kind || e.msg || "event");
        const sid = auditSessionId(e);
        return (
          <div key={i} className={expanded === i ? "bg-pressed" : ""}>
            <button
              className="flex w-full min-w-0 cursor-pointer items-baseline gap-2 px-5 py-1.5 text-left text-label hover:bg-hover phone:min-h-11 phone:items-center"
              onClick={() => onToggle(expanded === i ? null : i)}
            >
              <span className="text-faint shrink-0">{time}</span>
              <span className="text-fg font-medium shrink-0">{t}</span>
              {e.run_kind ? (
                <span className="text-faint shrink-0">
                  {String(e.run_kind)}
                </span>
              ) : null}
              <span className="text-dim truncate">{auditSummary(e)}</span>
              {sid && (
                <a
                  className="ml-auto min-w-0 max-w-48 shrink truncate text-meta text-faint underline phone:max-w-32"
                  href={`${BASE_PATH}/session/${sid}`}
                  onClick={(ev) => ev.stopPropagation()}
                >
                  <AgentName sessionId={sid} />
                </a>
              )}
            </button>
            {expanded === i && (
              <pre className="m-0 overflow-x-auto border-t border-line px-5 py-2.5 text-meta leading-relaxed text-dim">
                {JSON.stringify(e, null, 2)}
              </pre>
            )}
          </div>
        );
      })}
    </>
  );
}
