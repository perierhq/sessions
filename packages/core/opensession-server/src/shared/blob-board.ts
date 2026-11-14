/**
 * Blob's board: one persistent canvas per owner that the supervisor edits by
 * id, the way two people share a Paper file. Shared between the server
 * (store, tools, routes) and the clients that draw it.
 *
 * The board is built from seven primitives and nothing else: frame, text,
 * shape, arrow, stroke (freehand), image and note (Blob's handwriting, at
 * most five words, anchored to an element). A real object shows as a
 * primitive with a `ref` (`kind:locator`), which the server resolves to live
 * fields at read time (server/blob-board-refs.ts).
 *
 * Positions are data. The board is one surface in points with its origin at
 * the top-left of the first screen; a device is a camera on it. Opening the
 * Duo widens the camera and nothing re-flows. The engine never changes what
 * the owner is reading: only elements an op touched are clamped to the board
 * and nudged off the hinge band, and every nudge is reported.
 *
 * Everything here is pure: parse, validate and apply ops. Storage and the
 * compare-and-set live in server/blob-board.ts.
 */
import { z } from "zod";
import { hasUnsafeTextChars } from "./safe-text";

/** Bumped when a stored board can no longer be read as is. */
export const BOARD_SCHEMA = 1;

export const BOARD_LIMITS = {
  /** Elements on one board. */
  elements: 400,
  /** Ops in one apply. */
  ops: 100,
  /** The board's width and height, in points. */
  size: 16_384,
  /** One element's width or height. */
  elementSize: 4_096,
  idChars: 40,
  textChars: 200,
  subChars: 160,
  statusChars: 40,
  titleChars: 80,
  labelChars: 60,
  altChars: 120,
  noteWords: 5,
  noteChars: 60,
  strokePoints: 200,
  linePoints: 50,
  srcChars: 2_048,
  refChars: 160,
  /** Versions kept per owner, the current one included. */
  versions: 50,
} as const;

/** Colour tokens. Elements name a token, never a value, so the board renders
 *  in light and dark without edits. */
export const BOARD_PALETTE = [
  "ink",
  "ink2",
  "tangerine",
  "green",
  "red",
  "amber",
  "quiet",
] as const;
export type BoardToken = (typeof BOARD_PALETTE)[number];

/** Type-scale roles of a text element, with their line height in points. */
export const TEXT_ROLES = [
  "stat",
  "title",
  "supporting",
  "meta",
  "say",
] as const;
export type TextRole = (typeof TEXT_ROLES)[number];
export const TEXT_LINE_HEIGHT: Record<TextRole, number> = {
  stat: 32,
  title: 17,
  supporting: 16,
  meta: 13,
  say: 22,
};
/** Each role's font size in points (SF Pro; only `title` is semibold). */
export const TEXT_SIZE: Record<TextRole, number> = {
  stat: 28,
  title: 14,
  supporting: 13,
  meta: 11,
  say: 17,
};

export const SHAPE_KINDS = ["rect", "ellipse", "diamond", "line"] as const;
export const BOARD_SIDES = [
  "top",
  "right",
  "bottom",
  "left",
  "center",
] as const;
export type BoardSide = (typeof BOARD_SIDES)[number];
const NOTE_SIDES = ["top", "right", "bottom", "left"] as const;

/** Ref kinds in v1. `item` is one of the owner's supervisor inbox items
 *  (a decision waiting for them, or an update): tapping it opens the
 *  decision view. */
export const REF_KINDS = [
  "pr",
  "check",
  "incident",
  "thread",
  "release",
  "project",
  "item",
] as const;
export type RefKind = (typeof REF_KINDS)[number];
/** Kinds whose locator starts with one of the owner's projects. */
type ProjectRefKind = Exclude<RefKind, "item">;

/** Live fields a text element may write as `{ref.<field>}`. */
export const REF_FIELDS = [
  "title",
  "status",
  "statusTone",
  "updatedAt",
  "url",
  "number",
  "checks",
  "openFor",
] as const;

// ── Cameras ─────────────────────────────────────────────────────────────────

/** The closed Duo: the board shows x 0–382; the 84 pt clock strip on the
 *  trailing edge is chrome, never board. */
export const DUO_CLOSED = { w: 382, h: 678 } as const;
/** The open Duo at its home camera: left screen 0–455.5, the fold's band
 *  455.5–495.5, right screen to the strip at 867. */
export const DUO_OPEN = {
  w: 951,
  h: 669,
  hinge: [455.5, 495.5] as [number, number],
  strip: [867, 951] as [number, number],
} as const;

/** What the Blob app says about its camera with each prompt
 *  (server/blob-surface.ts). Camera points; `origin` is the board point at
 *  the camera's top-left. */
export interface BoardViewport {
  w: number;
  h: number;
  origin: [number, number];
  zoom: number;
  /** The fold's band, in camera points, on an open foldable. */
  hinge?: [number, number];
  /** Chrome on the trailing edge (the clock strip), in camera points. */
  strip?: [number, number];
  /** The closed camera's size, on a foldable. */
  closed?: { w: number; h: number };
}

/** The camera a supervisor turn assumes when the Blob app sent none: the
 *  closed Duo's board-visible area at the home position. */
export const DEFAULT_BOARD_VIEWPORT: BoardViewport = {
  w: DUO_CLOSED.w,
  h: DUO_CLOSED.h,
  origin: [0, 0],
  zoom: 1,
  closed: { w: DUO_CLOSED.w, h: DUO_CLOSED.h },
};

// ── Refs ────────────────────────────────────────────────────────────────────

const PROJECT = "[A-Za-z0-9][A-Za-z0-9._-]{0,79}";
/** A supervisor inbox item id (supervisor-inbox.ts: `si-<uuid>`). */
const ITEM_REF = /^(si-[A-Za-z0-9-]{1,76})$/;
const REF_PATTERNS: Record<ProjectRefKind, RegExp> = {
  pr: new RegExp(`^(${PROJECT})#(\\d{1,7})$`),
  check: new RegExp(`^(${PROJECT})#(\\d{1,7})/([A-Za-z0-9 ._():/-]{1,80})$`),
  incident: new RegExp(`^(${PROJECT})/([A-Za-z0-9_-]{1,80})$`),
  thread: new RegExp(`^(${PROJECT})/([A-Za-z0-9_-]{1,80})$`),
  release: new RegExp(`^(${PROJECT})@([A-Za-z0-9._+-]{1,40})$`),
  project: new RegExp(`^(${PROJECT})$`),
};

