// Inbound mail for one inbox: one IMAP connection, IDLE for push (a NOOP
// poll every pollMs when the server has no IDLE), and a UID cursor so only
// new mail is fetched, never a full scan. The cursor moves past a message
// only after the sink resolved, so a crash re-offers it (ingest dedupes).
// A first connect, or a UIDVALIDITY change, starts at UIDNEXT and imports
// nothing. Lost connections back off with full jitter; an auth failure
// pauses the inbox until someone saves or tests it again.
// Logs carry the inbox id, a kind and UIDs only: never the password, the
// addresses or any message content. Nothing runs at import.

import { ImapFlow, type ImapFlowOptions } from "imapflow";
import {
  IMAP_POLL_MS,
  type InboxConfig,
  type InboxHealth,
  type InboxHealthState,
  MAX_SOURCE_BYTES,
  type MailServerConfig,
} from "../../shared/support";
import type { InboundSink } from "../../server/support/channel";
import {
  PAUSE_COPY,
  type PauseKind,
  classifyImapError,
  nextBackoffMs,
} from "./backoff";
import { parseInbound } from "./parse";

export interface ImapCursor {
  uidValidity: string;
  lastUid: number;
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

const SINK_FAILED = "Couldn't store a new message. Retrying later";

/** The sink refused a message: not the server's fault. */
class SinkFailure extends Error {
  constructor(readonly uid: number) {
    super("sink failed");
  }
}

type Failure = { kind: PauseKind; reason: string; retryAfterMs?: number };

function clientOptions(
  server: Omit<MailServerConfig, "passwordRef">,
  password: string,
): ImapFlowOptions {
  return {
    host: server.host,
    port: server.port,
    secure: server.secure,
    auth: { user: server.user, pass: password },
    logger: false,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
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
  private cursor: ImapCursor | null = null;
  private catchUpRunning = false;
  private catchUpQueued = false;
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
    await this.connect();
  }

  /** Logs out and clears timers; no reconnect afterwards. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.generation++;
    this.clearTimers();
    const client = this.client;
    this.client = null;
    this.connectedAt = null;
    if (client) {
      try {
        await client.logout();
      } catch {
        // Closing anyway.
      }
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

  private clearTimers(): void {
    if (this.retryTimer) this.timers.clearTimeout(this.retryTimer);
    if (this.pollTimer) this.timers.clearTimeout(this.pollTimer);
    this.retryTimer = null;
    this.pollTimer = null;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const gen = ++this.generation;
    this.setHealth("connecting");
    const client = new ImapFlow({
      ...clientOptions(this.opts.inbox.imap, this.opts.password),
      maxIdleTime: MAX_IDLE_MS,
      ...(this.opts.autoIdleDelayMs !== undefined
        ? { autoIdleDelay: this.opts.autoIdleDelayMs }
        : {}),
    });
    this.client = client;
    let lastError: unknown = null;
    client.on("error", (err: unknown) => {
      lastError = err;
    });
    client.on("exists", () => this.scheduleCatchUp(gen));
    client.on("alert", () =>
      this.fail(gen, null, { kind: "alert", reason: PAUSE_COPY.alert }),
    );

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

      const mailbox = await client.mailboxOpen("INBOX");
      if (gen !== this.generation) return;
      const uidValidity = String(mailbox.uidValidity);
      let cursor = await this.opts.loadCursor();
      if (!cursor || cursor.uidValidity !== uidValidity) {
        const lastUid = await this.highestUid(client, mailbox.uidNext);
        cursor = { uidValidity, lastUid };
        await this.opts.saveCursor(cursor);
        log(this.inboxId, "imap cursor reset", { uidValidity, lastUid });
      }
      if (gen !== this.generation) return;
      this.cursor = cursor;
      this.connectedAt = this.timers.now();
      this.setHealth(idle ? "live" : "polling");
      await this.runCatchUp(gen);
      if (!idle && gen === this.generation) this.schedulePoll(gen);
    } catch (err) {
      this.fail(gen, err);
    }
  }

  private async highestUid(
    client: ImapFlow,
    uidNext: number | undefined,
  ): Promise<number> {
    if (typeof uidNext === "number" && uidNext > 0) return uidNext - 1;
    const uids = (await client.search({ all: true }, { uid: true })) || [];
    return uids.reduce((max, uid) => Math.max(max, uid), 0);
  }

  private schedulePoll(gen: number): void {
    const pollMs = this.opts.pollMs ?? IMAP_POLL_MS;
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
    }, pollMs);
  }

  private scheduleCatchUp(gen: number): void {
    if (gen !== this.generation || !this.cursor) return;
    this.runCatchUp(gen).catch((err) => this.fail(gen, err));
  }

  /** One catch-up at a time; an `exists` during one queues another. */
  private async runCatchUp(gen: number): Promise<void> {
    if (this.catchUpRunning) {
      this.catchUpQueued = true;
      return;
    }
    this.catchUpRunning = true;
    try {
      do {
        this.catchUpQueued = false;
        await this.exclusive(() => this.catchUpOnce(gen));
      } while (this.catchUpQueued && gen === this.generation);
    } finally {
      this.catchUpRunning = false;
    }
  }

  private async catchUpOnce(gen: number): Promise<void> {
    const client = this.client;
    const start = this.cursor;
    if (gen !== this.generation || !client || !start) return;
    const found =
      (await client.search({ uid: `${start.lastUid + 1}:*` }, { uid: true })) ||
      [];
    // `n:*` always matches the highest UID, even below n.
    const uids = found
      .filter((uid) => uid > start.lastUid)
      .sort((a, b) => a - b);
    const maxBytes = this.opts.maxSourceBytes ?? MAX_SOURCE_BYTES;

    for (let i = 0; i < uids.length; i += PAGE_SIZE) {
      const page: Array<{
        uid: number;
        size: number;
        internalDate?: Date | string;
      }> = [];
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
          start.uidValidity,
          item,
          maxBytes,
        );
        if (gen !== this.generation) return;
        if (message) {
          try {
            await this.opts.sink(message);
          } catch {
            log(this.inboxId, "imap sink failed", { uid: item.uid });
            throw new SinkFailure(item.uid);
          }
        }
        const next = { uidValidity: start.uidValidity, lastUid: item.uid };
        await this.opts.saveCursor(next);
        this.cursor = next;
        if (message) {
          this.current = { ...this.current, lastMessageAt: this.iso() };
          this.opts.onHealth(this.health());
        }
      }
    }
  }

  private async fetchMessage(
    client: ImapFlow,
    uidValidity: string,
    item: { uid: number; size: number; internalDate?: Date | string },
    maxBytes: number,
  ) {
    const internal = item.internalDate ? new Date(item.internalDate) : null;
    const ctx = {
      inboxId: this.inboxId,
      providerId: `imap:${uidValidity}:${item.uid}`,
      receivedAt:
        internal && !Number.isNaN(internal.getTime())
          ? internal.toISOString()
          : this.iso(),
    };
    const headersOnly = async () => {
      const one = await client.fetchOne(
        String(item.uid),
        { uid: true, headers: true },
        { uid: true },
      );
      if (!one || !one.headers) return null;
      return parseInbound(one.headers, { ...ctx, oversize: true });
    };

    if (item.size > maxBytes) return headersOnly();
    const one = await client.fetchOne(
      String(item.uid),
      { uid: true, source: true },
      { uid: true },
    );
    // Expunged since the search: nothing to offer.
    if (!one || !one.source) return null;
    try {
      return await parseInbound(one.source, ctx);
    } catch {
      log(this.inboxId, "imap parse failed, keeping headers", {
        uid: item.uid,
      });
      try {
        return await headersOnly();
      } catch {
        log(this.inboxId, "imap message skipped", { uid: item.uid });
        return null;
      }
    }
  }

  private fail(gen: number, err: unknown, known?: Failure): void {
    if (gen !== this.generation || this.stopped) return;
    this.generation++;
    if (this.pollTimer) this.timers.clearTimeout(this.pollTimer);
    this.pollTimer = null;
    const client = this.client;
    this.client = null;
    client?.close();

    const now = this.timers.now();
    if (this.connectedAt !== null && now - this.connectedAt >= LIVE_RESET_MS)
      this.attempt = 0;
    this.connectedAt = null;

    const failure = known ?? this.failureOf(err);
    if (failure.kind === "auth") {
      log(this.inboxId, "imap paused", { kind: failure.kind });
      this.setHealth("paused", failure.reason, null);
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
    });
    this.setHealth(
      failure.kind === "alert" ? "paused" : "backing-off",
      failure.reason,
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
): Promise<
  | { ok: true; idle: boolean; condstore: boolean; sentFolder: string | null }
  | { ok: false; kind: PauseKind; error: string }
> {
  const client = new ImapFlow(clientOptions(server, password));
  client.on("error", () => undefined);
  try {
    await client.connect();
    const idle = client.capabilities.has("IDLE");
    const condstore = client.capabilities.has("CONDSTORE");
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
