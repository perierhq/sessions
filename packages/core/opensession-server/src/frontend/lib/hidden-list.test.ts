import { describe, expect, test } from "bun:test";
import type { HiddenRow } from "./api";
import { hiddenListEntries, hiddenRowsSignature } from "./hidden-list";

const row = (key: string, overrides: Partial<HiddenRow> = {}): HiddenRow => ({
  key,
  hiddenAt: "2026-08-01T10:00:00.000Z",
  title: `Title ${key}`,
  repo: "acme/web",
  sessionId: `session-${key}`,
  ...overrides,
});

describe("hiddenListEntries", () => {
  test("lists the rows the server named, most recently hidden first", () => {
    const entries = hiddenListEntries(
      [row("workspace:a"), row("solo", { repo: null })],
      {
        "workspace:a": "2026-08-01T09:00:00.000Z",
        solo: "2026-08-01T11:00:00.000Z",
      },
    );
    expect(entries).toEqual([
      {
        kind: "row",
        key: "solo",
        hiddenAt: "2026-08-01T11:00:00.000Z",
        title: "Title solo",
        repo: null,
        sessionId: "session-solo",
      },
      {
        kind: "row",
        key: "workspace:a",
        hiddenAt: "2026-08-01T09:00:00.000Z",
        title: "Title workspace:a",
        repo: "acme/web",
        sessionId: "session-workspace:a",
      },
    ]);
  });

  // Restore clears the hide locally before the next fetch lands; the row must
  // leave the list at once rather than linger until the server catches up.
  test("drops a row whose hide was cleared since the fetch", () => {
    const entries = hiddenListEntries(
      [row("workspace:a"), row("workspace:b")],
      { "workspace:b": "2026-08-01T10:00:00.000Z" },
    );
    expect(entries.map((entry) => entry.key)).toEqual(["workspace:b"]);
  });

  test("lists hidden repositories beside rows, in hide order", () => {
    const entries = hiddenListEntries(
      [row("workspace:a")],
      {
        "workspace:a": "2026-08-01T09:00:00.000Z",
        "repo:acme/api": "2026-08-01T12:00:00.000Z",
      },
      ["acme/web", "acme/api"],
    );
    expect(entries).toEqual([
      {
        kind: "repo",
        key: "repo:acme/api",
        hiddenAt: "2026-08-01T12:00:00.000Z",
        repo: "acme/api",
      },
      expect.objectContaining({ kind: "row", key: "workspace:a" }),
    ]);
  });

  // A repository that left the sidebar's list (unregistered, no work left in
  // it) is stale, the same as an archived row.
  test("leaves out hidden repositories the sidebar no longer knows", () => {
    expect(
      hiddenListEntries([], { "repo:acme/gone": "2026-08-01T12:00:00.000Z" }, [
        "acme/web",
      ]),
    ).toEqual([]);
  });

  // Hides whose work was archived or deleted never come back from the server,
  // so they are not listed even though the hides map still holds them.
  test("lists nothing for stale hides the server did not name", () => {
    expect(
      hiddenListEntries([], {
        "workspace:archived": "2026-08-01T10:00:00.000Z",
      }),
    ).toEqual([]);
  });
});

test("hiddenRowsSignature ignores key order and values", () => {
  expect(
    hiddenRowsSignature({
      b: "2026-08-01T10:00:00.000Z",
      a: "2026-08-01T11:00:00.000Z",
    }),
  ).toBe(hiddenRowsSignature({ a: "x", b: "y" }));
  expect(hiddenRowsSignature({})).toBe("");
  // Repository hides need no server answer, so they don't trigger a refetch.
  expect(hiddenRowsSignature({ "repo:acme/web": "x" })).toBe("");
});
