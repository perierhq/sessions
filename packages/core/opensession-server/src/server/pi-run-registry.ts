import { registerActiveRunProbe } from "./run-journal";
import type { ImageInput } from "./run-events";

const g = globalThis as any;

// ── Live-run registry ────────────────────────────────────────────────────────

export interface PiRunHandle {
  abort: AbortController;
  /** Distinct-run identity: every alias key maps to the same handle object. */

  steer?: (text: string, images?: ImageInput[], steerId?: string) => void;
  retractSteer?: (steerId: string) => boolean;
  acceptedSteerIds?: Set<string>;
}

// Alias keys (runKey, unified session id, pi session id) → shared handle,
// parked on globalThis so hot reloads keep cancel/steer/isBusy working for
// in-flight turns — same pattern as the previous runner runner's activeRuns.
const activeRuns: Map<string, PiRunHandle> = (g.__piActiveRuns ??= new Map());

registerActiveRunProbe((runKey) => activeRuns.has(runKey));

export function isPiSessionBusy(id: string): boolean {
  return activeRuns.has(id);
}

export function activePiRunCount(): number {
  return new Set(activeRuns.values()).size;
}

/** Register `handle` under every key unless one of them is already live.
 *  False = busy: nothing was registered. */
export function claimPiRun(
  keys: ReadonlySet<string>,
  handle: PiRunHandle,
): boolean {
  if ([...keys].some((key) => activeRuns.has(key))) return false;
  for (const key of keys) activeRuns.set(key, handle);
  return true;
}

/** Add one alias key (the engine session id) for a claimed run. */
export function aliasPiRun(
  keys: Set<string>,
  key: string,
  handle: PiRunHandle,
): void {
  if (!keys.has(key)) {
    keys.add(key);
    activeRuns.set(key, handle);
  }
}

/** Drop every key still pointing at this run's handle. */
export function releasePiRun(
  keys: ReadonlySet<string>,
  handle: PiRunHandle,
): void {
  for (const key of keys) {
    if (activeRuns.get(key) === handle) activeRuns.delete(key);
  }
}

export function cancelPiRun(id: string): boolean {
  const handle = activeRuns.get(id);
  if (!handle) return false;
  handle.abort.abort();
  return true;
}

/** Native mid-turn steer: session.steer() queues the text for delivery at the
 *  next completed tool or assistant-message boundary, before the next LLM
 *  call. True = a live run accepted it; false = nothing steerable (caller
 *  queues for the next turn instead). */
export function acceptSteerOnce(
  accepted: Set<string>,
  steerId: string,
  accept: () => void,
): boolean {
  if (accepted.has(steerId)) return true;
  accept();
  accepted.add(steerId);
  return true;
}

export function steerPiRun(
  id: string,
  text: string,
  images?: ImageInput[],
  steerId?: string,
): boolean {
  const handle = activeRuns.get(id);
  if (!handle?.steer) return false;
  if (!steerId) {
    handle.steer(text, images);
    return true;
  }
  return acceptSteerOnce((handle.acceptedSteerIds ??= new Set()), steerId, () =>
    handle.steer!(text, images, steerId),
  );
}

export function retractPiSteer(id: string, steerId: string): boolean {
  const handle = activeRuns.get(id);
  const retracted = handle?.retractSteer?.(steerId) === true;
  if (retracted) handle?.acceptedSteerIds?.delete(steerId);
  return retracted;
}

/** Remove one exact pending steer, then let the caller rebuild the engine queue.
 * The synchronous mutation is the race boundary: delivery either removed the
 * item first, or retraction does, never both. */
export function retractPendingSteer<T extends { steerId?: string }>(
  pending: T[],
  steerId: string,
  replay: (remaining: readonly T[]) => void,
): boolean {
  const index = pending.findIndex((item) => item.steerId === steerId);
  if (index < 0) return false;
  const remaining = pending.filter((_, candidate) => candidate !== index);
  pending.splice(0, pending.length, ...remaining);
  replay(remaining);

  return true;
}