export type ParsedRef =
  | {
      kind: ProjectRefKind;
      project: string;
      /** PR number for pr and check. */
      number?: number;
      /** Check name, incident id, conversation id or release version. */
      name?: string;
    }
  | {
      kind: "item";
      /** The supervisor inbox item's id, in the owner's own inbox. */
      id: string;
    };

/**
 * `kind:locator`, or null. Locators: `pr:<project>#<n>`,
 * `check:<project>#<n>/<check name>`, `incident:<project>/<id>`,
 * `thread:<project>/<conversation id>`, `release:<project>@<version>`,
 * `project:<project>`, `item:<inbox item id>`.
 */
export function parseRef(ref: string): ParsedRef | null {
  if (ref.length > BOARD_LIMITS.refChars) return null;
  const colon = ref.indexOf(":");
  if (colon < 1) return null;
  const kind = ref.slice(0, colon) as RefKind;
  if (!REF_KINDS.includes(kind)) return null;
  if (kind === "item") {
    const item = ITEM_REF.exec(ref.slice(colon + 1));
    return item ? { kind, id: item[1]! } : null;
  }
  const match = REF_PATTERNS[kind].exec(ref.slice(colon + 1));
  if (!match) return null;
  const project = match[1]!;
  if (kind === "pr") return { kind, project, number: Number(match[2]) };
  if (kind === "check")
    return { kind, project, number: Number(match[2]), name: match[3] };
  if (kind === "project") return { kind, project };
  return { kind, project, name: match[2] };
}

/** A ref resolved to its live fields, or why it shows as plain text.
 *  An object the owner may not see reads exactly like one that is gone. */
export type ResolvedRef =
  | {
      ok: true;
      kind: RefKind;
      title: string;
      status: string;
      statusTone: BoardToken;
      url?: string;
      updatedAt?: string;
      /** Kind-specific fields (`number`, `checks`, `openFor`). */
      fields: Record<string, string>;
    }
  | { ok: false; reason: "not-found" | "limit" | "unavailable" };

// ── Schema ──────────────────────────────────────────────────────────────────

// The characters push text strips (controls, bidi, line separators) are
// refused here, so the board shows what its text says.
const line = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => !hasUnsafeTextChars(s), "one line of plain text");

/**
 * Where a board image may load from: this server's own media routes, as
 * same-origin paths. No external host in v1, so a board never makes the
 * owner's client fetch a URL the model wrote. To allow a host later, add an
 * exact `^https://<host>/` pattern to BOARD_IMAGE_ROUTES (https only, no
 * wildcards), allow the host in the clients' img-src, and name it in
 * docs/security-model.md.
 */
export const BOARD_IMAGE_ROUTES: readonly RegExp[] = [
  // routes/plain.ts: a Plain thread's attachment.
  /^\/api\/plain\/attachments\/[A-Za-z0-9_-]{1,120}$/,
  // routes/support.ts: an email conversation's attachment.
  /^\/api\/support\/conversations\/[A-Za-z0-9_-]{1,120}\/attachments\/[A-Za-z0-9_-]{1,120}$/,
  // routes/media.ts: a GitHub user attachment of a registered repo.
  /^\/gh-asset\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\?repo=[A-Za-z0-9._-]{1,120}$/i,
];

/** routes/media.ts: `/media?path=<absolute path>` (encoded or not, an
 *  optional `v`), no traversal. */
function isOwnMediaPath(src: string): boolean {
  if (!src.startsWith("/media?")) return false;
  let params: URLSearchParams;
  try {
    params = new URL(src, "http://board.invalid").searchParams;
  } catch {
    return false;
  }
  if ([...params.keys()].some((k) => k !== "path" && k !== "v")) return false;
  const path = params.get("path") ?? "";
  return (
    path.startsWith("/") &&
    !path.startsWith("//") &&
    !path.includes("..") &&
    !/\s/.test(path)
  );
}

export function isBoardImageSource(src: string): boolean {
  return (
    isOwnMediaPath(src) ||
    BOARD_IMAGE_ROUTES.some((pattern) => pattern.test(src))
  );
}

const id = z
  .string()
  .regex(
    new RegExp(`^[A-Za-z0-9-]{1,${BOARD_LIMITS.idChars}}$`),
    "letters, digits and -",
  );
const coord = z
  .number()
  .finite()
  .min(-BOARD_LIMITS.size)
  .max(2 * BOARD_LIMITS.size);
const size = z.number().finite().min(1).max(BOARD_LIMITS.elementSize);
const token = z.enum(BOARD_PALETTE);
const style = z.strictObject({
  stroke: token.optional(),
  fill: token.optional(),
  color: token.optional(),
});
const ref = z
  .string()
  .max(BOARD_LIMITS.refChars)
  .refine(
    (r) => parseRef(r) !== null,
    "a ref is kind:locator, e.g. pr:acme#12, check:acme#12/ci, incident:acme/inc-1, thread:acme/sc_1, release:acme@1.2.0, project:acme, item:si-<inbox item id>",
  );
const zIndex = z.number().int().min(-1000).max(1000);
const fraction = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]);
const point = z.tuple([coord, coord]);
const rel = z
  .number()
  .finite()
  .min(-BOARD_LIMITS.elementSize)
  .max(BOARD_LIMITS.elementSize);
const relPoint = z.tuple([rel, rel]);

const box = { id, x: coord, y: coord, w: size, h: size, z: zIndex.optional() };

export const frameSchema = z.strictObject({
  ...box,
  type: z.literal("frame"),
  style: style.optional(),
  ref: ref.optional(),
  title: line(BOARD_LIMITS.titleChars).optional(),
  /** This frame is the region of one of the owner's projects. */
  region: z
    .string()
    .regex(new RegExp(`^${PROJECT}$`))
    .optional(),
});

export const textSchema = z.strictObject({
  ...box,
  h: size.optional(),
  type: z.literal("text"),
  style: style.optional(),
  ref: ref.optional(),
  role: z.enum(TEXT_ROLES),
  text: line(BOARD_LIMITS.textChars).optional(),
  sub: line(BOARD_LIMITS.subChars).optional(),
  status: line(BOARD_LIMITS.statusChars).optional(),
});

