// Email support as an integration module: one EmailChannelAdapter per
// enabled inbox, registered in the support channel registry, with ingest
// (support/ingest.ts) as its sink. Inbox changes (support/inboxes.ts
// onInboxChange) are applied per inbox, one at a time:
//
//  - removed or disabled: disconnect and unregister at once (a removed
//    inbox also loses its IMAP cursor);
//  - created or enabled: connect at once;
//  - anything else waits `coalesceMs` (2 s) so a burst of saves is one
//    reconnect, then reads the inbox as it is now. A change to the IMAP
//    server, its password, internal hosts or the mailbox behaviour
//    disconnects the old adapter before the new one connects, so an inbox
//    never has two connections. Passwords are compared by SHA-256 digest
//    (a new password for the same server keeps its secret ref); the agent
//    never holds them. Other fields update the adapter in place; a new
//    address, send limit, SMTP server or SMTP password builds a new SMTP
//    pool only. A paused inbox saved with nothing to change tries again.
//
// Mail read while the inbox is disabled (and not yet disconnected) is
// refused, so its cursor stays and the mail is read again once enabled.
//
// Health lists inbox ids, states and reasons only, never an address. No
// routes in v1 (a webhook transport adds its route here). Nothing runs at
// import; startup() is called by the integration loader.

import { createHash } from "node:crypto";
import type { InboundMessage, InboxConfig } from "../../shared/support";
import {
  channelAdapterFor,
  registerChannelAdapter,
  unregisterChannelAdapter,
} from "../../server/support/channel";
import {
  getInbox,
  inboxPassword,
  listInboxes,
  onInboxChange,
} from "../../server/support/inboxes";
import { ingestInbound } from "../../server/support/ingest";
import type { AgentModule } from "../types";
import {
  EmailChannelAdapter,
  type EmailAdapterDeps,
  deleteInboxCursor,
} from "./adapter";

/** Changes this close together are applied as one. */
const COALESCE_MS = 2_000;

/** SHA-256 digests of the stored passwords, to tell a change. */
type Passwords = { imap: string | null; smtp: string | null };

interface Live {
  adapter: EmailChannelAdapter;
  inbox: InboxConfig;
  passwords: Passwords;
}

export interface EmailAgentOptions {
  coalesceMs?: number;
  /** IMAP timing for every adapter (tests). */
  imap?: EmailAdapterDeps["imap"];
}

const SERVER_FIELDS = ["host", "port", "tls", "user", "passwordRef"] as const;

/** Whether `next` needs a new IMAP connection: its server, internal hosts
 *  or the mailbox behaviour (read-only or not). SMTP-side changes are the
 *  adapter's (update() builds a new pool). */
function needsReconnect(current: InboxConfig, next: InboxConfig): boolean {
  return (
    current.allowInternalHost !== next.allowInternalHost ||
    current.mailbox !== next.mailbox ||
    SERVER_FIELDS.some((f) => current.imap[f] !== next.imap[f])
  );
}

const digest = (password: string | undefined): string | null =>
  password === undefined
    ? null
    : createHash("sha256").update(password).digest("hex");

/** Ingest, except for an inbox disabled since its adapter connected: the
 *  sink throws so the IMAP cursor stays (a deleted inbox is ignored by
 *  ingest itself). */
async function sink(m: InboundMessage) {
  const inbox = await getInbox(m.inboxId);
  if (inbox && !inbox.enabled) throw new Error("The inbox is turned off");
  return ingestInbound(m);
}

/** A reason shown in /health: any address in it (server ALERT text can
 *  carry one) is cut. */
const withoutAddresses = (reason: string | null) =>
  reason === null ? null : reason.replace(/\S*@\S*/g, "[address]");

function log(event: string, inboxId: string, error: unknown): void {
  const e = error as { code?: unknown; name?: unknown } | null;
  console.warn(`[email] ${event}`, {
    inboxId,
    error: String(e?.code ?? e?.name ?? "error"),
  });
}

export class EmailAgent implements AgentModule {
  readonly name = "email";
  private readonly coalesceMs: number;
  private readonly imapTiming: EmailAdapterDeps["imap"];
  private readonly live = new Map<string, Live>();
  /** The per-inbox queue: one reconcile at a time. */
  private readonly chains = new Map<string, Promise<void>>();
  /** Inboxes with a reconcile queued that hasn't started yet. */
  private readonly queued = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private unsubscribe: (() => void) | null = null;
  private stopped = true;

