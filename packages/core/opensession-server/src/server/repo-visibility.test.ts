import { describe, expect, test } from "bun:test";
import {
  __setRepoVisibilityDepsForTest,
  repoIsPrivate,
  treatRepoAsPublic,
} from "./repo-visibility";

const never = async () => {
  throw new Error("lookup must not run");
};

describe("treatRepoAsPublic", () => {
  test("an explicit config pin wins without asking GitHub", async () => {
    expect(
      await treatRepoAsPublic({ ghRepo: "acme/widget", public: true }, never),
    ).toBe(true);
    expect(
      await treatRepoAsPublic({ ghRepo: "acme/widget", public: false }, never),
    ).toBe(false);
  });

  test("follows GitHub's answer for an unpinned repo", async () => {
    const asked: string[] = [];
    const lookup = (isPrivate: boolean | null) => async (ghRepo: string) => {
      asked.push(ghRepo);
      return isPrivate;
    };
    expect(
      await treatRepoAsPublic({ ghRepo: "acme/widget" }, lookup(true)),
    ).toBe(false);
    expect(
      await treatRepoAsPublic({ ghRepo: "acme/widget" }, lookup(false)),
    ).toBe(true);
    expect(asked).toEqual(["acme/widget", "acme/widget"]);
  });

  // No token, an API failure, or no GitHub remote: the rule costs a
  // paragraph on a private repo and prevents a leak on a public one.
  test("fails closed when visibility cannot be confirmed", async () => {
    expect(
      await treatRepoAsPublic({ ghRepo: "acme/widget" }, async () => null),
    ).toBe(true);
    expect(await treatRepoAsPublic({ ghRepo: "" }, never)).toBe(true);
  });

  test("code.storage repos and repo-less runs are not public", async () => {
    expect(
      await treatRepoAsPublic({ ghRepo: "", host: "codestorage" }, never),
    ).toBe(false);
    expect(await treatRepoAsPublic(undefined, never)).toBe(false);
  });
});

describe("repoIsPrivate", () => {
  test("caches for the process, unless a caller asks for a fresher answer", async () => {
    let now = 0;
    let isPrivate = true;
    let asked = 0;
    const restore = __setRepoVisibilityDepsForTest({
      now: () => now,
      token: async () => "t",
      fetch: async () => {
        asked++;
        return Response.json({ private: isPrivate });
      },
    });
    try {
      const fresh = { maxAgeMs: 10 * 60_000 };
      expect(await repoIsPrivate("acme/widget", fresh)).toBe(true);
      isPrivate = false;
      now = 9 * 60_000;
      expect(await repoIsPrivate("acme/widget", fresh)).toBe(true);
      expect(asked).toBe(1);
      now = 11 * 60_000;
      expect(await repoIsPrivate("acme/widget", fresh)).toBe(false);
      expect(asked).toBe(2);
      now = 60 * 60_000;
      expect(await repoIsPrivate("acme/widget")).toBe(false);
      expect(asked).toBe(2);
    } finally {
      restore();
    }
  });
});
