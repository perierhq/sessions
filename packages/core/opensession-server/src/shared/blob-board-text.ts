/**
 * The board as plain text, for everywhere it can't render: the web
 * transcript, Slack, an export (docs/blocks.md: no block is the only carrier
 * of what the reader needs). The same words VoiceOver reads.
 *
 * Reading order is by screen, then top to bottom, then left to right: the
 * left screen (x before the Duo's fold) first, then the right. A frame is a
 * heading followed by what sits inside it. Text elements are lines; ref
 * elements are links with their live status; arrows are `A → B` lines after
 * their start; a shape without a ref around an element reads as "circled:"
 * or "boxed:"; notes read "Note on <anchor>: <text>" right after their
 * anchor's line. Freehand strokes carry no words and are left out.
 */
import {
  DUO_OPEN,
  elementBox,
  type ArrowEnd,
  type BoardElement,
  type Box,
  type ResolvedRef,
} from "./blob-board";

/** The text is cut here. */
export const BOARD_TEXT_MAX_LINES = 60;
export const BOARD_TEXT_MAX_CHARS = 4_000;

type Refs = Readonly<Record<string, ResolvedRef | undefined>>;

const LIVE = /\{ref\.([A-Za-z]+)\}/g;

function live(text: string, ref: ResolvedRef | undefined): string {
  return text.replace(LIVE, (_, field: string) => {
    if (!ref?.ok) return "";
    if (field === "title") return ref.title;
    if (field === "status") return ref.status;
    if (field === "statusTone") return ref.statusTone;
    if (field === "url") return ref.url ?? "";
    if (field === "updatedAt") return ref.updatedAt ?? "";
    return ref.fields[field] ?? "";
  });
}

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function screenOf(b: Box): number {
  return b.x < DUO_OPEN.hinge[1] ? 0 : 1;
}

function contains(outer: Box, inner: Box): boolean {
  const cx = inner.x + inner.w / 2;
  const cy = inner.y + inner.h / 2;
  return (
    cx >= outer.x &&
    cx <= outer.x + outer.w &&
    cy >= outer.y &&
    cy <= outer.y + outer.h
  );
}

/** What an element is called in other lines: its live title, its text,
 *  a frame's title, else its id. */
export function elementLabel(el: BoardElement, refs: Refs): string {
  const ref = "ref" in el && el.ref ? refs[el.ref] : undefined;
  if (el.type === "text" && el.text) {
    const text = clean(live(el.text, ref));
    if (text) return text;
  }
  if (ref?.ok) return ref.title;
  if ("ref" in el && el.ref) return el.ref.slice(el.ref.indexOf(":") + 1);
  if (el.type === "frame" && el.title) return el.title;
  if (el.type === "image" && el.alt) return el.alt;
  if (el.type === "note") return el.text;
  return el.id;
}

/** One element's own line, or null when it carries no words. */
function ownLine(
  el: BoardElement,
  refs: Refs,
  byId: ReadonlyMap<string, BoardElement>,
  boxes: ReadonlyMap<string, Box>,
): string | null {
  const ref = "ref" in el && el.ref ? refs[el.ref] : undefined;
  if (el.type === "text" || ("ref" in el && el.ref && el.type !== "frame")) {
    const main =
      el.type === "text" && el.text
        ? clean(live(el.text, ref))
        : ref?.ok
          ? ref.title
          : elementLabel(el, refs);
    const named = ref?.ok && ref.url ? `[${main}](${ref.url})` : main;
    const status =
      el.type === "text" && el.status
        ? clean(live(el.status, ref))
        : ref?.ok
          ? ref.status
          : "ref" in el && el.ref
            ? "not found"
            : "";
    const sub = el.type === "text" && el.sub ? clean(live(el.sub, ref)) : "";
    const tail = [status, sub].filter(Boolean).join(", ");
    return tail ? `${named}: ${tail}` : named;
  }
  if (el.type === "image") return `Image: ${el.alt ?? el.src}`;
  if (el.type === "shape") {
    const own = boxes.get(el.id);
    if (!own || el.kind === "line") return null;
    // The smallest element it is drawn around.
    const inside = [...byId.values()]
      .filter((other) => {
        const b = boxes.get(other.id);
        return (
          other.id !== el.id &&
          other.type !== "frame" &&
          other.type !== "shape" &&
          other.type !== "note" &&
          b &&
          contains(own, b) &&
          b.w * b.h < own.w * own.h
        );
      })
      .sort((a, b) => {
        const ba = boxes.get(a.id)!;
        const bb = boxes.get(b.id)!;
        return bb.w * bb.h - ba.w * ba.h;
      })[0];
    if (!inside) return null;
    const verb =
      el.kind === "ellipse"
        ? "circled"
        : el.kind === "rect"
          ? "boxed"
          : "marked";
    return `${verb}: ${elementLabel(inside, refs)}`;
  }
  return null;
}

