// Support retention and "Forget this customer". The hourly sweep reads the
// `support-index` work index and opens only the conversations that are due:
// closed longer than the inbox keeps them (deleted with their attachments
// and message-id keys) or holding an attachment past its expiry (file
// deleted, name and size kept), at most SWEEP_MAX_ACTIONS a run. A swept
// conversation's linked sessions go first. Once a day it also removes
// attachment directories no conversation owns. The held-sweep pattern of
// the incident notifier. Retention never touches the mailbox.
import { createHmac, randomBytes } from "node:crypto";
import {
  type AttachmentMeta,
  DEFAULT_RETENTION,
  type InboxConfig,
  type InboxRetention,
  type SupportConversation,
  type SupportIndexRow,
} from "../../shared/support";
import type { SessionDeleteResult } from "../session-delete";
import { isShuttingDown } from "../shutdown-state";
import type { UnifiedSession } from "../types";
import {
  putWorkspaceSecretAsync,
  resolveWorkspaceSecretAsync,
} from "../workspace-secrets";
import {
  deleteAttachmentFile,
  deleteConversationAttachments,
  removeOrphanAttachmentDirs,
} from "./attachments";
import { supportAudit } from "./audit-sink";
import { getInbox } from "./inboxes";
import {
  deleteConversation,
  existingConversations,
  getConversation,
  listIndexRows,
  updateConversation,
} from "./store";

export const RETENTION_SWEEP_MS = 3_600_000;
const FIRST_SWEEP_MS = 60_000;
const DAY_MS = 86_400_000;
/** Conversations one sweep acts on; the rest wait for the next hour. */
const SWEEP_MAX_ACTIONS = 200;
/** The workspace secret keying the forget audit digest. */
export const FORGET_KEY_REF = "wssec-support-forget-digest";

export interface RetentionDeps {
  now(): number;
  inbox(id: string): Promise<InboxConfig | null>;
  /** Resolves once the session is gone (or already was); throws when the
   *  deletion is refused. */
  deleteSession(sessionId: string, cleanWorktree: boolean): Promise<void>;
  audit(event: Record<string, unknown>): Promise<void>;
  shuttingDown(): boolean;
  maxActions: number;
}

/** The whole session deletion the sessions route runs. A session already
 *  gone is fine; a refused deletion throws. `seam` replaces the lookup and
 *  the deletion (tests). */
export async function deleteSupportSession(
  sessionId: string,
  cleanWorktree: boolean,
  seam?: {
    find(id: string): Promise<UnifiedSession | null | undefined>;
    remove(
      session: UnifiedSession,
      cleanWorktree: boolean,
    ): Promise<SessionDeleteResult>;
  },
): Promise<void> {
  const find =
    seam?.find ?? (await import("../session-cache")).findSessionAsync;
  const session = await find(sessionId);
  if (!session) return;
  const remove =
    seam?.remove ?? (await import("../session-delete")).deleteSessionCompletely;
  const { status, body } = await remove(session, cleanWorktree);
  if (status >= 200 && status < 300) return;
  const error = (body as { error?: unknown } | null)?.error;
  throw new Error(
    typeof error === "string"
      ? error
      : `Session ${sessionId} not deleted (${status})`,
  );
}

