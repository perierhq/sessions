import { describe, expect, test } from "bun:test";
import { LiveTurnStore } from "./live-turn-store";

describe("LiveTurnStore", () => {
  test("coalesces a burst of deltas into one published text snapshot", async () => {
    const store = new LiveTurnStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => notifications++);
    store.start("Jaap", "run-1");
    for (let index = 0; index < 100; index++) store.append(String(index % 10));
    await Bun.sleep(25);
    expect(store.getSnapshot().text).toHaveLength(100);
    // start + a single frame flush.
    expect(notifications).toBe(2);
    unsubscribe();
    store.clear();
  });

  test("keeps progress chrome retired between landed stream blocks", async () => {
    const store = new LiveTurnStore();
    store.start(undefined, "run-progress");
    expect(store.getSnapshot().hasPaintedText).toBe(false);
    store.append("first block");
    await Bun.sleep(25);
    expect(store.getSnapshot().hasPaintedText).toBe(true);
    store.land([{ content: "first block" }]);
    expect(store.getSnapshot().text).toBe("");
    expect(store.getSnapshot().hasPaintedText).toBe(true);
    store.start(undefined, "run-next");
    expect(store.getSnapshot().hasPaintedText).toBe(false);
    store.clear();
  });

  test("deduplicates committed text in either arrival order", async () => {
    const store = new LiveTurnStore();
    store.start(undefined, "run-2");
    store.land([{ content: "already committed" }]);
    store.append("already committed");
    await Bun.sleep(25);
    expect(store.getSnapshot().text).toBe("");

    store.append("streamed first");
    await Bun.sleep(25);
    store.land([{ content: "streamed first" }]);
    expect(store.getSnapshot().text).toBe("");
    store.clear();
  });

  test("drops a half-streamed block when its durable entry lands mid-flight", async () => {
    // The pi runner delivers a block as deltas, so the transcript
    // entry can arrive while the tail is still coming. Without prefix
    // matching the bubble keeps growing beside the durable entry and the
    // reply shows twice.
    const store = new LiveTurnStore();
    store.start(undefined, "run-3");
    store.append("Hello ");
    store.append("there, ");
    await Bun.sleep(25);
    store.land([{ content: "Hello there, world" }]);
    expect(store.getSnapshot().text).toBe("");

    // The rest of the block still arrives; it must be swallowed, not shown.
    store.append("wor");
    store.append("ld");
    await Bun.sleep(25);
    expect(store.getSnapshot().text).toBe("");
    store.clear();
  });

  test("cancels a block by id, whatever the durable text ended up being", async () => {
    // The wire normalizes and clamps entry content, so the durable text is
    // not always the streamed text character for character. The engine's
    // block id is, and it is what the entry carries.
    const store = new LiveTurnStore();
    store.start(undefined, "run-5");
    store.append("Here is the clip.\nOPENSESSION_VIDEO: /tmp/a.mp4\n", "prt_1");
    await Bun.sleep(25);
    store.land([{ id: "prt_1", content: "Here is the clip." }]);
    expect(store.getSnapshot().text).toBe("");

    // A late frame for that block is the entry's own words, not new text.
    store.append("trailing", "prt_1");
    await Bun.sleep(25);
    expect(store.getSnapshot().text).toBe("");
    store.clear();
  });

  test("keeps streaming text that follows a landed block", async () => {
    const store = new LiveTurnStore();
    store.start(undefined, "run-4");
    store.append("first block");
    await Bun.sleep(25);
    store.land([{ content: "first block" }]);
    store.append("second block");
    // The reveal types the text out over a few frames rather than one.
    await Bun.sleep(150);
    expect(store.getSnapshot().text).toBe("second block");
    store.clear();
  });

  test("types a chunk out at word boundaries instead of pasting it", async () => {
    const full = "Streaming should feel typed, not pasted. ";
    const store = new LiveTurnStore();
    const seen: string[] = [];
    const unsubscribe = store.subscribe(() =>
      seen.push(store.getSnapshot().text),
    );
    store.start(undefined, "run-6");
    store.append(full);
    await Bun.sleep(30);
    const mid = store.getSnapshot().text;
    expect(mid.length).toBeGreaterThan(0);
    expect(mid.length).toBeLessThan(full.length);
    expect(mid.endsWith(" ")).toBe(true);
    await Bun.sleep(300);
    expect(store.getSnapshot().text).toBe(full);
    // Every published frame is a prefix of the final text: the bubble only
    // ever grows, it never shows something the reply will take back.
    for (const frame of seen) expect(full.startsWith(frame)).toBe(true);
    unsubscribe();
    store.clear();
  });

  test("never publishes a frame with an open inline construct", async () => {
    const full = "Check run `a b c` then **bold words** end. ";
    const store = new LiveTurnStore();
    const seen: string[] = [];
    const unsubscribe = store.subscribe(() =>
      seen.push(store.getSnapshot().text),
    );
    store.start(undefined, "run-7");
    store.append(full);
    await Bun.sleep(300);
    expect(store.getSnapshot().text).toBe(full);
    for (const frame of seen) {
      expect((frame.match(/`/g) ?? []).length % 2).toBe(0);
      expect((frame.match(/\*\*/g) ?? []).length % 2).toBe(0);
    }
    unsubscribe();
    store.clear();
  });

  test("reveals a fence opener only together with its first code line", async () => {
    const full = "```ts\nconst a = 1;\nconst b = 2;\n```\n";
    const store = new LiveTurnStore();
    const seen: string[] = [];
    const unsubscribe = store.subscribe(() => {
      const text = store.getSnapshot().text;
      if (text) seen.push(text);
    });
    store.start(undefined, "run-8");
    store.append(full);
    await Bun.sleep(300);
    expect(seen[0]).toBe("```ts\nconst a = 1;\n");
    expect(store.getSnapshot().text).toBe(full);
    unsubscribe();
    store.clear();
  });

  test("finish snaps the tail so nothing keeps typing after the turn", () => {
    const full = "A long sentence that would otherwise type out slowly. ";
    const store = new LiveTurnStore();
    store.start(undefined, "run-9");
    store.append(full);
    store.finish();
    expect(store.getSnapshot().text).toBe(full);
    expect(store.getSnapshot().live).toBe(false);
    store.clear();
  });

  test("streams reasoning and reply as separate blocks and swaps each by id", async () => {
    const store = new LiveTurnStore();
    store.start(undefined, "run-10");
    store.append("I should check ", "msg-1", "reasoning");
    store.append("the router.", "msg-1", "reasoning");
    store.append("Rebased.", "msg-1-b1", "text");
    await Bun.sleep(300);
    expect(store.getSnapshot().blocks).toEqual([
      { key: "msg-1", kind: "reasoning", text: "I should check the router." },
      { key: "msg-1-b1", kind: "text", text: "Rebased." },
    ]);
    expect(store.getTailKind()).toBe("text");

    // The durable thought lands under the same id. Its text may differ (the
    // wire clamps and normalizes); the id alone decides, and the reply block
    // is left exactly as it was.
    store.land([{ id: "msg-1", content: "I should check the router" }]);
    expect(store.getSnapshot().blocks).toEqual([
      { key: "msg-1-b1", kind: "text", text: "Rebased." },
    ]);

    // A late frame of the landed thought is not new text.
    store.append(" More.", "msg-1", "reasoning");
    await Bun.sleep(25);
    expect(store.getSnapshot().blocks).toHaveLength(1);

    store.land([{ id: "msg-1-b1", content: "Rebased." }]);
    expect(store.getSnapshot().text).toBe("");
    expect(store.getTailKind()).toBeNull();
    store.clear();
  });

  test("shows a lump at once instead of typing it out", async () => {
    // The provider delivered a finished message in one burst: typing it out
    // would only delay words whose durable row lands moments later.
    const words = "The router is fine and the tests pass now. ";
    const store = new LiveTurnStore();
    store.start(undefined, "run-11");
    for (let i = 0; i < 8; i++) store.append(words, "msg-2", "text");
    await Bun.sleep(25);
    expect(store.getSnapshot().text).toBe(words.repeat(8));
    store.clear();
  });

  test("still types out a single shipped chunk", async () => {
    const full =
      "A sentence long enough to be typed out over a few frames rather than pasted. ";
    const store = new LiveTurnStore();
    store.start(undefined, "run-12");
    store.append(full, "msg-3", "text");
    await Bun.sleep(30);
    const mid = store.getSnapshot().text;
    expect(mid.length).toBeGreaterThan(0);
    expect(mid.length).toBeLessThan(full.length);
    store.clear();
  });

  test("keeps an unchanged block's view object across frames", async () => {
    const store = new LiveTurnStore();
    store.start(undefined, "run-reuse");
    store.append("I should check the config first.", "msg-1", "reasoning");
    await Bun.sleep(600);
    const thought = store.getSnapshot().blocks[0];
    expect(thought?.text).toBe("I should check the config first.");
    store.append("Checking", "msg-1-b1", "text");
    await Bun.sleep(600);
    store.append(" it now.", "msg-1-b1", "text");
    await Bun.sleep(600);
    const [first, second] = store.getSnapshot().blocks;
    // Only the growing block is a new object, so a memoized row for the
    // thought does not re-render its markdown on every frame.
    expect(first).toBe(thought);
    expect(second?.text).toBe("Checking it now.");
    store.clear();
  });

  test("never shows a whitespace-only block, which no durable row replaces", async () => {
    const store = new LiveTurnStore();
    store.start(undefined, "run-blank");
    store.append("\n\n", "msg-1-b1", "text");
    await Bun.sleep(50);
    expect(store.getSnapshot().blocks).toEqual([]);
    expect(store.hasText()).toBe(false);
    store.append("Checking the config.", "msg-1-b2", "reasoning");
    store.finish();
    expect(store.getSnapshot().blocks.map((block) => block.key)).toEqual([
      "msg-1-b2",
    ]);
    // The thought lands; nothing is left in the bubble.
    store.land([{ id: "msg-1-b2", content: "Checking the config." }]);
    expect(store.getSnapshot().blocks).toEqual([]);
    expect(store.getSnapshot().text).toBe("");
    store.clear();
  });

  test("a durable entry under another id still replaces the live text it repeats", () => {
    // An engine whose durable row does not reuse the live block ids (the
    // motion fixture's answer, older engines): the string fallback that the
    // shared LiveTextBuffer applies still clears the bubble.
    const store = new LiveTurnStore();
    store.start(undefined, "run-other-id");
    const parts = ["Intro.", "\n\nTool 1 settled.", "\n\nAll done."];
    store.append(parts[0]!, "s-intro");
    store.append(parts[1]!, "s-0");
    store.append(parts[2]!, "s-final");
    store.finish();
    store.land([{ id: "answer", content: parts.join("") }]);
    expect(store.getSnapshot().blocks).toEqual([]);
    expect(store.getSnapshot().text).toBe("");

    // Only the repeated span leaves; text the entry does not say stays.
    store.start(undefined, "run-partial");
    store.append("First paragraph.", "p-1");
    store.append(" Second paragraph.", "p-2");
    store.finish();
    store.land([{ id: "answer-2", content: "First paragraph." }]);
    expect(store.getSnapshot().blocks.map((block) => block.text)).toEqual([
      " Second paragraph.",
    ]);
    store.clear();
  });

  test("holds an early tool card under the live text it follows", async () => {
    const store = new LiveTurnStore();
    store.start(undefined, "run-13");
    const card = {
      id: "call-1",
      type: "tool_use" as const,
      toolUseId: "call-1",
      toolName: "bash",
      toolInput: {},
      content: "Using bash",
      timestamp: "2026-10-24T19:13:39Z",
    };
    // Nothing live on screen: the transcript can take it directly.
    expect(store.holdTool(card, true)).toBe(false);

    store.append("I should verify the changes.", "msg-4", "reasoning");
    await Bun.sleep(300);
    expect(store.holdTool(card, true)).toBe(true);
    expect(store.getSnapshot().tools).toEqual([card]);

    // Its input arrives on the ordinary frame: updated in place.
    const filled = { ...card, toolInput: { command: "pnpm install && tsc" } };
    expect(store.holdTool(filled, false)).toBe(true);
    expect(store.getSnapshot().tools).toEqual([filled]);

    // A card nobody held still goes to the transcript.
    expect(store.holdTool({ ...card, id: "call-2" }, false)).toBe(false);

    // The message's durable rows land together, the way the viewers route
    // them: prose through land(), the tool call by id through landIds(). Both
    // leave the bubble, and a late frame for the call is the transcript's.
    store.land([{ id: "msg-4", content: "I should verify the changes." }]);
    store.landIds(["call-1"]);
    expect(store.getSnapshot().tools).toEqual([]);
    expect(store.getSnapshot().text).toBe("");
    expect(store.holdTool(filled, false)).toBe(false);
    store.clear();
  });

  test("keeps the phase beside the bubble and drops it when the turn ends", () => {
    const store = new LiveTurnStore();
    store.start(undefined, "run-14");
    expect(store.getPhase()).toBeNull();
    const snapshot = store.getSnapshot();
    store.setPhase({ phase: "tool", since: Date.now() + 60_000 });
    // A server clock ahead of this one never starts a counter in the future.
    expect(store.getPhase()!.since).toBeLessThanOrEqual(Date.now());
    // The bubble's snapshot is untouched, so it does not repaint.
    expect(store.getSnapshot()).toBe(snapshot);
    store.finish();
    expect(store.getPhase()).toBeNull();
    store.clear();
  });
});
