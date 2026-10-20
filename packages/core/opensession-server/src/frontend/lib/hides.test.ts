import { describe, expect, test } from "bun:test";
import {
  hiddenRepos,
  isHiddenForSession,
  partitionHidden,
  partitionHiddenRepos,
  repoFromHideKey,
  repoHideKey,
} from "./hides";

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
});