  constructor(opts: EmailAgentOptions = {}) {
    this.coalesceMs = opts.coalesceMs ?? COALESCE_MS;
    this.imapTiming = opts.imap;
  }

  getRoutes(): Map<string, never> {
    return new Map<string, never>();
  }

  async startup(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    // Subscribed first: a change during the listing is reconciled too.
    this.unsubscribe = onInboxChange((next, previous) =>
      this.onChange(next, previous),
    );
    const inboxes = await listInboxes();
    await Promise.allSettled(
      inboxes.filter((i) => i.enabled).map((i) => this.enqueue(i.id)),
    );
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.allSettled([...this.chains.values()]);
    await Promise.allSettled(
      [...this.live.keys()].map((id) => this.stop(id, false)),
    );
  }

  health(): Record<string, unknown> {
    return {
      inboxes: [...this.live.values()].map(({ adapter }) => {
        const health = adapter.health();
        return {
          id: adapter.inboxId,
          state: health.state,
          reason: withoutAddresses(health.reason),
        };
      }),
    };
  }

  private onChange(next: InboxConfig | null, previous: InboxConfig | null) {
    if (this.stopped) return;
    const id = (next ?? previous)?.id;
    if (!id) return;
    const immediate = !next || !next.enabled || !previous || !previous.enabled;
    if (immediate) {
      const timer = this.timers.get(id);
      if (timer) clearTimeout(timer);
      this.timers.delete(id);
      void this.enqueue(id);
      return;
    }
    if (this.timers.has(id)) return;
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        void this.enqueue(id);
      }, this.coalesceMs),
    );
  }

  /** Queues a reconcile; one already queued and not started covers it. */
  private enqueue(id: string): Promise<void> {
    const previous = this.chains.get(id);
    if (previous && this.queued.has(id)) return previous;
    this.queued.add(id);
    const run = (previous ?? Promise.resolve())
      .then(() => {
        this.queued.delete(id);
        return this.reconcile(id);
      })
      .catch((error: unknown) => log("inbox not applied", id, error));
    this.chains.set(id, run);
    void run.finally(() => {
      if (this.chains.get(id) === run) this.chains.delete(id);
    });
    return run;
  }

  /** Brings the inbox's adapter in line with the stored inbox. */
  private async reconcile(id: string): Promise<void> {
    if (this.stopped) return this.stop(id, false);
    const inbox = await getInbox(id);
    if (!inbox || !inbox.enabled) return this.stop(id, !inbox);
    const passwords: Passwords = {
      imap: digest(await inboxPassword(inbox, "imap")),
      smtp: digest(await inboxPassword(inbox, "smtp")),
    };
    if (this.stopped) return;
    const current = this.live.get(id);
    if (current) {
      if (
        !needsReconnect(current.inbox, inbox) &&
        current.passwords.imap === passwords.imap
      ) {
        const { adapter } = current;
        adapter.update(inbox);
        if (current.passwords.smtp !== passwords.smtp) adapter.rebuildSmtp();
        current.inbox = inbox;
        current.passwords = passwords;
        // Saved again after a refused login: one more try, not waited for.
        if (adapter.health().state === "paused")
          adapter
            .resume()
            .catch((error: unknown) => log("resume failed", id, error));
        return;
      }
      await this.stop(id, false);
      if (this.stopped) return;
    }
    this.start(inbox, passwords);
  }

  /** Registers and starts connecting; doesn't wait for the server (an
   *  unreachable one must not hold up a disable). */
  private start(inbox: InboxConfig, passwords: Passwords): void {
    // The adapter reads the passwords from the workspace secrets itself.
    const adapter = new EmailChannelAdapter(inbox, {
      ...(this.imapTiming ? { imap: this.imapTiming } : {}),
    });
    this.live.set(inbox.id, { adapter, inbox, passwords });
    registerChannelAdapter(adapter);
    adapter
      .connect(sink)
      .catch((error: unknown) => log("connect failed", inbox.id, error));
  }

  private async stop(id: string, forget: boolean): Promise<void> {
    const current = this.live.get(id);
    if (current) {
      this.live.delete(id);
      if (channelAdapterFor(id) === current.adapter)
        unregisterChannelAdapter(id);
      await current.adapter.disconnect();
    }
    if (forget)
      await deleteInboxCursor(id).catch((error: unknown) =>
        log("cursor not removed", id, error),
      );
  }
}