export const shapeSchema = z.strictObject({
  ...box,
  type: z.literal("shape"),
  style: style.optional(),
  ref: ref.optional(),
  kind: z.enum(SHAPE_KINDS),
  points: z.array(relPoint).min(2).max(BOARD_LIMITS.linePoints).optional(),
});

const arrowEnd = z.union([
  z.strictObject({
    id,
    side: z.union([z.enum(BOARD_SIDES), fraction]).optional(),
  }),
  z.strictObject({ x: coord, y: coord }),
]);

export const arrowSchema = z.strictObject({
  id,
  type: z.literal("arrow"),
  z: zIndex.optional(),
  style: style.optional(),
  start: arrowEnd,
  end: arrowEnd,
  bend: z.number().min(-0.5).max(0.5).optional(),
  label: line(BOARD_LIMITS.labelChars).optional(),
});

export const strokeSchema = z.strictObject({
  ...box,
  type: z.literal("stroke"),
  style: style.optional(),
  points: z.array(relPoint).min(2).max(BOARD_LIMITS.strokePoints),
});

export const imageSchema = z.strictObject({
  ...box,
  type: z.literal("image"),
  ref: ref.optional(),
  src: z
    .string()
    .max(BOARD_LIMITS.srcChars)
    .refine(
      isBoardImageSource,
      "one of this server's media paths (/media?path=<absolute path>, /api/plain/attachments/<id>, /api/support/conversations/<id>/attachments/<id>, /gh-asset/<id>?repo=<repo>); no external URLs",
    ),
  fit: z.enum(["contain", "cover"]).optional(),
  alt: line(BOARD_LIMITS.altChars).optional(),
});

