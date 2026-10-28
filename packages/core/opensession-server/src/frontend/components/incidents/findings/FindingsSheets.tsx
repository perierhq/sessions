import type { Incident, StripLane } from "../../../../shared/incidents";
import {
  type DetailTarget,
  ledgerEntries,
} from "../../../lib/incidents/details";
import {
  type FindingSource,
  type FindingsSheetState,
  openFindingSource,
} from "../../../lib/incidents/findings";
import type { StripLaneMeta } from "../../../lib/incidents/strip-layout";
import { RunLedger } from "../../RunLedger";
import { DetailSheet } from "../DetailSheet";
import { RoundSheet } from "./RoundSheet";

type PrTarget = Extract<DetailTarget, { kind: "pr" }>;

/**
 * The sheets findings open over the incident page: an earlier round's
 * findings and the agents' cost. A block's source opens here, or leaves
 * for the session or the PR review. `sheet` is the parent's state, so the
 * section's head and its blocks open the same sheets.
 */
export function FindingsSheets({
  incident,
  sheet,
  onSheet,
  meta,
  signalName,
  onOpenSession,
  onOpenPr,
}: {
  incident: Incident;
  sheet: FindingsSheetState | null;
  onSheet: (next: FindingsSheetState | null) => void;
  meta: (lane: StripLane) => StripLaneMeta;
  signalName: (id: string) => string;
  onOpenSession: (id: string) => void;
  onOpenPr: (target: PrTarget) => void;
}) {
  const response = incident.response;
  const openSource = (target: FindingSource) =>
    openFindingSource(target, {
      sheet: onSheet,
      session: onOpenSession,
      pr: onOpenPr,
      url: (url) => window.open(url, "_blank", "noopener,noreferrer"),
    });
  const close = () => onSheet(null);
  return (
    <>
      <RoundSheet
        incident={incident}
        round={sheet?.kind === "round" ? sheet.round : null}
        onClose={close}
        meta={meta}
        signalName={signalName}
        onOpenSource={openSource}
      />
      {response ? (
        <DetailSheet
          title="Agent cost"
          open={sheet?.kind === "cost"}
          onClose={close}
        >
          <RunLedger
            entries={ledgerEntries(response, Date.now())}
            onOpenSession={(id) => {
              close();
              onOpenSession(id);
            }}
          />
        </DetailSheet>
      ) : null}
    </>
  );
}
