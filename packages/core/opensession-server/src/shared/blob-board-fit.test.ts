import { describe, expect, test } from "bun:test";
import {
  applyBoardOps,
  boardTextIssues,
  estimateTextWidth,
  textRoom,
  type BoardElement,
  type BoardViewport,
  type ResolvedRef,
} from "./blob-board";
import live from "./fixtures/blob-board-duo-open.json";

// The first real board an open Duo drew (project names replaced): a count
// line too wide for its box, ref cards drawn taller than theirs.
const elements = live.elements as BoardElement[];
const refs = live.refs as Record<string, ResolvedRef>;

const OPEN: BoardViewport = {
  w: 951,
  h: 669,
  origin: [0, 0],
  zoom: 1,
  hinge: [455.5, 495.5],
  strip: [867, 951],
  closed: { w: 382, h: 678 },
};

describe("text width estimate", () => {
  test("the count line needs more than its 350 pt box at stat size", () => {
    const w = estimateTextWidth("6 handled alone · 8 asked you", "stat");
    // The real line is about 355 pt in SF Pro 28; the estimate is close
    // and never short of it.
    expect(w).toBeGreaterThan(355);
    expect(w).toBeLessThan(380);
    expect(estimateTextWidth("abc", "title")).toBeGreaterThan(
      estimateTextWidth("abc", "supporting"),
    );
  });

  test("room to widen: the closed view's edge, the frame's inner edge, the next element", () => {
    const byId = new Map(elements.map((e) => [e.id, e]));
    const count = byId.get("brief-count") as Extract<
      BoardElement,
      { type: "text" }
    >;
    expect(textRoom(count, byId)).toBe(382);
    const card = byId.get("du-pr78") as Extract<BoardElement, { type: "text" }>;
    // In its region (8–374, children 12 in), and the note is no box.
    expect(textRoom(card, byId)).toBe(362);
  });
});

describe("overflow report", () => {
  test("board_read's list names the live board's overflow and collisions", () => {
    const issues = boardTextIssues(elements, refs, OPEN);
    const byKind = (kind: string) =>
      issues.filter((i) => i.kind === kind).map((i) => i.id);
    expect(byKind("overflow")).toContain("brief-count");
    const count = issues.find((i) => i.id === "brief-count")!;
    expect(count.detail).toContain("its box is 350 wide; set w to");
    // Cards are about 55 pt tall, drawn in 44 pt boxes: the first in a
    // region runs into the next.
    expect(byKind("overflow")).toContain("dec-example-support");
    expect(
      issues.some(
        (i) =>
          i.kind === "overlap" &&
          i.id === "dec-example-support" &&
          i.detail.includes("dec-example-csp"),
      ),
    ).toBe(true);
    // Every element starts below its frame's title band.
    expect(byKind("title-band")).toEqual([]);
  });

  test("a child in a frame's title band is reported", () => {
    const issues = boardTextIssues([
      { id: "f", type: "frame", x: 0, y: 0, w: 300, h: 200, title: "acme" },
      {
        id: "t",
        type: "text",
        x: 12,
        y: 6,
        w: 200,
        role: "supporting",
        text: "Under the title",
      },
    ]);
    expect(issues.map((i) => [i.id, i.kind])).toContainEqual([
      "t",
      "title-band",
    ]);
  });
});

describe("apply fits what it touched", () => {
  test("widens the count line when there is room, and says so", () => {
    const count = elements.find((e) => e.id === "brief-count")!;
    const rest = elements.filter((e) => e.id !== "brief-count");
    const result = applyBoardOps(rest, [{ op: "add", el: count }], OPEN);
    if (!result.ok) throw new Error(result.error);
    const fitted = result.elements.find((e) => e.id === "brief-count")!;
    expect(fitted.type === "text" && fitted.w).toBeGreaterThan(355);
    expect(fitted.type === "text" && fitted.x + fitted.w).toBeLessThanOrEqual(
      382,
    );
    expect(result.report.widened.map((w) => w.id)).toEqual(["brief-count"]);
    // One stat line is 32 pt tall; its box said 28.
    expect(result.report.grown).toEqual([{ id: "brief-count", h: 32 }]);
  });

  test("no room: wraps and grows, and reports the collision it leaves", () => {
    const result = applyBoardOps(
      [],
      [
        {
          op: "add",
          el: {
            id: "f",
            type: "frame",
            x: 0,
            y: 0,
            w: 200,
            h: 120,
            title: "acme",
          },
        },
        {
          op: "add",
          el: {
            id: "t",
            type: "text",
            x: 8,
            y: 10,
            w: 180,
            role: "title",
            text: "A title much too long for a box this narrow",
          },
        },
        {
          op: "add",
          el: {
            id: "u",
            type: "text",
            x: 8,
            y: 56,
            w: 180,
            role: "meta",
            text: "under it",
          },
        },
      ],
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.report.belowTitle).toEqual([{ id: "t", y: 28 }]);
    const t = result.elements.find((e) => e.id === "t")!;
    // Out to its frame's inner edge, 8 in like its left.
    expect(t.type === "text" && t.w).toBe(184);
    expect(result.report.grown).toEqual([{ id: "t", h: 34 }]);
    // The engine never moves what else is there: it says so instead.
    expect(
      result.report.issues.some((i) => i.id === "t" && i.kind === "overlap"),
    ).toBe(true);
  });
});
