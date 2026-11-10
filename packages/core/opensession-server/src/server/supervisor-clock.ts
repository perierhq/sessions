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
 * The owner's last message time is kept on the session file like the Blob
 * surface (blob-surface.ts). Each owner turn reads it, then writes its own
 * time (`recordOwnerSpoke`), so the turn sees the message before it.
 */
import { isTimeZone, localClock } from "./supervisor-quiet-hours";
import { touchNativeSession } from "./session-cache";
import type { SupervisorOwnerSpoke, UnifiedSession } from "./types";

const MINUTE_MS = 60_000;

/**
 * Record that the owner is speaking now and return when they spoke before.
 * Called once per owner-driven supervisor turn (run-session.ts), after the
 * turn is known to be the owner's, so retries, slash commands and every
 * entry point (HTTP, WebSocket, ask and voice replies) count the same way.
 * The write is awaited so the next turn reads it.
 */
export async function recordOwnerSpoke(
  session: UnifiedSession,
  now: Date = new Date(),
  write: (
    id: string,
    patch: { supervisorOwnerSpoke: SupervisorOwnerSpoke },
  ) => Promise<void> = touchNativeSession,
): Promise<string | undefined> {
  const previousAt = session.supervisorOwnerSpoke?.at;
  const next: SupervisorOwnerSpoke = { at: now.toISOString() };
  await write(session.id, { supervisorOwnerSpoke: next });
  session.supervisorOwnerSpoke = next;
  return previousAt;
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
