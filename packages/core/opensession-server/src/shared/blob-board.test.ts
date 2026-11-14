import { describe, expect, test } from "bun:test";
import {
  BOARD_LIMITS,
  DUO_OPEN,
  applyBoardOps,
  boardRefs,
  canvasFence,
  hingeBands,
  hingeShift,
  noteBox,
  parseBoardElement,
  parseCanvasFence,
  parseRef,
  type BoardElement,
  type BoardViewport,
} from "./blob-board";

const OPEN: BoardViewport = {
  w: 951,
  h: 669,
  origin: [0, 0],
  zoom: 1,
  hinge: [455.5, 495.5],
  strip: [867, 951],
  closed: { w: 382, h: 678 },
};

function apply(
  current: BoardElement[],
  ops: unknown[],
  viewport?: BoardViewport,
) {
  const result = applyBoardOps(current, ops, viewport);
  if (!result.ok) throw new Error(result.error);
  return result;
}

function refused(current: BoardElement[], ops: unknown[]): string {
  const result = applyBoardOps(current, ops);
  if (result.ok) throw new Error("expected a refusal");
  return result.error;
}

const text = (id: string, x: number, y: number, extra: object = {}) => ({
  id,
  type: "text",
  role: "supporting",
  x,
  y,
  w: 200,
  text: id,
  ...extra,
});

describe("refs", () => {
  test("reads each kind's locator", () => {
    expect(parseRef("pr:acme#12")).toEqual({
      kind: "pr",
      project: "acme",
      number: 12,
    });
    expect(parseRef("check:acme#12/ci-success")).toEqual({
      kind: "check",
      project: "acme",
      number: 12,
      name: "ci-success",
    });
    expect(parseRef("incident:acme/inc-1")).toMatchObject({ name: "inc-1" });
    expect(parseRef("thread:acme/sc_01")?.kind).toBe("thread");
    expect(parseRef("release:acme@1.19.0")).toMatchObject({ name: "1.19.0" });
    expect(parseRef("project:acme")).toEqual({
      kind: "project",
      project: "acme",
    });
    expect(parseRef("item:si-0b6f1c2e-1d2a-4c1e-9f00-123456789abc")).toEqual({
      kind: "item",
      id: "si-0b6f1c2e-1d2a-4c1e-9f00-123456789abc",
    });
  });

  test("refuses anything else", () => {
    for (const ref of [
      "decision:acme/merge",
      "pr:acme",
      "pr:acme#x",
      "acme#12",
      "incident:acme",
      "project:",
      `project:${"a".repeat(200)}`,
      "item:",
      "item:acme#12",
      "item:si-../x",
    ])
      expect(parseRef(ref)).toBeNull();
  });
});

