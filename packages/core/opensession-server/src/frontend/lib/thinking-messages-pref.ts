import type { TranscriptEntry } from "./types";
import { isLegacyReasoningHeading } from "./reasoning-display";
import * as UserPrefs from "./user-pref";

export type ThinkingMessagesPref = "none" | "latest" | "all";

const pref = UserPrefs.makeUserPref<ThinkingMessagesPref>({
  localKey: "opensession-thinking-messages",
  prefKey: "thinking-messages",
  changeEvent: "opensession-thinking-messages-changed",
  defaultValue: "latest",
  decode: (value) =>
    value === "none" || value === "latest" || value === "all" ? value : null,
  encode: (value) => value,
});

export const getThinkingMessagesPref = pref.get;
export const setThinkingMessagesPref = pref.set;
export const onThinkingMessagesChanged = pref.onChanged;

/**
 * A work-rail row where the model is thinking rather than talking. Work never
 * holds a turn's final answer, so a bold-only assistant row here is a legacy
 * reasoning heading, not a bold answer.
 */
export function isThinkingEntry(entry: TranscriptEntry): boolean {
  return (
    entry.type === "assistant" &&
    Boolean(entry.isReasoning || isLegacyReasoningHeading(entry.content))
  );
}

/**
 * Lay out the thinking rows of one turn's work rail.
 *
 * A thought belongs where it happened: above the steps it led to. It is never
 * moved, so nothing the reader has already passed is rewritten under them.
 * While the turn is live the newest thought doubles as the status of what the
 * model is doing; once the turn settles, thinking is the trace of why each
 * step happened.
 *
 * - none: no thinking rows.
 * - latest: every thought of a live turn stays in place (the rail folds all
 *   but the newest to one dim line, see quietEarlierThoughts); a settled turn
 *   shows none.
 * - all: the trace. Every thought stays in transcript order, in full.
 */
export function arrangeThinkingMessages(
  work: TranscriptEntry[],
  mode: ThinkingMessagesPref,
  live: boolean,
): TranscriptEntry[] {
  if (mode === "all" || (mode === "latest" && live)) return work;
  return work.filter((entry) => !isThinkingEntry(entry));
}

/** Whether a rail laid out by arrangeThinkingMessages folds its earlier
 * thoughts, keeping only the newest one open. */
export function quietsEarlierThoughts(
  mode: ThinkingMessagesPref,
  live: boolean,
): boolean {
  return mode === "latest" && live;
}
