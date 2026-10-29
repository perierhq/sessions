import { useEffect, useState } from "react";
import { fetchAudit, type KeychainCredentialDto } from "../../lib/api";
import { auditEventsSchema, type AuditEvent } from "../../lib/audit-events";
import { errorMessage } from "../../lib/error-message";
import { FIELD_HINT } from "../../lib/incident-settings-classes";
import { credentialName } from "../../lib/keychain-credential";
import { EmptyState, InlineAlert, ListSkeleton } from "../../ui/state";
import { AuditEventList } from "./AuditEventList";
import { SettingsDialog } from "./incidents/SettingsDialog";
import { Select } from "./shared";

/**
 * One credential's history: the audit log's rows (Settings → Audit log),
 * filtered to the lines that name it, one day at a time. Calls with their
 * status, refusals with their reason, tests, grants and edits.
 */
export function CredentialHistoryDialog({
  credential,
  onClose,
}: {
  credential: KeychainCredentialDto;
  onClose: () => void;
}) {
  // The day it was last used, when there is one: that is where its
  // history most likely is.
  const [date, setDate] = useState(credential.lastUsed?.at.slice(0, 10) ?? "");
  const [dates, setDates] = useState<string[]>([]);
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    setEvents(null);
    setError(null);
    fetchAudit({ date: date || undefined, q: credential.id, limit: 200 })
      .then((page) => {
        if (!live) return;
        setDates(page.dates);
        if (!date) {
          if (page.dates.length) setDate(page.dates[0]!);
          else setEvents([]);
          return;
        }
        setEvents(auditEventsSchema.parse(page.events || []));
        setTotal(page.total || 0);
        setExpanded(null);
      })
      .catch((e) => {
        if (live) setError(errorMessage(e, "Couldn't load the history"));
      });
    return () => {
      live = false;
    };
  }, [date, credential.id]);

  const days = dates.includes(date) || !date ? dates : [date, ...dates];

  return (
    <SettingsDialog
      open
      wide
      onClose={onClose}
      title={`${credentialName(credential)} history`}
    >
      <p className={FIELD_HINT}>
        Calls with their status, refusals with their reason, tests, grants and
        edits, from the audit log
      </p>
      {days.length > 0 && (
        <Select
          className="self-start phone:min-h-11"
          label="Day"
          value={date}
          options={days.map((d) => ({ value: d, label: d }))}
          onChange={setDate}
        />
      )}
      {error ? (
        <InlineAlert>{error}</InlineAlert>
      ) : events === null ? (
        <ListSkeleton rows={4} variant="rows" label="Loading history" />
      ) : events.length === 0 ? (
        <EmptyState placement="row">
          Nothing for {credentialName(credential)} on this day
        </EmptyState>
      ) : (
        <div className="-mx-5 flex flex-col phone:-mx-4">
          <AuditEventList
            events={events}
            expanded={expanded}
            onToggle={setExpanded}
          />
          {total > events.length && (
            <p className={`${FIELD_HINT} px-5 pt-2 phone:px-4`}>
              The latest {events.length} of {total}. The Audit log has the rest
            </p>
          )}
        </div>
      )}
    </SettingsDialog>
  );
}