describe("element schema", () => {
  test("accepts every primitive", () => {
    const els = [
      {
        id: "f",
        type: "frame",
        x: 0,
        y: 0,
        w: 300,
        h: 200,
        title: "Release",
        region: "acme",
      },
      text("t", 10, 10, {
        ref: "pr:acme#1",
        text: "{ref.title}",
        status: "{ref.status}",
      }),
      { id: "s", type: "shape", kind: "ellipse", x: 0, y: 0, w: 40, h: 40 },
      {
        id: "a",
        type: "arrow",
        start: { id: "t", side: "right" },
        end: { x: 10, y: 10 },
        bend: 0.2,
      },
      {
        id: "k",
        type: "stroke",
        x: 0,
        y: 0,
        w: 10,
        h: 10,
        points: [
          [0, 0],
          [5, 5],
        ],
      },
      {
        id: "i",
        type: "image",
        x: 0,
        y: 0,
        w: 10,
        h: 10,
        src: "/media?path=/tmp/a.png",
        alt: "Shot",
      },
      {
        id: "n",
        type: "note",
        anchor: { id: "t", side: "top" },
        text: "only you",
        leader: true,
      },
    ];
    for (const el of els)
      expect(parseBoardElement(el)).toMatchObject({ ok: true });
  });

  test("is strict", () => {
    const cases: Array<[unknown, string]> = [
      [{ ...text("t", 0, 0), color: "#ff0000" }, ""],
      [text("t", 0, 0, { style: { color: "#ff0000" } }), "style.color"],
      [text("bad id", 0, 0), "id"],
      [
        text("t", 0, 0, { text: "x".repeat(BOARD_LIMITS.textChars + 1) }),
        "text",
      ],
      [text("t", 0, 0, { text: "two\nlines" }), "text"],
      [text("t", 0, 0, { w: BOARD_LIMITS.elementSize + 1 }), "w"],
      [text("t", 0, 0, { ref: "decision:acme/x" }), "ref"],
      [
        {
          id: "i",
          type: "image",
          x: 0,
          y: 0,
          w: 1,
          h: 1,
          src: "javascript:alert(1)",
        },
        "src",
      ],
      [{ id: "q", type: "widget", x: 0, y: 0, w: 1, h: 1 }, ""],
    ];
    for (const [raw, path] of cases) {
      const parsed = parseBoardElement(raw);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok && path) expect(parsed.error).toStartWith(path);
    }
  });

  test("text refuses what push text strips", () => {
    for (const bad of [
      "tab\there",
      "del\u007f",
      "c1\u0085",
      "rlo\u202Egnp.exe",
      "lri\u2066x\u2069",
      "mark\u200F",
      "alm\u061C",
      "line\u2028sep",
      "para\u2029sep",
    ]) {
      const parsed = parseBoardElement(text("t", 0, 0, { text: bad }));
      expect(parsed).toMatchObject({ ok: false });
      expect(!parsed.ok && parsed.error).toBe("text: one line of plain text");
    }
    expect(
      parseBoardElement(text("t", 0, 0, { text: "Zażółć — ok ✓" })).ok,
    ).toBe(true);
  });

  test("images load from this server's media routes only", () => {
    const image = (src: string) => ({
      id: "i",
      type: "image",
      x: 0,
      y: 0,
      w: 10,
      h: 10,
      src,
    });
    for (const ok of [
      "/media?path=/tmp/a.png",
      `/media?path=${encodeURIComponent("/home/u/shot-1.png")}`,
      "/media?path=%2Ftmp%2Fa.png&v=3",
      "/api/plain/attachments/att_123",
      "/api/support/conversations/sc_1/attachments/att_2",
      "/gh-asset/0b8f6c1e-1a2b-4c3d-8e9f-0123456789ab?repo=acme",
    ])
      expect([ok, parseBoardElement(image(ok)).ok]).toEqual([ok, true]);
    for (const bad of [
      "https://example.test/a.png",
      "http://example.test/a.png",
      "//example.test/a.png",
      "data:image/png;base64,AAAA",
      "/media?path=/tmp/../etc/passwd.png",
      "/media?path=%2Ftmp%2F..%2Fx.png",
      "/media?path=relative.png",
      "/media?path=/tmp/a.png&url=https://example.test",
      "/api/plain/attachments/../../admin",
    ]) {
      const parsed = parseBoardElement(image(bad));
      expect([bad, parsed.ok]).toEqual([bad, false]);
      expect(!parsed.ok && parsed.error).toStartWith("src: ");
    }
  });

  test("notes are five plain words at most", () => {
    const note = (t: string) => ({
      id: "n",
      type: "note",
      anchor: { id: "t", side: "top" },
      text: t,
    });
    expect(parseBoardElement(note("GitHub billing, only you")).ok).toBe(true);
    const long = parseBoardElement(note("one two three four five six"));
    expect(long).toMatchObject({ ok: false });
    expect(!long.ok && long.error).toContain("at most 5 words");
    expect(parseBoardElement(note("**bold**")).ok).toBe(false);
    // A note has no box of its own.
    expect(parseBoardElement({ ...note("hi"), x: 1 }).ok).toBe(false);
  });

  test("live fields need a ref and a known field", () => {
    expect(
      parseBoardElement(text("t", 0, 0, { text: "{ref.title}" })),
    ).toMatchObject({
      ok: false,
      error: "{ref.title} needs a ref",
    });
    const unknown = parseBoardElement(
      text("t", 0, 0, { ref: "pr:acme#1", text: "{ref.secret}" }),
    );
    expect(!unknown.ok && unknown.error).toContain("unknown live field");
  });

  test("sketch marks are ink; ref elements are clean and may take colour", () => {
    expect(
      parseBoardElement({
        id: "s",
        type: "shape",
        kind: "rect",
        x: 0,
        y: 0,
        w: 1,
        h: 1,
        style: { stroke: "red" },
      }).ok,
    ).toBe(false);
    expect(
      parseBoardElement({
        id: "s",
        type: "shape",
        kind: "rect",
        x: 0,
        y: 0,
        w: 1,
        h: 1,
        ref: "pr:acme#1",
        style: { stroke: "red" },
      }).ok,
    ).toBe(true);
    expect(
      parseBoardElement({
        id: "a",
        type: "arrow",
        start: { x: 0, y: 0 },
        end: { x: 1, y: 1 },
        style: { stroke: "tangerine" },
      }).ok,
    ).toBe(false);
  });
});

