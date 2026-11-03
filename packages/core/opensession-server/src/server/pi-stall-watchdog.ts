/**
 * Stall watchdog for one pi turn.
 *
 * A provider stream can hang without an error: no tokens, no tool call, no
 * end. The session then shows "running" until someone notices, which on a
 * phone can be hours. This watches the turn's engine events. After
 * `steerAfterMs` with none, it steers the turn once with a short note (a
 * thinking-only response is cut by it; pi-steer-controller.ts). If still
 * nothing arrives for `stopAfterMs` more, it stops the turn and pi-runner
 * ends it with `stopReason` as the error, so the person sees why.
 *
 * Any event starts the quiet period again, so a long but live turn never
 * trips it. While any tool call runs it is paused entirely: tools carry
 * their own timeouts (bash caps at 10 minutes), and a question card or a
 * browser hand-off is a tool call that waits on a person for as long as it
 * takes, with no events at all.
 *
 * Minutes come from pi.json (`stallSteerMinutes`, default 10;
 * `stallStopMinutes`, default 5); `stallSteerMinutes: 0` turns it off.
 */

import { readPiEngineConfig, type PiEngineConfig } from "./pi-config";

export const PI_STALL_STEER_MINUTES = 10;
export const PI_STALL_STOP_MINUTES = 5;

export interface PiStallTimers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (id: unknown) => void;
}

const realTimers: PiStallTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export interface PiStallConfig {
  steerAfterMs: number;
  stopAfterMs: number;
}

/** The watchdog's timing from pi.json (pi-config.ts), or null when it is
 *  turned off. */
export function readPiStallConfig(
  config: Pick<
    PiEngineConfig,
    "stallSteerMinutes" | "stallStopMinutes"
  > | null = readPiEngineConfig(),
): PiStallConfig | null {
  const steer = config?.stallSteerMinutes ?? PI_STALL_STEER_MINUTES;
  if (steer === 0) return null;
  const stop = config?.stallStopMinutes || PI_STALL_STOP_MINUTES;
  return { steerAfterMs: steer * 60_000, stopAfterMs: stop * 60_000 };
}

/** "10 minutes", "1 minute", "30 seconds". */
function span(ms: number): string {
  if (ms < 60_000) {
    const s = Math.max(1, Math.round(ms / 1000));
    return `${s} second${s === 1 ? "" : "s"}`;
  }
  const m = Math.round(ms / 6_000) / 10;
  return `${m} minute${m === 1 ? "" : "s"}`;
}

/** Engine events that mean the turn is moving. */
const PROGRESS_EVENTS = new Set([
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "compaction_start",
  "compaction_end",
  "auto_retry_start",
  "auto_retry_end",
]);

export class PiStallWatchdog {
  private readonly steerAfterMs: number;
  private readonly stopAfterMs: number;
  private readonly onSteer: (note: string) => void;
  private readonly onStop: (reason: string) => void;
  private readonly timers: PiStallTimers;
  private readonly runningTools = new Set<string>();
  private timer: unknown;
  private steered = false;
  private disposed = false;
  private reason: string | undefined;

  constructor(init: {
    steerAfterMs: number;
    stopAfterMs: number;
    onSteer: (note: string) => void;
    onStop: (reason: string) => void;
    timers?: PiStallTimers;
  }) {
    this.steerAfterMs = init.steerAfterMs;
    this.stopAfterMs = init.stopAfterMs;
    this.onSteer = init.onSteer;
    this.onStop = init.onStop;
    this.timers = init.timers ?? realTimers;
  }

  /** Why the watchdog stopped the turn; undefined until it does. */
  get stopReason(): string | undefined {
    return this.reason;
  }

  /** Start watching: the prompt was just sent. */
  start(): void {
    this.rearm();
  }

  /** One engine event of the turn. Only events that show the model or a
   *  tool working count; bookkeeping (pi's queue_update for the nudge's own
   *  enqueue, session info, custom entries) would otherwise reset the
   *  watchdog and it would nudge forever without stopping. */
  observe(ev: { type: string; toolCallId?: unknown }): void {
    if (this.disposed || this.reason) return;
    if (!PROGRESS_EVENTS.has(ev.type)) return;
    if (ev.type === "tool_execution_start" && ev.toolCallId != null)
      this.runningTools.add(String(ev.toolCallId));
    else if (ev.type === "tool_execution_end" && ev.toolCallId != null)
      this.runningTools.delete(String(ev.toolCallId));
    this.steered = false;
    this.rearm();
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  private clear(): void {
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
  }

  private rearm(): void {
    this.clear();
    if (this.disposed || this.reason || this.runningTools.size > 0) return;
    if (!this.steered) {
      this.timer = this.timers.set(() => this.steer(), this.steerAfterMs);
    } else {
      this.timer = this.timers.set(() => this.stop(), this.stopAfterMs);
    }
  }

  private steer(): void {
    this.timer = undefined;
    if (this.disposed || this.reason) return;
    this.steered = true;
    this.onSteer(
      `Nothing has happened in this turn for ${span(this.steerAfterMs)}: no reply text and no ` +
        "tool call. If you are stuck or waiting on something that will not come, say what is " +
        "blocking you and end your turn. Otherwise continue.",
    );
    this.rearm();
  }

  private stop(): void {
    this.timer = undefined;
    if (this.disposed || this.reason) return;
    this.reason =
      `Stopped: the turn made no progress for ${span(this.steerAfterMs + this.stopAfterMs)} ` +
      "(no reply text and no tool call, even after a nudge). Send a message to continue.";
    this.onStop(this.reason);
  }
}
