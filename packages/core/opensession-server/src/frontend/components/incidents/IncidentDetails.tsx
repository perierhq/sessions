import { useState } from "react";
import type {
  AccessPreview,
  IncidentAgentsAccessView,
} from "../../../shared/incident-access";
import type {
  Incident,
  IncidentSummary,
  StripLane,
} from "../../../shared/incidents";
import { useSessionPrResource } from "../../hooks/useApiResources";
import { useIncidentAccess } from "../../hooks/useIncidents";
import { dayMonth, FIXED_BY_LABEL, formatUsd } from "../../lib/incidents/copy";
import {
  earlierFindingRounds,
  type FindingsSheetState,
} from "../../lib/incidents/findings";
import type { StripLaneMeta } from "../../lib/incidents/strip-layout";
import type { ProjectSectionId } from "../../lib/project-settings/page-model";
import {
  agentsWorkspaceNote,
  type DetailRow,
  type DetailRowKey,
  type DetailTarget,
  detailRows,
  ledgerEntries,
  rowWrapsOnPhone,
} from "../../lib/incidents/details";
import {
  AUDIT_SECTION_LABEL,
  DETAIL_BAND,
  DETAIL_BAND_NOTE,
  DETAIL_CHEVRON,
  DETAIL_METER,
  DETAIL_ROW,
  DETAIL_VALUE,
  DETAIL_VALUE_TEXT,
  DETAIL_VALUE_WRAP,
  INCIDENT_SECTION_LABEL,
} from "../../lib/incident-classes";
import {
  WS_SUMMARY_ICON,
  WS_SUMMARY_LABEL,
  WS_SUMMARY_PAGE_ROW,
  WS_SUMMARY_RAIL,
  WS_SUMMARY_STATE,
} from "../../lib/workspace-summary-classes";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { MeterTrack } from "../../ui/meter";
import {
  IconChevronRight,
  IconFileText2,
  IconGauge,
  IconHistory,
  IconPerson,
  IconPullRequest,
  IconShieldCheck,
} from "../icons";
import { RunLedger } from "../RunLedger";
import { LineStats } from "../TurnFooter";
import { PlainButton } from "../../ui/plain-button";
import { DetailSheet } from "./DetailSheet";
import { FindingsSheets } from "./findings/FindingsSheets";

const BANDS = ["Fix", "Agents", "History"] as const;

const GLYPH: Record<
  Exclude<DetailRowKey, `findings-${number}`>,
  typeof IconPerson
> = {
  change: IconPullRequest,
  note: IconFileText2,
  investigator: IconPerson,
  verifier: IconPerson,
  cost: IconGauge,
  access: IconShieldCheck,
  earlier: IconHistory,
};

const TONE_TEXT: Record<NonNullable<DetailRow["tone"]>, string> = {
  green: "text-green",
  yellow: "text-yellow",
  red: "text-red",
  faint: "text-faint",
};

function RowValue({ row }: { row: DetailRow }) {
  const tone = row.tone ? TONE_TEXT[row.tone] : undefined;
  const rest =
    row.emphasis && row.value.startsWith(row.emphasis)
      ? row.value.slice(row.emphasis.length)
      : null;
  return (
    <span
      className={cn(DETAIL_VALUE, rowWrapsOnPhone(row) && DETAIL_VALUE_WRAP)}
    >
      {row.lines && (
        <LineStats
          additions={row.lines.additions}
          deletions={row.lines.deletions}
          className="text-meta"
        />
      )}
      {row.value &&
        (rest !== null ? (
          <span className={DETAIL_VALUE_TEXT}>
            <span className={cn(WS_SUMMARY_STATE, tone)}>{row.emphasis}</span>
            {rest}
          </span>
        ) : (
          <span className={cn(DETAIL_VALUE_TEXT, tone)}>{row.value}</span>
        ))}
      {row.meter && (
        <>
          <MeterTrack pct={row.meter.pct} className={DETAIL_METER} />
          <span className="shrink-0 text-faint">{row.meter.of}</span>
        </>
      )}
    </span>
  );
}

const isFindingsRow = (key: DetailRowKey): key is `findings-${number}` =>
  key.startsWith("findings-");

/** An earlier round's findings are history, like earlier incidents. */
const glyphOf = (key: DetailRowKey) =>
  isFindingsRow(key) ? IconHistory : GLYPH[key];