const NOTE_MARKUP = /[*_`#<>[\]{}|~]/;
export const noteSchema = z.strictObject({
  id,
  type: z.literal("note"),
  z: zIndex.optional(),
  anchor: z.strictObject({
    id,
    side: z.enum(NOTE_SIDES),
    dx: z.number().finite().min(-400).max(400).optional(),
    dy: z.number().finite().min(-400).max(400).optional(),
  }),
  text: line(BOARD_LIMITS.noteChars)
    .refine(
      (s) => s.trim().split(/\s+/).length <= BOARD_LIMITS.noteWords,
      `a note is at most ${BOARD_LIMITS.noteWords} words; put more in a text element`,
    )
    .refine((s) => !NOTE_MARKUP.test(s), "a note is plain text, no markup"),
  leader: z
    .union([
      z.boolean(),
      z.strictObject({
        to: z.union([z.enum(BOARD_SIDES), fraction]).optional(),
        bend: z.number().min(-0.5).max(0.5).optional(),
      }),
    ])
    .optional(),
});

export const boardElementSchema = z.discriminatedUnion("type", [
  frameSchema,
  textSchema,
  shapeSchema,
  arrowSchema,
  strokeSchema,
  imageSchema,
  noteSchema,
]);

export type FrameElement = z.infer<typeof frameSchema>;
export type TextElement = z.infer<typeof textSchema>;
export type ShapeElement = z.infer<typeof shapeSchema>;
export type ArrowElement = z.infer<typeof arrowSchema>;
export type StrokeElement = z.infer<typeof strokeSchema>;
export type ImageElement = z.infer<typeof imageSchema>;
export type NoteElement = z.infer<typeof noteSchema>;
export type BoardElement = z.infer<typeof boardElementSchema>;
export type ArrowEnd = ArrowElement["start"];

export const BOARD_ELEMENT_TYPES = [
  "frame",
  "text",
  "shape",
  "arrow",
  "stroke",
  "image",
  "note",
] as const;

/** A stored board. `revision` 0 is the empty board nobody wrote yet. */
export interface Board {
  schema: typeof BOARD_SCHEMA;
  revision: number;
  /** ms */
  updatedAt: number;
  elements: BoardElement[];
}

export function emptyBoard(): Board {
  return { schema: BOARD_SCHEMA, revision: 0, updatedAt: 0, elements: [] };
}

function issueText(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid";
  // A discriminated union reports the closest member's issue; the path is
  // the field, the message says what it needs.
  const path = issue.path.filter((p) => typeof p !== "symbol").join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

const REF_FIELD_TOKEN = /\{ref\.([A-Za-z]+)\}/g;
const SKETCHY = new Set(["arrow", "stroke", "shape"]);

/** Parse one element against the strict schema and the rules the schema
 *  can't say: `{ref.field}` only with a ref, sketch marks in ink. */
export function parseBoardElement(
  raw: unknown,
): { ok: true; el: BoardElement } | { ok: false; error: string } {
  const parsed = boardElementSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: issueText(parsed.error) };
  const el = parsed.data;
  if (el.type === "text") {
    for (const value of [el.text, el.sub, el.status]) {
      if (!value) continue;
      for (const match of value.matchAll(REF_FIELD_TOKEN)) {
        if (!el.ref)
          return { ok: false, error: `{ref.${match[1]}} needs a ref` };
        if (!(REF_FIELDS as readonly string[]).includes(match[1]!))
          return {
            ok: false,
            error: `unknown live field {ref.${match[1]}}; use ${REF_FIELDS.join(", ")}`,
          };
      }
    }
  }
  if (SKETCHY.has(el.type) && !("ref" in el && el.ref)) {
    const s = "style" in el ? el.style : undefined;
    if ((s?.stroke && s.stroke !== "ink") || (s?.color && s.color !== "ink"))
      return {
        ok: false,
        error:
          "sketch marks are ink: a shape without a ref, an arrow or a stroke takes stroke and color ink only",
      };
  }
  return { ok: true, el };
}

/** Whether an element carries the board's one accent. */
export function usesTangerine(el: BoardElement): boolean {
  const s = "style" in el ? el.style : undefined;
  return !!s && Object.values(s).includes("tangerine");
}

// ── Geometry ────────────────────────────────────────────────────────────────

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const NOTE_GAP = 8;
const NOTE_LINE = 20;
const NOTE_MAX_W = 180;
const NOTE_CHAR_W = 8;

/** A text element's height: given, a ref card's, or its role's line plus
 *  a sub line. */
export function textHeight(el: TextElement): number {
  if (el.h !== undefined) return el.h;
  if (el.ref) return REF_CARD.minH;
  return TEXT_LINE_HEIGHT[el.role] + (el.sub ? 16 : 0);
}

// ── Text fit ────────────────────────────────────────────────────────────────
// The app measures every text element in its role's font and widens a box
// its words don't fit, or wraps them and grows it, moving what it would
// cover. The server can't measure, so it estimates (the same table as the
// app's BlobCore `BoardTextMetrics`): on apply it widens a touched text
// that would wrap when there is room, and board_read lists text that
// likely overflows or collides, so the model fixes it by id.

/** A ref element is a card: 12 pt before an 8 pt status dot, 10 after it,
 *  14 trailing; 10 above and below; a title and a status line at least. */
export const REF_CARD = { padX: 44, padY: 20, minH: 58 } as const;
/** The band at the top of a frame its title sits in: what the frame holds
 *  starts below it. */
export const FRAME_TITLE_BAND = 28;
/** Where text in the leading column stops widening: the closed Duo's
 *  board edge, so it stays on screen closed. */
const CLOSED_EDGE = DUO_CLOSED.w;
/** The open Duo's board edge (its strip). */
const OPEN_EDGE = DUO_OPEN.strip[0];

/** A character's width in ems of SF Pro, by class: close to the real face
 *  at the board's sizes, a little generous so an estimate wraps no later
 *  than the real text. */
export function charEm(ch: string): number {
  if (ch === " ") return 0.25;
  if ("ilj!'.,:;|·()[]".includes(ch)) return 0.27;
  if ("ftrI-/".includes(ch)) return 0.35;
  if (ch === "m" || ch === "w") return 0.8;
  if (ch === "M" || ch === "W") return 0.85;
  if (ch >= "0" && ch <= "9") return 0.58;
  if (ch >= "A" && ch <= "Z") return 0.65;
  if (ch >= "a" && ch <= "z") return 0.53;
  return ch.charCodeAt(0) < 128 ? 0.55 : 0.9;
}

/** One line of `text` in `role`, in points. */
export function estimateTextWidth(text: string, role: TextRole): number {
  let ems = 0;
  for (const ch of text) ems += charEm(ch);
  return ems * TEXT_SIZE[role] * (role === "title" ? 1.04 : 1);
}

/** How many lines greedy word wrap takes at `width`. */
export function wrappedLines(
  text: string,
  role: TextRole,
  width: number,
): number {
  const space = estimateTextWidth(" ", role);
  let lines = 1;
  let used = 0;
  for (const word of text.split(" ").filter(Boolean)) {
    const w = estimateTextWidth(word, role);
    if (used === 0) used = w;
    else if (used + space + w <= width) used += space + w;
    else {
      lines += 1;
      used = w;
    }
    while (used > width) {
      lines += 1;
      used -= width;
    }
  }
  return lines;
}

/** The words a text element shows: its main line in its role, and the
 *  supporting line (status · sub). A ref is a card with its live title
 *  and status; without the live fields (on apply) only its own words
 *  count. */
function textLines(
  el: TextElement,
  ref?: ResolvedRef,
): { main?: string; role: TextRole; tail?: string; card: boolean } {
  const live = ref && ref.ok ? ref : undefined;
  const fill = (s: string) =>
    s.replace(/\{ref\.([a-zA-Z]+)\}/g, (_, name: string) => {
      if (!live) return "";
      if (name === "title") return live.title;
      if (name === "status") return live.status;
      if (name === "statusTone") return live.statusTone;
      if (name === "url") return live.url ?? "";
      if (name === "updatedAt") return live.updatedAt ?? "";
      return live.fields[name] ?? "";
    });
  if (!el.ref) {
    const tail = [el.status, el.sub].filter(Boolean).join(" · ");
    return {
      main: el.text,
      role: el.role,
      tail: tail || undefined,
      card: false,
    };
  }
  const main = (el.text ? fill(el.text) : "") || live?.title;
  const status = el.status ? fill(el.status) : live?.status;
  const sub = el.sub ? fill(el.sub) : undefined;
  const tail = [status, sub].filter(Boolean).join(" · ");
  return { main, role: "title", tail: tail || undefined, card: true };
}

/** What a text element needs: its width on one line, and its height at a
 *  given width, padding included. */
export function textNeeds(
  el: TextElement,
  ref?: ResolvedRef,
): { oneLine: number; heightAt(width: number): number } {
  const t = textLines(el, ref);
  const pad = t.card ? REF_CARD.padX : 0;
  const oneLine =
    Math.max(
      t.main ? estimateTextWidth(t.main, t.role) : 0,
      t.tail ? estimateTextWidth(t.tail, "supporting") : 0,
    ) + pad;
  return {
    oneLine,
    heightAt(width: number) {
      const inner = Math.max(1, width - pad);
      const main = t.main
        ? wrappedLines(t.main, t.role, inner) * TEXT_LINE_HEIGHT[t.role]
        : 0;
      const tail = t.tail
        ? wrappedLines(t.tail, "supporting", inner) *
          TEXT_LINE_HEIGHT.supporting
        : 0;
      const gap = t.main && t.tail ? 2 : 0;
      return main + tail + gap + (t.card ? REF_CARD.padY : 0);
    },
  };
}

/** The frame an element sits in: the smallest whose box holds its
 *  top-left corner. */
function containingFrame(
  el: BoardElement,
  b: Box,
  els: Iterable<BoardElement>,
): FrameElement | undefined {
  let best: FrameElement | undefined;
  for (const f of els) {
    if (f.type !== "frame" || f.id === el.id) continue;
    if (b.x < f.x - 0.5 || b.y < f.y - 0.5) continue;
    if (b.x >= f.x + f.w || b.y >= f.y + f.h) continue;
    if (el.type === "frame" && f.w * f.h <= b.w * b.h) continue;
    if (!best || f.w * f.h < best.w * best.h) best = f;
  }
  return best;
}

function isAncestorFrame(
  frame: BoardElement,
  el: BoardElement,
  els: ReadonlyMap<string, BoardElement>,
): boolean {
  let current: BoardElement | undefined = el;
  for (let depth = 0; current && depth < 8; depth++) {
    const b = elementBox(current, els);
    if (!b) return false;
    const parent = containingFrame(current, b, els.values());
    if (!parent) return false;
    if (parent.id === frame.id) return true;
    current = parent;
  }
  return false;
}

/** What text must not overlap: text, frames, images and ref shapes. */
function isSolid(el: BoardElement): boolean {
  return (
    el.type === "text" ||
    el.type === "frame" ||
    el.type === "image" ||
    (el.type === "shape" && !!el.ref)
  );
}

/** The right edge a text element may widen to: its frame's inner edge,
 *  its column (the closed view, then the fold, then the open Duo's strip)
 *  and the next solid element on its right. */
export function textRoom(
  el: TextElement,
  els: ReadonlyMap<string, BoardElement>,
  bands: Array<[number, number]> = [DUO_OPEN.hinge],
): number {
  const fold = bands[0] ?? DUO_OPEN.hinge;
  const right = el.x + el.w;
  let edge =
    el.x < CLOSED_EDGE
      ? CLOSED_EDGE
      : el.x < fold[0]
        ? fold[0]
        : el.x < OPEN_EDGE
          ? OPEN_EDGE
          : el.x + Math.max(el.w, 480);
  edge = Math.max(edge, right);
  if (el.x < fold[0]) edge = Math.min(edge, Math.max(right, fold[0]));
  const box: Box = { x: el.x, y: el.y, w: el.w, h: textHeight(el) };
  const frame = containingFrame(el, box, els.values());
  if (frame)
    edge = Math.min(
      edge,
      frame.x + frame.w - Math.max(4, Math.min(12, el.x - frame.x)),
    );
  for (const other of els.values()) {
    if (other.id === el.id || !isSolid(other)) continue;
    if (other.type === "frame" && isAncestorFrame(other, el, els)) continue;
    const o = elementBox(other, els);
    if (!o) continue;
    if (o.y < box.y + box.h && o.y + o.h > box.y && o.x >= right - 0.5)
      edge = Math.min(edge, o.x - 8);
  }
  return edge;
}

/** Something on the board the owner would see clipped or colliding. */
export interface TextIssue {
  id: string;
  kind: "overflow" | "overlap" | "title-band" | "past-frame";
  /** One line for the model, with the fix. */
  detail: string;
}

/**
 * Text that likely overflows or collides, estimated with the char width
 * table: words wider than the box with no room to widen, a card or wrapped
 * text taller than its box, text running into another element below it or
 * past its frame's bottom, and text in a frame's title band. `refs` gives
 * cards their live titles (board_read has them; apply doesn't).
 */
export function boardTextIssues(
  elements: readonly BoardElement[],
  refs: Readonly<Record<string, ResolvedRef>> = {},
  viewport?: BoardViewport,
): TextIssue[] {
  const els = new Map(elements.map((e) => [e.id, e]));
  const bands = hingeBands(viewport);
  const issues: TextIssue[] = [];
  const grown = new Map<string, Box>();
  for (const el of elements) {
    if (el.type !== "text") continue;
    const needs = textNeeds(el, el.ref ? refs[el.ref] : undefined);
    const h = textHeight(el);
    const room = textRoom(el, els, bands) - el.x;
    const width = Math.max(el.w, Math.min(room, Math.ceil(needs.oneLine)));
    const needH = needs.heightAt(width);
    if (needs.oneLine > el.w + 0.5) {
      const fix =
        room >= needs.oneLine
          ? `set w to ${Math.ceil(needs.oneLine)}`
          : `shorten it, or set w ${Math.floor(width)} and h ${Math.ceil(needH)}`;
      issues.push({
        id: el.id,
        kind: "overflow",
        detail: `${el.id}: its words need about ${Math.ceil(needs.oneLine)} pt on one line at ${el.ref ? "card" : el.role} size, its box is ${round(el.w)} wide; ${fix}`,
      });
    } else if (needH > h + 0.5) {
      issues.push({
        id: el.id,
        kind: "overflow",
        detail: `${el.id}: ${el.ref ? "a card" : "its words"} need about ${Math.ceil(needH)} pt of height, its box is ${round(h)}; set h ${Math.ceil(needH)}`,
      });
    }
    grown.set(el.id, {
      x: el.x,
      y: el.y,
      w: width,
      h: Math.max(h, needH),
    });
  }
  for (const el of elements) {
    if (el.type !== "text") continue;
    const b = grown.get(el.id)!;
    const frame = containingFrame(el, b, els.values());
    if (frame?.title && b.y < frame.y + FRAME_TITLE_BAND - 0.5)
      issues.push({
        id: el.id,
        kind: "title-band",
        detail: `${el.id} sits in ${frame.id}'s title band; move it to y ${round(frame.y + FRAME_TITLE_BAND)} or lower`,
      });
    if (frame && b.y + b.h > frame.y + frame.h + 0.5)
      issues.push({
        id: el.id,
        kind: "past-frame",
        detail: `${el.id} runs past the bottom of ${frame.id} (to y ${Math.ceil(b.y + b.h)}); grow ${frame.id} to h ${Math.ceil(b.y + b.h + 8 - frame.y)} and move what is under it`,
      });
    for (const other of elements) {
      if (other.id === el.id || !isSolid(other)) continue;
      if (other.type === "frame" && isAncestorFrame(other, el, els)) continue;
      const o = grown.get(other.id) ?? elementBox(other, els);
      if (!o || o.y < b.y || (o.y === b.y && other.id < el.id)) continue;
      const ox = Math.min(b.x + b.w, o.x + o.w) - Math.max(b.x, o.x);
      const oy = Math.min(b.y + b.h, o.y + o.h) - Math.max(b.y, o.y);
      if (ox > 0.5 && oy > 0.5)
        issues.push({
          id: el.id,
          kind: "overlap",
          detail: `${el.id} runs into ${other.id}; move ${other.id} down to y ${Math.ceil(b.y + b.h + 6)}`,
        });
    }
  }
  return issues;
}

