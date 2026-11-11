import { describe, expect, it } from "bun:test";
import {
  closedSayScript,
  opensBody,
  parseSay,
  stripCueAnchors,
  type BodyNode,
} from "./say-block";

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

  it("drops anything shaped like a cue, valid or not", () => {
    expect(parseSay("Look here {#pr.12/x} and there.")?.text).toBe(
      "Look here and there.",
    );
  });

  it("only a leading bracket is a delivery hint", () => {
    expect(parseSay("Done. [aside] More.")?.text).toBe("Done. [aside] More.");
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

  it("drops a cue right after a bold lead", () => {
    expect(stripCueAnchors("**Release 533** {#rel} · stuck")).toBe(
      "**Release 533** · stuck",
    );
    expect(stripCueAnchors("- __Checkout__{#inc-4} · flapping")).toBe(
      "- __Checkout__ · flapping",
    );
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

describe("closedSayScript", () => {
  it("declines a script holding a fence line: the say fence was never closed", () => {
    expect(
      closedSayScript("Here's the plan.\n\n```metrics\nUsers: 12"),
    ).toBeNull();
    expect(closedSayScript("Here's the plan.")?.text).toBe("Here's the plan.");
  });
});

describe("opensBody", () => {
  type Fake = BodyNode & { children: Fake[] };
  const node = (nodeType: number, textContent = "", children: Fake[] = []) => {
    const n: Fake = {
      nodeType,
      textContent,
      children,
      parentNode: null,
      previousSibling: null,
    };
    children.forEach((child, i) => {
      child.parentNode = n;
      child.previousSibling = children[i - 1] ?? null;
    });
    return n;
  };

  it("is true for the first block, past whitespace and comments", () => {
    const pre = node(1);
    const root = node(1, "", [node(3, "\n  "), node(8, "x"), pre, node(1)]);
    expect(opensBody(pre, root)).toBe(true);
  });

  it("is false after another block or text", () => {
    const pre = node(1);
    node(1, "", [node(1), pre]);
    expect(opensBody(pre, pre.parentNode!)).toBe(false);
    const late = node(1);
    const root = node(1, "", [node(3, "Hi"), late]);
    expect(opensBody(late, root)).toBe(false);
  });

  it("looks through a wrapper", () => {
    const pre = node(1);
    const wrap = node(1, "", [pre]);
    const root = node(1, "", [wrap]);
    expect(opensBody(pre, root)).toBe(true);
    const other = node(1, "", [node(1), node(1, "", [node(1)])]);
    const deep = other.children[1]!.children[0]!;
    expect(opensBody(deep, other)).toBe(false);
  });
});
