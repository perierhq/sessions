// Support retention and "Forget this customer". The hourly sweep reads the
// `support-index` work index and opens only the conversations that are due:
// closed longer than the inbox keeps them (deleted with their attachments
// and message-id keys) or holding an attachment past its expiry (file
// deleted, name and size kept). The held-sweep pattern of the incident
// notifier. Retention never touches the mailbox.
import {
  type AttachmentMeta,
  DEFAULT_RETENTION,
  type InboxConfig,
  type InboxRetention,
  type SupportIndexRow,
} from "../../shared/support";
import { digest } from "../audit";
import { isShuttingDown } from "../shutdown-state";
import {
  deleteAttachmentFile,
  deleteConversationAttachments,
} from "./attachments";
import { supportAudit } from "./audit-sink";
import { getInbox } from "./inboxes";
import {
  deleteConversation,
  getConversation,
  listIndexRows,
  updateConversation,
} from "./store";

export const RETENTION_SWEEP_MS = 3_600_000;
const FIRST_SWEEP_MS = 60_000;
const DAY_MS = 86_400_000;

export interface RetentionDeps {
  now(): number;
  inbox(id: string): Promise<InboxConfig | null>;
  deleteSession(sessionId: string): Promise<void>;
  audit(event: Record<string, unknown>): Promise<void>;
}

/** The whole session deletion the sessions route runs, worktree kept. A
 *  session already gone is fine; a refused deletion throws. */
async function deleteSupportSession(sessionId: string): Promise<void> {
  const { findSessionAsync } = await import("../session-cache");
  const session = await findSessionAsync(sessionId);
  if (!session) return;
  const { deleteSessionCompletely } = await import("../routes/sessions");
  const response = await deleteSessionCompletely(session, false);
  if (!response.ok && response.status !== 404) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(
      body?.error ?? `Session ${sessionId} not deleted (${response.status})`,
    );
  }
}

const defaultDeps: RetentionDeps = {
  now: () => Date.now(),
  inbox: getInbox,
  deleteSession: deleteSupportSession,
  audit: supportAudit,
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Deletes the files first: a crash part way leaves the conversation (and
 *  its index row) for the next run, never an orphaned file. */
async function deleteWithAttachments(id: string): Promise<number> {
  const files = await deleteConversationAttachments(id);
  await deleteConversation(id);
  return files;
}

function closedPast(
  row: SupportIndexRow,
  retention: InboxRetention,
  now: number,
): boolean {
  if (row.status !== "closed" && row.status !== "spam") return false;
  if (!row.closedAt) return false;
  const closed = Date.parse(row.closedAt);
  return (
    Number.isFinite(closed) &&
    closed + retention.conversationDays * DAY_MS <= now
  );
}

async function expireAttachments(id: string, now: number): Promise<number> {
  const conversation = await getConversation(id);
  if (!conversation) return 0;
  const due = (a: AttachmentMeta) =>
    a.stored && !!a.expiresAt && Date.parse(a.expiresAt) <= now;
  const expired = conversation.messages.flatMap((m) =>
    m.attachments.filter(due),
  );
  for (const a of expired) await deleteAttachmentFile(id, a.id);
  // Also run with nothing expired: it rewrites a stale index row.
  await updateConversation(id, (c) => ({
    ...c,
    messages: c.messages.map((m) => ({
      ...m,
      attachments: m.attachments.map((a) =>
        due(a) ? { ...a, stored: false, expiresAt: null } : a,
      ),
    })),
  }));
  return expired.length;
}

let sweeping: Promise<{
  conversationsDeleted: number;
  attachmentsExpired: number;
}> | null = null;

export function sweepRetention(
  overrides: Partial<RetentionDeps> = {},
): Promise<{ conversationsDeleted: number; attachmentsExpired: number }> {
  const deps: RetentionDeps = { ...defaultDeps, ...overrides };
  sweeping ??= (async () => {
    const now = deps.now();
    const retentions = new Map<string, Promise<InboxRetention>>();
    const retentionFor = (inboxId: string) => {
      let found = retentions.get(inboxId);
      if (!found) {
        found = deps
          .inbox(inboxId)
          .then((inbox) => inbox?.retention ?? DEFAULT_RETENTION);
        retentions.set(inboxId, found);
      }
      return found;
    };
    let conversationsDeleted = 0;
    let attachmentsExpired = 0;
    for (const row of await listIndexRows()) {
      try {
        if (closedPast(row, await retentionFor(row.inboxId), now)) {
          await deleteWithAttachments(row.id);
          conversationsDeleted += 1;
        } else if (
          row.attachmentsExpireAt &&
          Date.parse(row.attachmentsExpireAt) <= now
        )
          attachmentsExpired += await expireAttachments(row.id, now);
      } catch (error) {
        console.warn(
          `[support] retention for ${row.id} failed:`,
          message(error),
        );
      }
    }
    return { conversationsDeleted, attachmentsExpired };
  })().finally(() => {
    sweeping = null;
  });
  return sweeping;
}

/** Deletes every conversation with this customer across inboxes, the
 *  sessions that worked on them (their transcripts hold the mail) and the
 *  attachments. A session that refuses to go throws and leaves its
 *  conversation for a retry. The audit row holds a digest of the address. */
export async function forgetCustomer(
  email: string,
  by: string,
  overrides: Partial<RetentionDeps> = {},
): Promise<{
  conversations: number;
  sessions: number;
  attachments: number;
  notDeleted: string[];
}> {
  const deps: RetentionDeps = { ...defaultDeps, ...overrides };
  const customer = email.trim().toLowerCase();
  const issues: string[] = [];
  const sessionsDeleted = new Set<string>();
  let conversations = 0;
  let attachments = 0;
  for (const row of await listIndexRows({ customerEmail: customer })) {
    const conversation = await getConversation(row.id);
    const sessionIds = [
      conversation?.sessionId ?? row.sessionId,
      conversation?.fixSessionId ?? null,
    ];
    for (const sessionId of sessionIds) {
      if (!sessionId || sessionsDeleted.has(sessionId)) continue;
      await deps.deleteSession(sessionId);
      sessionsDeleted.add(sessionId);
    }
    if (conversation?.issue && !issues.includes(conversation.issue.url))
      issues.push(conversation.issue.url);
    attachments += await deleteWithAttachments(row.id);
    conversations += 1;
  }
  await deps.audit({
    type: "support.forget",
    by,
    customer: digest(customer),
    conversations,
  });
  return {
    conversations,
    sessions: sessionsDeleted.size,
    attachments,
    notDeleted: ["Mail in the mailbox", ...issues],
  };
}

declare global {
  var __supportRetention: ReturnType<typeof setInterval> | undefined;
}

/** Idempotent. The first sweep runs a minute after boot, then hourly. */
export function startSupportRetention(): void {
  if (globalThis.__supportRetention) return;
  const run = () => {
    if (isShuttingDown()) return;
    void sweepRetention().catch((error) => {
      console.warn("[support] retention sweep failed:", message(error));
    });
  };
  const first = setTimeout(() => {
    run();
    const interval = setInterval(run, RETENTION_SWEEP_MS);
    interval.unref?.();
    globalThis.__supportRetention = interval;
  }, FIRST_SWEEP_MS);
  first.unref?.();
  globalThis.__supportRetention = first;
}
