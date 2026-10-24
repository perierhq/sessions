import { LiveTextBuffer } from "@tellahq/opensession-protocol/live-text";
import { advanceReveal } from "@tellahq/opensession-protocol/stream-cuts";
import type { StreamTextKind } from "@tellahq/opensession-protocol/events";
import type { TranscriptEntry } from "./types";
import type { LivePhase } from "./live-phase";
import {
  countSessionPerf,
  recordSessionPerf,
  startSessionPerfObservers,
} from "./session-performance";
import { randomUUID } from "./random-uuid";

/** One block of the live bubble, as far as the reveal has typed it. */
export interface LiveBlockView {
  /** The engine's block id (the durable row will carry it), or "anon" for
   * text that arrived without one. */
  key: string;
  kind: StreamTextKind;
  text: string;
}

export interface LiveTurnSnapshot {
  /** Every visible block's text, joined: what older surfaces render. */
  text: string;
  /** The same text split by block, in arrival order. */
  blocks: LiveBlockView[];
  /** Tool calls the model has started writing while live text from the same
   * message is still on screen. They render after that text, in the order
   * the model wrote them, until their durable rows land. */
  tools: TranscriptEntry[];
  live: boolean;
  by: string | null;
  runId: string | null;
  /** This run has painted visible stream text at least once. It stays true
   * across block reconciliation so progress chrome does not flicker back
   * between landed blocks. */
  hasPaintedText: boolean;
  revision: number;
}

const EMPTY: LiveTurnSnapshot = {
  text: "",
  blocks: [],
  tools: [],
  live: false,
  by: null,
  runId: null,
  hasPaintedText: false,
  revision: 0,
};

const ANON = "anon";

interface LiveBlock {
  id: string;
  kind: StreamTextKind;
  text: string;
  /** Recent frames (receive time, length), for telling a burst from a stream. */
  recent: Array<{ at: number; length: number }>;
}

// A shipped chunk is a sentence or a paragraph (the server cuts frames at
// block boundaries); pasting it in one repaint is the jump the reveal exists
// to remove. The pace is proportional to the backlog — a burst types out
// fast, the last words land gently — and a cut only ever falls on a
// word-safe boundary (advanceReveal), so mid-construct markdown never shows.
const CATCH_UP_MS = 400;
// Floor on per-frame progress so a short tail still finishes promptly.
const MIN_REVEAL_STEP = 2;
// A block that receives this much text inside this window arrived as a lump
// (the provider delivered a finished message at once), not as a stream.
// Typing a lump out only delays it: its durable row lands a few dozen
// milliseconds later anyway. Show it whole. A single shipped chunk is still
// typed out, which is what the reveal exists for.
const BURST_WINDOW_MS = 150;
const BURST_CHARS = 160;

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

type ScheduledFrame =
  | { kind: "animation"; id: number }
  | { kind: "timeout"; id: ReturnType<typeof setTimeout> };

const scheduleFrame = (callback: FrameRequestCallback): ScheduledFrame => {
  const requestFrame = globalThis.requestAnimationFrame;
  return requestFrame
    ? { kind: "animation", id: requestFrame(callback) }
    : {
        kind: "timeout",
        id: setTimeout(() => callback(performance.now()), 16),
      };
};

const cancelFrame = (frame: ScheduledFrame) => {
  if (frame.kind === "timeout") {
    clearTimeout(frame.id);
    return;
  }
  const cancelAnimation = globalThis.cancelAnimationFrame;
  if (cancelAnimation) cancelAnimation(frame.id);
  else clearTimeout(frame.id);
};

// Placeholder held while scheduleFrame is being called: if the callback fires
// synchronously (a test-installed requestAnimationFrame may), flush() nulls
// `frame` before scheduleFrame returns, and storing the returned handle over
// that null would block every future schedule, silencing the store for good.
const SCHEDULING = Symbol("scheduling-frame");

/**
 * The bubble a running turn writes into, and what the run is doing.
 *
 * Text arrives as blocks. A block the engine names (`blockId`) is kept by
 * that id and by its kind, the model's reasoning or its reply, so each renders
 * as its own row and is removed exactly when the durable row with the same id
 * lands: the row a reader is looking at is swapped, never rewritten. Text
 * without an id (older engines, a reconnect snapshot) goes through
 * `LiveTextBuffer`, the shared string-matching fallback.
 *
 * When to paint is this class's other job: the buffer holds what has arrived,
 * and a per-frame reveal types it out a few words at a time (`advanceReveal`)
 * instead of pasting a whole shipped block in one repaint. The pace scales
 * with the backlog, so the bubble never trails the model by more than about
 * CATCH_UP_MS; a lump (BURST_CHARS inside BURST_WINDOW_MS), a landed entry or
 * the end of the turn snaps it forward.
 *
 * The phase (`stream_phase`) is kept beside the snapshot rather than in it,
 * so a phase change re-renders the status row without repainting the bubble.
 */
