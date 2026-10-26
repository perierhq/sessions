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
import { type JobHandle, startJob } from "./jobs";
import { type MailRecord, pairThreads, type QaPair } from "./pairs";
import { mailTrust } from "./trust";

export interface MailboxDeps {
  now(): number;
  /** The small model for extractPair (default classifyRoute). */
  classify: typeof classifyRoute;
  repoChanges: Partial<RepoChangeDeps>;
  github: GithubReadOptions;
  /** The project's Support websites: links there survive the strip. */
  supportHosts(project: string): Promise<string[]>;
  maxSourceBytes: number;
}

/** Items per commit. */
export const BATCH_SIZE = 50;
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

async function defaultSupportHosts(project: string): Promise<string[]> {
  try {
    const { roleWebAccess } = await import("../../projects/effective");
    return (await roleWebAccess(project, "support")).websites;
  } catch {
    // Without the list every link is removed: stricter, never looser.
    return [];
  }
}

function bind(over: Partial<MailboxDeps>): MailboxDeps {
  return {
    now: over.now ?? Date.now,
    classify: over.classify as typeof classifyRoute,
    repoChanges: over.repoChanges ?? {},
    github: over.github ?? {},
    supportHosts: over.supportHosts ?? defaultSupportHosts,
    maxSourceBytes: over.maxSourceBytes ?? MAX_SOURCE_BYTES,
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

/** The window's mail of INBOX and the Sent folder, read-only. */
async function readMailbox(
  inbox: InboxConfig,
  password: string,
  since: number,
  deps: MailboxDeps,
): Promise<MailRecord[]> {
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
  const records: MailRecord[] = [];
  try {
    await client.connect();
    const folders = await client.list();
    const sent = folders.find((f) => f.specialUse === "\\Sent")?.path;
    // Without a Sent folder nothing is provably ours: no answers.
    if (!sent || sent.toUpperCase() === "INBOX") return [];
    // Sent first: a message in both folders counts as our copy.
    const folderList: Array<[string, "sent" | "inbox"]> = [
      [sent, "sent"],
      ["INBOX", "inbox"],
    ];
    for (const [path, folder] of folderList) {
      const mailbox = await client.mailboxOpen(path, { readOnly: true });
      const found = await client.search(
        { since: new Date(since) },
        { uid: true },
      );
      const uids = (found || []).sort((a, b) => a - b);
      for (let i = 0; i < uids.length; i += PAGE_SIZE) {
        const page: Array<{ uid: number; size: number; at: Date | null }> = [];
        for await (const item of client.fetch(
          uids.slice(i, i + PAGE_SIZE).join(","),
          { uid: true, size: true, internalDate: true },
          { uid: true },
        )) {
          const at = item.internalDate ? new Date(item.internalDate) : null;
          page.push({
            uid: item.uid,
            size: item.size ?? 0,
            at: at && Number.isFinite(at.getTime()) ? at : null,
          });
        }
        for (const item of page) {
          // The SINCE search is by day; the window is exact.
          if (!item.at || item.at.getTime() < since) continue;
          if (item.size > deps.maxSourceBytes) continue;
          const one = await client.fetchOne(
            String(item.uid),
            { uid: true, source: { maxLength: deps.maxSourceBytes + 1 } },
            { uid: true },
          );
          if (!one || !one.source || one.source.length > deps.maxSourceBytes)
            continue;
          let message: InboundMessage;
          try {
            message = await parseInbound(one.source, {
              inboxId: inbox.id,
              providerId: `imap:${mailbox.uidValidity}:${item.uid}`,
              receivedAt: item.at.toISOString(),
            });
          } catch {
            continue;
          }
          const record = toRecord(message, folder, addresses);
          if (record) records.push(record);
        }
      }
    }
  } catch (error) {
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
  return records;
}

// ── Writing items ───────────────────────────────────────────────────────

interface Planned {
  path: string;
  change: KnowledgeChange & { op: "put" };
  trusted: boolean;
}

/** The code repository paths the project's mirror items stand for. */
async function mirroredPaths(project: string, today: string) {
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
async function plan(
  project: string,
  pair: QaPair,
  path: string,
  ctx: { hosts: string[]; docPaths: string[]; deps: MailboxDeps },
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
): Promise<{ trusted: number; reference: number; dropped: number }> {
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
      return { trusted, reference: items.length - trusted, dropped };
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
  return { trusted: 0, reference: 0, dropped };
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

  const records = await readMailbox(input.inbox, input.password, since, deps);
  const pairs = pairThreads(records).sort((a, b) =>
    a.answer.at < b.answer.at ? -1 : a.answer.at > b.answer.at ? 1 : 0,
  );
  await job.setTotal(pairs.length);
  if (!pairs.length) return;

  await knowledgeRepo.call("ensureRepo", project);
  // The trust rule reads the default branch as last fetched; a failed
  // fetch leaves that (older) state, which can only make more reference.
  await fetchDefaultBranch(project, deps.repoChanges).catch(() => false);
  const [hosts, docPaths] = await Promise.all([
    deps.supportHosts(project),
    mirroredPaths(project, today),
  ]);

  let batch: Planned[] = [];
  const flush = async () => {
    if (!batch.length) return;
    const written = await commitBatch(project, batch, today);
    await job.progress({
      trusted: written.trusted,
      reference: written.reference,
      skipped: written.dropped,
      done: batch.length,
    });
    batch = [];
  };
  for (const pair of pairs) {
    const path = mailItemPath(pair.answer.messageId, pair.answer.at);
    const planned = (await exists(project, path, today))
      ? null
      : await plan(project, pair, path, { hosts, docPaths, deps });
    if (!planned) {
      await job.progress({ skipped: 1, done: 1 });
      continue;
    }
    batch.push(planned);
    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();
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
  const deps = bind(over);
  return startJob(
    project,
    "mailbox",
    { inboxId, months, by: input.by.name },
    (job) => backfill(job, { project, inbox, password, months }, deps),
  );
}
