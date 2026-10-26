// Inbound mail for one inbox: one IMAP connection, IDLE for push (a NOOP
// poll every pollMs when the server has no IDLE), and a UID cursor so only
// new mail is fetched, never a full scan. The cursor moves past a message
// only after the sink resolved, so a crash re-offers it (ingest dedupes).
// A first connect starts at UIDNEXT and imports nothing; a UIDVALIDITY
// change offers the mail received since the old cursor (at most 7 days,
// 500 messages; ingest dedupes by Message-ID) and then starts at UIDNEXT.
// An untouched mailbox is opened read-only. Lost connections back off with
// full jitter; an auth failure pauses the inbox until someone saves or
// tests it again. Server ALERT text is shown on the inbox, never acted on.
// Logs carry the inbox id, a kind and UIDs only: never the password, the
// addresses or any message content. Nothing runs at import.

import { ImapFlow, type ImapFlowOptions } from "imapflow";
import {
  IMAP_POLL_MS,
  type InboundMessage,
  type InboxConfig,
  type InboxHealth,
  type InboxHealthState,
  MAX_SOURCE_BYTES,
  type MailServerConfig,
} from "../../shared/support";
import type { InboundSink } from "../../server/support/channel";
import {
  MAIL_TLS_NONE_REFUSED,
  type MailHostPolicy,
  MailHostRefusedError,
  type MailHostTarget,
  resolveMailHost,
} from "../../server/support/mail-host";
import {
  PAUSE_COPY,
  type PauseKind,
  classifyImapError,
  nextBackoffMs,
} from "./backoff";
import {
  cleanLine,
  headerBlock,
  parseInbound,
  unreadableMessage,
} from "./parse";

export interface ImapCursor {
  uidValidity: string;
  lastUid: number;
  /** When the last offered message arrived (or when the cursor was set),
   *  ISO; where a UIDVALIDITY change looks back from. */
  lastReceivedAt?: string;
  /** When we last took a message in, ISO: the inbox health's last message,
   *  kept across restarts. */
  lastMessageAt?: string;
}

export interface ImapTransportOptions {
  inbox: InboxConfig;
  password: string;
  sink: InboundSink;
  loadCursor(): Promise<ImapCursor | null>;
  saveCursor(c: ImapCursor): Promise<void>;
  onHealth(h: InboxHealth): void;
  timers?: {
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
    now(): number;
  };
  random?: () => number;
  pollMs?: number;
  maxSourceBytes?: number;
  autoIdleDelayMs?: number;
}

/** IDLE restarts before Gmail cuts an IDLE at 29 minutes. */
const MAX_IDLE_MS = 1_500_000;
/** A connection live this long resets the backoff. */
const LIVE_RESET_MS = 300_000;
const PAGE_SIZE = 50;
const CONNECT_TIMEOUT_MS = 30_000;
/** imapflow's default; poll mode keeps the socket open past one poll. */
const SOCKET_TIMEOUT_MS = 300_000;
/** A sink that hasn't answered by then counts as failed. */
const SINK_TIMEOUT_MS = 120_000;
/** stop() waits this long for the current message, and again for LOGOUT. */
const STOP_LIMIT_MS = 5_000;
/** The most read for a header block (oversize or unreadable messages). */
const HEADER_BYTES = 262_144;
/** Server ALERT text shown on the inbox. */
const MAX_ALERT_CHARS = 200;
const DAY_MS = 86_400_000;
/** How far a UIDVALIDITY change looks back, at most. */
const RECOVERY_MAX_MS = 7 * DAY_MS;
const RECOVERY_MAX_MESSAGES = 500;

const SINK_FAILED = "Couldn't store a new message. Retrying later";
const CURSOR_FAILED = "Couldn't save the inbox position. Retrying later";

/** The sink refused a message, or didn't answer: not the server's fault. */
class SinkFailure extends Error {
  constructor(readonly uid: number) {
    super("sink failed");
  }
}