/** A note's size as the engine estimates it: Kalam 16/20, two lines at
 *  most. Clients measure the real text; this is for the layout guard. */
export function noteSize(text: string): { w: number; h: number } {
  const width = text.length * NOTE_CHAR_W + 4;
  return {
    w: Math.min(NOTE_MAX_W, width),
    h: width > NOTE_MAX_W ? 2 * NOTE_LINE : NOTE_LINE,
  };
}

/** Where a note sits: outside its anchor's side, 8 pt away, then shifted
 *  by dx, dy. */
export function noteBox(note: NoteElement, anchor: Box): Box {
  const { w, h } = noteSize(note.text);
  const midX = anchor.x + anchor.w / 2;
  const midY = anchor.y + anchor.h / 2;
  let x: number;
  let y: number;
  switch (note.anchor.side) {
    case "top":
      x = midX - w / 2;
      y = anchor.y - NOTE_GAP - h;
      break;
    case "bottom":
      x = midX - w / 2;
      y = anchor.y + anchor.h + NOTE_GAP;
      break;
    case "left":
      x = anchor.x - NOTE_GAP - w;
      y = midY - h / 2;
      break;
    default:
      x = anchor.x + anchor.w + NOTE_GAP;
      y = midY - h / 2;
  }
  return { x: x + (note.anchor.dx ?? 0), y: y + (note.anchor.dy ?? 0), w, h };
}