function endLabel(
  end: ArrowEnd,
  byId: ReadonlyMap<string, BoardElement>,
  refs: Refs,
): string {
  if ("x" in end) return "(a point)";
  const el = byId.get(end.id);
  return el ? elementLabel(el, refs) : end.id;
}

/**
 * The board as plain text, bounded by BOARD_TEXT_MAX_LINES and
 * BOARD_TEXT_MAX_CHARS. `refs` holds the live fields of the board's refs;
 * one missing or unresolved reads as plain text with "not found".
 */
export function boardText(
  elements: readonly BoardElement[],
  refs: Refs = {},
): string {
  const byId = new Map(elements.map((el) => [el.id, el]));
  const boxes = new Map<string, Box>();
  for (const el of elements) {
    const b = elementBox(el, byId);
    if (b) boxes.set(el.id, b);
  }
  const frames = elements.filter((el) => el.type === "frame");
  // Each element belongs to the smallest frame around it.
  const parent = new Map<string, string>();
  for (const el of elements) {
    if (el.type === "arrow" || el.type === "note") continue;
    const b = boxes.get(el.id);
    if (!b) continue;
    let best: { id: string; area: number } | undefined;
    for (const f of frames) {
      if (f.id === el.id) continue;
      const fb = boxes.get(f.id)!;
      const area = fb.w * fb.h;
      if (!contains(fb, b) || area <= b.w * b.h) continue;
      if (!best || area < best.area) best = { id: f.id, area };
    }
    if (best) parent.set(el.id, best.id);
  }
  const order = (a: BoardElement, b: BoardElement) => {
    const ba = boxes.get(a.id)!;
    const bb = boxes.get(b.id)!;
    return screenOf(ba) - screenOf(bb) || ba.y - bb.y || ba.x - bb.x;
  };
  const childrenOf = (frame: string | undefined) =>
    elements
      .filter(
        (el) =>
          el.type !== "arrow" &&
          el.type !== "note" &&
          boxes.has(el.id) &&
          parent.get(el.id) === frame,
      )
      .sort(order);

  const notesOn = new Map<string, BoardElement[]>();
  const arrowsFrom = new Map<string, BoardElement[]>();
  const looseArrows: BoardElement[] = [];
  for (const el of elements) {
    if (el.type === "note") {
      const list = notesOn.get(el.anchor.id) ?? [];
      list.push(el);
      notesOn.set(el.anchor.id, list);
    } else if (el.type === "arrow") {
      const from = "id" in el.start ? el.start.id : undefined;
      if (from && byId.has(from)) {
        const list = arrowsFrom.get(from) ?? [];
        list.push(el);
        arrowsFrom.set(from, list);
      } else looseArrows.push(el);
    }
  }

  const lines: string[] = [];
  const emitted = new Set<string>();
  const afterLine = (id: string) => {
    for (const note of notesOn.get(id) ?? []) {
      if (note.type !== "note" || emitted.has(note.id)) continue;
      emitted.add(note.id);
      lines.push(`Note on ${elementLabel(byId.get(id)!, refs)}: ${note.text}`);
      afterLine(note.id);
    }
    for (const arrow of arrowsFrom.get(id) ?? []) {
      if (arrow.type !== "arrow" || emitted.has(arrow.id)) continue;
      emitted.add(arrow.id);
      lines.push(
        `${endLabel(arrow.start, byId, refs)} → ${endLabel(arrow.end, byId, refs)}${arrow.label ? `: ${arrow.label}` : ""}`,
      );
    }
  };
  const walk = (frame: string | undefined, depth: number) => {
    for (const el of childrenOf(frame)) {
      if (el.type === "frame") {
        const heading = el.title ?? el.region;
        if (heading) lines.push(depth === 0 ? heading : `${heading}:`);
        afterLine(el.id);
        if (depth < 4) walk(el.id, depth + 1);
        continue;
      }
      const own = ownLine(el, refs, byId, boxes);
      if (own) lines.push(own);
      afterLine(el.id);
    }
  };
  walk(undefined, 0);
  for (const arrow of looseArrows)
    if (arrow.type === "arrow")
      lines.push(
        `${endLabel(arrow.start, byId, refs)} → ${endLabel(arrow.end, byId, refs)}${arrow.label ? `: ${arrow.label}` : ""}`,
      );

  const kept: string[] = [];
  let chars = 0;
  for (const l of lines) {
    if (
      kept.length >= BOARD_TEXT_MAX_LINES ||
      chars + l.length + 1 > BOARD_TEXT_MAX_CHARS
    ) {
      kept.push(`… and ${lines.length - kept.length} more lines`);
      break;
    }
    kept.push(l);
    chars += l.length + 1;
  }
  return kept.join("\n");
}
