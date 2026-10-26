/**
 * The mailbox backfill: an inbox's history of answered questions as
 * knowledge items under `sources/mail/`.
 *
 * Reads `INBOX` and the `\Sent` special-use folder over their own,
 * read-only IMAP connection (EXAMINE: no flag changes), for the mail of the
 * last `months` months (the folders' internal dates). The inbox's live
 * connection, its cursor and its conversations are never touched; no
 * support conversation is created. Automated mail (ours or theirs) is left
 * out. Only Sent-folder mail from this inbox's own addresses is ours;
 * mail in INBOX from any of our addresses is a loop or a spoof and is
 * dropped, and without a Sent folder there are no answers. Threads become pairs (pairs.ts); each pair is stripped and rewritten
 * (extract.ts, a pair it can't prove clean is skipped) and gets its trust
 * from the time-aware rule (trust.ts): an answer written before the latest
 * relevant change is reference, with the reason as the body's first line.
 * A reply whose Date header and arrival are more than a day apart, and
 * every answer of a run whose default-branch fetch failed, is reference.
 * Envelopes are read first and full sources only for paired messages; a
 * run looks at most MAX_SCANNED messages and imports at most MAX_PAIRS
 * pairs (newest kept, the job marked `truncated`), fails past DEADLINE_MS
 * and stops when a person cancels it.
 * Items already there are skipped, so a re-run adds only what's new.
 * Commits go in batches of 50, authored by Pat.
 *
 * Reuses the email transport's host check and client options
 * (resolveMailHost, imapClientOptions), its parser (parseInbound) and the
 * support loop check (isAutomatedMail). Logs never carry mail content or
 * addresses. Nothing runs at import.
 */
import { ImapFlow } from "imapflow";
import { classifyImapError } from "../../../agents/email/backoff";
import { imapClientOptions } from "../../../agents/email/imap-transport";
import { parseInbound } from "../../../agents/email/parse";
import type { Author } from "../../memory-repo/git-store";
import { MemoryRepoError } from "../../memory-repo/git-store";
import type { classifyRoute } from "../../route-classifier";
import {
  type KnowledgeFrontMatter,
  type KnowledgeImportJob,
  MAX_BACKFILL_MONTHS,
} from "../../../shared/knowledge";
import {
  type InboundMessage,
  type InboxConfig,
  MAX_SOURCE_BYTES,
  ownMailAddresses,
} from "../../../shared/support";
import { getInbox, inboxPassword, listInboxes } from "../../support/inboxes";
import { isAutomatedMail } from "../../support/loops";
import { resolveMailHost } from "../../support/mail-host";
import { knowledgeRepo } from "../client";
import type { KnowledgeChange } from "../service";
import { latestRelease, type GithubReadOptions } from "../freshness/github";
import {
  commitAt,
  fetchDefaultBranch,
  latestChange,
  type RepoChangeDeps,
} from "../freshness/repo-changes";
import { PAT_AUTHOR, PAT_TRAILER } from "../freshness/revalidate";
import { knowledgeRepoName, mailItemPath } from "../layout";
import { extractPair } from "./extract";
import { CANCELLED_COPY, type JobHandle, startJob } from "./jobs";
import { type MailRecord, pairThreads, type QaPair } from "./pairs";
import { HISTORY_UNREADABLE, mailTrust } from "./trust";

export interface MailboxDeps {
  now(): number;
  /** The small model for extractPair (default classifyRoute). */
  classify: typeof classifyRoute;
  repoChanges: Partial<RepoChangeDeps>;
  github: GithubReadOptions;
  /** The project's Support websites: links there survive the strip. */
  supportHosts(project: string): Promise<string[]>;
  maxSourceBytes: number;
  /** Most messages looked at per run, newest kept (MAX_SCANNED). */
  maxScanned: number;
  /** Most pairs imported per run, newest kept (MAX_PAIRS). */
  maxPairs: number;
  /** How long a run may take before it fails (DEADLINE_MS). */
  deadlineMs: number;
}

