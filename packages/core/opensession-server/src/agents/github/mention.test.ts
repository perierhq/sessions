import { describe, expect, test } from "bun:test";
import { BLOB_MARKER, OWN_MARKERS } from "./github-rest";
import { githubMentionHandles } from "./mention";

describe("GitHub mention handles", () => {
  test("always includes the App slug when aliases are configured", () => {
    expect(
      githubMentionHandles({
        persona: "Open Session",
        appSlug: "open-session-os-tella-dev",
        botLogin: "open-session-os-tella-dev[bot]",
        configured: ["tella-butler"],
      }),
    ).toEqual(["opensession", "open-session-os-tella-dev", "tella-butler"]);
  });

  test("adds environment aliases without replacing canonical handles", () => {
    expect(
      githubMentionHandles({
        persona: "OS",
        appSlug: "open-session-acme",
        environment: "@legacy, open-session-acme[bot]",
      }),
    ).toEqual(["os", "open-session-acme", "legacy"]);
  });
});

describe("our own GitHub content", () => {
  test("a post by Blob's GitHub account is ours", () => {
    expect(OWN_MARKERS).toContain(BLOB_MARKER);
    expect(BLOB_MARKER).toBe("<!-- os:blob -->");
  });
});
