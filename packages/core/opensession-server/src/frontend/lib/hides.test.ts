import { describe, expect, test } from "bun:test";
import {
  canHideRepo,
  hiddenRepos,
  isHiddenForSession,
  partitionHidden,
  partitionHiddenRepos,
  repoFromHideKey,
  repoHideKey,
  repoHideKeys,
  visiblePrRows,
} from "./hides";
import { makeUserMap } from "./user-map";

const row = (key: string, status: string) => ({ key, status });

describe("partitionHidden", () => {
  test("keeps rows with no hide entry visible", () => {
    const { hiddenKeys, resurfaced } = partitionHidden(
      [row("workspace:a", "inprogress"), row("workspace:b", "pending")],
      {},
    );
    expect(hiddenKeys.size).toBe(0);
    expect(resurfaced).toEqual([]);
  });

  test("hides a row the user hid", () => {
    const { hiddenKeys, resurfaced } = partitionHidden(
      [row("workspace:a", "inprogress"), row("workspace:b", "pending")],
      { "workspace:a": "2026-07-31T10:00:00.000Z" },
    );
    expect([...hiddenKeys]).toEqual(["workspace:a"]);
    expect(resurfaced).toEqual([]);
  });

  // The safety net: hiding must never swallow a session that is waiting on a
  // human, so a blocked row comes back and its entry is handed to the caller
  // to consume.
  test("resurfaces a hidden row that is blocked on a question", () => {
    const { hiddenKeys, resurfaced } = partitionHidden(
      [row("workspace:a", "needsinput")],
      { "workspace:a": "2026-07-31T10:00:00.000Z" },
    );
    expect(hiddenKeys.size).toBe(0);
    expect(resurfaced.map((r) => r.key)).toEqual(["workspace:a"]);
  });

  test("resurfacing is per row: other hidden rows stay hidden", () => {
    const { hiddenKeys, resurfaced } = partitionHidden(
      [
        row("workspace:a", "needsinput"),
        row("workspace:b", "inprogress"),
        row("workspace:c", "merged"),
      ],
      {
        "workspace:a": "2026-07-31T10:00:00.000Z",
        "workspace:b": "2026-07-31T10:00:00.000Z",
      },
    );
    expect([...hiddenKeys]).toEqual(["workspace:b"]);
    expect(resurfaced.map((r) => r.key)).toEqual(["workspace:a"]);
  });

  // The Sidebar always shows the open session's row. Opening a hidden one
  // (from the Hidden list, ⌘K or a link) shows its row without consuming the
  // hide: it is neither hidden nor resurfaced, so it leaves once you move on.
  test("keeps the open row in view without consuming its hide", () => {
    const rows = [
      row("workspace:open", "inprogress"),
      row("workspace:other", "pending"),
    ];
    const hides = {
      "workspace:open": "2026-07-31T10:00:00.000Z",
      "workspace:other": "2026-07-31T10:00:00.000Z",
    };
    const opened = partitionHidden(
      rows,
      hides,
      (r) => r.key === "workspace:open",
    );
    expect([...opened.hiddenKeys]).toEqual(["workspace:other"]);
    expect(opened.resurfaced).toEqual([]);
    // Move on and the row is hidden again: nothing was consumed.
    expect([...partitionHidden(rows, hides, () => false).hiddenKeys]).toEqual([
      "workspace:open",
      "workspace:other",
    ]);
  });

  // A hide entry whose row no longer exists (the session moved workspace, or a
  // solo session got absorbed into one) must not hide anything by accident.
  test("ignores stale entries that match no row", () => {
    const { hiddenKeys, resurfaced } = partitionHidden(
      [row("workspace:a", "pending")],
      {
        "workspace:gone": "2026-07-31T10:00:00.000Z",
      },
    );
    expect(hiddenKeys.size).toBe(0);
    expect(resurfaced).toEqual([]);
  });
});

describe("isHiddenForSession", () => {
  test("matches the workspace row that hides a linked session", () => {
    expect(
      isHiddenForSession(
        { id: "session-a", workspaceId: "linked" },
        { "workspace:linked": "2026-08-12T10:00:00.000Z" },
      ),
    ).toBe(true);
  });

  test("does not match an unrelated row hide", () => {
    expect(
      isHiddenForSession(
        { id: "session-a", workspaceId: "linked" },
        { "workspace:other": "2026-08-12T10:00:00.000Z" },
      ),
    ).toBe(false);
  });
});