/** Items per commit. */
export const BATCH_SIZE = 50;
export const MAX_SCANNED = 20_000;
export const MAX_PAIRS = 500;
export const DEADLINE_MS = 30 * 60 * 1000;
export const DEADLINE_COPY =
  "The import took too long and stopped. Start it again to continue.";
export const DATES_DISAGREE =
  "The reply's Date header and arrival time are more than a day apart";
const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 50;
const LIST_PAGE = 200;
const WRITE_ATTEMPTS = 3;

const INBOX_NOT_FOUND = "This inbox isn't one of the project's.";
const NO_PASSWORD = "The inbox has no IMAP password. Save it again first.";

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** `now` moved back `months` calendar months (UTC). */
function windowStart(now: number, months: number): number {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.getTime();
}

/** The project's Support websites; none when they can't be read. */
export async function projectSupportHosts(project: string): Promise<string[]> {
  try {
    const { roleWebAccess } = await import("../../projects/effective");
    return (await roleWebAccess(project, "support")).websites;
  } catch {
    // Without the list every link is removed: stricter, never looser.
    return [];
  }
}

export function bindMailboxDeps(over: Partial<MailboxDeps>): MailboxDeps {
  return {
    now: over.now ?? Date.now,
    classify: over.classify as typeof classifyRoute,
    repoChanges: over.repoChanges ?? {},
    github: over.github ?? {},
    supportHosts: over.supportHosts ?? projectSupportHosts,
    maxSourceBytes: over.maxSourceBytes ?? MAX_SOURCE_BYTES,
    maxScanned: over.maxScanned ?? MAX_SCANNED,
    maxPairs: over.maxPairs ?? MAX_PAIRS,
    deadlineMs: over.deadlineMs ?? DEADLINE_MS,
  };
}

// ── Reading the mailbox ─────────────────────────────────────────────────

/**
 * A message as a pairing record; null when it is left out. Only mail in
 * the Sent folder from one of this inbox's own addresses is ours. Mail in
 * INBOX from any of our addresses (this inbox's or another's) is a loop
 * or a spoof and never a question; a Sent message from another address
 * is neither.
 */
function toRecord(
  m: InboundMessage,
  folder: "sent" | "inbox",
  addresses: { inbox: string; ours: string[]; all: string[] },
): MailRecord | null {
  const messageId = m.keys.messageId;
  const text = m.text.trim();
  if (!messageId || !text || m.oversize || m.unreadable) return null;
  const address = m.from.address.trim().toLowerCase();
  if (!address) return null;
  const ours = folder === "sent";
  if (ours) {
    if (!addresses.ours.includes(address)) return null;
    // Header checks only: our own address would count as automated, and
    // an automatic reply is no person's answer.
    if (isAutomatedMail(m, [], "").automated) return null;
  } else if (isAutomatedMail(m, addresses.all, addresses.inbox).automated)
    return null;
  return {
    messageId,
    inReplyTo: m.keys.inReplyTo,
    references: m.keys.references,
    from: { ...(m.from.name ? { name: m.from.name } : {}), address },
    at: m.receivedAt,
    text,
    ours,
  };
}

/** Stops a run: cancelled, or past its deadline. Never wrapped. */
class StopRun extends Error {}

/** A run's cancel and deadline check, called between steps. */
type Step = () => void;

function stepper(signal: AbortSignal, deadlineMs: number): Step {
  const end = performance.now() + deadlineMs;
  return () => {
    if (signal.aborted) throw new StopRun(CANCELLED_COPY);
    if (performance.now() >= end) throw new StopRun(DEADLINE_COPY);
  };
}

type Folder = "sent" | "inbox";

/** What the first pass knows of a message (envelope and References). */
interface Seen {
  path: string;
  folder: Folder;
  uid: number;
  record: MailRecord;
}

function addressOf(
  list: Array<{ address?: string }> | undefined,
): string | null {
  const address = list?.[0]?.address?.trim().toLowerCase();
  return address || null;
}