/** saveCursor failed: not the server's fault either. */
class CursorFailure extends Error {
  constructor() {
    super("cursor not saved");
  }
}

class TimedOut extends Error {
  constructor() {
    super("timed out");
  }
}

type Failure = { kind: PauseKind; reason: string; retryAfterMs?: number };

type MessageItem = { uid: number; size: number; internalDate?: Date | string };

/** TLS mode → imapflow: implicit TLS; STARTTLS required (refused before
 *  LOGIN when not offered); or none, which never upgrades and is only for
 *  a loopback address. */
function tlsOptions(
  server: Pick<MailServerConfig, "tls">,
  target: MailHostTarget,
): Pick<ImapFlowOptions, "secure" | "doSTARTTLS"> {
  switch (server.tls) {
    case "implicit":
      return { secure: true };
    case "starttls":
      return { secure: false, doSTARTTLS: true };
    case "none":
      if (!target.loopback)
        throw new MailHostRefusedError(MAIL_TLS_NONE_REFUSED);
      return { secure: false, doSTARTTLS: false };
    default:
      throw new Error("Unknown mail server security");
  }
}

/** Connects to the checked address only; the name stays the TLS servername
 *  so SNI and the certificate check use it. */
export function imapClientOptions(
  target: MailHostTarget,
  server: Omit<MailServerConfig, "passwordRef">,
  password: string,
): ImapFlowOptions {
  return {
    host: target.address,
    ...(target.servername ? { servername: target.servername } : {}),
    port: server.port,
    ...tlsOptions(server, target),
    auth: { user: server.user, pass: password },
    logger: false,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
  };
}

/** What a failed connection said, for the log line that reports it: the
 *  error code (ECONNREFUSED, a server response code) and a short message.
 *  Never the password: imapflow's errors carry neither it nor the LOGIN
 *  arguments. */
export function imapErrorDetail(err: unknown): {
  code?: string;
  error?: string;
} {
  if (!err || typeof err !== "object") return {};
  const e = err as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const code = str(e.code) || str(e.serverResponseCode);
  const parts = [
    err instanceof Error ? err.message.trim() : "",
    str(e.responseText),
  ].filter(Boolean);
  const message = [...new Set(parts)].join(": ").slice(0, 300);
  return {
    ...(code ? { code } : {}),
    ...(message ? { error: message } : {}),
  };
}

function log(
  inboxId: string,
  event: string,
  detail: Record<string, unknown> = {},
) {
  console.warn(`[email] ${event}`, { inboxId, ...detail });
}

export class ImapTransport {
  private readonly opts: ImapTransportOptions;
  private readonly timers: NonNullable<ImapTransportOptions["timers"]>;
  private readonly random: () => number;
  private client: ImapFlow | null = null;
  /** Bumped for each connection and whenever one is given up, so late
   *  events from an old client are ignored. */
  private generation = 0;
  private stopped = true;
  private attempt = 0;
  private connectedAt: number | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  /** The current connection's cursor; null until it is loaded. */
  private cursor: ImapCursor | null = null;
  /** UIDNEXT from SELECT/EXAMINE, until an `exists` or the first catch-up
   *  uses it: nothing newer than the cursor means no search. */
  private knownUidNext: number | null = null;
  /** The last ALERT text of the current connection, sanitized. */
  private alertText: string | null = null;
  /** The current connection's catch-up; an `exists` during it queues one
   *  more pass. */
  private catchUp: {
    gen: number;
    queued: boolean;
    done: Promise<void>;
  } | null = null;
  /** Pending time limits (sink answers); stop() ends them all. */
  private readonly limits = new Set<() => void>();
  /** Serializes catch-up and withClient on the one connection. */
  private chain: Promise<unknown> = Promise.resolve();
  private current: InboxHealth;