const defaultDeps: RetentionDeps = {
  now: () => Date.now(),
  inbox: getInbox,
  deleteSession: (id, cleanWorktree) => deleteSupportSession(id, cleanWorktree),
  audit: supportAudit,
  shuttingDown: isShuttingDown,
  maxActions: SWEEP_MAX_ACTIONS,
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let keyCreation: Promise<string> | null = null;

/** The per-instance key, created on first use. Concurrent first uses in
 *  this process share one creation. */
function forgetKey(): Promise<string> {
  keyCreation ??= (async () => {
    const existing = await resolveWorkspaceSecretAsync(FORGET_KEY_REF);
    if (existing) return existing;
    await putWorkspaceSecretAsync(
      "support-forget-digest",
      randomBytes(32).toString("hex"),
      FORGET_KEY_REF,
    );
    const created = await resolveWorkspaceSecretAsync(FORGET_KEY_REF);
    if (!created) throw new Error("Support forget key not stored");
    return created;
  })().finally(() => {
    keyCreation = null;
  });
  return keyCreation;
}

/** The address as the forget audit records it: an HMAC under a
 *  per-instance key, so the audit log alone cannot confirm a guessed
 *  address, while the operator can still prove a given address was
 *  forgotten by recomputing it. */
export async function customerDigest(address: string): Promise<string> {
  return createHmac("sha256", await forgetKey())
    .update(address.trim().toLowerCase())
    .digest("hex")
    .slice(0, 32);
}

/** Deletes the conversation's support session with its worktree (Support
 *  is read-only, so it holds nothing worth keeping) and its fix session
 *  without (the worktree may hold a fix branch). `done` skips sessions
 *  already deleted in this run. Resolves true when a fix session was
 *  deleted. Throws when a deletion is refused. */
async function deleteLinkedSessions(
  conversation: SupportConversation | null,
  row: SupportIndexRow,
  deps: RetentionDeps,
  done: Set<string>,
): Promise<boolean> {
  const linked: Array<[string | null, boolean]> = [
    [conversation?.sessionId ?? row.sessionId, true],
    [conversation?.fixSessionId ?? null, false],
  ];
  let fixDeleted = false;
  for (const [sessionId, cleanWorktree] of linked) {
    if (!sessionId || done.has(sessionId)) continue;
    await deps.deleteSession(sessionId, cleanWorktree);
    done.add(sessionId);
    if (!cleanWorktree) fixDeleted = true;
  }
  return fixDeleted;
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

export interface SweepResult {
  conversationsDeleted: number;
  attachmentsExpired: number;
  orphansRemoved: number;
}

let sweeping: Promise<SweepResult> | null = null;
/** When this process last looked for orphaned attachment directories. */
let lastOrphanSweep = Number.NEGATIVE_INFINITY;

/** One sweep at a time per process: a call while one runs gets that one. */
export function sweepRetention(
  overrides: Partial<RetentionDeps> = {},
): Promise<SweepResult> {
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
    const sessionsDeleted = new Set<string>();
    let conversationsDeleted = 0;
    let attachmentsExpired = 0;
    let actions = 0;
    for (const row of await listIndexRows()) {
      if (actions >= deps.maxActions || deps.shuttingDown()) break;
      try {
        if (closedPast(row, await retentionFor(row.inboxId), now)) {
          actions += 1;
          // The linked transcripts hold the same mail, and once the row is
          // gone nothing finds them: they go first, and a refusal leaves
          // the conversation for the next sweep.
          await deleteLinkedSessions(
            await getConversation(row.id),
            row,
            deps,
            sessionsDeleted,
          );
          await deleteWithAttachments(row.id);
          conversationsDeleted += 1;
        } else if (
          row.attachmentsExpireAt &&
          Date.parse(row.attachmentsExpireAt) <= now
        ) {
          actions += 1;
          attachmentsExpired += await expireAttachments(row.id, now);
        }
      } catch (error) {
        console.warn(
          `[support] retention for ${row.id} failed:`,
          message(error),
        );
      }
    }
    let orphansRemoved = 0;
    if (!deps.shuttingDown() && now - lastOrphanSweep >= DAY_MS) {
      lastOrphanSweep = now;
      try {
        orphansRemoved = await removeOrphanAttachmentDirs(
          now,
          existingConversations,
        );
      } catch (error) {
        console.warn(
          "[support] orphan attachment cleanup failed:",
          message(error),
        );
      }
    }
    return { conversationsDeleted, attachmentsExpired, orphansRemoved };
  })().finally(() => {
    sweeping = null;
  });
  return sweeping;
}

/** Deletes every conversation with this customer across inboxes, the
 *  sessions that worked on them (their transcripts hold the mail) and the
 *  attachments. A conversation whose session refuses to go is kept for a
 *  retry and counted in `failed`; the rest still go. The audit row, written
 *  every time, holds a keyed digest of the address, never the address. */
export async function forgetCustomer(
  email: string,
  by: string,
  overrides: Partial<RetentionDeps> = {},
): Promise<{
  conversations: number;
  sessions: number;
  attachments: number;
  failed: number;
  notDeleted: string[];
}> {
  const deps: RetentionDeps = { ...defaultDeps, ...overrides };
  const customer = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(customer))
    throw new Error("Invalid customer address");
  // Before anything is deleted: a key that cannot be made stops here
  // rather than leaving a deletion with no audit row.
  const customerKey = await customerDigest(customer);
  const issues: string[] = [];
  const sessionsDeleted = new Set<string>();
  let conversations = 0;
  let attachments = 0;
  let failed = 0;
  let fixSessionKept = false;
  try {
    for (const row of await listIndexRows({ customerEmail: customer })) {
      try {
        const conversation = await getConversation(row.id);
        if (
          await deleteLinkedSessions(conversation, row, deps, sessionsDeleted)
        )
          fixSessionKept = true;
        attachments += await deleteWithAttachments(row.id);
        conversations += 1;
        if (conversation?.issue && !issues.includes(conversation.issue.url))
          issues.push(conversation.issue.url);
      } catch (error) {
        failed += 1;
        console.warn(`[support] forget for ${row.id} failed:`, message(error));
      }
    }
  } finally {
    await deps.audit({
      type: "support.forget",
      by,
      customer: customerKey,
      conversations,
      failed,
    });
  }
  return {
    conversations,
    sessions: sessionsDeleted.size,
    attachments,
    failed,
    notDeleted: [
      "Mail in the mailbox",
      ...(fixSessionKept ? ["Fix session worktree and branch"] : []),
      ...(failed
        ? [
            `${failed} ${failed === 1 ? "conversation" : "conversations"} still in use, try again`,
          ]
        : []),
      ...issues,
    ],
  };
}

/** Forget the once-a-day orphan cleanup (tests). */
export function __resetRetentionForTest(): void {
  lastOrphanSweep = Number.NEGATIVE_INFINITY;
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
