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
        key: "solo",
        hiddenAt: "2026-08-01T11:00:00.000Z",
        title: "Title solo",
        repo: null,
        sessionId: "session-solo",
      },
      {
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
});
