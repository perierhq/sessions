/**
 * What time it is for the owner, so Blob greets once a day instead of on
 * every turn. Each owner-driven supervisor turn gets one line of context next
 * to the report style (supervisor-inbox.ts `supervisorClockContext`), never
 * in the system prompt, so the clock moving keeps the prompt cache.
 *
 * The line names the owner's local weekday, date and time (their supervisor
 * prefs' time zone, the same one quiet hours use), how long ago their
 * previous message in this supervisor session was, and whether this is their
 * first conversation of their local day. The charter (supervisor.ts, "How
 * Blob speaks") says what to do with it.
 *
 * The previous message's time is kept on the session file like the Blob
 * surface (blob-surface.ts): each prompt the owner sends shifts `at` into
 * `previousAt`, so the turn that answers it still sees the one before.
 */
import { isTimeZone, localClock } from "./supervisor-quiet-hours";
import { supervisorInboxOwner } from "./supervisor-mcp";
import { touchNativeSession } from "./session-cache";
import type { SupervisorOwnerSpoke, UnifiedSession } from "./types";

const MINUTE_MS = 60_000;

/** The record after the owner sends a message at `now`. */
export function nextOwnerSpoke(
  previous: SupervisorOwnerSpoke | undefined,
  now: Date = new Date(),
): SupervisorOwnerSpoke {
  const at = now.toISOString();
  return previous?.at ? { at, previousAt: previous.at } : { at };
}

/**
 * Record that the owner sent a prompt to their supervisor session. Anyone
 * else's prompt, and every other session, is left alone.
 */
export function maybeRecordOwnerMessage(
  session: UnifiedSession | undefined,
  user: string | null | undefined,
  now: Date = new Date(),
): void {
  if (!session?.supervisor || session.source !== "opensession") return;
  if (!supervisorInboxOwner(session, user)) return;
  const next = nextOwnerSpoke(session.supervisorOwnerSpoke, now);
  touchNativeSession(session.id, { supervisorOwnerSpoke: next });
  session.supervisorOwnerSpoke = next;
}

const weekdays = new Map<string, Intl.DateTimeFormat>();

function weekday(at: number, timeZone: string): string {
  let format = weekdays.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" });
    if (weekdays.size >= 100) weekdays.clear();
    weekdays.set(timeZone, format);
  }
  return format.format(at);
}

function clockText(minutes: number): string {
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * The clock line for a turn at `now`. `previousAt` is the owner's message
 * before the one this turn answers; without one this is the first message of
 * the conversation, and so the first today.
 */
export function supervisorClockLine(input: {
  now: Date;
  timeZone: string;
  previousAt?: string;
}): string {
  const zone = isTimeZone(input.timeZone) ? input.timeZone : "UTC";
  const now = input.now.getTime();
  const { day, minutes } = localClock(now, zone);
  const parts = [
    `The owner's local time is ${weekday(now, zone)} ${day} ${clockText(minutes)} (${zone}).`,
  ];
  const previous = input.previousAt ? Date.parse(input.previousAt) : NaN;
  if (Number.isFinite(previous) && previous <= now) {
    const ago = Math.floor((now - previous) / MINUTE_MS);
    parts.push(
      `Their previous message in this conversation was ${ago} ${ago === 1 ? "minute" : "minutes"} ago.`,
    );
    const firstToday = localClock(previous, zone).day !== day;
    parts.push(`First conversation today: ${firstToday ? "yes" : "no"}.`);
  } else {
    parts.push("This is their first message in this conversation.");
    parts.push("First conversation today: yes.");
  }
  return parts.join(" ");
}
