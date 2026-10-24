// The session viewer's live-turn wiring, run through the real subscription
// hook: frames go in through the socket handler it registers, and the test
// reads the live-turn store and the transcript view store it drives. The
// hook's own React hooks run in the hook harness (no DOM).
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { createHookHarness, reactWithHarness } from "../tools/hook-harness";
import type { TranscriptEntry, WSServerMessage } from "../lib/types";

const storage = new Map<string, string>();
const noopListener = () => {};
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  },
  window: { addEventListener: noopListener, removeEventListener: noopListener },
});

const harness = createHookHarness();
const realReact = await import("react");
mock.module("react", () => reactWithHarness({ ...realReact }, harness));

const { useSessionViewerSubscription } =
  await import("./useSessionViewerSubscription");
const { LiveTurnStore } = await import("../lib/live-turn-store");
const { TranscriptViewStore } = await import("../lib/transcript-view-store");

type Options = Parameters<typeof useSessionViewerSubscription>[0];

const SESSION = "os-test-session";
const noop = () => {};

let handler: ((message: WSServerMessage) => void) | null = null;
let liveTurnStore: InstanceType<typeof LiveTurnStore>;
let viewStore: InstanceType<typeof TranscriptViewStore>;

function options(): Options {
  const ref = <T>(current: T) => ({ current });
  return {
    connection: {
      connected: true,
      // SAFETY: the hook reads only id, ran and modelHistory.
      session: { id: SESSION, ran: true } as Options["connection"]["session"],
      addHandler: (next) => {
        handler = next;
        return () => {
          handler = null;
        };
      },
      send: noop,
      onRunningChange: undefined,
    },
    transcript: {
      cursorRef: ref(null),
      sequenceRef: ref(null),
      readySessionRef: ref(null),
      viewStore,
      setEntries: (update) => viewStore.update(update),
      setLoading: noop,
      setSyncing: noop,
      setHistoryTruncated: noop,
      liveTurnStore,
    },
    index: {
      existingForInit: () => null,
      setMode: noop,
      acceptInitTail: noop,
      replace: noop,
      messagesRef: ref(null),
      followingLive: ref(true),
      acceptRange: noop,
      projectAppend: noop,
    } as unknown as Options["index"],
    history: {
      backgroundRef: ref(false),
      revealRef: ref(null),
      loadingRef: ref(false),
      setLoading: noop,
      walkRef: ref(null),
      setLoadingAll: noop,
      finishWalk: noop,
      shellTiming: { record: noop },
      startRef: ref(null),
      jumpMaxEntries: 1000,
      requestPage: noop,
      scrollToLatest: noop,
    },
    runtime: {
      setWorkflowRuns: noop,
      setViewers: noop,
      setTypingPresence: noop,
      dispatch: noop,
      setGitRefreshTick: noop,
      prTargetsRef: ref(new Set<string>()),
      setWorkspacePreparing: noop,
      setStopRequestedAt: noop,
      setAccountId: noop,
    },
    composer: {
      draggingQueueRef: ref(false),
      draftKey: "draft",
      setImages: noop,
      setFiles: noop,
      setContextSessions: noop,
      setPrefill: noop,
      setReplySuggestions: noop,
      setComposerPrediction: noop,
      emptySuggestions: [],
    },
    slack: {
      setComposer: noop,
      setStatus: noop,
      setReconnect: noop,
      setSent: noop,
    },
  };
}

function Probe(props: Options) {
  useSessionViewerSubscription(props);
  return null;
}

function frame(message: WSServerMessage) {
  if (!handler) throw new Error("the hook registered no socket handler");
  handler(message);
}

const toolUse = (
  id: string,
  toolInput: Record<string, unknown> = {},
): TranscriptEntry => ({
  id,
  type: "tool_use",
  content: "Using bash",
  timestamp: "2026-01-01T00:00:01.000Z",
  toolName: "bash",
  toolUseId: id,
  toolInput,
});

beforeEach(() => {
  storage.clear();
  liveTurnStore = new LiveTurnStore();
  viewStore = new TranscriptViewStore();
  harness.mount(Probe, options());
});

afterEach(() => {
  harness.unmountAll();
  handler = null;
});

test("a held early tool card is released when its durable row lands", () => {
  frame({ type: "stream_start", sessionId: SESSION, by: "acme" });
  frame({
    type: "stream_text",
    sessionId: SESSION,
    text: "Checking the tests.",
    blockId: "msg-1",
    kind: "text",
  });
  frame({
    type: "stream_tool_use",
    sessionId: SESSION,
    entry: toolUse("call-1"),
    inputPending: true,
  });
  expect(liveTurnStore.getSnapshot().tools.map((t) => t.id)).toEqual([
    "call-1",
  ]);

  frame({
    type: "transcript_append",
    sessionId: SESSION,
    entries: [
      {
        id: "msg-1",
        type: "assistant",
        content: "Checking the tests.",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
      toolUse("call-1", { command: "bun test" }),
    ],
  });

  // The durable card is in the transcript; the live bubble no longer holds a
  // second, pending copy of it.
  expect(liveTurnStore.getSnapshot().tools).toEqual([]);
  expect(viewStore.getSnapshot().map((e) => e.id)).toEqual(["msg-1", "call-1"]);

  // The frame that follows at tool_execution_start does not bring it back.
  frame({
    type: "stream_tool_use",
    sessionId: SESSION,
    entry: toolUse("call-1", { command: "bun test" }),
  });
  expect(liveTurnStore.getSnapshot().tools).toEqual([]);
});
