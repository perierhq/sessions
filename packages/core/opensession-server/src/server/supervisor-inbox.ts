/**
 * The supervisor inbox (adrs/supervisor-and-leads.md, sections 1, 3 and 5):
 * the one place project leads, and later other loops, report to, and the
 * only path that pushes the owner on their behalf.
 *
 * An item is either `needs-you` (a decision only the owner can make, pushed
 * through `notifyUser`) or `fyi` (something that ran alone, collected into
 * one quiet daily digest). The owner answers or dismisses an item from Blob
 * or the web; the answer reaches the supervisor's next turn through its
 * briefing (`supervisorInboxContext`) and the lead that raised it through
 * `onSupervisorAnswer`.
 *
 * Storage follows the notification inbox (notifications.ts): one catalog
 * document per person in `supervisor-items`, keyed like the notification
 * inbox (canonicalName of the lowercased name),
 * holding a bounded list of items, the person's quiet hours and digest time,
 * and when the last digest ran. Listing one person's items is one read, and
 * every change is one compare-and-set on that document, so dedupe, answer
 * and digest marks never race each other.
 *
 * Quiet hours (supervisor-quiet-hours.ts) apply to every supervisor push: a
 * needs-you item raised in them is held until they end, unless its urgency
 * is `down` (something fully down), which always goes through. A sweep once a
 * minute flushes held items, retries failed pushes and sends due digests.
 * Nothing runs at import: `startSupervisorInbox` starts the sweep, once.
 */
import { randomUUID } from "node:crypto";
import { catalogDocuments } from "./catalog-documents";
import type { NotificationEvent } from "./notification-threads";
import { wrapContext } from "./prompt-context";
import { isShuttingDown } from "./shutdown-state";
import { timezoneForUser } from "./shared/user-mappings";
import { canonicalName } from "./shared/user-store-key";
import {
  cleanPrefs,
  digestDayDue,
  inQuietHours,
  quietHoursEnd,
  type SupervisorPrefs,
} from "./supervisor-quiet-hours";

export const SUPERVISOR_ITEMS_NAMESPACE = "supervisor-items";

export type SupervisorItemKind = "needs-you" | "fyi";
export type SupervisorItemState = "open" | "answered" | "dismissed" | "expired";
/** `down`: something is fully down; it is pushed even in quiet hours. */
export type SupervisorItemUrgency = "normal" | "down";

export interface SupervisorItem {
  id: string;
  user: string;
  project?: string;
  /** Who raised it, e.g. `lead:betterbahn` or `supervisor`. */
  source: string;
  kind: SupervisorItemKind;
  urgency?: SupervisorItemUrgency;
  title: string;
  /** Markdown; may hold the fenced blocks of docs/blocks.md. */
  body: string;
  /** Numbered choices; the first is the recommended one. */
  options?: string[];
  dedupeKey?: string;
  createdAt: number;
  updatedAt: number;
  state: SupervisorItemState;
  answer?: string;
  answeredAt?: number;
  /** When the owner's device was pushed (needs-you only). */
  notifiedAt?: number;
  /** Held for quiet hours until about this time (needs-you only). */
  heldUntil?: number;
  /** Included in the daily digest (fyi only). */
  digestedAt?: number;
  /** The answer was shown to the supervisor in a turn's briefing. */
  briefedAt?: number;
}

interface InboxDocument {
  user: string;
  items: SupervisorItem[];
  prefs?: Partial<SupervisorPrefs>;
  lastDigestAt?: number;
  /** The local day (`YYYY-MM-DD`) the last digest was for. */
  lastDigestDay?: string;
}

export interface PostSupervisorItemInput {
  user: string;
  source: string;
  kind: SupervisorItemKind;
  title: string;
  body?: string;
  project?: string;
  options?: string[];
  dedupeKey?: string;
  urgency?: SupervisorItemUrgency;
}

export const MAX_ITEMS = 200;
export const MAX_LIST = 100;
const DEFAULT_LIST = 50;
const TITLE_LEN = 120;
const BODY_LEN = 4000;
const SOURCE_LEN = 80;
const PROJECT_LEN = 80;
const DEDUPE_LEN = 200;
const OPTION_LEN = 120;
const MAX_OPTIONS = 6;
const ANSWER_LEN = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Closed items stay listable this long, then drop out. */
const CLOSED_RETENTION_MS = 30 * DAY_MS;
/** A digested fyi item expires after this. */
const FYI_TTL_MS = 7 * DAY_MS;
/** An unanswered needs-you item expires after this. */
const NEEDS_YOU_TTL_MS = 30 * DAY_MS;
export const SWEEP_MS = 60_000;

