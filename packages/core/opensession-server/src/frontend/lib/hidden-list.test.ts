import { describe, expect, test } from "bun:test";
import type { HiddenRow } from "./api";
import {
  hiddenListEntries,
  hiddenRowKeys,
  MAX_HIDDEN_ROW_KEYS,
} from "./hidden-list";
import { makeUserMap } from "./user-map";

const row = (key: string, overrides: Partial<HiddenRow> = {}): HiddenRow => ({
  key,
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

  // A hide stored under a repo id renamed since (shared/repo-renames.ts) is
  // listed as the repo it became, keyed by what is stored so Restore clears it.
  test("lists a hide stored under a renamed repo id as the new repo", () => {
    expect(
      hiddenListEntries([], { "repo:backstage": "2026-08-01T12:00:00.000Z" }, [
        "opensession",
      ]),
    ).toEqual([
      {
        kind: "repo",
        key: "repo:backstage",
        hiddenAt: "2026-08-01T12:00:00.000Z",
        repo: "opensession",
      },
    ]);
    // Registered again under the old id, the hide is that repo's own.
    expect(
      hiddenListEntries([], { "repo:backstage": "2026-08-01T12:00:00.000Z" }, [
        "backstage",
        "opensession",
      ]).map((entry) => entry.kind === "repo" && entry.repo),
    ).toEqual(["backstage"]);
  });
});

describe("hiddenRowKeys", () => {
  test("ignores key order and values", () => {
    expect(
      hiddenRowKeys({
        b: "2026-08-01T10:00:00.000Z",
        a: "2026-08-01T11:00:00.000Z",
      }),
    ).toEqual(["a", "b"]);
    expect(hiddenRowKeys({})).toEqual([]);
    // Repository hides need no server answer, so they don't trigger a fetch.
    expect(hiddenRowKeys({ "repo:acme/web": "x" })).toEqual([]);
  });

  // The server rejects a request over its limits rather than truncating it,
  // so the client never sends one.
  test("stays within the request limits, keeping the newest hides", () => {
    const hides = Object.fromEntries([
      ["x".repeat(129), "2026-08-02T00:00:00.000Z"],
      ...Array.from({ length: MAX_HIDDEN_ROW_KEYS + 5 }, (_, i) => [
        `s${String(i).padStart(3, "0")}`,
        new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      ]),
    ]);
    const keys = hiddenRowKeys(hides);
    expect(keys).toHaveLength(MAX_HIDDEN_ROW_KEYS);
    // The five oldest go; the over-long key is never sent.
    expect(keys[0]).toBe("s005");
    expect(keys.some((key) => key.length > 128)).toBe(false);
  });
});

// The race the POST lookup fixes: hiding writes the map (a PUT) and asks for
// the Hidden list's names at the same moment, and the read can reach the server
// first. The lookup carries the client's keys, so it names the new row while
// the stored map still lacks it.
test("a hide is named even while its write has not reached the server", async () => {
  const stored: Record<string, string> = {};
  let landWrite = () => {};
  const store = makeUserMap<string>({
    changeEvent: "test-hides-changed",
    fetchMap: async () => ({ ...stored }),
    saveDelta: (_user, delta) =>
      new Promise<void>((resolve) => {
        landWrite = () => {
          Object.assign(stored, delta.set);
          resolve();
        };
      }),
    currentUser: () => "ann",
  });
  await store.hydrate("ann");
  // A server that answers for the keys it is sent, never its stored map.
  const lookup = async (keys: string[]) =>
    keys.map((key) => row(key, { title: "Checkout flow" }));

  store.update((hides) => ({
    ...hides,
    "workspace:a": "2026-08-01T10:00:00.000Z",
  }));
  // The write is still in flight: the server's map is empty.
  expect(stored).toEqual({});
  const keys = hiddenRowKeys(store.get());
  expect(keys).toEqual(["workspace:a"]);
  const entries = hiddenListEntries(await lookup(keys), store.get());
  expect(entries.map((entry) => entry.key)).toEqual(["workspace:a"]);
  landWrite();
});
