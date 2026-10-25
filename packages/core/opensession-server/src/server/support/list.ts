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
  channels: SupportChannelStatus[];
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

const reasonText = (reason: Error | string | null, fallback: string) =>
  (reason instanceof Error ? reason.message : reason) || fallback;

const newestFirst = (a: SupportListItem, b: SupportListItem) =>
  (b.at ?? "").localeCompare(a.at ?? "");

async function emailItems(): Promise<SupportListItem[]> {
  const [rows, inboxes] = await Promise.all([
    listIndexRows({ status: ["open", "waiting"] }),
    listInboxes(),
  ]);
  const labels = new Map(inboxes.map((i) => [i.id, i.label]));
  return rows.map((row) => emailItem(row, labels.get(row.inboxId) ?? null));
}

/** Email rows (open or waiting, newest first) and, when Plain is loaded,
 *  its TODO queue; merged newest first. */
export async function listSupportItems(): Promise<SupportListResult> {
  const [email, plain] = await Promise.allSettled([
    emailItems(),
    plainThreads(),
  ]);
  const items: SupportListItem[] = [];
  const channels: SupportChannelStatus[] = [];
  if (email.status === "fulfilled") {
    items.push(...email.value);
    channels.push({ channel: "email", label: "Email", error: null });
  } else {
    console.warn(
      "[support] email list failed:",
      reasonText(email.reason, "unknown error"),
    );
    channels.push({
      channel: "email",
      label: "Email",
      error: "Email conversations could not be read",
    });
  }
  if (plain.status === "fulfilled") {
    if (plain.value !== null) {
      items.push(...plain.value.map(plainItem));
      channels.push({ channel: "plain", label: "Plain", error: null });
    }
  } else {
    channels.push({
      channel: "plain",
      label: "Plain",
      error: reasonText(plain.reason, "Plain lookup failed"),
    });
  }
  return { items: items.sort(newestFirst), channels };
}
