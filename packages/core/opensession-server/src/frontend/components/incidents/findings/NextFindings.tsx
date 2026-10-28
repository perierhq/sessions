import type { NextFindings } from "../../../lib/incidents/findings";
import { NEXT_FINDINGS_COPY } from "../../../lib/incidents/findings";
import {
  FINDINGS_LABEL,
  NEXT_FINDINGS,
  NEXT_FINDINGS_PART,
} from "../../../lib/incident-classes";
import { Prose } from "./TextBlocks";

/**
 * The findings the owner needs while deciding, inside the Next card: the
 * agents' open questions, which is where they ask the owner for
 * something. Text only; the card's own buttons stay the only actions.
 */
export function NextFindingsView({ findings }: { findings: NextFindings }) {
  if (findings.asks.length === 0) return null;
  return (
    <div className={NEXT_FINDINGS}>
      {findings.asks.map((ask) => (
        <section
          key={ask.key}
          aria-label={NEXT_FINDINGS_COPY.ask}
          className={NEXT_FINDINGS_PART}
        >
          <p className={FINDINGS_LABEL}>{NEXT_FINDINGS_COPY.ask}</p>
          <Prose text={ask.text} />
          {ask.wouldAnswer.trim() ? (
            <Prose
              text={`${NEXT_FINDINGS_COPY.wouldAnswer}: ${ask.wouldAnswer}`}
              quiet
            />
          ) : null}
        </section>
      ))}
    </div>
  );
}
