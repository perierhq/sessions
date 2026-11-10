import { describe, expect, test } from "bun:test";
import {
  blobSurfaceContext,
  maybePersistBlobSurface,
  parseBlobSurface,
} from "./blob-surface";
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
      "the first paragraph is what Blob says aloud and shows as its Say line",
    );
    expect(text).toContain("never read out numbers, lists or tables");
    expect(text).toContain(
      "everything after the first paragraph is shown and never spoken",
    );
    expect(text).toContain("docs/blocks.md");
    expect(text).not.toContain("may read the prose aloud");
  });

  test("says nothing outside the supervisor, without a surface, or once it is stale", () => {
    const fresh = {
      panes: 1 as const,
      width: "compact" as const,
      at: now.toISOString(),
    };
    expect(
      blobSurfaceContext({ supervisor: false, blobSurface: fresh }, now),
    ).toBeUndefined();
    expect(blobSurfaceContext({ supervisor: true }, now)).toBeUndefined();
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
    ).toBeUndefined();
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
