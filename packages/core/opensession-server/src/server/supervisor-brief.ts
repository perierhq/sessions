/**
 * The morning brief: once a day the owner's supervisor goes through their
 * inbox and writes what Blob says when they open it, in place of a queue of
 * cards (adrs/supervisor-and-leads.md, "The morning brief").
 *
 * The brief turn runs in the owner's supervisor session as a server notice
 * with no owner message, through the same path a merge card's outcome uses
 * (supervisor-merge-queue.ts): `deliverToSession` with the session-notice
 * sentinel and the server-only `conversationNotice`, so the conversation
 * keeps it instead of handing it to the watch. The charter's "The morning
 * brief" section (supervisor.ts) says what to do; the notice only names
 * the day. The turn checks each open item with its tools, closes stale and
 * duplicate ones (close_items), acts where the rules allow, and ends with
 * write_brief (supervisor-mcp.ts), which lands here.
 *
 * A turn starts:
 * - at the owner's digest time, from the inbox sweep (`scheduled`), once
 *   per local day; it replaces the old counts-only digest push;
 * - when the owner opens Blob (GET /api/supervisor/brief) with no brief for
 *   today and quiet hours over (`open`), which counts as the day's turn;
 * - on the owner's request (`refresh`), at most every 30 minutes.
 * One turn at a time; one that writes nothing within 20 minutes is over.
 *
 * The record lives in the owner's inbox document (`brief`, cleaned here),
 * so a brief's decisions are checked against the very items it is written
 * with, in one compare-and-set. A decision names one real open needs-you
 * item and is answered through the item API with that item's revision, so
 * a lead's approval keeps binding to what the owner saw. Duplicates are
 * closed, never merged into a new item.
 *
 * Pushes: a scheduled brief pushes "Your morning brief is ready" once,
 * outside quiet hours, unless the owner has already seen it. When the
 * scheduled turn could not run or wrote nothing and decisions wait, one
 * fallback push says so instead. Nothing runs at import.
 */
import { randomUUID } from "node:crypto";
import { pushSafeText } from "./notification-threads";
import {
  pushSupervisorBrief,
  readSupervisorBriefView,
  updateSupervisorBrief,
  type SupervisorBriefView,
  type SupervisorItem,
} from "./supervisor-inbox";
import type { ShownSupervisorItem } from "./leads/item-acts";
import { inQuietHours, localClock } from "./supervisor-quiet-hours";

export const BRIEF_MAX_DECISIONS = 3;
export const BRIEF_SAY_LEN = 600;
export const BRIEF_LINE_LEN = 160;
export const BRIEF_MAX_HANDLED = 10;
export const BRIEF_MAX_LATER = 50;
const OPTION_LEN = 120;
/** A brief turn that wrote nothing in this long is over. */
export const BRIEF_RUN_TIMEOUT_MS = 20 * 60_000;
/** A turn the owner asks for starts at most this often. */
export const BRIEF_REFRESH_MS = 30 * 60_000;
/** Delivery ids of brief notices, for the receipts. */
export const BRIEF_DELIVERY_PREFIX = "supervisor-brief:";
/** Kept in sync with SESSION_NOTICE_SENTINEL_RE in protocol notices.ts. */
const SESSION_NOTICE = "<!--os:session-notice-->";

export type BriefTrigger = "scheduled" | "open" | "refresh";
const TRIGGERS: readonly BriefTrigger[] = ["scheduled", "open", "refresh"];

export interface BriefHandled {
  /** One line: what Blob closed or did. */
  line: string;
  itemId?: string;
}

export interface BriefDecision {
  itemId: string;
  /** The option Blob recommends: one of the item's options. */
  recommended?: string;
}

export interface SupervisorBrief {
  /** The owner's local day (`YYYY-MM-DD`) it was written for. */
  day: string;
  /** When it was written, ms. */
  asOf: number;
  /** What Blob says, written for the ear. */
  say: string;
  handled: BriefHandled[];
  /** At most three, most important first. */
  decisions: BriefDecision[];
  /** The other open needs-you items when it was written. */
  later: { count: number; itemIds: string[] };
  seenAt?: number;
  /** The server-started turn that wrote it; absent when written in a
   *  conversation turn. */
  trigger?: BriefTrigger;
  pushedAt?: number;
}