const MESSAGE_ID = /<[^<>\s]+>/g;

/**
 * The window's question/answer pairs of INBOX and the Sent folder,
 * read-only, in two passes: envelopes and References first (at most
 * `maxScanned` messages, newest kept), then the full source only of the
 * messages of the newest `maxPairs` pairs. A message's time is the earlier
 * of its arrival and its Date header; a reply whose two are more than a
 * day apart is marked (`dateMismatch`). No Sent folder: no pairs.
 */
async function readPairs(
  inbox: InboxConfig,
  password: string,
  since: number,
  deps: MailboxDeps,
  step: Step,
): Promise<{ pairs: QaPair[]; truncated: boolean }> {
  const others = (await listInboxes())
    .filter((i) => i.id !== inbox.id)
    .map((i) => i.address);
  const addresses = {
    inbox: inbox.address,
    ours: ownMailAddresses(inbox),
    all: ownMailAddresses(inbox, others),
  };
  let client: ImapFlow;
  try {
    const target = await resolveMailHost(inbox.imap.host, {
      allowInternalHost: inbox.allowInternalHost,
      tls: inbox.imap.tls,
    });
    client = new ImapFlow(imapClientOptions(target, inbox.imap, password));
  } catch (error) {
    throw new Error(
      `Couldn't reach the mail server: ${classifyImapError(error).message}`,
    );
  }
  client.on("error", () => undefined);
  let truncated = false;
  try {
    await client.connect();
    const folders = await client.list();
    const sent = folders.find((f) => f.specialUse === "\\Sent")?.path;
    // Without a Sent folder nothing is provably ours: no answers.
    if (!sent || sent.toUpperCase() === "INBOX")
      return { pairs: [], truncated };
    // Sent first: a message in both folders counts as our copy.
    const folderList: Array<[string, Folder]> = [
      [sent, "sent"],
      ["INBOX", "inbox"],
    ];

    // Pass 1: envelopes.
    const seen = new Map<MailRecord, Seen>();
    let scanned = 0;
    for (const [path, folder] of folderList) {
      step();
      await client.mailboxOpen(path, { readOnly: true });
      const found = await client.search(
        { since: new Date(since) },
        { uid: true },
      );
      let uids = (found || []).sort((a, b) => a - b);
      const budget = Math.max(0, deps.maxScanned - scanned);
      if (uids.length > budget) {
        uids = budget ? uids.slice(-budget) : [];
        truncated = true;
      }
      scanned += uids.length;
      for (let i = 0; i < uids.length; i += PAGE_SIZE) {
        step();
        for await (const item of client.fetch(
          uids.slice(i, i + PAGE_SIZE).join(","),
          {
            uid: true,
            size: true,
            internalDate: true,
            envelope: true,
            headers: ["references"],
          },
          { uid: true },
        )) {
          const arrived = item.internalDate
            ? new Date(item.internalDate).getTime()
            : NaN;
          // The SINCE search is by day; the window is exact.
          if (!Number.isFinite(arrived) || arrived < since) continue;
          if ((item.size ?? 0) > deps.maxSourceBytes) continue;
          const env = item.envelope;
          const messageId = env?.messageId?.trim();
          const address = addressOf(env?.from);
          if (!messageId || !address) continue;
          // Ours only from the Sent folder and this inbox's addresses;
          // any of our addresses in INBOX is a loop or a spoof.
          if (folder === "sent" && !addresses.ours.includes(address)) continue;
          if (folder === "inbox" && addresses.all.includes(address)) continue;
          const dated = env?.date ? new Date(env.date).getTime() : NaN;
          const at = Number.isFinite(dated)
            ? Math.min(arrived, dated)
            : arrived;
          const references =
            (item.headers?.toString("utf8") ?? "")
              .replace(/^references:/i, "")
              .match(MESSAGE_ID) ?? [];
          const record: MailRecord = {
            messageId,
            inReplyTo: env?.inReplyTo?.trim() || null,
            references,
            from: { address },
            at: new Date(at).toISOString(),
            text: "",
            ours: folder === "sent",
            ...(Number.isFinite(dated) && Math.abs(arrived - dated) > DAY_MS
              ? { dateMismatch: true }
              : {}),
          };
          seen.set(record, { path, folder, uid: item.uid, record });
        }
      }
    }

    let pairs = pairThreads([...seen.keys()]).sort((a, b) =>
      a.answer.at < b.answer.at ? -1 : a.answer.at > b.answer.at ? 1 : 0,
    );
    if (pairs.length > deps.maxPairs) {
      pairs = deps.maxPairs ? pairs.slice(-deps.maxPairs) : [];
      truncated = true;
    }

    // Pass 2: the sources of the paired messages, folder by folder.
    const wanted = new Map<string, Seen[]>();
    for (const pair of pairs)
      for (const record of [pair.question, pair.answer]) {
        const at = seen.get(record)!;
        const list = wanted.get(at.path) ?? [];
        if (!list.includes(at)) list.push(at);
        wanted.set(at.path, list);
      }
    const full = new Map<MailRecord, MailRecord>();
    for (const [path, list] of wanted) {
      step();
      const mailbox = await client.mailboxOpen(path, { readOnly: true });
      for (const at of list) {
        step();
        // One byte past the cap: a source cut at maxLength is longer than
        // the cap and skipped, never parsed half.
        const one = await client.fetchOne(
          String(at.uid),
          { uid: true, source: { maxLength: deps.maxSourceBytes + 1 } },
          { uid: true },
        );
        if (!one || !one.source || one.source.length > deps.maxSourceBytes)
          continue;
        let message: InboundMessage;
        try {
          message = await parseInbound(one.source, {
            inboxId: inbox.id,
            providerId: `imap:${mailbox.uidValidity}:${at.uid}`,
            receivedAt: at.record.at,
          });
        } catch {
          continue;
        }
        const record = toRecord(message, at.folder, addresses);
        if (!record) continue;
        full.set(at.record, {
          ...record,
          at: at.record.at,
          ...(at.record.dateMismatch ? { dateMismatch: true } : {}),
        });
      }
    }
    // A pair whose question or answer didn't survive the full checks
    // (automated, unreadable) is left out, not re-paired.
    const kept: QaPair[] = [];
    for (const pair of pairs) {
      const question = full.get(pair.question);
      const answer = full.get(pair.answer);
      if (question && answer) kept.push({ question, answer });
    }
    return { pairs: kept, truncated };
  } catch (error) {
    if (error instanceof StopRun) throw error;
    throw new Error(
      `Couldn't read the mailbox: ${classifyImapError(error).message}`,
    );
  } finally {
    try {
      await client.logout();
    } catch {
      // Closing anyway.
    }
    client.close();
  }
}

