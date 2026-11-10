import { describe, expect, it } from "bun:test";
import { parseSay, stripCueAnchors } from "./say-block";

describe("parseSay", () => {
  it("joins the script's lines into one line of words", () => {
    expect(
      parseSay("Here's what happened overnight.\nTwo things matter."),
    ).toEqual({
      text: "Here's what happened overnight. Two things matter.",
    });
  });

  it("takes a leading delivery hint out of the words", () => {
    expect(parseSay("[warm, unhurried] Morning. One thing needs you.")).toEqual(
      {
        text: "Morning. One thing needs you.",
        delivery: "warm, unhurried",
      },
    );
  });

  it("drops cue markers, wherever they sit", () => {
    expect(
      parseSay(
        "Two things matter. {#inc-4} Checkout flapped again, I'd roll back. {#pr-12} And the sermon drafts shipped.",
      ),
    ).toEqual({
      text: "Two things matter. Checkout flapped again, I'd roll back. And the sermon drafts shipped.",
    });
    expect(parseSay("[calm] {#stats} Numbers are up.")).toEqual({
      text: "Numbers are up.",
      delivery: "calm",
    });
  });

  it("keeps a bracket that is a link's text", () => {
    expect(parseSay("[the PR](https://example.test) is green.")?.text).toBe(
      "[the PR](https://example.test) is green.",
    );
  });

  it("is null when nothing would be said", () => {
    expect(parseSay("")).toBeNull();
    expect(parseSay("  \n ")).toBeNull();
    expect(parseSay("[warm]")).toBeNull();
    expect(parseSay("{#a}")).toBeNull();
  });
});

describe("stripCueAnchors", () => {
  it("drops a cue right after a link", () => {
    expect(
      stripCueAnchors(
        "- [PR #12](https://example.test/pull/12){#pr-12} merged",
      ),
    ).toBe("- [PR #12](https://example.test/pull/12) merged");
  });

  it("drops a cue ending a line, and on a fence's opening line", () => {
    expect(stripCueAnchors("Checkout is flapping {#inc-4}\nNext")).toBe(
      "Checkout is flapping\nNext",
    );
    expect(stripCueAnchors("```metrics {#stats}\nUsers: 12\n```")).toBe(
      "```metrics\nUsers: 12\n```",
    );
  });

  it("leaves fenced code and mid-line braces alone", () => {
    const code = "```svelte\n{#each}\nx {#id}\n```";
    expect(stripCueAnchors(code)).toBe(code);
    expect(stripCueAnchors("a {#id} b")).toBe("a {#id} b");
    expect(stripCueAnchors("{{#each}}")).toBe("{{#each}}");
  });

  it("returns the same string when there is no cue", () => {
    const src = "Plain text\n\n- list";
    expect(stripCueAnchors(src)).toBe(src);
  });
});