export interface BriefRun {
  id: string;
  day: string;
  trigger: BriefTrigger;
  startedAt: number;
  /** It could not start (no supervisor session, the delivery failed). */
  failedAt?: number;
}

export interface BriefRecord {
  brief?: SupervisorBrief;
  /** The latest server-started turn; cleared when it writes its brief. */
  run?: BriefRun;
  /** The day a fallback push went out. */
  fallbackDay?: string;
  /** When the latest server-started turn started, kept after it writes
   *  its brief: a refresh waits 30 minutes from it. */
  lastStartAt?: number;
}

// ── Dependencies ────────────────────────────────────────────────────────────

export interface BriefDeps {
  now(): number;
  /** The owner's current supervisor session, without creating one. */
  currentSessionId(user: string): Promise<string | null>;
  /** The owner's supervisor session, created on first use. */
  ensureSessionId(user: string): Promise<string>;
  /** Deliver the brief notice into the supervisor conversation. */
  deliver(sessionId: string, text: string, deliveryId: string): Promise<void>;
  push(
    user: string,
    day: string,
    decisions: number,
    ready: boolean,
  ): Promise<void>;
  /** Items with their revision and a lead's steps (leads/item-acts.ts). */
  expand(items: SupervisorItem[]): Promise<ShownSupervisorItem[]>;
  /** Tell the owner's open clients a brief was written. */
  announce(user: string, day: string): Promise<void>;
}

const liveDeps: BriefDeps = {
  now: Date.now,
  currentSessionId: async (user) =>
    (await import("./supervisor")).currentSupervisorSessionId(user),
  ensureSessionId: async (user) =>
    (await (await import("./supervisor")).ensureSupervisorSession(user))
      .sessionId,
  deliver: async (sessionId, text, deliveryId) => {
    const { tryGetSessionControl } = await import("./session-control");
    const control = tryGetSessionControl();
    if (!control) throw new Error("sessions are not running");
    const result = await control.deliverToSession(sessionId, text, undefined, {
      deliveryId,
      conversationNotice: true,
    });
    // Only a turn that will run counts; "handled" ran nothing.
    if (result.status === "error" || result.status === "handled")
      throw new Error(result.message);
  },
  push: (user, day, decisions, ready) =>
    pushSupervisorBrief(user, day, decisions, ready),
  expand: async (items) =>
    (await import("./leads/item-acts")).withItemActs(items),
  announce: async (user, day) => {
    const { broadcastToUser } = await import("./ws-hub");
    broadcastToUser(user, { type: BRIEF_READY_EVENT, user, day });
  },
};

/** The socket frame a written brief sends: { type, user, day }. Blob
 *  reads GET /api/supervisor/brief again on it. */
export const BRIEF_READY_EVENT = "supervisor_brief_ready";

let deps: BriefDeps = liveDeps;

/** Swap dependencies in tests. Returns a restore function. */
export function __setBriefDepsForTest(
  overrides: Partial<BriefDeps>,
): () => void {
  const previous = deps;
  deps = { ...liveDeps, ...overrides };
  return () => {
    deps = previous;
  };
}

// ── Cleaning ────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function id(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 80) : "";
}

/** One line of agent-written text: no newlines, control or bidi
 *  characters, bounded. */