function RowBody({ row }: { row: DetailRow }) {
  const Glyph = glyphOf(row.key);
  return (
    <>
      <span className={WS_SUMMARY_RAIL}>
        <Glyph size={20} className={WS_SUMMARY_ICON} />
      </span>
      <span className={WS_SUMMARY_LABEL}>{row.label}</span>
      <RowValue row={row} />
      {row.target && (
        <IconChevronRight size={16} dense className={DETAIL_CHEVRON} />
      )}
    </>
  );
}

function Row({
  row,
  onRow,
}: {
  row: DetailRow;
  onRow: (row: DetailRow) => void;
}) {
  const className = cn(WS_SUMMARY_PAGE_ROW, DETAIL_ROW);
  if (row.target?.kind === "url")
    return (
      <a
        className={className}
        href={row.target.url}
        target="_blank"
        rel="noreferrer"
      >
        <RowBody row={row} />
      </a>
    );
  if (row.target)
    return (
      <PlainButton className={className} onClick={() => onRow(row)}>
        <RowBody row={row} />
      </PlainButton>
    );
  return (
    <div className={cn(className, "cursor-default hover:bg-transparent")}>
      <RowBody row={row} />
    </div>
  );
}

/**
 * The summary rows under the cause, in the workspace-summary grammar:
 * bands Fix, Agents and History, a glyph, a label, the value at the right,
 * and a chevron on rows that open something. Presentational.
 */
