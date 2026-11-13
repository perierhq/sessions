// What Blob's GitHub tools tell the model about the account they post as
// (blob-github-tools.ts). The guards themselves are in
// github-blob-write.test.ts.
import { describe, expect, test } from "bun:test";
import { blobGithubTools } from "./blob-github-tools";

const descriptions = (as: "own-account" | "owner") =>
  blobGithubTools(async () => "not now", "", as).map((t) => t.description);

describe("Blob's GitHub tool descriptions", () => {
  test("with Blob's own account: posts as Blob's account, never as the owner", () => {
    for (const text of descriptions("own-account")) {
      expect(text).toContain(
        "Posts as Blob's own GitHub account, never as the owner or Pat",
      );
      expect(text).toContain("Write your own words only.");
    }
  });

  test("with the owner's account: posts as the owner, signed as Blob, rules kept", () => {
    const texts = descriptions("owner");
    expect(texts).toHaveLength(4);
    for (const text of texts) {
      expect(text).toContain(
        "Posts as the owner's own GitHub account, signed as Blob",
      );
      expect(text).toContain("Written by Blob, <owner>'s assistant");
      expect(text).not.toContain("Blob's own GitHub account");
      expect(text).toContain(
        "On a public repository leave out everything internal",
      );
      expect(text).toContain("@mention only teammates on the roster");
    }
    expect(texts[1]).toContain(
      "Blob never approves or requests changes, and never pushes or merges.",
    );
  });
});
