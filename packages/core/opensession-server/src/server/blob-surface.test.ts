import { describe, expect, test } from "bun:test";
import { DEFAULT_BOARD_VIEWPORT } from "../shared/blob-board";
import {
  BOARD_ANSWER_LINE,
  blobSurfaceContext,
  boardViewportLines,
  freshBlobSurface,
  maybePersistBlobSurface,
  NOT_IN_BLOB,
  parseBlobSurface,
  parseBoardViewport,
} from "./blob-surface";
import { wrapContext } from "./prompt-context";
import type { UnifiedSession } from "./types";

const now = new Date("2026-11-10T09:00:00.000Z");

const OPEN_VIEWPORT = {
  w: 951,
  h: 669,
  origin: [0, 0] as [number, number],
  zoom: 1,
  hinge: [455.5, 495.5] as [number, number],
  strip: [867, 951] as [number, number],
  closed: { w: 382, h: 678 },
};

describe("board camera", () => {
  test("reads the camera Blob sends with the surface", () => {
    expect(
      parseBlobSurface(
        { app: "blob", panes: 2, width: "regular", viewport: OPEN_VIEWPORT },
        now,
      ),
    ).toEqual({
      panes: 2,
      width: "regular",
      viewport: OPEN_VIEWPORT,
      at: now.toISOString(),
    });
    // A Mac window: no fold, no strip; origin and zoom default.
    expect(parseBoardViewport({ w: 1280, h: 748 })).toEqual({
      w: 1280,
      h: 748,
      origin: [0, 0],
      zoom: 1,
    });
  });

  test("drops a malformed camera and keeps the rest of the surface", () => {
    for (const viewport of [
      { ...OPEN_VIEWPORT, w: -1 },
      { ...OPEN_VIEWPORT, zoom: 9 },
      { ...OPEN_VIEWPORT, hinge: [495.5, 455.5] },
      { ...OPEN_VIEWPORT, hinge: [455.5, 2000] },
      { ...OPEN_VIEWPORT, origin: ["0", 0] },
      { ...OPEN_VIEWPORT, closed: { w: 0, h: 1 } },
      "wide",
    ]) {
      expect(parseBoardViewport(viewport)).toBeUndefined();
      expect(
        parseBlobSurface(
          { app: "blob", panes: 2, width: "regular", viewport },
          now,
        ),
      ).toEqual({ panes: 2, width: "regular", at: now.toISOString() });
    }
  });

  test("tells the turn what is visible, where the fold is and what closed shows", () => {
    const lines = boardViewportLines(OPEN_VIEWPORT).join("\n");
    expect(lines).toContain(
      "Camera now: the open Duo, 951×669 pt at board (0, 0), zoom 1. Visible board: x 0–867, y 0–669 (the clock strip on the trailing edge is not board).",
    );
    expect(lines).toContain(
      "The fold: board x 455.5–495.5 at the home camera. No text there",
    );
    expect(lines).toContain("Closed, the camera shows x 0–382");
    // Open, the right screen is for new content, never by moving the old.
    expect(lines).toContain(
      "Open now, the right screen shows board x 495.5–867 too: put new content that doesn't fit the closed view there",
    );
    expect(lines).toContain("never by moving what is already on the board");
    const panned = boardViewportLines({
      ...OPEN_VIEWPORT,
      origin: [500, 100],
      zoom: 2,
    }).join("\n");
    expect(panned).toContain("Visible board: x 500–933.5, y 100–434.5");
    const assumed = boardViewportLines(undefined).join("\n");
    expect(assumed).toContain(
      "No camera came with this message, so assume the closed Duo below.",
    );
    // The default is the closed Duo's board-visible area, 382×678.
    expect(assumed).toContain(
      "Camera now: the closed Duo, 382×678 pt at board (0, 0), zoom 1. Visible board: x 0–382, y 0–678.",
    );
    expect(assumed).toContain("Opened, the fold is board x 455.5–495.5");
    const context = blobSurfaceContext(
      {
        supervisor: true,
        blobSurface: {
          panes: 2,
          width: "regular",
          viewport: OPEN_VIEWPORT,
          at: now.toISOString(),
        },
      },
      now,
    );
    expect(context).toContain("board_read");
    expect(context).toContain("Camera now: the open Duo");
  });

  test("every Blob turn carries a camera: the closed Duo when the app sent none", () => {
    const context = blobSurfaceContext(
      {
        supervisor: true,
        blobSurface: { panes: 1, width: "compact", at: now.toISOString() },
      },
      now,
    );
    expect(context).toContain(
      "No camera came with this message, so assume the closed Duo below.",
    );
    expect(context).toContain("Visible board: x 0–382, y 0–678.");
    expect(DEFAULT_BOARD_VIEWPORT).toEqual({
      w: 382,
      h: 678,
      origin: [0, 0],
      zoom: 1,
      closed: { w: 382, h: 678 },
    });
  });

  test("structured questions are answered on the board, chat in text", () => {
    const context = blobSurfaceContext(
      {
        supervisor: true,
        blobSurface: { panes: 1, width: "compact", at: now.toISOString() },
      },
      now,
    );
    expect(context).toContain(BOARD_ANSWER_LINE);
    expect(BOARD_ANSWER_LINE).toContain(
      "status, why something is stuck, what changed, a plan, a comparison, a timeline",
    );
    expect(BOARD_ANSWER_LINE).toContain("canvas fence board_apply returns");
    expect(BOARD_ANSWER_LINE).toContain(
      "Plain text replies are for simple chat only.",
    );
  });

  test("a stale surface carries no camera", () => {
    const at = new Date(now.getTime() - 31 * 60_000).toISOString();
    expect(
      freshBlobSurface(
        {
          blobSurface: {
            panes: 1,
            width: "compact",
            viewport: OPEN_VIEWPORT,
            at,
          },
        },
        now,
      ),
    ).toBeUndefined();
  });
});