const KINDS: readonly SupervisorItemKind[] = ["needs-you", "fyi"];
const STATES: readonly SupervisorItemState[] = [
  "open",
  "answered",
  "dismissed",
  "expired",
];

// ── Dependencies ────────────────────────────────────────────────────────────

export interface SupervisorInboxDeps {
  now(): number;
  /** Record and deliver a notification; rejects when it was not recorded. */
  notify(user: string, event: NotificationEvent): Promise<unknown>;
  /** Mark the person's inbox rows done, so they leave the notification list. */
  markDone(user: string, threadIds: string[]): Promise<void>;
  /** The person's supervisor session id, created on first use. */
  supervisorSessionId(user: string): Promise<string>;
  /** The person's profile time zone (identity.team[].timezone, else the
   *  instance default, else UTC). */
  timeZone(user: string): string;
}

const defaultDeps: SupervisorInboxDeps = {
  now: Date.now,
  notify: async (user, event) =>
    (await import("./notifications")).deliverNotification(user, event),
  markDone: async (user, ids) => {
    await (
      await import("./notifications")
    ).markNotifications(user, {
      ids,
      done: true,
    });
  },
  supervisorSessionId: async (user) =>
    (await (await import("./supervisor")).ensureSupervisorSession(user))
      .sessionId,
  timeZone: (user) => timezoneForUser(user) || "UTC",
};

let deps: SupervisorInboxDeps = defaultDeps;

/** Swap dependencies in tests. Returns a restore function. */
export function __setSupervisorInboxDepsForTest(
  overrides: Partial<SupervisorInboxDeps>,
): () => void {
  const previous = deps;
  deps = { ...defaultDeps, ...overrides };
  return () => {
    deps = previous;
  };
}

// ── Cleaning ────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function cleanOptions(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const options = value
    .map((option) => text(option, OPTION_LEN))
    .filter(Boolean)
    .slice(0, MAX_OPTIONS);
  return options.length ? options : undefined;
}

function cleanItem(value: unknown): SupervisorItem | null {
  if (!isRecord(value)) return null;
  const id = text(value.id, 80);
  const kind = KINDS.find((k) => k === value.kind);
  const state = STATES.find((s) => s === value.state);
  const createdAt = num(value.createdAt);
  if (!id || !kind || !state || createdAt === undefined) return null;
  const item: SupervisorItem = {
    id,
    user: text(value.user, 120),
    source: text(value.source, SOURCE_LEN),
    kind,
    title: text(value.title, TITLE_LEN),
    body: typeof value.body === "string" ? value.body.slice(0, BODY_LEN) : "",
    createdAt,
    updatedAt: num(value.updatedAt) ?? createdAt,
    state,
  };
  const project = text(value.project, PROJECT_LEN);
  if (project) item.project = project;
  if (value.urgency === "down") item.urgency = "down";
  const options = cleanOptions(value.options);
  if (options) item.options = options;
  const dedupeKey = text(value.dedupeKey, DEDUPE_LEN);
  if (dedupeKey) item.dedupeKey = dedupeKey;
  if (typeof value.answer === "string")
    item.answer = value.answer.slice(0, ANSWER_LEN);
  for (const key of [
    "answeredAt",
    "notifiedAt",
    "heldUntil",
    "digestedAt",
    "briefedAt",
  ] as const) {
    const at = num(value[key]);
    if (at !== undefined) item[key] = at;
  }
  return item;
}

function cleanDocument(value: unknown, user: string): InboxDocument {
  if (!isRecord(value)) return { user, items: [] };
  const items = Array.isArray(value.items)
    ? value.items.flatMap((item) => cleanItem(item) ?? [])
    : [];
  const doc: InboxDocument = { user: text(value.user, 120) || user, items };
  if (isRecord(value.prefs)) doc.prefs = value.prefs as InboxDocument["prefs"];
  const lastDigestAt = num(value.lastDigestAt);
  if (lastDigestAt !== undefined) doc.lastDigestAt = lastDigestAt;
  if (typeof value.lastDigestDay === "string")
    doc.lastDigestDay = value.lastDigestDay;
  return doc;
}