describe("ops", () => {
  test("add, update, move and remove by id", () => {
    let els = apply([], [{ op: "add", el: text("a", 10, 10) }]).elements;
    els = apply(els, [
      { op: "update", id: "a", set: { sub: "detail", role: "title" } },
    ]).elements;
    expect(els[0]).toMatchObject({ role: "title", sub: "detail" });
    els = apply(els, [{ op: "update", id: "a", set: { sub: null } }]).elements;
    expect(els[0]).not.toHaveProperty("sub");
    els = apply(els, [{ op: "move", id: "a", x: 30, y: 40 }]).elements;
    expect(els[0]).toMatchObject({ x: 30, y: 40 });
    const removed = apply(els, [{ op: "remove", id: "a" }]);
    expect(removed.elements).toEqual([]);
    expect(removed.report.removed).toEqual(["a"]);
  });

  test("refuses the whole batch on one bad op, and names it", () => {
    const els = apply([], [{ op: "add", el: text("a", 10, 10) }]).elements;
    expect(
      refused(els, [
        { op: "add", el: text("b", 0, 0) },
        { op: "add", el: text("a", 0, 0) },
      ]),
    ).toBe("op 2 (add a): a is already on the board; update it instead");
    expect(refused(els, [{ op: "update", id: "nope", set: {} }])).toBe(
      "op 1 (update nope): no element nope",
    );
    expect(
      refused(els, [{ op: "update", id: "a", set: { type: "frame" } }]),
    ).toContain("can't change");
    expect(refused(els, [{ op: "paint" }])).toStartWith("op 1:");
    expect(refused(els, [])).toBe("ops must be a non-empty list");
    expect(
      refused(
        els,
        Array.from({ length: BOARD_LIMITS.ops + 1 }, () => ({
          op: "remove",
          id: "a",
        })),
      ),
    ).toContain("at most");
  });

  test("remove drops the arrows and notes bound to the element, and says so", () => {
    const els = apply(
      [],
      [
        { op: "add", el: text("a", 10, 10) },
        { op: "add", el: text("b", 10, 100) },
        {
          op: "add",
          el: { id: "ab", type: "arrow", start: { id: "a" }, end: { id: "b" } },
        },
        {
          op: "add",
          el: {
            id: "na",
            type: "note",
            anchor: { id: "a", side: "right" },
            text: "this one",
          },
        },
        {
          op: "add",
          el: {
            id: "to-note",
            type: "arrow",
            start: { id: "na" },
            end: { id: "b" },
          },
        },
      ],
    ).elements;
    const result = apply(els, [{ op: "remove", id: "a" }]);
    expect(result.elements.map((e) => e.id)).toEqual(["b"]);
    expect(result.report.cascaded).toEqual([
      { id: "ab", with: "a" },
      { id: "na", with: "a" },
      { id: "to-note", with: "a" },
    ]);
  });

  test("bindings must resolve at the end of the batch", () => {
    expect(
      refused(
        [],
        [
          {
            op: "add",
            el: {
              id: "x",
              type: "arrow",
              start: { id: "ghost" },
              end: { x: 0, y: 0 },
            },
          },
        ],
      ),
    ).toBe("arrow x binds to ghost, which is not on the board");
    // Bound in the same batch, added after the arrow: fine.
    expect(
      apply(
        [],
        [
          {
            op: "add",
            el: {
              id: "x",
              type: "arrow",
              start: { id: "a" },
              end: { x: 0, y: 0 },
            },
          },
          { op: "add", el: text("a", 0, 0) },
        ],
      ).elements,
    ).toHaveLength(2);
    expect(
      refused(
        [],
        [
          {
            op: "add",
            el: {
              id: "n",
              type: "note",
              anchor: { id: "ghost", side: "top" },
              text: "hi",
            },
          },
        ],
      ),
    ).toContain("anchored to ghost");
  });

  test("a note follows its anchor; a bound arrow follows its elements", () => {
    const els = apply(
      [],
      [
        { op: "add", el: text("a", 10, 10) },
        {
          op: "add",
          el: {
            id: "n",
            type: "note",
            anchor: { id: "a", side: "top" },
            text: "hi",
          },
        },
        {
          op: "add",
          el: {
            id: "ar",
            type: "arrow",
            start: { id: "a" },
            end: { x: 300, y: 300 },
          },
        },
        {
          op: "add",
          el: {
            id: "ab",
            type: "arrow",
            start: { id: "a" },
            end: { id: "a", side: "bottom" },
          },
        },
      ],
    ).elements;
    expect(refused(els, [{ op: "move", id: "n", x: 0, y: 0 }])).toContain(
      "follows its anchor",
    );
    expect(refused(els, [{ op: "move", id: "ab", x: 0, y: 0 }])).toContain(
      "follows its elements",
    );
    const moved = apply(els, [
      { op: "move", id: "ar", x: 310, y: 290 },
    ]).elements.find((e) => e.id === "ar");
    expect(moved).toMatchObject({
      start: { id: "a" },
      end: { x: 310, y: 290 },
    });
  });

  test("one tangerine element and one region per project", () => {
    expect(
      refused(
        [],
        [
          { op: "add", el: text("a", 0, 0, { style: { color: "tangerine" } }) },
          {
            op: "add",
            el: text("b", 0, 50, { style: { color: "tangerine" } }),
          },
        ],
      ),
    ).toContain("one tangerine element");
    expect(
      refused(
        [],
        [
          {
            op: "add",
            el: {
              id: "f1",
              type: "frame",
              x: 0,
              y: 0,
              w: 10,
              h: 10,
              region: "acme",
            },
          },
          {
            op: "add",
            el: {
              id: "f2",
              type: "frame",
              x: 0,
              y: 20,
              w: 10,
              h: 10,
              region: "acme",
            },
          },
        ],
      ),
    ).toBe("f2: f1 is already the region of acme");
  });

  test("a note's style is dropped: notes are ink", () => {
    const result = apply(
      [],
      [
        { op: "add", el: text("a", 0, 0) },
        {
          op: "add",
          el: {
            id: "n",
            type: "note",
            anchor: { id: "a", side: "bottom" },
            text: "hi",
            style: { color: "red" },
          },
        },
      ],
    );
    expect(result.elements[1]).not.toHaveProperty("style");
    expect(result.report.dropped).toEqual(["n.style (notes are ink)"]);
  });

  test("clear keeps what it names and is refused for an unknown id", () => {
    const els = apply(
      [],
      [
        { op: "add", el: text("a", 0, 0) },
        { op: "add", el: text("b", 0, 50) },
        {
          op: "add",
          el: {
            id: "n",
            type: "note",
            anchor: { id: "b", side: "right" },
            text: "hi",
          },
        },
      ],
    ).elements;
    const cleared = apply(els, [{ op: "clear", keep: ["a", "n"] }]);
    expect(cleared.elements.map((e) => e.id)).toEqual(["a"]);
    expect(cleared.report.cascaded).toEqual([{ id: "n", with: "b" }]);
    expect(refused(els, [{ op: "clear", keep: ["zz"] }])).toContain(
      "keep names zz",
    );
  });

  test("the board's element count is bounded", () => {
    const full = Array.from({ length: BOARD_LIMITS.elements }, (_, i) =>
      parseBoardElement(text(`t${i}`, 0, i)).ok
        ? (text(`t${i}`, 0, i) as BoardElement)
        : null,
    ).filter((e): e is BoardElement => !!e);
    expect(
      refused(full, [{ op: "add", el: text("one-more", 0, 0) }]),
    ).toContain("at most");
  });
});

