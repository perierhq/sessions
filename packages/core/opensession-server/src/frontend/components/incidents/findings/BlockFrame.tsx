import { type ReactNode, useId } from "react";
import {
  BLOCK_TITLES,
  type FindingItem,
  type RoundMark,
  roundMarkCopy,
} from "../../../lib/incidents/findings";
import {
  FINDINGS_BLOCK,
  FINDINGS_BLOCK_TITLE,
  FINDINGS_BYLINE,
  FINDINGS_HIGHLIGHT,
  FINDINGS_ROUND_MARK,
} from "../../../lib/incident-classes";
import { FINDINGS_COPY } from "../../../../shared/findings";
import { Button } from "../../../ui/button";
import { cn } from "../../../ui/cn";

/**
 * One block of the Findings section: a section named by its heading, who
 * put it there and when when that differs from the section's byline, and a "Show source" link when the block's data
 * has somewhere to open, described by the block's heading so each one
 * says which block it opens. The link only opens; nothing in a block acts.
 * `highlight` tints the block for a moment after its content changed;
 * `mark` says it is new or changed in this round.
 */
export function BlockFrame({
  item,
  highlight,
  mark = null,
  round = 1,
  onOpenSource,
  children,
}: {
  item: FindingItem;
  highlight: boolean;
  /** New or changed against the round before. */
  mark?: RoundMark | null;
  round?: number;
  onOpenSource: (() => void) | null;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      data-highlight={highlight || undefined}
      className={cn(FINDINGS_BLOCK, highlight && FINDINGS_HIGHLIGHT)}
    >
      <header className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 id={headingId} className={FINDINGS_BLOCK_TITLE}>
            {item.block.title ?? BLOCK_TITLES[item.block.kind]}
          </h3>
          {mark ? (
            <p className={FINDINGS_ROUND_MARK}>{roundMarkCopy(mark, round)}</p>
          ) : null}
          {item.ownByline ? (
            <p className={FINDINGS_BYLINE}>{item.byline}</p>
          ) : null}
        </div>
        {onOpenSource ? (
          <Button
            variant="ghost"
            size="sm"
            className="-mr-2 shrink-0 phone:min-h-11"
            aria-describedby={headingId}
            onClick={onOpenSource}
          >
            {FINDINGS_COPY.showSource}
          </Button>
        ) : null}
      </header>
      {children}
    </section>
  );
}
