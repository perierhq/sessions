import { describe, expect, test } from "bun:test";
import { mentionsBlob } from "./people";
import { blobActor, blobItemActor } from "./session-actors";

describe("mentionsBlob", () => {
  test.each([
    ["@Blob can you look at this?", "start"],
    ["Hey @Blob, can you look?", "middle after a space"],
    ["can you look at this @Blob", "end"],
    ["thanks @blob.", "lowercase before a full stop"],
    ["(@BLOB) please", "inside parentheses"],
    ["@Blob: ship it", "before a colon"],
    ["first line\n@Blob second line", "at a line start"],
    ["`code` then @Blob", "after a code span"],
    ["```\nnpm test\n```\n@Blob run it", "after a fenced block"],
  ])("matches %p (%s)", (text) => {
    expect(mentionsBlob(text, "Ada")).toBe(true);
  });

  test.each([
    ["Blob without the at sign", "bare name"],
    ["write to blob@example.test", "email address"],
    ["x@Blob.example.test", "address with Blob as domain"],
    ["@Blobby is someone else", "longer name"],
    ["@Blob-team is a team", "hyphenated name"],
    ["@Blob.example.test", "domain"],
    ["acme/@Blob", "path segment"],
    ["run `@Blob` literally", "inline code span"],
    ["```\n@Blob in a fence\n```", "fenced block"],
    ["~~~\n@Blob in a tilde fence\n~~~", "tilde fence"],
    ["```\nunclosed @Blob", "unclosed fence"],
  ])("ignores %p (%s)", (text) => {
    expect(mentionsBlob(text, "Ada")).toBe(false);
  });

  test("Blob mentioning itself never counts, in any recorded form", () => {
    for (const sender of [
      "Blob",
      "blob",
      blobActor("os-supervisor-1"),
      blobItemActor("lead:acme"),
    ])
      expect(mentionsBlob("@Blob", sender)).toBe(false);
  });

  test("matches the configured GitHub login too", () => {
    expect(mentionsBlob("cc @acme-blob", "Ada")).toBe(false);
    expect(mentionsBlob("cc @acme-blob", "Ada", "acme-blob")).toBe(true);
    expect(mentionsBlob("cc @ACME-BLOB.", "Ada", "acme-blob")).toBe(true);
    expect(mentionsBlob("cc @acme-blobs", "Ada", "acme-blob")).toBe(false);
    expect(mentionsBlob("cc @Blob", "Ada", "acme-blob")).toBe(true);
  });

  test("the login posting as itself is Blob too", () => {
    expect(mentionsBlob("cc @Blob", "acme-blob", "acme-blob")).toBe(false);
  });
});
