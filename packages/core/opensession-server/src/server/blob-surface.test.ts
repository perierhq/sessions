import { describe, expect, test } from "bun:test";
import { blobSurfaceContext, parseBlobSurface } from "./blob-surface";

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

  test("tells a Desk turn where the reply is shown", () => {
    const one = blobSurfaceContext(
      {
        desk: true,
        blobSurface: { panes: 1, width: "compact", at: now.toISOString() },
      },
      now,
    );
    expect(one).toContain('source="blob-surface"');
    expect(one).toContain("one narrow phone screen");
    const two = blobSurfaceContext(
      {
        desk: true,
        blobSurface: { panes: 2, width: "regular", at: now.toISOString() },
      },
      now,
    );
    expect(two).toContain("two panes");
  });

  test("says nothing outside the Desk, without a surface, or once it is stale", () => {
    const fresh = {
      panes: 1 as const,
      width: "compact" as const,
      at: now.toISOString(),
    };
    expect(
      blobSurfaceContext({ desk: false, blobSurface: fresh }, now),
    ).toBeUndefined();
    expect(blobSurfaceContext({ desk: true }, now)).toBeUndefined();
    const later = new Date(now.getTime() + 31 * 60 * 1000);
    expect(
      blobSurfaceContext({ desk: true, blobSurface: fresh }, later),
    ).toBeUndefined();
  });
});