export function IncidentDetailsView({
  rows,
  onRow,
  workspaceNote,
}: {
  rows: DetailRow[];
  onRow: (row: DetailRow) => void;
  workspaceNote: string | null;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {BANDS.map((band) => {
        const inBand = rows.filter((row) => row.band === band);
        if (!inBand.length) return null;
        return (
          <section key={band} className={DETAIL_BAND}>
            <h2 className={INCIDENT_SECTION_LABEL}>{band}</h2>
            {band === "Agents" && workspaceNote && (
              <p className={DETAIL_BAND_NOTE}>{workspaceNote}</p>
            )}
            <ul className="m-0 flex list-none flex-col p-0">
              {inBand.map((row) => (
                <li key={row.key} className="min-w-0">
                  <Row row={row} onRow={onRow} />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function CostSheetBody({
  incident,
  budgetUsd,
  onOpenSession,
}: {
  incident: Incident;
  budgetUsd: number | null;
  onOpenSession: (sessionId: string) => void;
}) {
  const response = incident.response;
  if (!response)
    return <p className="m-0 text-body text-faint">No agents yet</p>;
  const spent = formatUsd(response.costUsd);
  const budget = budgetUsd !== null && budgetUsd > 0 ? budgetUsd : null;
  const entries = ledgerEntries(response, Date.now());
  return (
    <>
      <div className="flex flex-col gap-1.5">
        {budget !== null && (
          <MeterTrack pct={(response.costUsd / budget) * 100} />
        )}
        <p className="m-0 text-label text-dim tabular-nums">
          {budget !== null
            ? `${spent} of ${formatUsd(budget, { whole: true })} per incident`
            : spent}
        </p>
      </div>
      {entries.length > 0 && (
        <RunLedger entries={entries} onOpenSession={onOpenSession} />
      )}
    </>
  );
}

const ACCESS_ROLES = [
  ["investigator", "Investigator"],
  ["verifier", "Verifier"],
] as const;

function AccessRole({
  label,
  preview,
}: {
  label: string;
  preview: AccessPreview;
}) {
  const tools = preview.tools.length;
  return (
    <section className="flex min-w-0 flex-col gap-1">
      <h3 className={AUDIT_SECTION_LABEL}>{label}</h3>
      {preview.access ? (
        <p className="m-0 text-body text-fg [overflow-wrap:anywhere]">
          {preview.access.summary}
        </p>
      ) : (
        <p className="m-0 text-body text-red [overflow-wrap:anywhere]">
          {preview.error ?? "No access"}
        </p>
      )}
      <p className="m-0 text-meta text-dim tabular-nums">
        {tools === 1 ? "1 tool" : `${tools} tools`}
      </p>
      {preview.warnings.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {preview.warnings.map((warning) => (
            <li
              key={warning}
              className="text-meta text-yellow [overflow-wrap:anywhere]"
            >
              {warning}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AccessSheetBody({
  access,
  onEdit,
}: {
  access: IncidentAgentsAccessView;
  onEdit: () => void;
}) {
  return (
    <>
      {ACCESS_ROLES.map(([role, label]) => (
        <AccessRole key={role} label={label} preview={access[role]} />
      ))}
      <div>
        <Button variant="soft" size="lg" className="min-h-11" onClick={onEdit}>
          Edit in settings
        </Button>
      </div>
    </>
  );
}

function EarlierSheetBody({
  earlier,
  onOpen,
}: {
  earlier: IncidentSummary[];
  onOpen: (id: string) => void;
}) {
  return (
    <ul className="-mx-2 m-0 flex list-none flex-col p-0">
      {earlier.map((other) => (
        <li key={other.id} className="min-w-0">
          <PlainButton
            className={cn(WS_SUMMARY_PAGE_ROW, DETAIL_ROW)}
            onClick={() => onOpen(other.id)}
          >
            <span className={WS_SUMMARY_RAIL}>
              <IconHistory size={20} className={WS_SUMMARY_ICON} />
            </span>
            <span className={WS_SUMMARY_LABEL}>{other.title}</span>
            <span className="shrink-0 text-meta text-dim tabular-nums">
              {[
                other.fixedBy ? FIXED_BY_LABEL[other.fixedBy] : null,
                dayMonth(other.openedAt),
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
            <IconChevronRight size={16} dense className={DETAIL_CHEVRON} />
          </PlainButton>
        </li>
      ))}
    </ul>
  );
}

type Sheet = "cost" | "access" | "earlier";
type PrTarget = Extract<DetailTarget, { kind: "pr" }>;

/**
 * The summary rows with their data: the investigator's PR, the agents'
 * access, and the sheets the rows open (Agent cost, Access, Earlier
 * incidents, an earlier round's findings). Agent rows open the agent's own
 * session.
 */
export function IncidentDetails({
  incident,
  earlier,
  budgetUsd,
  onOpenSession,
  onOpenPr,
  onOpenIncident,
  onOpenSettings,
  meta,
  signalName,
}: {
  incident: Incident;
  earlier: IncidentSummary[];
  budgetUsd: number | null;
  onOpenSession: (sessionId: string) => void;
  onOpenPr: (target: PrTarget) => void;
  onOpenIncident: (id: string) => void;
  onOpenSettings: (project: string, section?: ProjectSectionId) => void;
  /** For signal blocks in an earlier round's findings. */
  meta: (lane: StripLane) => StripLaneMeta;
  signalName: (id: string) => string;
}) {
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [shown, setShown] = useState<Sheet>("cost");
  const [findings, setFindings] = useState<FindingsSheetState | null>(null);
  const prSession = incident.response?.agents.findLast(
    (run) => run.role === "investigator" && run.prUrl,
  )?.sessionId;
  const pr = useSessionPrResource(prSession ?? "", undefined, undefined, {
    enabled: !!prSession,
  });
  const access = useIncidentAccess(incident.id).data ?? null;
  const rows = detailRows({
    incident,
    earlier,
    pr: (prSession && pr.data) || null,
    budgetUsd,
    access,
    now: Date.now(),
    findingRounds: earlierFindingRounds(incident),
  });

  const onRow = (row: DetailRow) => {
    const target = row.target;
    if (!target) return;
    if (target.kind === "pr") onOpenPr(target);
    else if (target.kind === "session") onOpenSession(target.sessionId);
    else if (target.kind === "sheet") {
      if (target.sheet === "findings")
        setFindings({ kind: "round", round: target.round });
      else {
        setShown(target.sheet);
        setSheet(target.sheet);
      }
    }
  };
  const close = () => setSheet(null);
  const titles: Record<Sheet, string> = {
    cost: "Agent cost",
    access: "Access",
    earlier: "Earlier incidents",
  };

  return (
    <>
      <IncidentDetailsView
        rows={rows}
        onRow={onRow}
        workspaceNote={agentsWorkspaceNote(incident.response)}
      />
      <DetailSheet title={titles[shown]} open={sheet !== null} onClose={close}>
        {shown === "cost" ? (
          <CostSheetBody
            incident={incident}
            budgetUsd={budgetUsd}
            onOpenSession={(id) => {
              close();
              onOpenSession(id);
            }}
          />
        ) : shown === "access" ? (
          access && (
            <AccessSheetBody
              access={access}
              onEdit={() => {
                close();
                onOpenSettings(incident.project, "access");
              }}
            />
          )
        ) : (
          <EarlierSheetBody
            earlier={earlier}
            onOpen={(id) => {
              close();
              onOpenIncident(id);
            }}
          />
        )}
      </DetailSheet>
      <FindingsSheets
        incident={incident}
        sheet={findings}
        onSheet={setFindings}
        meta={meta}
        signalName={signalName}
        onOpenSession={onOpenSession}
        onOpenPr={onOpenPr}
      />
    </>
  );
}
