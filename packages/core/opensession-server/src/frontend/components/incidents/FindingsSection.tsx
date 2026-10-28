import { useReducedMotion } from "motion/react";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { FINDINGS_COPY } from "../../../shared/findings";
import type { Incident, StripLane } from "../../../shared/incidents";
import type { IncidentCauseView } from "../../lib/incidents/cause";
import { type DetailTarget, ledgerEntries } from "../../lib/incidents/details";
import {
  asksInNext,
  changedKeys,
  FINDINGS_HIGHLIGHT_MS,
  FINDINGS_SECTION_ID,
  type FindingItem,
  type FindingSource,
  findingsPage,
} from "../../lib/incidents/findings";
import type { StripLaneMeta } from "../../lib/incidents/strip-layout";
import {
  FINDINGS_SECTION_BYLINE,
  FINDINGS_SECTION_HEAD,
  FINDINGS_UNDER_WAY,
  INCIDENT_SECTION_LABEL,
} from "../../lib/incident-classes";
import { RunLedger } from "../RunLedger";
import { FindingsGrid } from "./findings/FindingsGrid";
import { IncidentCause } from "./IncidentCause";
import { DetailSheet } from "./IncidentDetails";

type PrTarget = Extract<DetailTarget, { kind: "pr" }>;

const NONE: ReadonlySet<string> = new Set();

/** What the page shows of the blocks: their keys and content, without the
 *  bylines, whose time moves on every call. */
const signatureOf = (items: readonly FindingItem[] | null) =>
  JSON.stringify(
    items?.map((item) => [item.key, item.block, item.status, item.claims]) ??
      null,
  );

/**
 * The blocks whose content just changed, for a short tint. The incident's
 * refetch on `incidents_changed` brings each update; the previous update's
 * blocks are kept to compare against. Off with reduced motion.
 */
function useChangedBlocks(
  items: readonly FindingItem[] | null,
  enabled: boolean,
): ReadonlySet<string> {
  const [highlighted, setHighlighted] = useState<ReadonlySet<string>>(NONE);
  const previous = useRef<readonly FindingItem[] | null>(null);
  const signature = signatureOf(items);
  const compare = useEffectEvent(() => {
    const changed = enabled
      ? changedKeys(previous.current, items ?? [])
      : new Set<string>();
    previous.current = items;
    if (changed.size > 0) setHighlighted(changed);
  });
  useEffect(() => compare(), [signature]);
  useEffect(() => {
    if (highlighted.size === 0) return;
    const timer = setTimeout(() => setHighlighted(NONE), FINDINGS_HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlighted]);
  return enabled ? highlighted : NONE;
}

/**
 * What the agents found, in the slot the Cause section had: the page
 * round's blocks with a quiet "Round 2 under way" while a newer round has
 * not shown anything yet. With no findings, the Cause view exactly as it
 * was. Blocks only open things: a session, a PR, the agents' cost.
 */
export function FindingsSection({
  incident,
  cause,
  waiting,
  meta,
  signalName,
  onOpenSession,
  onOpenPr,
}: {
  incident: Incident;
  cause: IncidentCauseView | null;
  waiting: boolean;
  meta: (lane: StripLane) => StripLaneMeta;
  signalName: (id: string) => string;
  onOpenSession: (id: string) => void;
  onOpenPr: (target: PrTarget) => void;
}) {
  // The open questions go with the decision in the Next card.
  const page = findingsPage(incident, { withoutAsks: asksInNext(incident) });
  const reduceMotion = useReducedMotion() ?? false;
  const highlighted = useChangedBlocks(page?.items ?? null, !reduceMotion);
  const [costOpen, setCostOpen] = useState(false);
  const headingId = useId();

  if (!page) return <IncidentCause cause={cause} waiting={waiting} />;

  const openSource = (target: FindingSource) => {
    if (target.kind === "session") onOpenSession(target.sessionId);
    else if (target.kind === "pr") onOpenPr(target);
    else if (target.kind === "ledger") setCostOpen(true);
    else if (target.kind === "url")
      window.open(target.url, "_blank", "noopener,noreferrer");
  };
  const response = incident.response;

  return (
    <section
      id={FINDINGS_SECTION_ID}
      aria-labelledby={headingId}
      className="flex min-w-0 scroll-mt-4 flex-col"
    >
      <div className={FINDINGS_SECTION_HEAD}>
        <h2 id={headingId} className={INCIDENT_SECTION_LABEL}>
          {FINDINGS_COPY.heading}
        </h2>
        <p className={FINDINGS_SECTION_BYLINE}>{page.byline}</p>
        {page.underWay !== null ? (
          <p className={FINDINGS_UNDER_WAY}>
            {FINDINGS_COPY.underWay(page.underWay)}
          </p>
        ) : null}
      </div>
      <FindingsGrid
        page={page}
        incident={incident}
        highlighted={highlighted}
        animate={!reduceMotion}
        meta={meta}
        signalName={signalName}
        onOpenSource={openSource}
      />
      {response ? (
        <DetailSheet
          title="Agent cost"
          open={costOpen}
          onClose={() => setCostOpen(false)}
        >
          <RunLedger
            entries={ledgerEntries(response, Date.now())}
            onOpenSession={(id) => {
              setCostOpen(false);
              onOpenSession(id);
            }}
          />
        </DetailSheet>
      ) : null}
    </section>
  );
}
