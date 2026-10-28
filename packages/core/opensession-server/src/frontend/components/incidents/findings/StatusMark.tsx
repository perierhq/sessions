import {
  FINDINGS_COPY,
  type HypothesisStatus,
} from "../../../../shared/findings";
import { STATUS_DOT } from "../../../lib/incidents/findings";
import { DOT_BG } from "../../../lib/incidents/tone";
import { FINDINGS_STATUS_TONE } from "../../../lib/incident-classes";
import { cn } from "../../../ui/cn";

/** A hypothesis's status as a mark: the dot the Next card's eyebrow
 *  wears, then the word in the status's colour. */
export function StatusMark({ status }: { status: HypothesisStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        className={cn(
          "size-2 shrink-0 rounded-full",
          DOT_BG[STATUS_DOT[status]],
        )}
      />
      <span className={cn("font-medium", FINDINGS_STATUS_TONE[status])}>
        {FINDINGS_COPY.status[status]}
      </span>
    </span>
  );
}