// ── Writing items ───────────────────────────────────────────────────────

export interface Planned {
  path: string;
  change: KnowledgeChange & { op: "put" };
  trusted: boolean;
}

/** The code repository paths the project's mirror items stand for. */
export async function mirroredPaths(project: string, today: string) {
  const paths = new Set<string>();
  for (let offset = 0; ; offset += LIST_PAGE) {
    const page = await knowledgeRepo.call("index.list", project, "all", {
      today,
      limit: LIST_PAGE,
      offset,
    });
    for (const item of page.items) {
      if (item.origin !== "repo") continue;
      for (const source of item.sources) {
        if (!source.startsWith("repo:")) continue;
        const value = source.slice("repo:".length);
        const at = value.lastIndexOf("@");
        paths.add(
          at > 0 && !value.slice(at).includes("/") ? value.slice(0, at) : value,
        );
      }
    }
    if (page.items.length < LIST_PAGE || offset + LIST_PAGE >= page.total)
      return [...paths].sort();
  }
}

async function exists(project: string, path: string, today: string) {
  return (await knowledgeRepo.call("index.get", project, path, today)) !== null;
}

function body(
  question: string,
  answer: string,
  referenceReason: string | null,
): string {
  const note = referenceReason
    ? `> Imported as reference: ${referenceReason}\n\n`
    : "";
  return `${note}## Question\n\n${question}\n\n## Answer\n\n${answer}\n`;
}