/** An element's box on the board; arrows have none of their own. */
export function elementBox(
  el: BoardElement,
  byId: ReadonlyMap<string, BoardElement>,
  depth = 0,
): Box | undefined {
  switch (el.type) {
    case "arrow":
      return undefined;
    case "note": {
      const anchor = byId.get(el.anchor.id);
      if (!anchor || depth > 4) return undefined;
      const a = elementBox(anchor, byId, depth + 1);
      return a ? noteBox(el, a) : undefined;
    }
    case "text":
      return { x: el.x, y: el.y, w: el.w, h: textHeight(el) };
    default:
      return { x: el.x, y: el.y, w: el.w, h: el.h };
  }
}

/** Elements that read as text: the hinge rule keeps them off the fold. */
function carriesText(el: BoardElement): boolean {
  if (el.type === "text" || el.type === "note") return true;
  return el.type !== "frame" && "ref" in el && !!el.ref;
}

/** The band(s) text stays off, in board points: the home camera's fold
 *  (the Duo's, or the hint's own) and the fold where the current camera
 *  puts it. */
export function hingeBands(viewport?: BoardViewport): Array<[number, number]> {
  const home: [number, number] = viewport?.hinge ?? DUO_OPEN.hinge;
  const bands: Array<[number, number]> = [home];
  if (viewport?.hinge) {
    const zoom = viewport.zoom > 0 ? viewport.zoom : 1;
    const at: [number, number] = [
      viewport.origin[0] + viewport.hinge[0] / zoom,
      viewport.origin[0] + viewport.hinge[1] / zoom,
    ];
    if (Math.abs(at[0] - home[0]) > 0.5 || Math.abs(at[1] - home[1]) > 0.5)
      bands.push(at);
  }
  return bands;
}

/** The board rectangle the camera shows, without the trailing strip. */
export function visibleRect(viewport: BoardViewport): Box {
  const zoom = viewport.zoom > 0 ? viewport.zoom : 1;
  const width = viewport.strip ? viewport.strip[0] : viewport.w;
  return {
    x: viewport.origin[0],
    y: viewport.origin[1],
    w: width / zoom,
    h: viewport.h / zoom,
  };
}

function overlaps(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  );
}

/** The smallest horizontal move that takes [x, x+w] off the band: to the
 *  nearer side, rightwards when the left side has no room. */
export function hingeShift(
  x: number,
  w: number,
  band: [number, number],
): number {
  const [a, b] = band;
  if (!(x < b && x + w > a)) return 0;
  const left = a - (x + w);
  const right = b - x;
  if (x + left < 0) return right;
  return Math.abs(left) <= Math.abs(right) ? left : right;
}

const round = (n: number) => Math.round(n * 2) / 2;

// ── Ops ─────────────────────────────────────────────────────────────────────

const opSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("add"),
    el: z.record(z.string(), z.unknown()),
  }),
  z.strictObject({
    op: z.literal("update"),
    id,
    set: z.record(z.string(), z.unknown()),
  }),
  z.strictObject({ op: z.literal("move"), id, x: coord, y: coord }),
  z.strictObject({ op: z.literal("remove"), id }),
  z.strictObject({
    op: z.literal("clear"),
    keep: z.array(id).max(BOARD_LIMITS.elements).optional(),
  }),
]);
export type BoardOp = z.infer<typeof opSchema>;

export interface ApplyReport {
  /** Added, updated or moved, still on the board. */
  touched: string[];
  /** Removed by a remove or clear op. */
  removed: string[];
  /** Arrows and notes removed with the element they were bound to. */
  cascaded: Array<{ id: string; with: string }>;
  /** Text the engine moved off the hinge band. */
  nudged: Array<{ id: string; dx: number }>;
  /** Text the engine widened so its words fit one line. */
  widened: Array<{ id: string; w: number }>;
  /** Text the engine made taller: its words wrap, or it is a card. */
  grown: Array<{ id: string; h: number }>;
  /** Elements the engine moved below their frame's title band. */
  belowTitle: Array<{ id: string; y: number }>;
  /** Touched text that still overflows or collides, for the model to fix. */
  issues: TextIssue[];
  /** Elements pulled back inside the board. */
  clamped: string[];
  /** Touched elements outside what the camera shows now. */
  offCamera: string[];
  /** Fields the engine dropped (a note's style). */
  dropped: string[];
}

export type ApplyResult =
  | { ok: true; elements: BoardElement[]; report: ApplyReport }
  | { ok: false; error: string };

function opLabel(op: BoardOp, index: number): string {
  const target =
    op.op === "add"
      ? typeof op.el.id === "string"
        ? op.el.id
        : ""
      : op.op === "clear"
        ? ""
        : op.id;
  return `op ${index + 1} (${op.op}${target ? ` ${target}` : ""})`;
}

/**
 * Apply ops in order, atomically: any refused op refuses the batch, and the
 * error names it. `remove` drops the arrows and notes bound to the element
 * (and theirs, in turn) and reports them. After the ops, every binding must
 * resolve, the board stays within its counts, carries at most one Tangerine
 * element and one region frame per project. Then only the touched elements
 * are clamped to the board and nudged off the hinge band.
 */
