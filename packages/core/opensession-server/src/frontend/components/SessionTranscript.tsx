import React, { useLayoutEffect, useSyncExternalStore } from "react";
import { renderMarkdown } from "../lib/markdown";
import type { LiveBlockView, LiveTurnStore } from "../lib/live-turn-store";
import {
  msgBodyLive,
  msgBodyStreaming,
  msgReasoningBody,
  msgReasoningShimmer,
  msgReasoningTitle,
  msgRow,
  msgStreamingRow,
} from "../lib/msg-classes";
import { useOpenAssetPaths } from "../lib/open-asset";
import { cn } from "../ui/cn";
import { TextShimmer } from "../ui/text-shimmer";
import {
  liveReasoningHeading,
  normalizeFragmentedReasoning,
} from "../lib/reasoning-display";
import { MarkdownBody, useMarkdownRepo } from "./MarkdownBody";
import { ToolCallBlock } from "./ToolCallBlock";
import { TranscriptBlocks } from "./TranscriptBlocks";

type TranscriptBlocksProps = React.ComponentProps<typeof TranscriptBlocks>;

type SessionTranscriptProps = Omit<TranscriptBlocksProps, "sessionId"> & {
  sessionId: string;
  liveTurnStore: LiveTurnStore;
  /** Re-measure the host scroll region after transcript geometry commits. */
  onLayout?: () => void;
};

/**
 * The durable transcript and the live assistant tail for any session surface.
 * Full sessions and compact session views use this component so markdown,
 * stream reconciliation, and transcript grouping cannot drift apart.
 */
export const SessionTranscript = function SessionTranscript({
  sessionId,
  liveTurnStore,
  onLayout,
  ...blocks
}: SessionTranscriptProps) {
  const phase = useSyncExternalStore(
    liveTurnStore.subscribe,
    liveTurnStore.getPhase,
    liveTurnStore.getPhase,
  );
  return (
    <>
      <TranscriptBlocks
        {...blocks}
        sessionId={sessionId}
        onLayout={onLayout}
        livePhase={phase?.phase ?? null}
      />
      <StreamingMessage
        store={liveTurnStore}
        sessionId={sessionId}
        onLayout={onLayout}
      />
    </>
  );
};

function StreamingMessage({
  store,
  sessionId,
  onLayout,
}: {
  store: LiveTurnStore;
  sessionId: string;
  onLayout?: () => void;
}) {
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );
  const repo = useMarkdownRepo();
  const assetPaths = useOpenAssetPaths();
  useLayoutEffect(() => {
    onLayout?.();
  }, [snapshot.revision, onLayout]);
  if (!snapshot.text && snapshot.tools.length === 0) return null;
  const markdown = { repo, sessionId, assetPaths };
  // One caret, on the answer being written right now. Text without a kind
  // (older servers) is answer text, so their bubble looks as it always has.
  const caretAt = snapshot.tools.length === 0 ? snapshot.blocks.length - 1 : -1;
  return (
    <>
      {snapshot.blocks.map((block, index) =>
        block.kind === "reasoning" ? (
          <LiveReasoning key={block.key} block={block} markdown={markdown} />
        ) : (
          <LiveText
            key={block.key}
            block={block}
            markdown={markdown}
            caret={index === caretAt}
          />
        ),
      )}
      {snapshot.tools.length > 0 && (
        // The calls this message has started, after the text that led to
        // them, in the work rail's own shape; each moves into the rail when
        // its durable row lands.
        <div className={LIVE_COLUMN}>
          <div className={LIVE_RAIL}>
            <div className="-ml-px desktop:ml-0">
              {snapshot.tools.map((entry) => (
                <ToolCallBlock
                  key={entry.id}
                  entry={entry}
                  sessionId={sessionId}
                  pending
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

type LiveMarkdown = Parameters<typeof renderMarkdown>[1] &
  React.ComponentProps<typeof MarkdownBody>["markdown"];

/** The reading column, kept out of scroll anchoring like the streaming row. */
const LIVE_COLUMN =
  "mx-auto w-full max-w-[var(--session-col)] [overflow-anchor:none]";
/** The work rail's hairline and inset (TurnBlock), for live work that has not
 * landed in a rail yet. */
const LIVE_RAIL = "relative mb-3 ml-[5px] border-l border-line pl-2.5";

/** The model's thinking as it streams: the durable reasoning row's own dim
 * prose, in the rail, so landing swaps it by id without restyling it. The
 * status row under the transcript is what says "Thinking". */
function LiveReasoning({
  block,
  markdown,
}: {
  block: LiveBlockView;
  markdown: LiveMarkdown;
}) {
  const heading = liveReasoningHeading(block.text);
  return (
    <div className={LIVE_COLUMN} data-live-kind="reasoning">
      <div className={LIVE_RAIL}>
        <div className="my-2 px-1">
          {heading ? (
            <div className={msgReasoningTitle}>{heading}</div>
          ) : (
            <MarkdownBody
              className={cn(msgReasoningBody, "markdown")}
              html={renderMarkdown(
                normalizeFragmentedReasoning(block.text),
                markdown,
              )}
              enhance={false}
              markdown={markdown}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function LiveText({
  block,
  markdown,
  caret,
}: {
  block: LiveBlockView;
  markdown: LiveMarkdown;
  caret: boolean;
}) {
  const reasoningHeading = liveReasoningHeading(block.text);
  if (reasoningHeading) {
    return (
      <div className={cn(msgRow, msgStreamingRow, "mb-2")} role="status">
        <TextShimmer className={cn(msgReasoningTitle, msgReasoningShimmer)}>
          {reasoningHeading}
        </TextShimmer>
      </div>
    );
  }
  const html = renderMarkdown(
    normalizeFragmentedReasoning(block.text),
    markdown,
  );
  // Always rendered, never raw source: the server cuts frames at block
  // boundaries, so what arrives here is markdown that stands on its own.
  return (
    /* .msg-streaming + .msg-body-assistant stay as hooks: the streaming caret
		   is a ::after on that pair, and the reduced-motion exception names it.
		   Only the newest text block carries the pair, so one caret shows. */
    <div className={cn(msgRow, caret ? msgStreamingRow : LIVE_ANCHOR_OFF)}>
      <MarkdownBody
        className={cn(caret ? msgBodyStreaming : msgBodyLive, "markdown")}
        html={html}
        enhance={false}
        markdown={markdown}
      />
    </div>
  );
}

const LIVE_ANCHOR_OFF = "[overflow-anchor:none]";
