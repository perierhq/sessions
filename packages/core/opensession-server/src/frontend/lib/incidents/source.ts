// A findings block's cited tool call, loaded for the source sheet: the
// call and its result as the transcript's own entries, and where the
// quoted lines are in what the sheet renders.
import type { ToolRef } from "../../../shared/findings";
import { request } from "../api/request";
import type { TranscriptEntry } from "../types";

/** One transcript entry, unclamped (GET /api/sessions/:id/entry/:entryId). */
export interface FullEntry {
  content: string;
  toolInput?: unknown;
  images?: string[];
}

export function fetchFullEntry(
  sessionId: string,
  entryId: string,
): Promise<FullEntry> {
  return request<FullEntry>(
    `/sessions/${encodeURIComponent(sessionId)}/entry/${encodeURIComponent(entryId)}`,
    { label: "Couldn't load the source" },
  );
}

/** The call and its result as transcript entries, for the transcript's
 *  own tool-call row. */
export interface SourceEntries {
  entry: TranscriptEntry;
  result: TranscriptEntry;
}

export function sourceEntries(
  ref: ToolRef,
  use: FullEntry,
  result: FullEntry,
): SourceEntries {
  const entry: TranscriptEntry = {
    id: ref.useId,
    type: "tool_use",
    content: use.content,
    timestamp: ref.at,
    toolName: ref.tool,
    toolUseId: ref.useId,
  };
  if (use.toolInput !== undefined) entry.toolInput = use.toolInput;
  const out: TranscriptEntry = {
    id: ref.resultId,
    type: "tool_result",
    content: result.content,
    timestamp: ref.at,
    toolUseId: ref.useId,
  };
  if (result.images?.length) out.images = result.images;
  return { entry, result: out };
}

/** The innermost element under `root` whose text holds the first quoted
 *  line found, so the sheet can scroll it into view and mark it. */
export interface QuoteNode<T> {
  readonly textContent: string | null;
  readonly children: Iterable<T>;
}

export function findQuote<T extends QuoteNode<T>>(
  root: T,
  quote: readonly string[],
): T | null {
  const deepest = (el: T, text: string): T | null => {
    if (!el.textContent?.includes(text)) return null;
    for (const child of el.children) {
      const inner = deepest(child, text);
      if (inner) return inner;
    }
    return el;
  };
  for (const line of quote) {
    const text = line.trim();
    const found = text ? deepest(root, text) : null;
    if (found) return found;
  }
  return null;
}

/** The first quoted line inside `el`'s text as a Range over just that
 *  line, for marking it without touching the rendered markup. Null when
 *  the line spans text nodes (then the element itself is marked). */
export function quoteRange(
  el: Element,
  quote: readonly string[],
): Range | null {
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? "";
    for (const line of quote) {
      const want = line.trim();
      const at = want ? text.indexOf(want) : -1;
      if (at < 0) continue;
      const range = el.ownerDocument.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + want.length);
      return range;
    }
  }
  return null;
}

/** Centre `range` in each scrolling box around it, innermost first: a
 *  long output's own well, then the sheet. */
export function scrollRangeIntoView(range: Range): void {
  let box = range.startContainer.parentElement;
  while (box) {
    const style = getComputedStyle(box);
    if (
      box.scrollHeight > box.clientHeight + 1 &&
      /auto|scroll/.test(style.overflowY)
    ) {
      const line = range.getBoundingClientRect();
      const frame = box.getBoundingClientRect();
      box.scrollTop +=
        line.top - frame.top - (box.clientHeight - line.height) / 2;
    }
    box = box.parentElement;
  }
}