export function applyBoardOps(
  current: readonly BoardElement[],
  rawOps: unknown,
  viewport?: BoardViewport,
): ApplyResult {
  if (!Array.isArray(rawOps) || rawOps.length === 0)
    return { ok: false, error: "ops must be a non-empty list" };
  if (rawOps.length > BOARD_LIMITS.ops)
    return { ok: false, error: `at most ${BOARD_LIMITS.ops} ops per apply` };
  const els = new Map<string, BoardElement>(current.map((e) => [e.id, e]));
  const touched = new Set<string>();
  const report: ApplyReport = {
    touched: [],
    removed: [],
    cascaded: [],
    nudged: [],
    widened: [],
    grown: [],
    belowTitle: [],
    issues: [],
    clamped: [],
    offCamera: [],
    dropped: [],
  };

  const removeCascade = (root: string) => {
    const queue = [root];
    els.delete(root);
    touched.delete(root);
    while (queue.length) {
      const gone = queue.shift()!;
      for (const el of [...els.values()]) {
        const bound =
          (el.type === "arrow" &&
            (("id" in el.start && el.start.id === gone) ||
              ("id" in el.end && el.end.id === gone))) ||
          (el.type === "note" && el.anchor.id === gone);
        if (!bound) continue;
        els.delete(el.id);
        touched.delete(el.id);
        report.cascaded.push({ id: el.id, with: root });
        queue.push(el.id);
      }
    }
  };

  for (const [index, raw] of rawOps.entries()) {
    const parsed = opSchema.safeParse(raw);
    if (!parsed.success)
      return {
        ok: false,
        error: `op ${index + 1}: ${issueText(parsed.error)}`,
      };
    const op = parsed.data;
    const label = opLabel(op, index);
    if (op.op === "add") {
      let source = op.el;
      if (source.type === "note" && "style" in source) {
        const { style: _style, ...rest } = source;
        source = rest;
        report.dropped.push(`${String(source.id)}.style (notes are ink)`);
      }
      const el = parseBoardElement(source);
      if (!el.ok) return { ok: false, error: `${label}: ${el.error}` };
      if (els.has(el.el.id))
        return {
          ok: false,
          error: `${label}: ${el.el.id} is already on the board; update it instead`,
        };
      els.set(el.el.id, el.el);
      touched.add(el.el.id);
    } else if (op.op === "update") {
      const existing = els.get(op.id);
      if (!existing)
        return { ok: false, error: `${label}: no element ${op.id}` };
      if ("id" in op.set || "type" in op.set)
        return {
          ok: false,
          error: `${label}: id and type can't change; remove it and add a new one`,
        };
      const merged: Record<string, unknown> = { ...existing };
      for (const [key, value] of Object.entries(op.set)) {
        if (value === null) delete merged[key];
        else merged[key] = value;
      }
      if (existing.type === "note" && "style" in merged) {
        delete merged.style;
        report.dropped.push(`${op.id}.style (notes are ink)`);
      }
      const el = parseBoardElement(merged);
      if (!el.ok) return { ok: false, error: `${label}: ${el.error}` };
      els.set(op.id, el.el);
      touched.add(op.id);
    } else if (op.op === "move") {
      const existing = els.get(op.id);
      if (!existing)
        return { ok: false, error: `${label}: no element ${op.id}` };
      if (existing.type === "note")
        return {
          ok: false,
          error: `${label}: a note follows its anchor; update anchor.dx and anchor.dy instead`,
        };
      if (existing.type === "arrow") {
        const free = [existing.start, existing.end].find((end) => "x" in end);
        if (!free || !("x" in free))
          return {
            ok: false,
            error: `${label}: a bound arrow follows its elements; move them instead`,
          };
        const dx = op.x - free.x;
        const dy = op.y - free.y;
        const shift = (end: ArrowEnd): ArrowEnd =>
          "x" in end ? { x: end.x + dx, y: end.y + dy } : end;
        els.set(op.id, {
          ...existing,
          start: shift(existing.start),
          end: shift(existing.end),
        });
      } else {
        els.set(op.id, { ...existing, x: op.x, y: op.y });
      }
      touched.add(op.id);
    } else if (op.op === "remove") {
      if (!els.has(op.id))
        return { ok: false, error: `${label}: no element ${op.id}` };
      removeCascade(op.id);
      report.removed.push(op.id);
    } else {
      const keep = new Set(op.keep ?? []);
      for (const kept of keep)
        if (!els.has(kept))
          return {
            ok: false,
            error: `${label}: keep names ${kept}, which is not on the board`,
          };
      for (const el of [...els.values()]) {
        if (keep.has(el.id) || !els.has(el.id)) continue;
        removeCascade(el.id);
        report.removed.push(el.id);
      }
      // A kept arrow or note whose element went loses it too, reported as
      // cascaded with what took it.
    }
  }

  // Whole-board rules.
  if (els.size > BOARD_LIMITS.elements)
    return {
      ok: false,
      error: `the board holds at most ${BOARD_LIMITS.elements} elements; remove some first`,
    };
  let tangerine = 0;
  const regions = new Map<string, string>();
  for (const el of els.values()) {
    if (usesTangerine(el) && ++tangerine > 1)
      return {
        ok: false,
        error:
          "one tangerine element per board: it marks the one thing that needs the owner",
      };
    if (el.type === "frame" && el.region) {
      const other = regions.get(el.region);
      if (other)
        return {
          ok: false,
          error: `${el.id}: ${other} is already the region of ${el.region}`,
        };
      regions.set(el.region, el.id);
    }
    if (el.type === "arrow") {
      for (const end of [el.start, el.end]) {
        if (!("id" in end)) continue;
        const target = els.get(end.id);
        if (!target)
          return {
            ok: false,
            error: `arrow ${el.id} binds to ${end.id}, which is not on the board`,
          };
        if (target.type === "arrow")
          return {
            ok: false,
            error: `arrow ${el.id} can't bind to another arrow (${end.id})`,
          };
      }
    }
    if (el.type === "note") {
      const anchor = els.get(el.anchor.id);
      if (!anchor)
        return {
          ok: false,
          error: `note ${el.id} is anchored to ${el.anchor.id}, which is not on the board`,
        };
      if (anchor.type === "arrow" || anchor.type === "note")
        return {
          ok: false,
          error: `note ${el.id} anchors to an element, not an ${anchor.type}`,
        };
    }
  }

  // Layout guard: only what this apply touched moves.
  const bands = hingeBands(viewport);
  const max = BOARD_LIMITS.size;
  const clamp = (v: number, lo: number, hi: number) =>
    Math.min(Math.max(v, lo), hi);
  for (const tid of touched) {
    let el = els.get(tid);
    if (!el) continue;
    if (el.type === "arrow") {
      const fix = (end: ArrowEnd): ArrowEnd =>
        "x" in end ? { x: clamp(end.x, 0, max), y: clamp(end.y, 0, max) } : end;
      const next = { ...el, start: fix(el.start), end: fix(el.end) };
      if (JSON.stringify(next) !== JSON.stringify(el)) report.clamped.push(tid);
      els.set(tid, next);
      continue;
    }
    if (el.type === "note") {
      const anchor = els.get(el.anchor.id);
      const a = anchor && elementBox(anchor, els);
      if (!a) continue;
      let b = noteBox(el, a);
      let dx = el.anchor.dx ?? 0;
      let dy = el.anchor.dy ?? 0;
      const cx = clamp(b.x, 0, max - b.w) - b.x;
      const cy = clamp(b.y, 0, max - b.h) - b.y;
      if (cx || cy) report.clamped.push(tid);
      dx += cx;
      dy += cy;
      b = { ...b, x: b.x + cx, y: b.y + cy };
      let nudge = 0;
      for (let pass = 0; pass < 3; pass++)
        for (const band of bands) {
          const s = hingeShift(b.x, b.w, band);
          if (!s) continue;
          b = { ...b, x: b.x + s };
          nudge += s;
        }
      if (nudge) {
        dx += nudge;
        report.nudged.push({ id: tid, dx: round(nudge) });
      }
      if (dx !== (el.anchor.dx ?? 0) || dy !== (el.anchor.dy ?? 0))
        els.set(tid, {
          ...el,
          anchor: {
            ...el.anchor,
            dx: round(clamp(dx, -400, 400)),
            dy: round(clamp(dy, -400, 400)),
          },
        });
      continue;
    }
    if (el.type === "text") el = fitText(el, els, bands, report);
    const h = el.type === "text" ? textHeight(el) : el.h;
    const x = clamp(el.x, 0, max - el.w);
    const y = clamp(el.y, 0, max - h);
    if (x !== el.x || y !== el.y) {
      report.clamped.push(tid);
      el = { ...el, x, y };
    }
    if (carriesText(el)) {
      let nx = el.x;
      for (let pass = 0; pass < 3; pass++)
        for (const band of bands) nx += hingeShift(nx, el.w, band);
      nx = clamp(round(nx), 0, max - el.w);
      if (nx !== el.x) {
        report.nudged.push({ id: tid, dx: round(nx - el.x) });
        el = { ...el, x: nx };
      }
    }
    els.set(tid, el);
  }

  if (viewport) {
    const view = visibleRect(viewport);
    for (const tid of touched) {
      const el = els.get(tid);
      const b = el && elementBox(el, els);
      if (b && !overlaps(b, view)) report.offCamera.push(tid);
    }
  }
  report.touched = [...touched].filter((t) => els.has(t));
  const all = [...els.values()];
  report.issues = boardTextIssues(all, {}, viewport).filter((issue) =>
    touched.has(issue.id),
  );
  return { ok: true, elements: all, report };
}