function oneLine(value: unknown, max: number): string {
  return typeof value === "string" ? pushSafeText(value).slice(0, max) : "";
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function cleanBrief(value: unknown): SupervisorBrief | undefined {
  if (!isRecord(value)) return undefined;
  const day = typeof value.day === "string" ? value.day : "";
  const asOf = num(value.asOf);
  const say = typeof value.say === "string" ? value.say.trim() : "";
  if (!DAY.test(day) || asOf === undefined || !say) return undefined;
  const handled = (Array.isArray(value.handled) ? value.handled : [])
    .flatMap((entry): BriefHandled[] => {
      if (!isRecord(entry)) return [];
      const line = oneLine(entry.line, BRIEF_LINE_LEN);
      if (!line) return [];
      const itemId = id(entry.itemId);
      return [itemId ? { line, itemId } : { line }];
    })
    .slice(0, BRIEF_MAX_HANDLED);
  const decisions = (Array.isArray(value.decisions) ? value.decisions : [])
    .flatMap((entry): BriefDecision[] => {
      if (!isRecord(entry)) return [];
      const itemId = id(entry.itemId);
      if (!itemId) return [];
      const recommended = oneLine(entry.recommended, OPTION_LEN);
      return [recommended ? { itemId, recommended } : { itemId }];
    })
    .slice(0, BRIEF_MAX_DECISIONS);
  const laterRaw = isRecord(value.later) ? value.later : {};
  const itemIds = (Array.isArray(laterRaw.itemIds) ? laterRaw.itemIds : [])
    .map(id)
    .filter(Boolean)
    .slice(0, BRIEF_MAX_LATER);
  const brief: SupervisorBrief = {
    day,
    asOf,
    say: say.slice(0, BRIEF_SAY_LEN),
    handled,
    decisions,
    later: {
      count: Math.max(itemIds.length, Math.floor(num(laterRaw.count) ?? 0)),
      itemIds,
    },
  };
  const seenAt = num(value.seenAt);
  if (seenAt !== undefined) brief.seenAt = seenAt;
  const pushedAt = num(value.pushedAt);
  if (pushedAt !== undefined) brief.pushedAt = pushedAt;
  const trigger = TRIGGERS.find((t) => t === value.trigger);
  if (trigger) brief.trigger = trigger;
  return brief;
}

function cleanRun(value: unknown): BriefRun | undefined {
  if (!isRecord(value)) return undefined;
  const runId = id(value.id);
  const day = typeof value.day === "string" ? value.day : "";
  const trigger = TRIGGERS.find((t) => t === value.trigger);
  const startedAt = num(value.startedAt);
  if (!runId || !DAY.test(day) || !trigger || startedAt === undefined)
    return undefined;
  const run: BriefRun = { id: runId, day, trigger, startedAt };
  const failedAt = num(value.failedAt);
  if (failedAt !== undefined) run.failedAt = failedAt;
  return run;
}

export function cleanBriefRecord(value: unknown): BriefRecord {
  if (!isRecord(value)) return {};
  const record: BriefRecord = {};
  const brief = cleanBrief(value.brief);
  if (brief) record.brief = brief;
  const run = cleanRun(value.run);
  if (run) record.run = run;
  if (typeof value.fallbackDay === "string" && DAY.test(value.fallbackDay))
    record.fallbackDay = value.fallbackDay;
  const lastStartAt = num(value.lastStartAt);
  if (lastStartAt !== undefined) record.lastStartAt = lastStartAt;
  return record;
}

function stored(record: BriefRecord): Record<string, unknown> | undefined {
  return record.brief ||
    record.run ||
    record.fallbackDay ||
    record.lastStartAt !== undefined
    ? (JSON.parse(JSON.stringify(record)) as Record<string, unknown>)
    : undefined;
}

// ── Runs ────────────────────────────────────────────────────────────────────

/** A turn started and still within its time, with no brief since. */
export function runInFlight(record: BriefRecord, now: number): boolean {
  const run = record.run;
  return (
    !!run &&
    run.failedAt === undefined &&
    now - run.startedAt < BRIEF_RUN_TIMEOUT_MS
  );
}

/** A server-started turn that is over without writing a brief. */
function runEndedEmpty(run: BriefRun | undefined, now: number): boolean {
  return (
    !!run &&
    (run.failedAt !== undefined || now - run.startedAt >= BRIEF_RUN_TIMEOUT_MS)
  );
}

function today(view: SupervisorBriefView, now: number): string {
  return localClock(now, view.timeZone).day;
}

/** The notice that starts a brief turn: fixed words and the day; what to
 *  do is in the charter. */
export function briefNotice(day: string): string {
  return `${SESSION_NOTICE}\nMorning brief for ${day}. Prepare it as "The morning brief" in your charter says, and finish with write_brief.`;
}

export type StartBriefResult =
  | { started: true; run: BriefRun; delivered: Promise<boolean> }
  | {
      started: false;
      reason: "running" | "ready" | "quiet" | "used" | "too-soon";
      /** For too-soon: when a turn may start. */
      retryAt?: number;
    };

/**
 * Start a brief turn for the owner, when its trigger's rules allow it:
 * - scheduled (the sweep, at the digest time): for `dueDay`, once;
 * - open (Blob opened): no brief for today yet, quiet hours over, and the
 *   day's turn not used, or the last one ended empty 30 minutes ago;
 * - refresh (the owner asks): 30 minutes after the last turn started.
 * Never while one is in flight. The claim is one compare-and-set; the
 * delivery runs after it (`delivered`), and one that fails marks the turn
 * failed.
 */
export async function startBriefTurn(
  user: string,
  trigger: BriefTrigger,
  dueDay?: string,
): Promise<StartBriefResult> {
  const now = deps.now();
  let result: StartBriefResult = { started: false, reason: "running" };
  await updateSupervisorBrief(user, (view) => {
    const record = cleanBriefRecord(view.brief);
    const day = trigger === "scheduled" && dueDay ? dueDay : today(view, now);
    if (runInFlight(record, now)) {
      result = { started: false, reason: "running" };
      return null;
    }
    const lastStart = record.lastStartAt ?? record.run?.startedAt;
    // Another gateway's sweep already took the day.
    if (
      trigger === "scheduled" &&
      view.lastDigestDay !== undefined &&
      view.lastDigestDay >= day
    ) {
      result = { started: false, reason: "used" };
      return null;
    }
    if (trigger === "open") {
      if (record.brief?.day === day) {
        result = { started: false, reason: "ready" };
        return null;
      }
      if (inQuietHours(view.prefs, view.timeZone, now)) {
        result = { started: false, reason: "quiet" };
        return null;
      }
      const used =
        view.lastDigestDay !== undefined && view.lastDigestDay >= day;
      if (
        used &&
        !(
          runEndedEmpty(record.run, now) &&
          lastStart !== undefined &&
          now - lastStart >= BRIEF_REFRESH_MS
        )
      ) {
        result = { started: false, reason: "used" };
        return null;
      }
    }
    if (
      trigger === "refresh" &&
      lastStart !== undefined &&
      now - lastStart < BRIEF_REFRESH_MS
    ) {
      result = {
        started: false,
        reason: "too-soon",
        retryAt: lastStart + BRIEF_REFRESH_MS,
      };
      return null;
    }
    const run: BriefRun = {
      id: randomUUID(),
      day,
      trigger,
      startedAt: now,
    };
    result = { started: true, run, delivered: Promise.resolve(false) };
    return {
      brief: stored({ ...record, run, lastStartAt: now }),
      // A scheduled or opened turn is the day's; a refresh is extra.
      ...(trigger === "refresh" ? {} : { lastDigestDay: day }),
    };
  });
  // Assigned in the callback, which TypeScript doesn't follow.
  const outcome = result as StartBriefResult;
  if (!outcome.started) return outcome;
  const run = outcome.run;
  return {
    started: true,
    run,
    delivered: deliverRun(user, run).catch(() => false),
  };
}

async function deliverRun(user: string, run: BriefRun): Promise<boolean> {
  try {
    // A scheduled brief never creates a supervisor for someone who has
    // none; Blob opening does, as it would anyway.
    const sessionId =
      run.trigger === "scheduled"
        ? await deps.currentSessionId(user)
        : await deps.ensureSessionId(user);
    if (!sessionId) throw new Error("no supervisor session");
    await deps.deliver(
      sessionId,
      briefNotice(run.day),
      `${BRIEF_DELIVERY_PREFIX}${run.id}`,
    );
    return true;
  } catch (error) {
    console.warn(
      `[supervisor-brief] ${user}: the brief turn did not start:`,
      error instanceof Error ? error.message : error,
    );
    await updateSupervisorBrief(user, (view) => {
      const record = cleanBriefRecord(view.brief);
      if (record.run?.id !== run.id) return null;
      return {
        brief: stored({
          ...record,
          run: { ...record.run, failedAt: deps.now() },
        }),
      };
    }).catch(() => {});
    return false;
  }
}

// ── Writing ─────────────────────────────────────────────────────────────────

export interface WriteBriefInput {
  say: string;
  handled?: Array<{ line: string; itemId?: string }>;
  decisions?: Array<{ itemId: string; recommended?: string }>;
}

export type WriteBriefResult =
  | { ok: true; brief: SupervisorBrief }
  | { ok: false; error: string };

/** A recommendation as one of the item's options: its text (any case) or
 *  its number. Without options, one line of its own. */
function recommendedOption(
  item: SupervisorItem,
  raw: string | undefined,
): { ok: true; value?: string } | { ok: false; error: string } {
  const wanted = (raw ?? "").trim();
  if (!wanted) return { ok: true };
  const options = item.options ?? [];
  if (!options.length) return { ok: true, value: oneLine(wanted, OPTION_LEN) };
  const index = /^\d+$/.test(wanted) ? Number(wanted) - 1 : -1;
  const match =
    options[index] ??
    options.find((option) => option.toLowerCase() === wanted.toLowerCase());
  if (!match)
    return {
      ok: false,
      error: `The recommendation for ${item.id} must be one of its options: ${options.map((o, i) => `${i + 1}. ${o}`).join("  ")}`,
    };
  return { ok: true, value: match };
}

/** The brief as the server checks it against the owner's items; an error
 *  names what to fix. */
export function validateBrief(
  input: WriteBriefInput,
  items: readonly SupervisorItem[],
):
  | { ok: true; value: Omit<SupervisorBrief, "day" | "asOf"> }
  | {
      ok: false;
      error: string;
    } {
  const say = typeof input.say === "string" ? input.say.trim() : "";
  if (!say) return { ok: false, error: "say is empty." };
  if (say.length > BRIEF_SAY_LEN)
    return {
      ok: false,
      error: `say is ${say.length} characters; keep it under ${BRIEF_SAY_LEN}.`,
    };
  const byId = new Map(items.map((item) => [item.id, item]));
  const handledIn = input.handled ?? [];
  if (handledIn.length > BRIEF_MAX_HANDLED)
    return {
      ok: false,
      error: `At most ${BRIEF_MAX_HANDLED} handled lines: fold the rest into one.`,
    };
  const handled: BriefHandled[] = [];
  for (const entry of handledIn) {
    const line = oneLine(entry.line, BRIEF_LINE_LEN);
    if (!line) return { ok: false, error: "A handled line is empty." };
    const itemId = id(entry.itemId);
    if (itemId && !byId.has(itemId))
      return { ok: false, error: `No item ${itemId} in the owner's inbox.` };
    handled.push(itemId ? { line, itemId } : { line });
  }
  const decisionsIn = input.decisions ?? [];
  if (decisionsIn.length > BRIEF_MAX_DECISIONS)
    return {
      ok: false,
      error: `At most ${BRIEF_MAX_DECISIONS} decisions: the rest wait as later.`,
    };
  const decisions: BriefDecision[] = [];
  for (const entry of decisionsIn) {
    const itemId = id(entry.itemId);
    const item = byId.get(itemId);
    if (!item || item.kind !== "needs-you" || item.state !== "open")
      return {
        ok: false,
        error: `${itemId || "A decision"} is not an open needs-you item of the owner's: a decision names one of them.`,
      };
    if (decisions.some((d) => d.itemId === itemId))
      return { ok: false, error: `${itemId} is listed twice.` };
    const recommended = recommendedOption(item, entry.recommended);
    if (!recommended.ok) return recommended;
    decisions.push(
      recommended.value
        ? { itemId, recommended: recommended.value }
        : { itemId },
    );
  }
  const chosen = new Set(decisions.map((d) => d.itemId));
  const later = items
    .filter(
      (item) =>
        item.kind === "needs-you" &&
        item.state === "open" &&
        !chosen.has(item.id),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return {
    ok: true,
    value: {
      say,
      handled,
      decisions,
      later: {
        count: later.length,
        itemIds: later.slice(0, BRIEF_MAX_LATER).map((item) => item.id),
      },
    },
  };
}

/**
 * write_brief: the owner's brief for today, checked against their inbox in
 * the same compare-and-set it is stored with. A server-started turn in
 * flight is done with it; the fyi items up to now count as told (they were
 * what the old digest carried). A scheduled brief is pushed once quiet
 * hours allow (`pushBriefIfDue`).
 */
export async function writeSupervisorBrief(
  user: string,
  input: WriteBriefInput,
): Promise<WriteBriefResult> {
  const now = deps.now();
  let result: WriteBriefResult = { ok: false, error: "not written" };
  await updateSupervisorBrief(user, (view) => {
    const valid = validateBrief(input, view.items);
    if (!valid.ok) {
      result = valid;
      return null;
    }
    const record = cleanBriefRecord(view.brief);
    const run = runInFlight(record, now) ? record.run : undefined;
    const brief: SupervisorBrief = {
      day: run?.day ?? today(view, now),
      asOf: now,
      ...valid.value,
      ...(run ? { trigger: run.trigger } : {}),
    };
    result = { ok: true, brief };
    const next: BriefRecord = { ...record, brief };
    if (run) delete next.run;
    return {
      brief: stored(next),
      digestFyi: view.items
        .filter(
          (item) =>
            item.kind === "fyi" &&
            item.state === "open" &&
            item.digestedAt === undefined,
        )
        .map((item) => item.id),
    };
  });
  const written = result as WriteBriefResult;
  if (written.ok) {
    await deps.announce(user, written.brief.day).catch(() => {});
    await pushBriefIfDue(user).catch(() => 0);
  }
  return written;
}

/** The owner saw the brief: no push for it after this. */
export async function markBriefSeen(
  user: string,
  day?: string,
): Promise<SupervisorBrief | null> {
  const now = deps.now();
  let seen: SupervisorBrief | null = null;
  await updateSupervisorBrief(user, (view) => {
    const record = cleanBriefRecord(view.brief);
    seen = null;
    if (!record.brief || (day && record.brief.day !== day)) return null;
    seen = { ...record.brief, seenAt: record.brief.seenAt ?? now };
    return { brief: stored({ ...record, brief: seen }) };
  });
  return seen;
}

// ── Pushes ──────────────────────────────────────────────────────────────────

/** Whether the scheduled brief for today should be pushed now. */
function briefPushDue(
  record: BriefRecord,
  view: SupervisorBriefView,
  now: number,
): boolean {
  const brief = record.brief;
  return (
    !!brief &&
    brief.trigger === "scheduled" &&
    brief.pushedAt === undefined &&
    brief.seenAt === undefined &&
    brief.day === today(view, now) &&
    !inQuietHours(view.prefs, view.timeZone, now)
  );
}

/** Push the scheduled brief once; a failed push is tried again by the
 *  next sweep (the event key keeps a replay from bannering twice). */
export async function pushBriefIfDue(user: string): Promise<number> {
  const now = deps.now();
  let claimed: SupervisorBrief | undefined;
  await updateSupervisorBrief(user, (view) => {
    claimed = undefined;
    const record = cleanBriefRecord(view.brief);
    if (!briefPushDue(record, view, now)) return null;
    claimed = { ...record.brief!, pushedAt: now };
    return { brief: stored({ ...record, brief: claimed }) };
  });
  const brief = claimed as SupervisorBrief | undefined;
  if (!brief) return 0;
  try {
    await deps.push(user, brief.day, brief.decisions.length, true);
    return 1;
  } catch (error) {
    console.warn(
      "[supervisor-brief] push failed:",
      error instanceof Error ? error.message : error,
    );
    await updateSupervisorBrief(user, (view) => {
      const record = cleanBriefRecord(view.brief);
      if (record.brief?.pushedAt !== now) return null;
      const next = { ...record.brief };
      delete next.pushedAt;
      return { brief: stored({ ...record, brief: next }) };
    }).catch(() => {});
    return 0;
  }
}

/** Open needs-you items that never pushed on their own. */
function waitingDecisions(items: readonly SupervisorItem[]): number {
  return items.filter(
    (item) => item.kind === "needs-you" && item.state === "open",
  ).length;
}

/** The scheduled turn could not run or wrote nothing: when decisions
 *  wait, one push for the day says so, so nothing waits unseen. */
async function pushFallbackIfDue(user: string): Promise<number> {
  const now = deps.now();
  let count = 0;
  let day = "";
  await updateSupervisorBrief(user, (view) => {
    count = 0;
    const record = cleanBriefRecord(view.brief);
    const run = record.run;
    if (
      !run ||
      run.trigger !== "scheduled" ||
      !runEndedEmpty(run, now) ||
      run.day !== today(view, now) ||
      record.fallbackDay === run.day ||
      record.brief?.day === run.day ||
      inQuietHours(view.prefs, view.timeZone, now)
    )
      return null;
    const waiting = waitingDecisions(view.items);
    // Marked either way: nothing waiting needs no push later today.
    count = waiting;
    day = run.day;
    return { brief: stored({ ...record, fallbackDay: run.day }) };
  });
  if (!count) return 0;
  try {
    await deps.push(user, day, count, false);
    return 1;
  } catch (error) {
    console.warn(
      "[supervisor-brief] fallback push failed:",
      error instanceof Error ? error.message : error,
    );
    return 0;
  }
}

/**
 * The brief's part of the inbox sweep, from the document the sweep read:
 * start the scheduled turn for `dueDay`, push a scheduled brief that is
 * ready, or the fallback when its turn ended empty. Reads nothing more
 * unless there is something to do.
 */
export async function sweepSupervisorBrief(
  user: string,
  view: SupervisorBriefView,
  dueDay: string | null,
): Promise<{ started: number; pushed: number }> {
  const now = deps.now();
  let started = 0;
  if (dueDay) {
    const result = await startBriefTurn(user, "scheduled", dueDay);
    if (result.started) {
      started = 1;
      await result.delivered;
    }
  }
  const record = cleanBriefRecord(view.brief);
  let pushed = 0;
  if (briefPushDue(record, view, now)) pushed += await pushBriefIfDue(user);
  if (
    record.run?.trigger === "scheduled" &&
    runEndedEmpty(record.run, now) &&
    record.fallbackDay !== record.run.day
  )
    pushed += await pushFallbackIfDue(user);
  return { started, pushed };
}

// ── Reading ─────────────────────────────────────────────────────────────────

export type BriefState = "ready" | "preparing" | "none";

export interface BriefResponse {
  /** ready: a brief is there (today's, or the latest: see brief.day);
   *  preparing: a turn is writing one (the socket says when it is ready,
   *  brief holds the previous one meanwhile); none: no brief yet. */
  state: BriefState;
  brief: null | {
    day: string;
    asOf: number;
    say: string;
    seenAt: number | null;
    handled: BriefHandled[];
    /** Still open ones only, each with the item as the items route
     *  returns it (revision, act). */
    decisions: Array<{
      itemId: string;
      recommended: string | null;
      item: ShownSupervisorItem;
    }>;
    later: { count: number; itemIds: string[] };
  };
  /** Open needs-you items raised after the brief, newest first. */
  newSince: { count: number; itemIds: string[] };
  /** When the running turn started. */
  preparingSince: number | null;
  /** When the owner may ask for a fresh brief. */
  refreshAt: number;
}

/**
 * GET /api/supervisor/brief: today's brief, or the latest. With `start`
 * (Blob opening) and no brief for today, outside quiet hours, the day's
 * turn starts and the answer is `preparing`; it finishes on its own.
 */
export async function getSupervisorBrief(
  user: string,
  options: { start?: boolean } = {},
): Promise<BriefResponse> {
  if (options.start) {
    const result = await startBriefTurn(user, "open");
    // Not awaited: the turn finishes while Blob polls.
    if (result.started) void result.delivered;
  }
  const now = deps.now();
  const view = await readSupervisorBriefView(user);
  const record = cleanBriefRecord(view.brief);
  const preparing = runInFlight(record, now);
  const brief = record.brief;
  const state: BriefState = preparing ? "preparing" : brief ? "ready" : "none";
  const open = view.items.filter(
    (item) => item.kind === "needs-you" && item.state === "open",
  );
  const openById = new Map(open.map((item) => [item.id, item]));
  const inBrief = new Set([
    ...(brief?.decisions.map((d) => d.itemId) ?? []),
    ...(brief?.later.itemIds ?? []),
  ]);
  const fresh = brief
    ? open
        .filter((item) => item.createdAt > brief.asOf && !inBrief.has(item.id))
        .sort((a, b) => b.createdAt - a.createdAt)
    : [];
  let payload: BriefResponse["brief"] = null;
  if (brief) {
    const decided = brief.decisions.filter((d) => openById.has(d.itemId));
    const shown = await deps.expand(
      decided.map((d) => openById.get(d.itemId)!),
    );
    const later = brief.later.itemIds.filter((itemId) => openById.has(itemId));
    payload = {
      day: brief.day,
      asOf: brief.asOf,
      say: brief.say,
      seenAt: brief.seenAt ?? null,
      handled: brief.handled,
      decisions: decided.map((d, i) => ({
        itemId: d.itemId,
        recommended: d.recommended ?? null,
        item: shown[i]!,
      })),
      later: {
        // Ids past the stored ones aren't known; the count can only drop
        // as they close.
        count:
          later.length +
          Math.max(0, brief.later.count - brief.later.itemIds.length),
        itemIds: later,
      },
    };
  }
  return {
    state,
    brief: payload,
    newSince: { count: fresh.length, itemIds: fresh.map((item) => item.id) },
    preparingSince: preparing ? (record.run?.startedAt ?? null) : null,
    refreshAt: Math.max(
      now,
      (record.lastStartAt ?? record.run?.startedAt ?? 0) + BRIEF_REFRESH_MS,
    ),
  };
}