describe("layout guard", () => {
  test("text on the fold moves to the nearer side and is reported", () => {
    const left = apply(
      [],
      [{ op: "add", el: text("l", 300, 10, { w: 160 }) }],
      OPEN,
    );
    expect(left.elements[0]).toMatchObject({ x: 295.5 });
    expect(left.report.nudged).toEqual([{ id: "l", dx: -4.5 }]);
    const right = apply(
      [],
      [{ op: "add", el: text("r", 490, 10, { w: 100 }) }],
      OPEN,
    );
    expect(right.elements[0]).toMatchObject({ x: 495.5 });
    // No room on the left: right.
    const wide = apply(
      [],
      [{ op: "add", el: text("w", 10, 10, { w: 470 }) }],
      OPEN,
    );
    expect(wide.elements[0]).toMatchObject({ x: 495.5 });
  });

  test("shapes, strokes and arrows may cross it", () => {
    const result = apply(
      [],
      [
        {
          op: "add",
          el: {
            id: "s",
            type: "shape",
            kind: "rect",
            x: 400,
            y: 0,
            w: 200,
            h: 50,
          },
        },
        {
          op: "add",
          el: {
            id: "k",
            type: "stroke",
            x: 440,
            y: 0,
            w: 40,
            h: 40,
            points: [
              [0, 0],
              [40, 40],
            ],
          },
        },
      ],
      OPEN,
    );
    expect(result.report.nudged).toEqual([]);
    expect(result.elements[0]).toMatchObject({ x: 400 });
  });

  test("a ref element is text; a note is text", () => {
    const result = apply(
      [],
      [
        {
          op: "add",
          el: {
            id: "c",
            type: "shape",
            kind: "rect",
            ref: "pr:acme#1",
            x: 450,
            y: 100,
            w: 60,
            h: 40,
          },
        },
        { op: "add", el: text("a", 100, 300) },
        // Right of `a` (ends at 300), shifted onto the fold.
        {
          op: "add",
          el: {
            id: "n",
            type: "note",
            anchor: { id: "a", side: "right", dx: 150 },
            text: "hi",
          },
        },
      ],
      OPEN,
    );
    expect(result.report.nudged.map((m) => m.id).sort()).toEqual(["c", "n"]);
    const a = result.elements.find((e) => e.id === "a")!;
    const n = result.elements.find((e) => e.id === "n")!;
    if (n.type !== "note" || a.type !== "text") throw new Error("types");
    const box = noteBox(n, { x: a.x, y: a.y, w: a.w, h: 16 });
    expect(box.x + box.w <= 455.5 || box.x >= 495.5).toBe(true);
  });

  test("without a camera the Duo's own fold still holds", () => {
    expect(hingeBands()).toEqual([DUO_OPEN.hinge]);
    const result = apply([], [{ op: "add", el: text("t", 460, 0, { w: 20 }) }]);
    expect(result.report.nudged).toHaveLength(1);
  });

  test("a panned camera adds the fold where it sits now", () => {
    expect(hingeBands({ ...OPEN, origin: [1000, 0] })).toEqual([
      [455.5, 495.5],
      [1455.5, 1495.5],
    ]);
  });

  test("never moves what the batch did not touch", () => {
    // Stored before the rule, on the fold: left where the owner reads it.
    const onFold = { ...text("old", 460, 0, { w: 20 }) } as BoardElement;
    const result = apply(
      [onFold],
      [{ op: "add", el: text("new", 0, 0) }],
      OPEN,
    );
    expect(result.elements[0]).toMatchObject({ x: 460 });
    expect(result.report.nudged).toEqual([]);
  });

  test("clamps what it touched to the board", () => {
    const result = apply(
      [],
      [{ op: "add", el: text("t", -50, BOARD_LIMITS.size + 10) }],
      OPEN,
    );
    expect(result.elements[0]).toMatchObject({
      x: 0,
      y: BOARD_LIMITS.size - 16,
    });
    expect(result.report.clamped).toEqual(["t"]);
    expect(result.report.offCamera).toEqual(["t"]);
  });

  test("hingeShift is the smallest move off the band", () => {
    expect(hingeShift(0, 100, [455.5, 495.5])).toBe(0);
    expect(hingeShift(470, 10, [455.5, 495.5])).toBe(-24.5);
    expect(hingeShift(480, 10, [455.5, 495.5])).toBe(15.5);
    expect(hingeShift(460, 10, [455.5, 495.5])).toBe(-14.5);
  });
});

describe("canvas fence", () => {
  test("round-trips the revision and keeps the text readable", () => {
    const fence = canvasFence(43, "Why it is stuck\n```inner```");
    expect(fence).toStartWith("```canvas\nrevision: 43\n");
    expect(fence.match(/```/g)).toHaveLength(2);
    const body = fence.split("\n").slice(1, -1).join("\n");
    expect(parseCanvasFence(body)).toEqual({
      revision: 43,
      text: "Why it is stuck\n``inner``",
    });
    expect(parseCanvasFence("nothing")).toBeNull();
    expect(parseCanvasFence("revision: 0")).toBeNull();
  });

  test("boardRefs lists each ref once", () => {
    const els = apply(
      [],
      [
        { op: "add", el: text("a", 0, 0, { ref: "pr:acme#1" }) },
        { op: "add", el: text("b", 0, 30, { ref: "pr:acme#1" }) },
        { op: "add", el: text("c", 0, 60, { ref: "project:acme" }) },
      ],
    ).elements;
    expect(boardRefs(els)).toEqual(["pr:acme#1", "project:acme"]);
  });
});