export class LiveTurnStore {
  private snapshot: LiveTurnSnapshot = EMPTY;
  private listeners = new Set<() => void>();
  private anon = new LiveTextBuffer();
  private blocks: LiveBlock[] = [];
  private landedIds = new Set<string>();
  private tools: TranscriptEntry[] = [];
  private phase: LivePhase | null = null;
  private frame: ScheduledFrame | typeof SCHEDULING | null = null;
  private clearTimer: ReturnType<typeof setTimeout> | null = null;
  private firstDeltaAt: number | null = null;
  /** How much of the held text the bubble shows; the reveal walks it forward. */
  private shown = 0;
  /** A lump arrived: the next paint shows everything held. */
  private snapPending = false;
  private lastFrameAt = 0;
  private instant = prefersReducedMotion();

  constructor() {
    startSessionPerfObservers();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;
  getServerSnapshot = () => EMPTY;
  hasText = () => Boolean(this.heldText());
  hasPaintedText = () => this.snapshot.hasPaintedText;
  textLength = () => this.heldText().length;
  /** What the run is doing, from its latest stream_phase; null until one
   * arrives, and after the turn ends. */
  getPhase = () => this.phase;
  /** The kind of the newest visible block, or null when the bubble is empty. */
  getTailKind = (): StreamTextKind | null =>
    this.snapshot.blocks.at(-1)?.kind ?? null;

  start(by?: string | null, runId?: string) {
    this.cancelTimers();
    this.resetHeld();
    this.phase = null;
    this.instant = prefersReducedMotion();
    this.firstDeltaAt = null;
    this.snapshot = {
      ...EMPTY,
      live: true,
      by: by ?? null,
      runId: runId ?? randomUUID(),
      revision: this.snapshot.revision + 1,
    };
    this.emit();
  }

  append(text: string, blockId?: string, kind: StreamTextKind = "text") {
    if (!text) return;
    const now = performance.now();
    if (blockId) {
      if (this.landedIds.has(blockId)) return;
      let block = this.blocks.find((candidate) => candidate.id === blockId);
      if (!block) {
        block = { id: blockId, kind, text: "", recent: [] };
        this.blocks.push(block);
      }
      block.text += text;
      if (this.isBurst(block.recent, now, text.length)) this.snapPending = true;
    } else {
      if (!this.anon.append(text)) return;
      if (this.isBurst(this.anonRecent, now, text.length))
        this.snapPending = true;
    }
    countSessionPerf("stream_frames_received");
    if (this.firstDeltaAt === null) this.firstDeltaAt = now;
    this.schedule();
  }

  /**
   * A tool card frame (`stream_tool_use`; `early` when the model has only
   * started writing the call). Returns false when the caller should merge it into the transcript as
   * usual: no live text is on screen for it to follow, so it cannot be shown
   * out of order there.
   */
  holdTool(entry: TranscriptEntry, early: boolean): boolean {
    if (this.landedIds.has(entry.id)) return false;
    const at = this.tools.findIndex((tool) => tool.id === entry.id);
    // A later frame for a held card updates it in place (its input arrived);
    // only an early card starts being held.
    if (at === -1 && (!early || !this.heldText())) return false;
    if (at === -1) this.tools = [...this.tools, entry];
    else this.tools = this.tools.map((tool, i) => (i === at ? entry : tool));
    this.publish(false);
    return true;
  }

  /** The run's current phase, from a stream_phase frame. */
  setPhase(next: LivePhase | null) {
    if (next) {
      // `since` is on the server's clock. Never let a clock ahead of this one
      // start a counter in the future; behind, the count is off by the skew,
      // which NTP keeps to milliseconds on both ends.
      next = { ...next, since: Math.min(next.since, Date.now()) };
    }
    this.phase = next;
    this.emit();
  }

  /** Blocks that just landed as durable transcript entries. */
  land(entries: Array<{ id?: string; content: string }>) {
    for (const entry of entries) {
      let matched = false;
      if (entry.id) {
        this.landedIds.add(entry.id);
        const before = this.blocks.length;
        this.blocks = this.blocks.filter((block) => block.id !== entry.id);
        matched = this.blocks.length !== before;
        if (this.tools.some((tool) => tool.id === entry.id)) {
          this.tools = this.tools.filter((tool) => tool.id !== entry.id);
          matched = true;
        }
      }
      // An id'd block that matched has nothing to cancel in the anonymous
      // text unless some is on screen (a reconnect snapshot of the same run).
      if (!matched || !this.anon.isEmpty)
        this.anon.land(entry.content, entry.id);
    }
    // The durable entry supersedes the bubble: snap the reveal so no tail of
    // a landed block keeps typing under the entry that already says it.
    this.shown = this.heldText().length;
    this.publish(false);
  }

  finish() {
    // Snap the tail: the durable entry lands next, and a bubble that keeps
    // typing after the turn ended reads as a stuck run.
    this.shown = this.heldText().length;
    this.phase = null;
    this.publish(false, {
      hasPaintedText: this.snapshot.hasPaintedText || Boolean(this.heldText()),
      live: false,
      by: null,
    });
    if (this.clearTimer !== null) clearTimeout(this.clearTimer);
    const runId = this.snapshot.runId;
    this.clearTimer = setTimeout(() => {
      if (this.snapshot.runId === runId && !this.snapshot.live) this.clear();
    }, 5_000);
  }

  clear() {
    this.cancelTimers();
    this.resetHeld();
    this.phase = null;
    this.snapshot = {
      ...EMPTY,
      revision: this.snapshot.revision + 1,
    };
    this.emit();
  }

  private anonRecent: Array<{ at: number; length: number }> = [];

  private resetHeld() {
    this.anon.reset();
    this.anonRecent = [];
    this.blocks = [];
    this.landedIds.clear();
    this.tools = [];
    this.shown = 0;
    this.snapPending = false;
    this.lastFrameAt = 0;
  }

  /** Record a frame; true once the window holds a lump rather than a stream. */
  private isBurst(
    recent: Array<{ at: number; length: number }>,
    now: number,
    length: number,
  ): boolean {
    recent.push({ at: now, length });
    while (recent.length > 0 && now - recent[0]!.at > BURST_WINDOW_MS)
      recent.shift();
    if (recent.length < 2) return false;
    let chars = 0;
    for (const frame of recent) chars += frame.length;
    return chars >= BURST_CHARS;
  }

  /** Held text in display order: the anonymous run, then each named block. */
  private segments(): Array<{
    key: string;
    kind: StreamTextKind;
    text: string;
  }> {
    const out: Array<{ key: string; kind: StreamTextKind; text: string }> = [];
    const anonText = this.anon.text;
    if (anonText) out.push({ key: ANON, kind: "text", text: anonText });
    for (const block of this.blocks)
      if (block.text)
        out.push({ key: block.id, kind: block.kind, text: block.text });
    return out;
  }

  private heldText(): string {
    let out = this.anon.text;
    for (const block of this.blocks) out += block.text;
    return out;
  }

  /** Walk the reveal forward by `budget` characters, block by block, each cut
   * on a word-safe boundary of its own block (advanceReveal). */
  private advance(budget: number): number {
    let offset = 0;
    let left = budget;
    for (const segment of this.segments()) {
      const end = offset + segment.text.length;
      if (this.shown < end) {
        const local = advanceReveal(
          segment.text,
          this.shown - offset,
          Math.max(1, left),
        );
        const moved = offset + local - this.shown;
        this.shown = offset + local;
        left -= moved;
        if (this.shown < end || left <= 0) return this.shown;
      }
      offset = end;
    }
    return this.shown;
  }

  /** Publish what the reveal has reached. */
  private publish(painted: boolean, extra: Partial<LiveTurnSnapshot> = {}) {
    const segments = this.segments();
    const blocks: LiveBlockView[] = [];
    let offset = 0;
    let text = "";
    for (const segment of segments) {
      const visible = Math.max(
        0,
        Math.min(segment.text.length, this.shown - offset),
      );
      if (visible > 0) {
        const slice = segment.text.slice(0, visible);
        blocks.push({ key: segment.key, kind: segment.kind, text: slice });
        text += slice;
      }
      offset += segment.text.length;
    }
    this.snapshot = {
      ...this.snapshot,
      text,
      blocks,
      tools: this.tools,
      hasPaintedText: this.snapshot.hasPaintedText || (painted && !!text),
      ...extra,
      revision: this.snapshot.revision + 1,
    };
    this.emit();
  }

  private schedule() {
    if (this.frame !== null) return;
    this.frame = SCHEDULING;
    const id = scheduleFrame(() => this.flush());
    // A synchronous callback already flushed and cleared the slot.
    if (this.frame === SCHEDULING) this.frame = id;
  }

  private flush() {
    if (this.frame !== null && this.frame !== SCHEDULING) {
      cancelFrame(this.frame);
    }
    this.frame = null;
    const target = this.heldText().length;
    if (this.shown >= target) {
      // Caught up (or the held text shrank under us via land).
      this.shown = target;
      this.lastFrameAt = 0;
      this.snapPending = false;
      return;
    }
    if (this.instant || this.snapPending) {
      this.shown = target;
      this.snapPending = false;
    } else {
      const now = performance.now();
      const dt =
        this.lastFrameAt > 0 ? Math.min(now - this.lastFrameAt, 100) : 17;
      this.lastFrameAt = now;
      const backlog = target - this.shown;
      const budget = Math.max(
        MIN_REVEAL_STEP,
        Math.round((backlog * dt) / CATCH_UP_MS),
      );
      this.advance(budget);
    }
    const receivedAt = this.firstDeltaAt;
    this.firstDeltaAt = null;
    countSessionPerf("stream_paints");
    if (receivedAt !== null) {
      recordSessionPerf(
        "first_delta_to_paint_ms",
        performance.now() - receivedAt,
      );
    }
    this.publish(true);
    // Keep typing until the bubble has caught the held text up.
    if (this.shown < target) this.schedule();
    else this.lastFrameAt = 0;
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }

  private cancelTimers() {
    if (this.frame !== null && this.frame !== SCHEDULING) {
      cancelFrame(this.frame);
    }
    if (this.clearTimer !== null) clearTimeout(this.clearTimer);
    this.frame = null;
    this.clearTimer = null;
  }
}
