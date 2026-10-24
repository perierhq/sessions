import { expect, test } from "bun:test";
import { feedSnapshotFrames } from "./feed-snapshot-frames";
import type { WSServerMessage } from "./types";

type Snapshot = Extract<WSServerMessage, { type: "feed_snapshot" }>;

const snapshot = (active: Snapshot["active"]): Snapshot => ({
  type: "feed_snapshot",
  sessionId: "s1",
  feedEpoch: "e1",
  feedSeq: 7,
  active,
});

const active = {
  runId: "r1",
  turnId: "t1",
  entryId: "a1",
  by: "acme",
  startedAt: 1_000,
};

test("an idle snapshot replays nothing", () => {
  expect(feedSnapshotFrames(snapshot(null))).toEqual([]);
});

test("a mid-turn snapshot replays each live block by id and kind, then the phase", () => {
  const frames = feedSnapshotFrames(
    snapshot({
      ...active,
      text: "I should run the tests.Running them now.",
      blocks: [
        { id: "m1", text: "I should run the tests.", kind: "reasoning" },
        { id: "m1-b1", text: "Running them now.", kind: "text" },
      ],
      phase: {
        phase: "tool",
        since: 5_000,
        tool: { id: "call-1", name: "bash", summary: "bun test" },
        toolCount: 1,
      },
    }),
  );
  expect(frames).toEqual([
    { type: "stream_start", sessionId: "s1", by: "acme" },
    {
      type: "stream_text",
      sessionId: "s1",
      text: "I should run the tests.",
      blockId: "m1",
      kind: "reasoning",
    },
    {
      type: "stream_text",
      sessionId: "s1",
      text: "Running them now.",
      blockId: "m1-b1",
      kind: "text",
    },
    {
      type: "stream_phase",
      sessionId: "s1",
      phase: "tool",
      since: 5_000,
      tool: { id: "call-1", name: "bash", summary: "bun test" },
      toolCount: 1,
    },
  ]);
});

test("an older server's snapshot without blocks replays the joined text", () => {
  expect(
    feedSnapshotFrames(snapshot({ ...active, text: "Partial reply" })),
  ).toEqual([
    { type: "stream_start", sessionId: "s1", by: "acme" },
    { type: "stream_text", sessionId: "s1", text: "Partial reply" },
  ]);
});

test("the socket hook replays a feed snapshot through these frames", async () => {
  const hook = await Bun.file(
    new URL("../hooks/useWebSocket.ts", import.meta.url),
  ).text();
  const at = hook.indexOf('msg.type === "feed_snapshot"');
  expect(at).toBeGreaterThan(-1);
  expect(hook.slice(at, at + 800)).toContain(
    "for (const frame of feedSnapshotFrames(msg))",
  );
});
