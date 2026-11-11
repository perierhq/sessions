// Blob's GitHub account settings: the server's answers read into what the
// section shows (401/403 hide it), errors in plain words, the expiry warning
// and the repository toggles.
import { afterEach, describe, expect, test } from "bun:test";
import { ApiError } from "./api/request";
import {
  githubRepoNames,
  loadBlobGithub,
  parseLabels,
  plainError,
  removeBlobGithubToken,
  saveBlobGithub,
  togglePublicRepo,
  toggleRepo,
  tokenExpiry,
} from "./blob-github";

const settings = {
  login: "acme-blob",
  expiresAt: "2027-02-09T12:00:00.000Z",
  repos: ["acme/widget"],
  publicRepos: [],
  enabled: false,
  tokenSet: true,
};

describe("loadBlobGithub", () => {
  const answer =
    (
      status: number,
      body: { blob?: Partial<typeof settings>; error?: string },
    ) =>
    async () =>
      new Response(JSON.stringify(body), { status });

  test("reads the labels allowlist when the server sends it", async () => {
    const labels = { ...settings, labels: ["bug"] };
    expect(await loadBlobGithub(answer(200, { blob: labels }))).toEqual({
      kind: "ready",
      settings: labels,
    });
  });

  test("reads the settings", async () => {
    expect(await loadBlobGithub(answer(200, { blob: settings }))).toEqual({
      kind: "ready",
      settings,
    });
  });

  test("signed out, not the owner, or an old server hides the section", async () => {
    for (const status of [401, 403, 404])
      expect(await loadBlobGithub(answer(status, { error: "no" }))).toEqual({
        kind: "hidden",
      });
  });

  test("a failure or an unexpected body is an error", async () => {
    expect(await loadBlobGithub(answer(500, { error: "boom" }))).toEqual({
      kind: "error",
    });
    expect(await loadBlobGithub(answer(200, { blob: {} }))).toEqual({
      kind: "error",
    });
    expect(
      await loadBlobGithub(async () => {
        throw new TypeError("Failed to fetch");
      }),
    ).toEqual({ kind: "error" });
  });
});

describe("plainError", () => {
  test("drops the field name and ends as a sentence", () => {
    expect(
      plainError(
        new ApiError(
          "token: use a fine-grained personal access token (it starts with github_pat_)",
          400,
        ),
      ),
    ).toBe("Use a fine-grained token. It starts with github_pat_.");
    expect(plainError(new ApiError("token: not a GitHub token", 400))).toBe(
      "That isn't a GitHub token. Copy it again, whole.",
    );
    expect(
      plainError(
        new ApiError("acme/old is not a registered GitHub repository", 400),
      ),
    ).toBe("acme/old is not a registered GitHub repository.");
    expect(plainError(new ApiError("enabled: must be a boolean", 400))).toBe(
      "Must be a boolean.",
    );
    expect(
      plainError(
        new ApiError(
          "GitHub refused the token. Check it was copied whole and is live.",
          400,
        ),
      ),
    ).toBe("GitHub refused the token. Check it was copied whole and is live.");
    expect(plainError(new TypeError("Failed to fetch"))).toBe(
      "Couldn't reach the server. Try again.",
    );
  });
});

describe("an unexpected answer to a save", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("is its own plain error, not a network failure", async () => {
    const stub = async () =>
      new Response(JSON.stringify({ blob: { login: 1 } }), { status: 200 });
    globalThis.fetch = Object.assign(stub, {
      preconnect: realFetch.preconnect,
    });
    for (const call of [
      () => saveBlobGithub({ enabled: true }),
      () => removeBlobGithubToken(),
    ]) {
      const caught = await call().then(
        () => null,
        (error: Error) => error,
      );
      expect(caught).toBeInstanceOf(Error);
      expect(plainError(caught!)).toBe("The server sent an unexpected answer.");
    }
  });
});

describe("parseLabels", () => {
  test("comma separated, trimmed, each once", () => {
    expect(parseLabels(" bug, needs-info,,Bug , good first issue ")).toEqual([
      "bug",
      "needs-info",
      "good first issue",
    ]);
    expect(parseLabels("  ")).toEqual([]);
  });
});

describe("tokenExpiry", () => {
  const now = Date.parse("2026-11-11T12:00:00Z");
  const inDays = (days: number) =>
    new Date(now + days * 86_400_000).toISOString();

  test("relative, warning under 14 days", () => {
    expect(tokenExpiry(inDays(60), now)).toEqual({
      text: "Expires in 60 days",
      warn: false,
      expired: false,
    });
    expect(tokenExpiry(inDays(14), now)?.warn).toBe(false);
    expect(tokenExpiry(inDays(13.5), now)).toEqual({
      text: "Expires in 13 days",
      warn: true,
      expired: false,
    });
    expect(tokenExpiry(inDays(1.2), now)?.text).toBe("Expires tomorrow");
    expect(tokenExpiry(inDays(0.2), now)?.text).toBe("Expires today");
    expect(tokenExpiry(inDays(-1), now)).toEqual({
      text: "Expired",
      warn: true,
      expired: true,
    });
    expect(tokenExpiry(null, now)).toBeNull();
  });
});

describe("repositories", () => {
  test("only registered repositories on GitHub, once each", () => {
    expect(
      githubRepoNames([
        { ghRepo: "acme/widget" },
        { ghRepo: "" },
        {},
        { ghRepo: "Acme/Docs" },
        { ghRepo: "acme/widget" },
      ]),
    ).toEqual(["Acme/Docs", "acme/widget"]);
  });

  test("dropping a repository drops it from the public ones", () => {
    const current = {
      repos: ["acme/widget", "acme/docs"],
      publicRepos: ["acme/docs"],
    };
    expect(toggleRepo(current, "acme/docs", false)).toEqual({
      repos: ["acme/widget"],
      publicRepos: [],
    });
    expect(toggleRepo(current, "acme/site", true).repos).toEqual([
      "acme/widget",
      "acme/docs",
      "acme/site",
    ]);
    expect(togglePublicRepo(current, "acme/widget", true)).toEqual([
      "acme/docs",
      "acme/widget",
    ]);
    expect(togglePublicRepo(current, "acme/docs", false)).toEqual([]);
  });
});
