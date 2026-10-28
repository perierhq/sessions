import { useReducedMotion } from "motion/react";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { FINDINGS_COPY } from "../../../shared/findings";
import type { Incident, StripLane } from "../../../shared/incidents";
import type { IncidentCauseView } from "../../lib/incidents/cause";
import type { DetailTarget } from "../../lib/incidents/details";
import {
  asksInNext,
  changedKeys,
  FINDINGS_HIGHLIGHT_MS,
  FINDINGS_SECTION_ID,
  type FindingItem,
  type FindingSource,
  type FindingsSheetState,
  findingsPage,
  openFindingSource,
  roundChanges,
  roundChangesCopy,
} from "../../lib/incidents/findings";
import type { StripLaneMeta } from "../../lib/incidents/strip-layout";
import {
  FINDINGS_SECTION_BYLINE,
  FINDINGS_ROUND_LINK,
  FINDINGS_ROUNDS,
  FINDINGS_SECTION_HEAD,
  FINDINGS_UNDER_WAY,
  INCIDENT_SECTION_LABEL,
} from "../../lib/incident-classes";
import { PlainButton } from "../../ui/plain-button";
import { FindingsGrid } from "./findings/FindingsGrid";
import { FindingsSheets } from "./findings/FindingsSheets";
import { IncidentCause } from "./IncidentCause";

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
 * round's blocks under who they are from, with a quiet "Round 2 under
 * way" while a newer round has not shown anything yet. In a later round
 * the head says what changed since the round before, each changed block
 * says so, and the earlier rounds open from here. With no findings, the
 * Cause view exactly as it was. Blocks only open things: a session, a PR,
 * the agents' cost, an earlier round.
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
  const [sheet, setSheet] = useState<FindingsSheetState | null>(null);
  const headingId = useId();

  if (!page) return <IncidentCause cause={cause} waiting={waiting} />;

  const changes = roundChanges(incident);
  const openSource = (target: FindingSource) =>
    openFindingSource(target, {
      sheet: setSheet,
      session: onOpenSession,
      pr: onOpenPr,
      url: (url) => window.open(url, "_blank", "noopener,noreferrer"),
    });

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
        {changes || page.earlierRounds.length > 0 ? (
          <div className={FINDINGS_ROUNDS}>
            {changes ? (
              <p className="m-0">{roundChangesCopy(changes)}</p>
            ) : null}
            {page.earlierRounds.map((round) => (
              <PlainButton
                key={round}
                className={FINDINGS_ROUND_LINK}
                onClick={() => setSheet({ kind: "round", round })}
              >
                {FINDINGS_COPY.earlierRow(round)}
              </PlainButton>
            ))}
          </div>
        ) : null}
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
        marks={changes?.marks}
        animate={!reduceMotion}
        meta={meta}
        signalName={signalName}
        onOpenSource={openSource}
      />
      <FindingsSheets
        incident={incident}
        sheet={sheet}
        onSheet={setSheet}
        meta={meta}
        signalName={signalName}
        onOpenSession={onOpenSession}
        onOpenPr={onOpenPr}
      />
    </section>
  );
}
