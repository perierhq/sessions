import { describe, expect, test } from "bun:test";
import {
  blobSurfaceContext,
  maybePersistBlobSurface,
  NOT_IN_BLOB,
  parseBlobSurface,
} from "./blob-surface";
import { wrapContext } from "./prompt-context";
import type { UnifiedSession } from "./types";

const now = new Date("2026-11-10T09:00:00.000Z");

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