/** The pair as an item; null when it must be skipped. */
export async function planMailItem(
  project: string,
  pair: QaPair,
  path: string,
  ctx: {
    hosts: string[];
    docPaths: string[];
    deps: MailboxDeps;
    /** False when the default branch couldn't be fetched. */
    historyRead: boolean;
  },
): Promise<Planned | null> {
  const { question, answer } = pair;
  const extracted = await extractPair(
    {
      question: question.text,
      answer: answer.text,
      customer: question.from,
      answeredAt: answer.at,
      supportHosts: ctx.hosts,
      docPaths: ctx.docPaths,
    },
    ctx.deps.classify ? { classify: ctx.deps.classify } : {},
  );
  if (!extracted) return null;
  const { repoChanges, github } = ctx.deps;
  let decision;
  try {
    decision = await mailTrust(
      { answeredAt: answer.at, touchedPaths: extracted.touchedPaths },
      {
        latestRelease: () => latestRelease(project, github),
        latestChange: (paths) => latestChange(project, paths, repoChanges),
        commitAt: (at) => commitAt(project, at, repoChanges),
      },
    );
  } catch {
    // Not a date the rule can place: skipped, not guessed.
    return null;
  }
  // What the trust rule can't see makes the answer reference: history
  // that couldn't be fetched, or a reply whose own dates disagree.
  const forced = !ctx.historyRead
    ? HISTORY_UNREADABLE
    : answer.dateMismatch
      ? DATES_DISAGREE
      : null;
  if (forced)
    decision = {
      ...decision,
      trust: "reference" as const,
      reason: forced,
      validAsOfCommit: undefined,
    };
  const fm: KnowledgeFrontMatter = {
    title: extracted.title,
    kind: "answer",
    trust: decision.trust,
    status: "active",
    origin: "mail",
    topics: extracted.topics,
    sources: [`mail:${answer.messageId}`],
    dependsOn: decision.dependsOn,
    validAsOf: decision.validAsOf,
    ...(decision.validAsOfCommit
      ? { validAsOfCommit: decision.validAsOfCommit }
      : {}),
    answeredAt: answer.at,
  };
  const reason = decision.trust === "reference" ? decision.reason : null;
  return {
    path,
    change: {
      op: "put",
      path,
      fm,
      body: body(extracted.question, extracted.answer, reason ?? null),
    },
    trusted: decision.trust === "trusted",
  };
}

/** Commit one batch; items someone wrote meanwhile are dropped and the
 *  rest tried again. Returns how many were written and how many dropped. */
async function commitBatch(
  project: string,
  batch: Planned[],
  today: string,
): Promise<{
  trusted: number;
  reference: number;
  dropped: number;
  paths: string[];
}> {
  let items = batch;
  let dropped = 0;
  for (let attempt = 1; items.length; attempt++) {
    const trusted = items.filter((i) => i.trusted).length;
    try {
      await knowledgeRepo.call(
        "write",
        project,
        items.map((i) => i.change),
        {
          message: `Import mail: ${items.length} answers (${trusted} trusted)`,
          author: PAT_AUTHOR,
          trailers: [PAT_TRAILER],
          expected: Object.fromEntries(items.map((i) => [i.path, null])),
        },
      );
      return {
        trusted,
        reference: items.length - trusted,
        dropped,
        paths: items.map((i) => i.path),
      };
    } catch (error) {
      const conflict =
        error instanceof Error && error.name === "KnowledgeConflictError";
      if (!conflict || attempt >= WRITE_ATTEMPTS) throw error;
      const left: Planned[] = [];
      for (const item of items)
        if (await exists(project, item.path, today)) dropped++;
        else left.push(item);
      items = left;
    }
  }
  return { trusted: 0, reference: 0, dropped, paths: [] };
}