/** A touched text element made to fit, the way the app will draw it:
 *  below its frame's title band, wider when its words would wrap and there
 *  is room, taller when they still wrap. Each change is reported. */
function fitText(
  el: TextElement,
  els: Map<string, BoardElement>,
  bands: Array<[number, number]>,
  report: ApplyReport,
): TextElement {
  let next = el;
  const frame = containingFrame(
    el,
    { x: el.x, y: el.y, w: el.w, h: textHeight(el) },
    els.values(),
  );
  if (frame?.title && next.y < frame.y + FRAME_TITLE_BAND) {
    next = { ...next, y: frame.y + FRAME_TITLE_BAND };
    report.belowTitle.push({ id: el.id, y: next.y });
  }
  const needs = textNeeds(next);
  if (needs.oneLine > next.w + 0.5) {
    const room = textRoom(next, els, bands) - next.x;
    const w = Math.min(Math.ceil(needs.oneLine), Math.max(next.w, room));
    if (w > next.w + 0.5) {
      next = { ...next, w: round(w) };
      report.widened.push({ id: el.id, w: next.w });
    }
  }
  const needH = needs.heightAt(next.w);
  if (needH > textHeight(next) + 0.5) {
    next = { ...next, h: Math.ceil(needH) };
    report.grown.push({ id: el.id, h: next.h! });
  }
  if (next !== el) els.set(el.id, next);
  return next;
}

/** Every distinct ref on the board, in board order. */
export function boardRefs(elements: readonly BoardElement[]): string[] {
  const out = new Set<string>();
  for (const el of elements) if ("ref" in el && el.ref) out.add(el.ref);
  return [...out];
}

// ── The canvas block ────────────────────────────────────────────────────────

/** The fence a reply carries to show the board as it was at `revision`.
 *  Its body after the first line is the board as plain text, so the fence
 *  still reads where the board can't render (docs/blocks.md). */
export function canvasFence(revision: number, text: string): string {
  // A fence inside the text would close ours early.
  const body = text.replace(/`{3,}/g, "``");
  return [
    "```canvas",
    `revision: ${revision}`,
    ...(body ? [body] : []),
    "```",
  ].join("\n");
}

/** A canvas fence's body: the board revision it shows, or null. */
export function parseCanvasFence(
  source: string,
): { revision: number; text: string } | null {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const first = lines.findIndex((l) => l.trim() !== "");
  if (first < 0) return null;
  const match = /^revision:\s*(\d{1,9})\s*$/.exec(lines[first]!.trim());
  if (!match) return null;
  const revision = Number(match[1]);
  if (!Number.isSafeInteger(revision) || revision < 1) return null;
  return {
    revision,
    text: lines
      .slice(first + 1)
      .join("\n")
      .trim(),
  };
}
