import { FINDINGS_COPY } from "../../../../shared/findings";
import type { Incident, StripLane } from "../../../../shared/incidents";
import {
  type FindingSource,
  findingsPage,
  roundChanges,
} from "../../../lib/incidents/findings";
import type { StripLaneMeta } from "../../../lib/incidents/strip-layout";
import { DetailSheet } from "../DetailSheet";
import { FindingsGrid } from "./FindingsGrid";

const NO_HIGHLIGHT: ReadonlySet<string> = new Set();

/**
 * An earlier round's findings in a wide sheet, laid out as the page lays
 * them out (two columns on a desktop), with that round's own marks
 * against the round before it. Opened from the Findings section's head
 * and from History.
 */
export function RoundSheet({
  incident,
  round,
  onClose,
  meta,
  signalName,
  onOpenSource,
}: {
  incident: Incident;
  /** The round shown; null keeps the sheet closed. */
  round: number | null;
  onClose: () => void;
  meta: (lane: StripLane) => StripLaneMeta;
  signalName: (id: string) => string;
  onOpenSource: (target: FindingSource) => void;
}) {
  const page = round === null ? null : findingsPage(incident, { round });
  const marks =
    round === null ? undefined : roundChanges(incident, { round })?.marks;
  return (
    <DetailSheet
      title={round === null ? "" : FINDINGS_COPY.earlierRow(round)}
      open={round !== null}
      onClose={onClose}
      wide
    >
      {page && (
        <FindingsGrid
          page={page}
          incident={incident}
          highlighted={NO_HIGHLIGHT}
          marks={marks}
          animate={false}
          meta={meta}
          signalName={signalName}
          onOpenSource={onOpenSource}
        />
      )}
    </DetailSheet>
  );
}