/** Expire stale items, drop old closed ones, and bound the list: open items
 *  first, newest first. */
function prune(items: SupervisorItem[], now: number): SupervisorItem[] {
  return items
    .map((item) => {
      if (item.state !== "open") return item;
      const stale =
        item.kind === "fyi"
          ? item.digestedAt !== undefined && now - item.digestedAt >= FYI_TTL_MS
          : now - item.updatedAt >= NEEDS_YOU_TTL_MS;
      return stale
        ? { ...item, state: "expired" as const, updatedAt: now }
        : item;
    })
    .filter(
      (item) =>
        item.state === "open" || now - item.updatedAt < CLOSED_RETENTION_MS,
    )
    .sort(
      (a, b) =>
        Number(b.state === "open") - Number(a.state === "open") ||
        b.updatedAt - a.updatedAt,
    )
    .slice(0, MAX_ITEMS);
}

// ── Storage ─────────────────────────────────────────────────────────────────

let documentsCache: ReturnType<typeof catalogDocuments> | undefined;
function documents() {
  return (documentsCache ??= catalogDocuments(SUPERVISOR_ITEMS_NAMESPACE));
}

/** One inbox per person, whatever case their name arrives in: the key the
 *  notification inbox uses (notifications.ts). */
export function supervisorInboxKey(user: string): string {
  return canonicalName(user.trim().toLowerCase());
}

function validUser(user: string | null | undefined): user is string {
  return typeof user === "string" && user.trim().length > 0;
}

async function readDocument(user: string): Promise<InboxDocument> {
  return cleanDocument(
    await documents().get(supervisorInboxKey(user)),
    user.trim(),
  );
}

/** Compare-and-set one person's document. `mutate` may run more than once
 *  (a conflict reruns it on the committed truth); its last run committed. */
async function updateDocument(
  user: string,
  mutate: (doc: InboxDocument) => InboxDocument,
): Promise<InboxDocument> {
  let next: InboxDocument = { user, items: [] };
  await documents().update(supervisorInboxKey(user), (current) => {
    const doc = cleanDocument(current, user.trim());
    next = mutate(doc);
    return next;
  });
  return next;
}

function prefsAndZone(
  doc: InboxDocument,
  user: string,
): { prefs: SupervisorPrefs; timeZone: string } {
  const prefs = cleanPrefs(doc.prefs);
  return { prefs, timeZone: prefs.timezone || deps.timeZone(user) };
}

// ── Notifications ───────────────────────────────────────────────────────────

/** The notification row for an item: `supervisor:<item id>`. */
export function itemThreadId(id: string): string {
  return `supervisor:${id}`;
}

/** Where a push opens: the supervisor session, with the item for Blob. */
export function itemUrl(sessionId: string, itemId: string): string {
  return `/session/${encodeURIComponent(sessionId)}?item=${encodeURIComponent(itemId)}`;
}

function optionsLine(options: string[] | undefined): string {
  return (options ?? []).map((option, i) => `${i + 1}. ${option}`).join("  ");
}

function firstLine(body: string): string {
  return (
    body
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("```")) ?? ""
  );
}

function needsYouEvent(
  item: SupervisorItem,
  sessionId: string,
  delivery: "alert" | "quiet",
): NotificationEvent {
  return {
    kind: "supervisor_needs_you",
    subject: {
      type: "supervisor",
      id: item.id,
      title: item.title,
      ...(item.project ? { context: item.project } : {}),
    },
    reason: item.urgency === "down" ? "Down, needs you" : "Needs you",
    body: optionsLine(item.options) || firstLine(item.body),
    url: itemUrl(sessionId, item.id),
    // One push per version of the item: a retry after a crash between the
    // push and its mark is a replay, never a second banner.
    eventKey: `${item.id}:${item.updatedAt}`,
    at: deps.now(),
    delivery,
    ...(item.urgency === "down" ? { push: { urgency: "high" as const } } : {}),
  };
}

/** Push one needs-you item now and mark it notified. A failure leaves it
 *  unmarked for the sweep to retry. */
async function pushItem(user: string, item: SupervisorItem): Promise<boolean> {
  try {
    const sessionId = await deps.supervisorSessionId(user);
    await deps.notify(user, needsYouEvent(item, sessionId, "alert"));
  } catch (error) {
    console.warn(
      "[supervisor-inbox] push failed:",
      error instanceof Error ? error.message : error,
    );
    return false;
  }
  const at = deps.now();
  await updateDocument(user, (doc) => ({
    ...doc,
    items: doc.items.map((current) =>
      current.id === item.id && current.notifiedAt === undefined
        ? { ...current, notifiedAt: at, heldUntil: undefined }
        : current,
    ),
  }));
  return true;
}

