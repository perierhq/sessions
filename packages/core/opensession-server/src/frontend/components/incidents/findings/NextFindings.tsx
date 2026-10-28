import type { NextCause, NextFindings } from "../../../lib/incidents/findings";
import {
  CONFIDENCE_WORD,
  FINDINGS_SECTION_ID,
  NEXT_FINDINGS_COPY,
} from "../../../lib/incidents/findings";
import {
  FINDINGS_LABEL,
  LIKELY_CAUSE,
  NEXT_FINDINGS,
  NEXT_FINDINGS_LINK,
  NEXT_FINDINGS_META,
  NEXT_FINDINGS_PART,
} from "../../../lib/incident-classes";
import { PlainButton } from "../../../ui/plain-button";
import { StatusMark } from "./StatusMark";
import { Prose } from "./TextBlocks";

/** Bring the Findings section into view, where the cause's evidence is. */
function seeFindings() {
  document
    .getElementById(FINDINGS_SECTION_ID)
    ?.scrollIntoView({ block: "start", behavior: "smooth" });
}

/**
 * The likely cause under the status line, above the strip and the Next
 * card, so the owner reads why before deciding, on a phone's first screen
 * too: the page's first hypothesis in one sentence, its status as a mark,
 * the agent's confidence, and a link down to the evidence.
 */
export function LikelyCause({ cause }: { cause: NextCause }) {
  return (
    <section aria-label={NEXT_FINDINGS_COPY.cause} className={LIKELY_CAUSE}>
      <p className={FINDINGS_LABEL}>{NEXT_FINDINGS_COPY.cause}</p>
      <Prose text={cause.statement} />
      <p className={NEXT_FINDINGS_META}>
        <StatusMark status={cause.status} />
        <span aria-hidden>·</span>
        <span>{CONFIDENCE_WORD[cause.confidence]}</span>
        <PlainButton className={NEXT_FINDINGS_LINK} onClick={seeFindings}>
          {NEXT_FINDINGS_COPY.seeFindings}
        </PlainButton>
      </p>
    </section>
  );
}

/**
 * The agents' open questions inside the Next card, between its sentence
 * and its buttons: a question block is where an agent asks the owner for
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
