import { useEffect, useRef } from "react";
import useSWR from "swr";
import { provenanceLabel, type ToolRef } from "../../../../shared/findings";
import {
  fetchFullEntry,
  findQuote,
  quoteRange,
  scrollRangeIntoView,
  sourceEntries,
} from "../../../lib/incidents/source";
import { FINDINGS_SOURCE_BODY } from "../../../lib/incident-classes";
import { Button } from "../../../ui/button";
import { InlineAlert, ListSkeleton } from "../../../ui/state";
import { ToolCallBlock } from "../../ToolCallBlock";
import { DetailSheet } from "../DetailSheet";

const QUOTE_ATTR = "data-findings-quote";
/** The CSS highlight the quoted line is painted with (FINDINGS_SOURCE_BODY). */
const QUOTE_HIGHLIGHT = "findings-quote";

/** The cited call and its result, loaded once per call. */
function useSource(ref: ToolRef | null) {
  return useSWR(
    ref ? ["findings-source", ref.sessionId, ref.useId, ref.resultId] : null,
    async () => {
      const [use, result] = await Promise.all([
        fetchFullEntry(ref!.sessionId, ref!.useId),
        fetchFullEntry(ref!.sessionId, ref!.resultId),
      ]);
      return sourceEntries(ref!, use, result);
    },
    { revalidateOnFocus: false },
  );
}

/**
 * A block's cited tool output in a sheet over the incident page, drawn by
 * the transcript's own tool-call row, open, and scrolled to the first
 * quoted line, which is marked. The whole session is one step further, as
 * a secondary button.
 */
export function SourceSheet({
  source,
  onClose,
  onOpenSession,
}: {
  /** The call and the lines to land on; null keeps the sheet closed. */
  source: { ref: ToolRef; quote: string[] } | null;
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const ref = source?.ref ?? null;
  const { data, error, mutate } = useSource(ref);
  const body = useRef<HTMLDivElement>(null);
  const quote = source?.quote ?? [];
  const quoteKey = quote.join("\n");

  useEffect(() => {
    const root: Element | null = body.current;
    if (!root || !data) return;
    // The row renders its output after it mounts; land once it has.
    const lines = quoteKey.split("\n");
    const frame = requestAnimationFrame(() => {
      const found = findQuote<Element>(root, lines);
      if (!found) return;
      // Mark just the line where the browser can; else the element.
      const range = quoteRange(found, lines);
      if (range && "highlights" in CSS) {
        CSS.highlights.set(QUOTE_HIGHLIGHT, new Highlight(range));
        scrollRangeIntoView(range);
      } else {
        found.setAttribute(QUOTE_ATTR, "");
        found.scrollIntoView({ block: "center" });
      }
    });
    return () => {
      cancelAnimationFrame(frame);
      if ("highlights" in CSS) CSS.highlights.delete(QUOTE_HIGHLIGHT);
      for (const el of root.querySelectorAll(`[${QUOTE_ATTR}]`))
        el.removeAttribute(QUOTE_ATTR);
    };
  }, [data, quoteKey]);

  const title = ref ? capitalize(provenanceLabel(ref.provenance).text) : "";
  return (
    <DetailSheet title={title} open={!!source} onClose={onClose} wide>
      <div ref={body} className={FINDINGS_SOURCE_BODY}>
        {error && !data ? (
          <InlineAlert onRetry={() => void mutate()}>
            Couldn&apos;t load the source
          </InlineAlert>
        ) : data && ref ? (
          <ToolCallBlock
            entry={data.entry}
            result={data.result}
            sessionId={ref.sessionId}
            defaultExpanded
          />
        ) : (
          <ListSkeleton variant="bare" rows={3} />
        )}
      </div>
      {ref ? (
        <div>
          <Button
            variant="soft"
            size="lg"
            className="min-h-11"
            onClick={() => {
              onClose();
              onOpenSession(ref.sessionId);
            }}
          >
            Open the agent&apos;s session
          </Button>
        </div>
      ) : null}
    </DetailSheet>
  );
}

const capitalize = (text: string) =>
  text.charAt(0).toUpperCase() + text.slice(1);