describe("repository hides", () => {
  const repoRow = (key: string, status: string, repo: string | null) => ({
    key,
    status,
    repo,
  });
  const repoOf = (r: { repo: string | null }) => r.repo;
  const AT = "2026-07-31T10:00:00.000Z";

  test("a repo key round-trips and row keys are not repos", () => {
    expect(repoHideKey("acme/web")).toBe("repo:acme/web");
    expect(repoFromHideKey("repo:acme/web")).toBe("acme/web");
    expect(repoFromHideKey("workspace:a")).toBeNull();
    expect(repoFromHideKey("repo:")).toBeNull();
  });

  test("hiddenRepos reads repo keys and leaves out the filtered repo", () => {
    const hides = {
      "repo:acme/web": AT,
      "repo:acme/api": AT,
      "workspace:a": AT,
    };
    expect([...hiddenRepos(hides)].sort()).toEqual(["acme/api", "acme/web"]);
    // Filtering the sidebar to a hidden repo is asking to see it.
    expect([...hiddenRepos(hides, "acme/web")]).toEqual(["acme/api"]);
  });

  test("hides every row of a hidden repo and nothing else", () => {
    const hidden = partitionHiddenRepos(
      [
        repoRow("workspace:a", "inprogress", "acme/web"),
        repoRow("workspace:b", "pending", "acme/web"),
        repoRow("workspace:c", "pending", "acme/api"),
        // Scratch and feed rows file under no repository band.
        repoRow("workspace:d", "pending", null),
      ],
      new Set(["acme/web"]),
      repoOf,
      () => false,
    );
    expect([...hidden]).toEqual(["workspace:a", "workspace:b"]);
  });

  // The same safety net as a row hide: a hide must never swallow work that
  // needs you. Unlike a row hide nothing is consumed; the repo stays hidden.
  test("keeps rows blocked on a question and the open row", () => {
    const hidden = partitionHiddenRepos(
      [
        repoRow("workspace:blocked", "needsinput", "acme/web"),
        repoRow("workspace:open", "pending", "acme/web"),
        repoRow("workspace:idle", "pending", "acme/web"),
      ],
      new Set(["acme/web"]),
      repoOf,
      (r) => r.key === "workspace:open",
    );
    expect([...hidden]).toEqual(["workspace:idle"]);
  });

  test("hides nothing when no repo is hidden", () => {
    expect(
      partitionHiddenRepos(
        [repoRow("workspace:a", "pending", "acme/web")],
        new Set(),
        repoOf,
        () => false,
      ).size,
    ).toBe(0);
  });

  // A review request addressed to you is someone waiting on you, so a repo
  // hide leaves it in the band's Needs review; the repo's other PR rows go.
  test("keeps review requests addressed to you in a hidden repo", () => {
    const pr = (n: number, repo: string, source: string) => ({
      n,
      source,
      pr: { repo },
    });
    const items = [
      pr(1, "acme/web", "requested"),
      pr(2, "acme/web", "mine"),
      pr(3, "acme/web", "team"),
      pr(4, "acme/api", "mine"),
    ];
    expect(
      visiblePrRows(items, new Set(["acme/web"])).map((item) => item.n),
    ).toEqual([1, 4]);
    expect(visiblePrRows(items, new Set())).toHaveLength(4);
  });

  // The server keeps keys of at most 128 characters and silently drops longer
  // ones, so a hide of a longer repo id would vanish on reload.
  test("refuses a repo whose hide key the server would not keep", () => {
    expect(canHideRepo("a".repeat(123))).toBe(true);
    expect(repoHideKey("a".repeat(123))).toHaveLength(128);
    expect(canHideRepo("a".repeat(124))).toBe(false);
  });

  // A repo id renamed since it was hidden (shared/repo-renames.ts) reads as
  // the repo it became, so the hide still applies and Restore clears it.
  test("reads a hide stored under a renamed repo id as the new id", () => {
    const hides = { "repo:backstage": AT };
    expect(repoFromHideKey("repo:backstage")).toBe("opensession");
    expect([...hiddenRepos(hides, null, ["opensession"])]).toEqual([
      "opensession",
    ]);
    // Registered again under the old id, the hide is that repo's own.
    expect([...hiddenRepos(hides, null, ["backstage", "opensession"])]).toEqual(
      ["backstage"],
    );
    expect(repoHideKeys("opensession")).toEqual([
      "repo:opensession",
      "repo:backstage",
    ]);
    expect(repoHideKeys("opensession", ["backstage"])).toEqual([
      "repo:opensession",
    ]);
  });
});

// Starting a session in a hidden repo restores it, and on a fresh load that
// can happen before the hides map has arrived. The clear must survive the
// hydration that brings the stored key in, and reach the server.
test("a clear made before hides hydrate still applies", async () => {
  const saves: { set: Record<string, string>; remove: string[] }[] = [];
  let serve: (map: Record<string, string>) => void = () => {};
  const store = makeUserMap<string>({
    changeEvent: "test-hides-clear",
    fetchMap: () =>
      new Promise((resolve) => {
        serve = resolve;
      }),
    saveDelta: async (_user, delta) => {
      saves.push(delta);
    },
    currentUser: () => "ann",
  });
  expect(store.ready()).toBe(false);
  const at = "2026-07-31T10:00:00.000Z";
  store.remove(["repo:acme/web"]);
  serve({ "repo:acme/web": at, "workspace:a": at });
  await Bun.sleep(0);
  expect(store.ready()).toBe(true);
  expect(store.get()).toEqual({ "workspace:a": at });
  expect(saves).toEqual([{ set: {}, remove: ["repo:acme/web"] }]);
  // Hydrated, clearing a key the map lacks writes nothing.
  store.remove(["repo:acme/api"]);
  expect(saves).toHaveLength(1);
});