  constructor(opts: ImapTransportOptions) {
    this.opts = opts;
    this.timers = opts.timers ?? {
      setTimeout,
      clearTimeout,
      now: () => Date.now(),
    };
    this.random = opts.random ?? Math.random;
    this.current = {
      state: "off",
      since: this.iso(),
      reason: null,
      retryAt: null,
      lastMessageAt: null,
    };
  }

  private get inboxId(): string {
    return this.opts.inbox.id;
  }

  private iso(at = this.timers.now()): string {
    return new Date(at).toISOString();
  }

  health(): InboxHealth {
    return { ...this.current };
  }

  private setHealth(
    state: InboxHealthState,
    reason: string | null = null,
    retryAt: string | null = null,
  ): void {
    const since =
      state === this.current.state ? this.current.since : this.iso();
    this.current = { ...this.current, state, since, reason, retryAt };
    this.opts.onHealth(this.health());
  }

  /** Resolves after the first connect attempt settles. */
  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    // The last message as of the stored cursor, before the server answers.
    const stored = await this.opts.loadCursor().catch(() => null);
    this.rememberLastMessage(stored);
    await this.connect();
  }

  /** Takes the stored last-message time when none is known yet. */
  private rememberLastMessage(cursor: ImapCursor | null): void {
    if (this.current.lastMessageAt || !cursor?.lastMessageAt) return;
    if (Number.isNaN(Date.parse(cursor.lastMessageAt))) return;
    this.current = { ...this.current, lastMessageAt: cursor.lastMessageAt };
  }

  /** Tries again now after a pause with no retry planned (a refused login
   *  or server address): someone saved or tested the inbox. Does nothing
   *  while connected, connecting, backing off or stopped. Resolves after
   *  the attempt settles. */
  async resume(): Promise<void> {
    if (this.stopped || this.client || this.retryTimer) return;
    if (this.current.state !== "paused") return;
    this.attempt = 0;
    await this.connect();
  }

  /** Lets the current message finish and logs out, each for at most
   *  STOP_LIMIT_MS, then closes; clears timers; no reconnect afterwards. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.generation++;
    this.clearTimers();
    const client = this.client;
    const running = this.catchUp?.done;
    this.client = null;
    this.connectedAt = null;
    this.cursor = null;
    this.knownUidNext = null;
    this.catchUp = null;
    if (running) await this.settleWithin(running, STOP_LIMIT_MS);
    // A sink still running past the limit is given up on, and its timer
    // with it.
    for (const cut of [...this.limits]) cut();
    if (client) {
      await this.settleWithin(client.logout(), STOP_LIMIT_MS);
      client.close();
    }
    this.setHealth("off");
  }

  /** Run on the live connection (C3 mark, B3 Sent copy); rejects when not connected. */
  withClient<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = this.client;
    if (this.stopped || !client || !client.usable)
      return Promise.reject(new Error("The inbox is not connected"));
    return this.exclusive(() => {
      if (this.client !== client || !client.usable)
        throw new Error("The inbox is not connected");
      return fn(client);
    });
  }

  private exclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** `work`, or a TimedOut rejection after `ms` on the injected clock (or
   *  when stop() cuts all limits short). */
  private within<T>(work: Promise<T>, ms: number): Promise<T> {
    let cut = () => undefined as void;
    const limit = new Promise<never>((_, reject) => {
      const timer = this.timers.setTimeout(() => cut(), ms);
      cut = () => {
        this.timers.clearTimeout(timer);
        this.limits.delete(cut);
        reject(new TimedOut());
      };
      this.limits.add(cut);
    });
    return Promise.race([work, limit]).finally(() => cut());
  }

  /** Waits for `work` to settle, at most `ms`; never throws. */
  private async settleWithin(work: Promise<unknown>, ms: number) {
    try {
      await this.within(work, ms);
    } catch {
      // Settled, failed or given up: stopping either way.
    }
  }

  private clearTimers(): void {
    if (this.retryTimer) this.timers.clearTimeout(this.retryTimer);
    if (this.pollTimer) this.timers.clearTimeout(this.pollTimer);
    this.retryTimer = null;
    this.pollTimer = null;
  }

  private pollMs(): number {
    return this.opts.pollMs ?? IMAP_POLL_MS;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const gen = ++this.generation;
    this.cursor = null;
    this.knownUidNext = null;
    this.alertText = null;
    this.setHealth("connecting");
    const { imap, allowInternalHost } = this.opts.inbox;
    let target: MailHostTarget;
    try {
      target = await resolveMailHost(imap.host, {
        allowInternalHost,
        tls: imap.tls,
      });
    } catch (err) {
      this.fail(gen, err);
      return;
    }
    if (gen !== this.generation || this.stopped) return;
    let options: ImapFlowOptions;
    try {
      options = imapClientOptions(target, imap, this.opts.password);
    } catch (err) {
      this.fail(gen, err);
      return;
    }
    const client = new ImapFlow({
      ...options,
      maxIdleTime: MAX_IDLE_MS,
      socketTimeout: Math.max(SOCKET_TIMEOUT_MS, this.pollMs() + 60_000),
      ...(this.opts.autoIdleDelayMs !== undefined
        ? { autoIdleDelay: this.opts.autoIdleDelayMs }
        : {}),
    });
    this.client = client;
    let lastError: unknown = null;
    client.on("error", (err: unknown) => {
      lastError = err;
    });
    let sawExists = false;
    client.on("exists", () => {
      sawExists = true;
      if (gen === this.generation) this.knownUidNext = null;
      this.scheduleCatchUp(gen);
    });
    // RFC 9051 7.1: ALERT text is for a person. It never closes the
    // connection: a refused LOGIN still rejects and is classified there.
    client.on("alert", (alert: { message?: unknown }) => {
      if (gen !== this.generation) return;
      const text = cleanLine(String(alert?.message ?? ""), MAX_ALERT_CHARS);
      if (!text) return;
      this.alertText = text;
      if (this.current.state === "live" || this.current.state === "polling")
        this.setHealth(this.current.state, text);
    });

    try {
      await client.connect();
      if (gen !== this.generation) {
        client.close();
        return;
      }
      client.on("close", () =>
        this.fail(
          gen,
          lastError ??
            Object.assign(new Error("closed"), { code: "EConnectionClosed" }),
        ),
      );
      const idle = client.capabilities.has("IDLE");
      // Read on every auto-idle decision, so it can be set once IDLE
      // support is known.
      if (!idle)
        (
          client as unknown as { options: ImapFlowOptions }
        ).options.disableAutoIdle = true;

      // EXAMINE when nothing here changes the mailbox: the server can't set
      // \Seen or anything else on our behalf.
      const mailbox = await client.mailboxOpen("INBOX", {
        readOnly: this.opts.inbox.mailbox === "untouched",
      });
      if (gen !== this.generation) return;
      const uidValidity = String(mailbox.uidValidity);
      const uidNext =
        typeof mailbox.uidNext === "number" && mailbox.uidNext > 0
          ? mailbox.uidNext
          : null;
      const stored = await this.opts.loadCursor();
      if (gen !== this.generation) return;
      this.rememberLastMessage(stored);
      let cursor = stored;
      if (!cursor || cursor.uidValidity !== uidValidity) {
        const lastUid =
          uidNext !== null ? uidNext - 1 : await this.highestUid(client);
        if (cursor) {
          const old = cursor;
          await this.exclusive(() =>
            this.recover(gen, client, old, uidValidity, lastUid),
          );
        }
        if (gen !== this.generation) return;
        const lastMessageAt = this.current.lastMessageAt;
        cursor = {
          uidValidity,
          lastUid,
          lastReceivedAt: this.iso(),
          ...(lastMessageAt ? { lastMessageAt } : {}),
        };
        await this.persist(cursor);
        if (gen !== this.generation) return;
        log(this.inboxId, "imap cursor reset", { uidValidity, lastUid });
      }
      // UIDNEXT is current unless new mail was announced since the open.
      if (uidNext !== null && !sawExists) this.knownUidNext = uidNext;
      this.cursor = cursor;
      this.connectedAt = this.timers.now();
      this.setHealth(idle ? "live" : "polling", this.alertText);
      await this.runCatchUp(gen);
      if (!idle && gen === this.generation) this.schedulePoll(gen);
    } catch (err) {
      this.fail(gen, err);
    }
  }

  /** Without UIDNEXT: the UID of the newest message, 0 when empty. */
  private async highestUid(client: ImapFlow): Promise<number> {
    const uids = (await client.search({ uid: "*" }, { uid: true })) || [];
    return uids.reduce((max, uid) => Math.max(max, uid), 0);
  }

  /** UIDVALIDITY changed, so the old UIDs mean nothing: offer what arrived
   *  since a day before the old cursor (at most RECOVERY_MAX_MS back, the
   *  newest RECOVERY_MAX_MESSAGES). Ingest drops what it already has by
   *  Message-ID. The old cursor stays until all of them were offered. */
  private async recover(
    gen: number,
    client: ImapFlow,
    old: ImapCursor,
    uidValidity: string,
    lastUid: number,
  ): Promise<void> {
    if (gen !== this.generation) return;
    const now = this.timers.now();
    const last = old.lastReceivedAt ? Date.parse(old.lastReceivedAt) : NaN;
    const since = Math.max(
      now - RECOVERY_MAX_MS,
      Number.isNaN(last) ? -Infinity : last - DAY_MS,
    );
    const found =
      (await client.search({ since: new Date(since) }, { uid: true })) || [];
    const uids = found
      .filter((uid) => uid <= lastUid)
      .sort((a, b) => a - b)
      .slice(-RECOVERY_MAX_MESSAGES);
    log(this.inboxId, "imap uidvalidity changed", {
      uidValidity,
      offered: uids.length,
    });
    await this.offer(gen, client, uidValidity, uids, false);
  }

  private schedulePoll(gen: number): void {
    this.pollTimer = this.timers.setTimeout(async () => {
      this.pollTimer = null;
      const client = this.client;
      if (gen !== this.generation || !client) return;
      try {
        await client.noop();
        await this.runCatchUp(gen);
      } catch (err) {
        this.fail(gen, err);
        return;
      }
      if (gen === this.generation) this.schedulePoll(gen);
    }, this.pollMs());
  }

  private scheduleCatchUp(gen: number): void {
    if (gen !== this.generation || !this.cursor) return;
    this.runCatchUp(gen).catch((err) => this.fail(gen, err));
  }

  /** One catch-up per connection at a time; an `exists` during one queues
   *  another. A new connection never waits on an old one's queue. */
  private runCatchUp(gen: number): Promise<void> {
    const running = this.catchUp;
    if (running && running.gen === gen) {
      running.queued = true;
      return Promise.resolve();
    }
    const state = { gen, queued: false, done: Promise.resolve() };
    state.done = (async () => {
      try {
        do {
          state.queued = false;
          await this.exclusive(() => this.catchUpOnce(gen));
        } while (state.queued && gen === this.generation);
      } finally {
        if (this.catchUp === state) this.catchUp = null;
      }
    })();
    this.catchUp = state;
    return state.done;
  }

  private async catchUpOnce(gen: number): Promise<void> {
    const client = this.client;
    const start = this.cursor;
    if (gen !== this.generation || !client || !start) return;
    const uidNext = this.knownUidNext;
    this.knownUidNext = null;
    if (uidNext !== null && uidNext - 1 <= start.lastUid) return;
    const found =
      (await client.search({ uid: `${start.lastUid + 1}:*` }, { uid: true })) ||
      [];
    // `n:*` always matches the highest UID, even below n.
    const uids = found
      .filter((uid) => uid > start.lastUid)
      .sort((a, b) => a - b);
    await this.offer(gen, client, start.uidValidity, uids, true);
  }

  /** Fetches and offers `uids` in order; with `advance`, saves the cursor
   *  after each message the sink took. */
  private async offer(
    gen: number,
    client: ImapFlow,
    uidValidity: string,
    uids: number[],
    advance: boolean,
  ): Promise<void> {
    const maxBytes = this.opts.maxSourceBytes ?? MAX_SOURCE_BYTES;
    for (let i = 0; i < uids.length; i += PAGE_SIZE) {
      const page: MessageItem[] = [];
      for await (const item of client.fetch(
        uids.slice(i, i + PAGE_SIZE).join(","),
        { uid: true, size: true, internalDate: true },
        { uid: true },
      ))
        page.push({
          uid: item.uid,
          size: item.size ?? 0,
          internalDate: item.internalDate,
        });
      page.sort((a, b) => a.uid - b.uid);

      for (const item of page) {
        if (gen !== this.generation) return;
        const message = await this.fetchMessage(
          client,
          uidValidity,
          item,
          maxBytes,
        );
        if (gen !== this.generation) return;
        if (message) await this.deliver(message, item.uid);
        if (gen !== this.generation) return;
        const lastMessageAt = message
          ? this.iso()
          : (this.current.lastMessageAt ?? undefined);
        if (advance) {
          const next: ImapCursor = {
            uidValidity,
            lastUid: item.uid,
            lastReceivedAt:
              message?.receivedAt ?? this.cursor?.lastReceivedAt ?? this.iso(),
            ...(lastMessageAt ? { lastMessageAt } : {}),
          };
          await this.persist(next);
          if (gen !== this.generation) return;
          this.cursor = next;
        }
        if (message) {
          this.current = { ...this.current, lastMessageAt: lastMessageAt! };
          this.opts.onHealth(this.health());
        }
      }
    }
  }

  private async deliver(message: InboundMessage, uid: number): Promise<void> {
    try {
      await this.within(
        Promise.resolve().then(() => this.opts.sink(message)),
        SINK_TIMEOUT_MS,
      );
    } catch (err) {
      log(this.inboxId, "imap sink failed", {
        uid,
        timedOut: err instanceof TimedOut,
      });
      throw new SinkFailure(uid);
    }
  }

  private async persist(cursor: ImapCursor): Promise<void> {
    try {
      await this.opts.saveCursor(cursor);
    } catch {
      log(this.inboxId, "imap cursor not saved", { lastUid: cursor.lastUid });
      throw new CursorFailure();
    }
  }

  /** null when the message is gone. IMAP errors propagate (the message is
   *  fetched again after a reconnect); a source nothing can be parsed from
   *  still yields a message, so one bad mail never blocks the inbox. */
  private async fetchMessage(
    client: ImapFlow,
    uidValidity: string,
    item: MessageItem,
    maxBytes: number,
  ): Promise<InboundMessage | null> {
    const internal = item.internalDate ? new Date(item.internalDate) : null;
    const ctx = {
      inboxId: this.inboxId,
      providerId: `imap:${uidValidity}:${item.uid}`,
      receivedAt:
        internal && !Number.isNaN(internal.getTime())
          ? internal.toISOString()
          : this.iso(),
    };
    const fromHeaders = async (
      source: Uint8Array,
      flag: { oversize: true } | { unreadable: true },
    ) => {
      try {
        return await parseInbound(
          headerBlock(source.subarray(0, HEADER_BYTES)),
          {
            ...ctx,
            ...flag,
          },
        );
      } catch {
        log(this.inboxId, "imap headers unreadable", { uid: item.uid });
        return unreadableMessage(ctx);
      }
    };

    if (item.size > maxBytes) {
      const one = await client.fetchOne(
        String(item.uid),
        { uid: true, source: { maxLength: HEADER_BYTES } },
        { uid: true },
      );
      if (!one || !one.source) return null;
      return fromHeaders(one.source, { oversize: true });
    }
    // One byte past the limit tells a message bigger than its reported
    // RFC822.SIZE (or one without a size) from one that fits.
    const one = await client.fetchOne(
      String(item.uid),
      { uid: true, source: { maxLength: maxBytes + 1 } },
      { uid: true },
    );
    // Expunged since the search: nothing to offer.
    if (!one || !one.source) return null;
    if (one.source.length > maxBytes)
      return fromHeaders(one.source, { oversize: true });
    try {
      return await parseInbound(one.source, ctx);
    } catch {
      log(this.inboxId, "imap parse failed, keeping headers", {
        uid: item.uid,
      });
      return fromHeaders(one.source, { unreadable: true });
    }
  }

  private fail(gen: number, err: unknown): void {
    if (gen !== this.generation || this.stopped) return;
    this.generation++;
    if (this.pollTimer) this.timers.clearTimeout(this.pollTimer);
    this.pollTimer = null;
    const client = this.client;
    this.client = null;
    this.cursor = null;
    this.knownUidNext = null;
    this.catchUp = null;
    client?.close();

    const now = this.timers.now();
    if (this.connectedAt !== null && now - this.connectedAt >= LIVE_RESET_MS)
      this.attempt = 0;
    this.connectedAt = null;

    const failure = this.failureOf(err);
    const reason = this.alertText
      ? `${failure.reason}. The server said: ${this.alertText}`
      : failure.reason;
    if (failure.kind === "auth" || failure.kind === "address") {
      log(this.inboxId, "imap paused", {
        kind: failure.kind,
        ...imapErrorDetail(err),
      });
      this.setHealth("paused", reason, null);
      return;
    }
    const delay = nextBackoffMs(
      this.attempt,
      this.random,
      failure.retryAfterMs,
    );
    this.attempt++;
    log(this.inboxId, "imap backing off", {
      kind: failure.kind,
      delayMs: delay,
      ...imapErrorDetail(err),
    });
    this.setHealth(
      failure.kind === "alert" ? "paused" : "backing-off",
      reason,
      this.iso(now + delay),
    );
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }

  private failureOf(err: unknown): Failure {
    if (err instanceof SinkFailure)
      return { kind: "protocol", reason: SINK_FAILED };
    if (err instanceof CursorFailure)
      return { kind: "protocol", reason: CURSOR_FAILED };
    const classified = classifyImapError(err);
    return {
      kind: classified.kind,
      reason: classified.message,
      ...(classified.retryAfterMs !== undefined
        ? { retryAfterMs: classified.retryAfterMs }
        : {}),
    };
  }
}

