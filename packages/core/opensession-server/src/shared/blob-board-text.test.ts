import { describe, expect, test } from "bun:test";
import {
  applyBoardOps,
  type BoardElement,
  type ResolvedRef,
} from "./blob-board";
import { BOARD_TEXT_MAX_LINES, boardText } from "./blob-board-text";

function board(ops: unknown[]): BoardElement[] {
  const result = applyBoardOps([], ops);
  if (!result.ok) throw new Error(result.error);
  return result.elements;
}

const REFS: Record<string, ResolvedRef> = {
  "pr:acme#533": {
    ok: true,
    kind: "pr",
    title: "#533 search-service 1.19.0",
    status: "checks failing",
    statusTone: "red",
    url: "https://example.test/acme/pull/533",
    fields: { number: "533" },
  },
  "check:acme#533/ci-success": {
    ok: true,
    kind: "check",
    title: "ci-success",
    status: "failing",
    statusTone: "red",
    fields: {},
  },
};

describe("board as plain text", () => {
  // The release board from the spec, in miniature.
  const els = board([
    {
      op: "add",
      el: {
        id: "f",
        type: "frame",
        x: 0,
        y: 0,
        w: 380,
        h: 400,
        title: "Why the release is stuck",
      },
    },
    {
      op: "add",
      el: {
        id: "gh",
        type: "text",
        role: "title",
        x: 20,
        y: 40,
        w: 300,
        text: "GitHub Actions is blocked",
        status: "billing stopped every run",
      },
    },
    {
      op: "add",
      el: {
        id: "c-ci",
        type: "text",
        role: "supporting",
        ref: "check:acme#533/ci-success",
        x: 20,
        y: 120,
        w: 260,
        h: 58,
        text: "{ref.title}",
        status: "can't run",
        sub: "required check on #533",
      },
    },
    {
      op: "add",
      el: {
        id: "e-ci",
        type: "shape",
        kind: "ellipse",
        x: 10,
        y: 110,
        w: 290,
        h: 80,
      },
    },
    {
      op: "add",
      el: {
        id: "pr",
        type: "text",
        role: "supporting",
        ref: "pr:acme#533",
        x: 20,
        y: 250,
        w: 300,
      },
    },
    {
      op: "add",
      el: {
        id: "a1",
        type: "arrow",
        start: { id: "c-ci" },
        end: { id: "pr" },
        label: "blocks",
      },
    },
    {
      op: "add",
      el: {
        id: "n-bill",
        type: "note",
        anchor: { id: "c-ci", side: "top" },
        text: "GitHub billing, only you",
      },
    },
    {
      op: "add",
      el: {
        id: "later",
        type: "text",
        role: "meta",
        x: 520,
        y: 10,
        w: 200,
        text: "Path to release",
      },
    },
    {
      op: "add",
      el: {
        id: "gone",
        type: "text",
        role: "meta",
        ref: "incident:acme/old",
        x: 520,
        y: 60,
        w: 200,
      },
    },
    {
      op: "add",
      el: {
        id: "tick",
        type: "stroke",
        x: 0,
        y: 500,
        w: 10,
        h: 10,
        points: [
          [0, 0],
          [10, 10],
        ],
      },
    },
  ]);

  test("reads like the board: headings, lines, links, arrows, notes, marks", () => {
    expect(boardText(els, REFS)).toBe(
      [
        "Why the release is stuck",
        "GitHub Actions is blocked: billing stopped every run",
        "circled: ci-success",
        "ci-success: can't run, required check on #533",
        "Note on ci-success: GitHub billing, only you",
        "ci-success → #533 search-service 1.19.0: blocks",
        "[#533 search-service 1.19.0](https://example.test/acme/pull/533): checks failing",
        "Path to release",
        "acme/old: not found",
      ].join("\n"),
    );
  });

  test("a ref that did not resolve reads as plain text", () => {
    const text = boardText(els, {});
    expect(text).toContain("acme#533: not found");
    expect(text).not.toContain("https://");
  });

  test("is bounded", () => {
    const many = board(
      Array.from({ length: 100 }, (_, i) => ({
        op: "add",
        el: {
          id: `t${i}`,
          type: "text",
          role: "meta",
          x: 0,
          y: i * 20,
          w: 100,
          text: `line ${i}`,
        },
      })),
    );
    const lines = boardText(many).split("\n");
    expect(lines).toHaveLength(BOARD_TEXT_MAX_LINES + 1);
    expect(lines.at(-1)).toBe("… and 40 more lines");
  });
});