// ── Posting ─────────────────────────────────────────────────────────────────

export type PostDelivery = "pushed" | "held" | "updated" | "none";

/** How an open needs-you item is delivered at `now`. */
function deliveryPlan(
  item: SupervisorItem,
  quiet: boolean,
): "push" | "hold" | "none" {
  if (item.kind !== "needs-you" || item.state !== "open") return "none";
  if (item.notifiedAt !== undefined) return "none";
  if (quiet && item.urgency !== "down") return "hold";
  return "push";
}

/**
 * Raise an item to `user`. An open item with the same `dedupeKey` is updated
 * in place instead of adding a second one; an update of an item already
 * pushed changes its notification row quietly, never a second banner.
 */
export async function postSupervisorItem(
  input: PostSupervisorItemInput,
): Promise<{
  item: SupervisorItem;
  created: boolean;
  delivery: PostDelivery;
}> {
  const user = input.user?.trim();
  if (!validUser(user)) throw new Error("missing user");
  const kind = KINDS.find((k) => k === input.kind);
  if (!kind) throw new Error("kind must be needs-you or fyi");
  const title = text(input.title, TITLE_LEN);
  if (!title) throw new Error("missing title");
  const source = text(input.source, SOURCE_LEN);
  if (!source) throw new Error("missing source");
  const now = deps.now();
  const fields = {
    kind,
    title,
    body: (input.body ?? "").slice(0, BODY_LEN),
    source,
    project: text(input.project, PROJECT_LEN) || undefined,
    options: cleanOptions(input.options),
    urgency: input.urgency === "down" ? ("down" as const) : undefined,
  };
  const dedupeKey = text(input.dedupeKey, DEDUPE_LEN) || undefined;

  const outcome: {
    item: SupervisorItem | null;
    created: boolean;
    plan: "push" | "hold" | "none";
    wasNotified: boolean;
  } = { item: null, created: false, plan: "none", wasNotified: false };
  await updateDocument(user, (doc) => {
    const { prefs, timeZone } = prefsAndZone(doc, user);
    const quiet = inQuietHours(prefs, timeZone, now);
    const existing = dedupeKey
      ? doc.items.find(
          (item) => item.state === "open" && item.dedupeKey === dedupeKey,
        )
      : undefined;
    let item: SupervisorItem;
    if (existing) {
      item = {
        ...existing,
        ...fields,
        // Escalating to down never loses the flag on a later plain update.
        urgency: fields.urgency ?? existing.urgency,
        updatedAt: now,
      };
      if (!item.project) delete item.project;
      if (!item.options) delete item.options;
      if (!item.urgency) delete item.urgency;
    } else {
      item = {
        id: `si-${randomUUID()}`,
        user,
        ...fields,
        ...(dedupeKey ? { dedupeKey } : {}),
        createdAt: now,
        updatedAt: now,
        state: "open",
      };
      if (!item.project) delete item.project;
      if (!item.options) delete item.options;
      if (!item.urgency) delete item.urgency;
    }
    const plan = deliveryPlan(item, quiet);
    if (plan === "hold" && item.heldUntil === undefined)
      item.heldUntil = quietHoursEnd(prefs, timeZone, now);
    if (plan === "push") delete item.heldUntil;
    outcome.item = item;
    outcome.created = !existing;
    outcome.plan = plan;
    outcome.wasNotified =
      item.kind === "needs-you" && item.notifiedAt !== undefined;
    return {
      ...doc,
      items: prune(
        [item, ...doc.items.filter((other) => other.id !== item.id)],
        now,
      ),
    };
  });
  const item = outcome.item as SupervisorItem | null;
  if (!item) throw new Error("supervisor item was not recorded");

  let delivery: PostDelivery = outcome.plan === "hold" ? "held" : "none";
  if (outcome.plan === "push")
    delivery = (await pushItem(user, item)) ? "pushed" : "none";
  else if (outcome.wasNotified && !outcome.created) {
    // Already on the owner's device: update the row, no new banner.
    try {
      const sessionId = await deps.supervisorSessionId(user);
      await deps.notify(user, needsYouEvent(item, sessionId, "quiet"));
      delivery = "updated";
    } catch {}
  }
  return {
    item: (await getItem(user, item.id)) ?? item,
    created: outcome.created,
    delivery,
  };
}