/** One login for the inbox form's Test button. Never returns the password. */
export async function testImapLogin(
  server: Omit<MailServerConfig, "passwordRef">,
  password: string,
  policy: MailHostPolicy,
): Promise<
  | { ok: true; idle: boolean; condstore: boolean; sentFolder: string | null }
  | { ok: false; kind: PauseKind; error: string }
> {
  let options: ImapFlowOptions;
  try {
    const target = await resolveMailHost(server.host, {
      ...policy,
      tls: server.tls,
    });
    options = imapClientOptions(target, server, password);
  } catch (err) {
    const { kind, message } = classifyImapError(err);
    return { ok: false, kind, error: message };
  }
  const client = new ImapFlow(options);
  client.on("error", () => undefined);
  try {
    await client.connect();
    const idle = client.capabilities.has("IDLE");
    const condstore = client.capabilities.has("CONDSTORE");
    // Proves the mailbox the transport reads opens; read-only, so the test
    // changes nothing.
    await client.mailboxOpen("INBOX", { readOnly: true });
    const folders = await client.list();
    const sent = folders.find((f) => f.specialUse === "\\Sent");
    try {
      await client.logout();
    } catch {
      // The answer is known already.
    }
    return { ok: true, idle, condstore, sentFolder: sent?.path ?? null };
  } catch (err) {
    const { kind, message } = classifyImapError(err);
    return { ok: false, kind, error: message };
  } finally {
    client.close();
  }
}
