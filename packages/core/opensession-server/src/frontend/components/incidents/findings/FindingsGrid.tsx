import { AnimatePresence, motion } from "motion/react";
import type { Incident, StripLane } from "../../../../shared/incidents";
import {
  type FindingItem,
  type FindingSource,
  type FindingsPageView,
  itemSource,
  type RoundMark,
  sourceTarget,
} from "../../../lib/incidents/findings";
import type { StripLaneMeta } from "../../../lib/incidents/strip-layout";
import {
  FINDINGS_CELL_FULL,
  FINDINGS_CELL_HALF,
  FINDINGS_GRID,
} from "../../../lib/incident-classes";
import { cn } from "../../../ui/cn";
import { duration, ease } from "../../../ui/motion";
import { BlockFrame } from "./BlockFrame";
import { ChangeBlock, CompareBlock, SignalBlock } from "./DataBlocks";
import {
  ClaimsBlock,
  HypothesisBlock,
  LogBlock,
  QuestionBlock,
  TimelineBlock,
} from "./TextBlocks";

type Meta = (lane: StripLane) => StripLaneMeta;

/** New blocks fade and open in, removed ones fade and close. The cell
 *  clips only while it moves, so a focus ring at a block's edge shows once
 *  it has settled. */
const ENTER = { opacity: 0, height: 0, overflow: "hidden" } as const;
const SHOWN = {
  opacity: 1,
  height: "auto",
  transitionEnd: { overflow: "visible" },
} as const;
const TRANSITION = { duration: duration.base, ease };

function BlockBody({
  item,
  incident,
  round,
  meta,
  signalName,
}: {
  item: FindingItem;
  incident: Incident;
  round: number;
  meta: Meta;
  signalName: (id: string) => string;
}) {
  switch (item.block.kind) {
    case "hypothesis":
      return <HypothesisBlock item={item} />;
    case "timeline":
      return <TimelineBlock item={item} incident={incident} round={round} />;
    case "signal":
      return <SignalBlock item={item} meta={meta} signalName={signalName} />;
    case "log":
      return <LogBlock item={item} />;
    case "change":
      return <ChangeBlock item={item} incident={incident} />;
    case "claims":
      return <ClaimsBlock item={item} />;
    case "compare":
      return <CompareBlock item={item} meta={meta} signalName={signalName} />;
    case "question":
      return <QuestionBlock item={item} />;
  }
}

/**
 * A round's blocks in the agent's order: two columns on a desktop, where
 * paired half blocks share a row, one on a phone. Blocks keep their key
 * across updates, so an unchanged block never re-mounts; there is no
 * layout animation, so none moves by animation either. `columns={1}` is
 * for narrow places (the earlier-rounds sheet).
 */
export function FindingsGrid({
  page,
  incident,
  highlighted,
  marks,
  animate,
  meta,
  signalName,
  onOpenSource,
  columns = 2,
}: {
  page: FindingsPageView;
  incident: Incident;
  highlighted: ReadonlySet<string>;
  /** New and changed blocks against the round before (`roundChanges`). */
  marks?: ReadonlyMap<string, RoundMark>;
  animate: boolean;
  meta: Meta;
  signalName: (id: string) => string;
  onOpenSource: (target: FindingSource) => void;
  columns?: 1 | 2;
}) {
  const cells = page.items.map((item) => {
    const ref = itemSource(item);
    const target = ref ? sourceTarget(ref, incident) : null;
    const cell =
      columns === 1
        ? "min-w-0"
        : item.span === "half"
          ? FINDINGS_CELL_HALF
          : FINDINGS_CELL_FULL;
    const block = (
      <BlockFrame
        item={item}
        highlight={highlighted.has(item.key)}
        mark={marks?.get(item.key) ?? null}
        round={page.round}
        onOpenSource={target ? () => onOpenSource(target) : null}
      >
        <BlockBody
          item={item}
          incident={incident}
          round={page.round}
          meta={meta}
          signalName={signalName}
        />
      </BlockFrame>
    );
    return animate ? (
      <motion.div
        key={item.key}
        className={cell}
        initial={ENTER}
        animate={SHOWN}
        exit={ENTER}
        transition={TRANSITION}
      >
        {block}
      </motion.div>
    ) : (
      <div key={item.key} className={cell}>
        {block}
      </div>
    );
  });
  return (
    <div className={cn(FINDINGS_GRID, columns === 1 && "desktop:grid-cols-1")}>
      {animate ? (
        <AnimatePresence initial={false}>{cells}</AnimatePresence>
      ) : (
        cells
      )}
    </div>
  );
}