async function getItem(
  user: string,
  id: string,
): Promise<SupervisorItem | undefined> {
  return (await readDocument(user)).items.find((item) => item.id === id);
}

// ── Reading ─────────────────────────────────────────────────────────────────

/** One person's items, newest first; bounded by `limit` (at most 100). */
export async function listSupervisorItems(
  user: string,
  options: {
    state?: SupervisorItemState;
    kind?: SupervisorItemKind;
    /** Only items changed at or after this ms epoch. */
    since?: number;
    limit?: number;
  } = {},
): Promise<SupervisorItem[]> {
  if (!validUser(user)) return [];
  const limit = Math.max(
    1,
    Math.min(MAX_LIST, Math.floor(options.limit ?? DEFAULT_LIST)),
  );
  const now = deps.now();
  return prune((await readDocument(user)).items, now)
    .filter(
      (item) =>
        (!options.state || item.state === options.state) &&
        (!options.kind || item.kind === options.kind) &&
        (options.since === undefined || item.updatedAt >= options.since),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

// ── Answering ───────────────────────────────────────────────────────────────

export type AnswerHandler = (
  item: SupervisorItem,
  answer: string,
) => void | Promise<void>;

const answerHandlers: Array<{ prefix: string; handler: AnswerHandler }> = [];

/**
 * React to the owner's answers to items whose `source` starts with
 * `sourcePrefix` (a lead registers `lead:<project>`). Returns an unsubscribe.
 * A handler's failure is logged; it never fails the answer.
 */
export function onSupervisorAnswer(
  sourcePrefix: string,
  handler: AnswerHandler,
): () => void {
  const entry = { prefix: sourcePrefix, handler };
  answerHandlers.push(entry);
  return () => {
    const at = answerHandlers.indexOf(entry);
    if (at >= 0) answerHandlers.splice(at, 1);
  };
}

/** A numbered answer ("2") to an item with options is that option's text. */
function resolveAnswer(item: SupervisorItem, raw: string): string {
  const answer = raw.trim().slice(0, ANSWER_LEN);
  const index = /^\d+$/.test(answer) ? Number(answer) - 1 : -1;
  return item.options && index >= 0 && index < item.options.length
    ? item.options[index]!
    : answer;
}

export type CloseResult =
  | { ok: true; item: SupervisorItem }
  | { ok: false; error: "not-found" | "closed" | "empty" };

async function closeItem(
  user: string,
  id: string,
  close: (item: SupervisorItem, now: number) => SupervisorItem | "empty",
): Promise<CloseResult> {
  if (!validUser(user)) return { ok: false, error: "not-found" };
  const now = deps.now();
  let result: CloseResult = { ok: false, error: "not-found" };
  await updateDocument(user, (doc) => {
    const current = doc.items.find((item) => item.id === id);
    if (!current) {
      result = { ok: false, error: "not-found" };
      return doc;
    }
    if (current.state !== "open") {
      result = { ok: false, error: "closed" };
      return doc;
    }
    const next = close(current, now);
    if (next === "empty") {
      result = { ok: false, error: "empty" };
      return doc;
    }
    result = { ok: true, item: next };
    return {
      ...doc,
      items: prune(
        doc.items.map((item) => (item.id === id ? next : item)),
        now,
      ),
    };
  });
  if (result.ok) {
    // The row leaves the notification list, and a push held for the night
    // has nothing left to say.
    await deps.markDone(user, [itemThreadId(id)]).catch(() => {});
  }
  return result;
}

/** The owner's answer. It reaches the supervisor's next turn (briefing) and
 *  every `onSupervisorAnswer` handler whose prefix matches the source. */
export async function answerSupervisorItem(
  user: string,
  id: string,
  answer: string,
): Promise<CloseResult> {
  const result = await closeItem(user, id, (item, now) => {
    const resolved = resolveAnswer(
      item,
      typeof answer === "string" ? answer : "",
    );
    if (!resolved) return "empty";
    const next: SupervisorItem = {
      ...item,
      state: "answered",
      answer: resolved,
      answeredAt: now,
      updatedAt: now,
    };
    delete next.heldUntil;
    return next;
  });
  if (result.ok) {
    for (const { prefix, handler } of [...answerHandlers]) {
      if (!result.item.source.startsWith(prefix)) continue;
      try {
        await handler(result.item, result.item.answer ?? "");
      } catch (error) {
        console.warn(
          `[supervisor-inbox] answer handler for ${prefix} failed:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }
  return result;
}

export async function dismissSupervisorItem(
  user: string,
  id: string,
): Promise<CloseResult> {
  return closeItem(user, id, (item, now) => {
    const next: SupervisorItem = {
      ...item,
      state: "dismissed",
      updatedAt: now,
    };
    delete next.heldUntil;
    return next;
  });
}

// ── Prefs ───────────────────────────────────────────────────────────────────

export interface SupervisorPrefsView extends SupervisorPrefs {
  /** The time zone in effect: `timezone`, else the profile's. */
  effectiveTimezone: string;
}

export async function getSupervisorPrefs(
  user: string,
): Promise<SupervisorPrefsView> {
  const doc = await readDocument(user);
  const { prefs, timeZone } = prefsAndZone(doc, user);
  return { ...prefs, effectiveTimezone: timeZone };
}

export async function setSupervisorPrefs(
  user: string,
  patch: Partial<SupervisorPrefs>,
): Promise<SupervisorPrefsView> {
  const doc = await updateDocument(user, (current) => ({
    ...current,
    prefs: { ...cleanPrefs(current.prefs), ...patch },
  }));
  const { prefs, timeZone } = prefsAndZone(doc, user);
  return { ...prefs, effectiveTimezone: timeZone };
}

// ── Sweep: held pushes, retries, digest ─────────────────────────────────────

/** Push what is due for one person, then send their digest when due. */
async function sweepUser(user: string): Promise<{
  pushed: number;
  digested: number;
}> {
  const now = deps.now();
  const doc = await readDocument(user);
  const { prefs, timeZone } = prefsAndZone(doc, user);
  const quiet = inQuietHours(prefs, timeZone, now);
  let pushed = 0;
  for (const item of doc.items) {
    if (deliveryPlan(item, quiet) !== "push") continue;
    if (item.heldUntil !== undefined && item.heldUntil > now) continue;
    if (await pushItem(user, item)) pushed++;
  }

  const day = digestDayDue(prefs, timeZone, now, doc.lastDigestDay);
  if (!day) return { pushed, digested: 0 };
  const fyi = doc.items.filter(
    (item) =>
      item.kind === "fyi" &&
      item.state === "open" &&
      item.digestedAt === undefined,
  );
  if (fyi.length) {
    try {
      const sessionId = await deps.supervisorSessionId(user);
      await deps.notify(user, digestEvent(fyi, sessionId, day, now));
    } catch (error) {
      // Not marked: the next sweep tries again.
      console.warn(
        "[supervisor-inbox] digest failed:",
        error instanceof Error ? error.message : error,
      );
      return { pushed, digested: 0 };
    }
  }
  const included = new Set(fyi.map((item) => item.id));
  await updateDocument(user, (current) => ({
    ...current,
    lastDigestAt: now,
    lastDigestDay: day,
    items: current.items.map((item) =>
      included.has(item.id) && item.digestedAt === undefined
        ? { ...item, digestedAt: now }
        : item,
    ),
  }));
  return { pushed, digested: fyi.length };
}

function digestEvent(
  fyi: SupervisorItem[],
  sessionId: string,
  day: string,
  now: number,
): NotificationEvent {
  const count = fyi.length;
  return {
    kind: "supervisor_digest",
    // One row per day, so each digest arrives unread.
    subject: { type: "supervisor", id: `digest-${day}`, title: "Daily digest" },
    reason: "Daily digest",
    body: `${count} ${count === 1 ? "update" : "updates"}: ${fyi
      .slice(0, 3)
      .map((item) => item.title)
      .join(", ")}${count > 3 ? ", and more" : ""}`,
    url: `/session/${encodeURIComponent(sessionId)}`,
    eventKey: `digest:${day}`,
    at: now,
    delivery: "quiet",
  };
}

let sweeping: Promise<{ pushed: number; digested: number }> | null = null;

/**
 * One pass over every person's inbox document (one per person, bounded):
 * flush held needs-you items whose quiet hours are over, retry failed pushes,
 * and send due digests. Serial, one sweep at a time.
 */
export function sweepSupervisorInbox(): Promise<{
  pushed: number;
  digested: number;
}> {
  sweeping ??= (async () => {
    const totals = { pushed: 0, digested: 0 };
    let rows: Array<{ key: string; value: unknown }>;
    try {
      rows = await documents().list();
    } catch (error) {
      console.warn(
        "[supervisor-inbox] sweep could not list inboxes:",
        error instanceof Error ? error.message : error,
      );
      return totals;
    }
    for (const row of rows) {
      const user = isRecord(row.value) ? text(row.value.user, 120) : "";
      if (!user) continue;
      try {
        const done = await sweepUser(user);
        totals.pushed += done.pushed;
        totals.digested += done.digested;
      } catch (error) {
        console.warn(
          "[supervisor-inbox] sweep failed for one inbox:",
          error instanceof Error ? error.message : error,
        );
      }
    }
    return totals;
  })().finally(() => {
    sweeping = null;
  });
  return sweeping;
}

declare global {
  var __supervisorInboxSweep: ReturnType<typeof setInterval> | undefined;
}

/** Start the once-a-minute sweep. Idempotent; called from boot. */
export function startSupervisorInbox(): void {
  if (globalThis.__supervisorInboxSweep) return;
  const timer = setInterval(() => {
    if (isShuttingDown()) return;
    void sweepSupervisorInbox();
  }, SWEEP_MS);
  timer.unref?.();
  globalThis.__supervisorInboxSweep = timer;
}

export function __resetSupervisorInboxForTest(): void {
  if (globalThis.__supervisorInboxSweep)
    clearInterval(globalThis.__supervisorInboxSweep);
  globalThis.__supervisorInboxSweep = undefined;
  answerHandlers.length = 0;
  sweeping = null;
}

// ── Briefing ────────────────────────────────────────────────────────────────

const BRIEF_MAX = 8;
const BRIEF_BODY = 240;

function briefLine(item: SupervisorItem): string {
  const where = [item.project, item.source].filter(Boolean).join(", ");
  return `- [${item.id}] ${item.title}${where ? ` (${where})` : ""}`;
}

/**
 * The supervisor's per-turn view of its inbox, wrapped as context: open
 * needs-you items with their options, fyi items since the last digest, and
 * answers the owner gave since the last briefing. Answers shown here are
 * marked briefed, so each reaches exactly one turn. Bounded; undefined when
 * there is nothing to say.
 */
export async function supervisorInboxContext(
  user: string | null | undefined,
): Promise<string | undefined> {
  if (!validUser(user)) return undefined;
  const now = deps.now();
  const items = prune((await readDocument(user)).items, now);
  const needsYou = items
    .filter((item) => item.kind === "needs-you" && item.state === "open")
    .slice(0, BRIEF_MAX);
  const fyi = items
    .filter(
      (item) =>
        item.kind === "fyi" &&
        item.state === "open" &&
        item.digestedAt === undefined,
    )
    .slice(0, BRIEF_MAX);
  const answered = items
    .filter((item) => item.state === "answered" && item.briefedAt === undefined)
    .slice(0, BRIEF_MAX);
  if (!needsYou.length && !fyi.length && !answered.length) return undefined;

  const sections = ["## Your inbox"];
  if (answered.length)
    sections.push(
      "Answered by the owner since your last turn:\n" +
        answered
          .map((item) => `${briefLine(item)}: "${item.answer ?? ""}"`)
          .join("\n"),
    );
  if (needsYou.length)
    sections.push(
      "Waiting on the owner:\n" +
        needsYou
          .map((item) => {
            const held =
              item.heldUntil !== undefined ? " (held for quiet hours)" : "";
            const options = item.options?.length
              ? `\n  Options: ${optionsLine(item.options)}`
              : "";
            const body = firstLine(item.body).slice(0, BRIEF_BODY);
            return `${briefLine(item)}${held}${body ? `\n  ${body}` : ""}${options}`;
          })
          .join("\n"),
    );
  if (fyi.length)
    sections.push(
      "For the next digest:\n" + fyi.map((item) => briefLine(item)).join("\n"),
    );

  if (answered.length) {
    const ids = new Set(answered.map((item) => item.id));
    await updateDocument(user, (doc) => ({
      ...doc,
      items: doc.items.map((item) =>
        ids.has(item.id) && item.briefedAt === undefined
          ? { ...item, briefedAt: now }
          : item,
      ),
    })).catch(() => {});
  }
  return wrapContext(sections.join("\n\n"), "supervisor-inbox");
}
