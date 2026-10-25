// The Support list across channels: email conversations from the
// `support-index` work index, and Plain's TODO queue through its sidebar
// feed (`listTodoThreads` behind the feed layer's 60 s cache, invalidated
// by the Plain mutations). This is the listing half of the channel layer for
// Plain; its send and inbound paths stay in agents/plain until the Plain
// migration. A channel that fails to list is reported in `channels`, never
// thrown, so the others still show.
import type { SupportThreadSummary } from "../../agents/plain/api";
import {
  type SupportChannelKind,
  type SupportIndexRow,
  type SupportListItem,
  SUPPORT_EMAIL_LIST_LIMIT,
  supportItemId,
} from "../../shared/support";
import { listInboxes } from "./inboxes";
import { listIndexRows } from "./store";

export interface SupportChannelStatus {
  channel: SupportChannelKind;
  label: string;
  error: string | null;
}

export interface SupportListResult {
  items: SupportListItem[];
  /** Each channel's state; `error` is copy for the page, never a raw
   *  provider error. */
  channels: SupportChannelStatus[];
  /** Email had more open conversations than the list carries. */
  truncated: boolean;
}

/** The email list row. Pure; email has no priority. */
export function emailItem(
  row: SupportIndexRow,
  inboxLabel: string | null,
): SupportListItem {
  return {
    id: supportItemId("email", row.id),
    channel: "email",
    title: row.subject,
    preview: row.preview,
    customer: { name: row.customer.name, email: row.customer.address },
    priority: null,
    status: row.status,
    at: row.lastMessageAt,
    inbox: inboxLabel === null ? null : { id: row.inboxId, label: inboxLabel },
    project: row.project,
    draftState: row.draftState,
    vetoDeadline: row.vetoDeadline,
    sessionId: row.sessionId,
  };
}

/** The existing Plain queue row as a Support list row. Pure. */
export function plainItem(thread: SupportThreadSummary): SupportListItem {
  return {
    id: supportItemId("plain", thread.id),
    channel: "plain",
    title: thread.title ?? "",
    preview: thread.previewText ?? "",
    customer: { name: thread.customer.name, email: thread.customer.email },
    priority: thread.priority,
    status: thread.status,
    at: thread.statusChangedAt ?? thread.createdAt,
    inbox: null,
    project: null,
    draftState: null,
    vetoDeadline: null,
    // Plain links sessions by thread id on the session (plainThreadId).
    sessionId: null,
  };
}

/** null when the Plain integration is not loaded. */
type PlainThreads = () => Promise<SupportThreadSummary[] | null>;

let plainThreadsOverride: PlainThreads | undefined;

export function __setPlainThreadsForTest(fn: PlainThreads | undefined): void {
  plainThreadsOverride = fn;
}

async function plainThreads(): Promise<SupportThreadSummary[] | null> {
  if (plainThreadsOverride) return plainThreadsOverride();
  const { ensureFeedsRegistered, getFeedItems } = await import("../feeds");
  await ensureFeedsRegistered();
  const items = await getFeedItems("plain");
  if (items === null) return null;
  return items.flatMap((item) =>
    isThreadSummary(item.meta) ? [item.meta] : [],
  );
}

/** The Plain feed keeps each `listTodoThreads` row whole as its item meta. */
function isThreadSummary(
  meta: Record<string, unknown> | undefined,
): meta is Record<string, unknown> & SupportThreadSummary {
  const customer = meta?.customer;
  return (
    typeof meta?.id === "string" &&
    typeof customer === "object" &&
    customer !== null
  );
}

/** The raw reason as log text; never empty. */
function reasonText(reason: unknown, fallback: string): string {
  if (reason instanceof Error) return reason.message || fallback;
  if (typeof reason === "string") return reason || fallback;
  try {
    return JSON.stringify(reason) ?? fallback;
  } catch {
    return fallback;
  }
}

const newestFirst = (a: SupportListItem, b: SupportListItem) =>
  (b.at ?? "").localeCompare(a.at ?? "");

export const SIGN_IN_FOR_MAIL = "Sign in to read support mail";
const EMAIL_UNREADABLE = "Email conversations could not be read";
const PLAIN_UNREACHABLE = "Plain could not be reached";

async function emailItems(): Promise<{
  items: SupportListItem[];
  truncated: boolean;
}> {
  const [rows, inboxes] = await Promise.all([
    listIndexRows({ status: ["open", "waiting"] }),
    listInboxes(),
  ]);
  const labels = new Map(inboxes.map((i) => [i.id, i.label]));
  return {
    // listIndexRows is newest first.
    items: rows
      .slice(0, SUPPORT_EMAIL_LIST_LIMIT)
      .map((row) => emailItem(row, labels.get(row.inboxId) ?? null)),
    truncated: rows.length > SUPPORT_EMAIL_LIST_LIMIT,
  };
}

/**
 * Plain's TODO queue whenever Plain is loaded, and email rows (open or
 * waiting, the newest SUPPORT_EMAIL_LIST_LIMIT) only for a signed-in
 * `person`; without one the email channel says to sign in. Merged newest
 * first; `truncated` when email had more rows than the list carries.
 */
export async function listSupportItems({
  person,
}: {
  person: string | null;
}): Promise<SupportListResult> {
  const [email, plain] = await Promise.allSettled([
    person ? emailItems() : Promise.resolve(null),
    plainThreads(),
  ]);
  const items: SupportListItem[] = [];
  const channels: SupportChannelStatus[] = [];
  let truncated = false;
  if (email.status === "fulfilled") {
    if (email.value) {
      items.push(...email.value.items);
      truncated = email.value.truncated;
    }
    channels.push({
      channel: "email",
      label: "Email",
      error: email.value ? null : SIGN_IN_FOR_MAIL,
    });
  } else {
    console.warn(
      "[support] email list failed:",
      reasonText(email.reason, "unknown error"),
    );
    channels.push({
      channel: "email",
      label: "Email",
      error: EMAIL_UNREADABLE,
    });
  }
  if (plain.status === "fulfilled") {
    if (plain.value !== null) {
      items.push(...plain.value.map(plainItem));
      channels.push({ channel: "plain", label: "Plain", error: null });
    }
  } else {
    console.warn("[support] Plain list failed:", plain.reason);
    channels.push({
      channel: "plain",
      label: "Plain",
      error: PLAIN_UNREACHABLE,
    });
  }
  return { items: items.sort(newestFirst), channels, truncated };
}
