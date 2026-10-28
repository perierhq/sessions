import { useEffect, useState } from "react";
import { fetchAudit } from "../../lib/api";
import { auditEventsSchema, type AuditEvent } from "../../lib/audit-events";
import { Input } from "../../ui/input";
import { Button } from "../../ui/button";
import { SettingCard, SettingsHeader, SettingsPanel } from "../../ui/settings";
import { EmptyState } from "../../ui/state";
import { Switch } from "../../ui/switch";
import { AuditEventList } from "./AuditEventList";
import { Select } from "./shared";

/** Read-only viewer over ~/.opensession-audit daily JSONL (agent flight recorder). */
export function AuditPanel() {
  const [dates, setDates] = useState<string[]>([]);
  const [date, setDate] = useState("");
  const [type, setType] = useState("");
  const [types, setTypes] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [all, setAll] = useState(false);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  // Debounced reload on any filter change.
  useEffect(() => {
    const t = setTimeout(() => {
      setLoading(true);
      fetchAudit({
        date: date || undefined,
        type: type || undefined,
        q: q || undefined,
        all,
      })
        .then((page) => {
          setDates(page.dates);
          if (!date && page.dates.length) {
            setDate(page.dates[0]);
            return; // effect re-runs with the date set
          }
          setEvents(auditEventsSchema.parse(page.events || []));
          setTotal(page.total || 0);
          setTypes(page.types || []);
          setExpanded(null);
          setLoading(false);
        })
        .catch(() => setLoading(false));
    }, 250);
    return () => clearTimeout(t);
  }, [date, type, q, all]);

  async function loadMore() {
    const page = await fetchAudit({
      date,
      type: type || undefined,
      q: q || undefined,
      all,
      offset: events.length,
    });
    setEvents([...events, ...auditEventsSchema.parse(page.events || [])]);
  }

  return (
    <SettingsPanel>
      <SettingsHeader
        title="Audit log"
        description="Review prompts, tool decisions, account switches, and confirmations from every agent run. Events are read-only and kept for 400 days."
      />

      <div className="mb-3 flex flex-wrap items-center gap-2 px-5">
        <Select
          className="w-auto"
          label="Date"
          value={date}
          options={dates.map((d) => ({ value: d, label: d }))}
          onChange={setDate}
        />
        <Select
          className="w-auto"
          label="Event type"
          value={type}
          options={[
            { value: "", label: all ? "All events" : "Significant events" },
            ...types.map((t) => ({ value: t, label: t })),
          ]}
          onChange={setType}
        />
        <label className="flex cursor-pointer items-center gap-2 text-label text-dim">
          <Switch checked={all} onCheckedChange={setAll} />
          Include tool firehose
        </label>
        <Input
          className="min-w-[140px] flex-1"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search (session id, tool, text…)"
          aria-label="Search audit log"
        />
      </div>

      <div className="mb-2 px-5 text-meta text-faint">
        {loading
          ? "Loading…"
          : `${events.length} of ${total} events (newest first)`}
      </div>

      <SettingCard>
        <AuditEventList
          events={events}
          expanded={expanded}
          onToggle={setExpanded}
        />
        {!loading && events.length === 0 && (
          <EmptyState placement="row">No events match.</EmptyState>
        )}
      </SettingCard>

      {events.length < total && (
        <div className="mt-2">
          <Button size="sm" onClick={loadMore}>
            Load more ({total - events.length} left)
          </Button>
        </div>
      )}
    </SettingsPanel>
  );
}