describe("Blob surface", () => {
  test("reads only a well-formed Blob surface", () => {
    expect(
      parseBlobSurface({ app: "blob", panes: 2, width: "regular" }, now),
    ).toEqual({
      panes: 2,
      width: "regular",
      at: now.toISOString(),
    });
    expect(
      parseBlobSurface({ app: "os", panes: 1, width: "compact" }, now),
    ).toBeUndefined();
    expect(
      parseBlobSurface({ app: "blob", panes: 3, width: "compact" }, now),
    ).toBeUndefined();
    expect(
      parseBlobSurface({ app: "blob", panes: 1, width: "huge" }, now),
    ).toBeUndefined();
    expect(parseBlobSurface("blob", now)).toBeUndefined();
    expect(parseBlobSurface(undefined, now)).toBeUndefined();
  });

  test("tells a supervisor turn where the reply is shown", () => {
    const one = blobSurfaceContext(
      {
        supervisor: true,
        blobSurface: { panes: 1, width: "compact", at: now.toISOString() },
      },
      now,
    );
    expect(one).toContain('source="blob-surface"');
    expect(one).toContain("one narrow phone screen");
    const two = blobSurfaceContext(
      {
        supervisor: true,
        blobSurface: { panes: 2, width: "regular", at: now.toISOString() },
      },
      now,
    );
    expect(two).toContain("two panes");
  });

  test("splits the reply into what Blob says and what it shows", () => {
    const text = blobSurfaceContext(
      {
        supervisor: true,
        blobSurface: { panes: 1, width: "compact", at: now.toISOString() },
      },
      now,
    );
    expect(text).toContain(
      "Say: open with a ```say fence holding the script Blob speaks aloud.",
    );
    expect(text).toContain(
      "Write it for the ear: one to three short sentences",
    );
    expect(text).toContain("It talks about what is shown and never repeats it");
    expect(text).toContain("[warm, unhurried], only when the tone helps");
    expect(text).toContain(
      "Show: everything after the say fence is shown and never spoken. View first, prose minimal",
    );
    expect(text).toContain("Tables only when the owner asked for data.");
    expect(text).toContain("No paragraph recaps.");
    expect(text).toContain("docs/blocks.md");
    expect(text).not.toContain("first paragraph");
  });

  test("tells Blob how to point at what it shows with cues", () => {
    const text = blobSurfaceContext(
      {
        supervisor: true,
        blobSurface: { panes: 1, width: "compact", at: now.toISOString() },
      },
      now,
    );
    expect(text).toContain(
      "put {#id} in the script where the speech turns to a shown element, at a sentence start or mid-sentence",
    );
    expect(text).toContain(
      "Checkout flapped again right after 2.3.4, {#pr-12} and Pat's fix is waiting.",
    );
    expect(text).toContain("```metrics {#stats}");
    expect(text).toContain("[PR #12](url){#pr-12}");
    expect(text).toContain("Keep at least four words between cues");
    expect(text).toContain(
      "only when pointing helps, and at most one per sentence",
    );
    expect(text).toContain("the cue itself is never read");
  });

  test("says nothing outside the supervisor, and not in Blob without a fresh surface", () => {
    const fresh = {
      panes: 1 as const,
      width: "compact" as const,
      at: now.toISOString(),
    };
    expect(
      blobSurfaceContext({ supervisor: false, blobSurface: fresh }, now),
    ).toBeUndefined();
    const notInBlob = wrapContext(NOT_IN_BLOB, "blob-surface");
    expect(blobSurfaceContext({ supervisor: true }, now)).toBe(notInBlob);
    expect(NOT_IN_BLOB).toBe(
      "Not in Blob this turn: write a normal reply with no say fence.",
    );
    // Blob no longer talks to the Desk.
    expect(
      blobSurfaceContext(
        { desk: true, blobSurface: fresh } as Pick<
          UnifiedSession,
          "supervisor" | "blobSurface"
        >,
        now,
      ),
    ).toBeUndefined();
    const later = new Date(now.getTime() + 31 * 60 * 1000);
    expect(
      blobSurfaceContext({ supervisor: true, blobSurface: fresh }, later),
    ).toBe(notInBlob);
  });

  test("records the surface only on a supervisor session", () => {
    const surface = { app: "blob", panes: 1, width: "compact" };
    const desk = {
      id: "os-desk",
      source: "opensession",
      desk: true,
    } as UnifiedSession;
    maybePersistBlobSurface(desk, surface);
    expect(desk.blobSurface).toBeUndefined();

    const supervisor = {
      id: "os-supervisor",
      source: "opensession",
      supervisor: true,
    } as UnifiedSession;
    maybePersistBlobSurface(supervisor, surface);
    expect(supervisor.blobSurface).toMatchObject({
      panes: 1,
      width: "compact",
    });
  });
});