async function backfill(
  job: JobHandle,
  input: {
    project: string;
    inbox: InboxConfig;
    password: string;
    months: number;
  },
  deps: MailboxDeps,
): Promise<void> {
  const { project } = input;
  const now = deps.now();
  const today = utcDay(now);
  const since = windowStart(now, input.months);

  const step = stepper(job.signal, deps.deadlineMs);
  step();
  const read = await readPairs(input.inbox, input.password, since, deps, step);
  if (read.truncated) await job.markTruncated();
  const pairs = read.pairs;
  await job.setTotal(pairs.length);
  if (!pairs.length) return;

  step();
  await knowledgeRepo.call("ensureRepo", project);
  // The trust rule reads the default branch as last fetched; when the
  // fetch fails every answer is reference ("History couldn't be read").
  const historyRead = await fetchDefaultBranch(project, deps.repoChanges).catch(
    () => false,
  );
  const [hosts, docPaths] = await Promise.all([
    deps.supportHosts(project),
    mirroredPaths(project, today),
  ]);

  let batch: Planned[] = [];
  const imported: string[] = [];
  const flush = async () => {
    if (!batch.length) return;
    const written = await commitBatch(project, batch, today);
    imported.push(...written.paths);
    await job.progress({
      trusted: written.trusted,
      reference: written.reference,
      skipped: written.dropped,
      done: batch.length,
    });
    batch = [];
  };
  for (const pair of pairs) {
    step();
    const path = mailItemPath(pair.answer.messageId, pair.answer.at);
    const planned = (await exists(project, path, today))
      ? null
      : await planMailItem(project, pair, path, {
          hosts,
          docPaths,
          deps,
          historyRead,
        });
    if (!planned) {
      await job.progress({ skipped: 1, done: 1 });
      continue;
    }
    batch.push(planned);
    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();

  // Questions answered by hand in more than one thread: suggestions
  // (capture.ts). The import stands when this fails.
  step();
  try {
    const { suggestRepeats } = await import("./capture");
    const made = await suggestRepeats(project, imported, {
      now: deps.now,
      ...(deps.classify ? { classify: deps.classify } : {}),
      repoChanges: deps.repoChanges,
      github: deps.github,
      supportHosts: deps.supportHosts,
    });
    if (made.created) await job.progress({ suggestions: made.created });
  } catch (error) {
    console.warn(
      "[knowledge] suggestions after the mailbox import failed:",
      error instanceof Error ? error.name : typeof error,
    );
  }
}

/**
 * Start a backfill of `inboxId`'s last `months` months into `project`'s
 * knowledge; resolves with the job (it runs in the background). Refuses
 * an inbox of another project (404), a window outside 1–36 months, an
 * inbox without its IMAP password, and a second mailbox import while one
 * runs (409).
 */
export async function startMailboxBackfill(
  input: { project: string; inboxId: string; months: number; by: Author },
  over: Partial<MailboxDeps> = {},
): Promise<KnowledgeImportJob> {
  const { project, inboxId, months } = input;
  try {
    knowledgeRepoName(project);
  } catch {
    throw new MemoryRepoError(`"${project}" isn't a project name.`);
  }
  if (!Number.isInteger(months) || months < 1 || months > MAX_BACKFILL_MONTHS)
    throw new MemoryRepoError(
      `Choose between 1 and ${MAX_BACKFILL_MONTHS} months.`,
    );
  const inbox = await getInbox(inboxId);
  if (!inbox || inbox.project !== project)
    throw new MemoryRepoError(INBOX_NOT_FOUND, 404);
  const password = await inboxPassword(inbox, "imap");
  if (!password) throw new MemoryRepoError(NO_PASSWORD);
  const deps = bindMailboxDeps(over);
  return startJob(
    project,
    "mailbox",
    { inboxId, months, by: input.by.name },
    (job) => backfill(job, { project, inbox, password, months }, deps),
  );
}
