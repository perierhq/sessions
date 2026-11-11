/**
 * The supervisor's merge cards: raised without holding up the conversation,
 * one at a time per session, in the order the owner asked.
 *
 * force_merge_pull_request in a supervisor session lands here instead of
 * waiting on the card (force-merge.ts). The tool answers as soon as the
 * card is in front of the owner, or queued behind the cards before it. How
 * each card ends (merged, cancelled, expired, refused) comes back later as
 * a session notice delivered into the conversation, so Blob can say it.
 *
 * The card itself is unchanged: the gateway writes it from the PR's live
 * state, only the owner can confirm it, and the merge runs with their own
 * GitHub token pinned to the head on the card.
 *
 * Several PRs merge in order. When a PR conflicts with its base (usually
 * because the one before it just merged), it is handed to the persona's
 * auto-fix loop (ask_pat auto_fix, which updates the branch and resolves
 * the conflicts), and its card comes back when that run finishes, saying
 * the new head carries the fix. The owner hears about the conflict once. A
 * PR that still conflicts after MAX_PAT_ROUNDS runs leaves the queue. Only
 * a real conflict goes to the persona: GitHub reporting the PR as
 * conflicting (mergeable CONFLICTING, merge state DIRTY). A branch rule or
 * a missing permission goes to the owner as a needs-you item instead.
 *
 * Same lifetime as the cards: in memory, so a restart drops the queue and
 * nothing is merged. What was queued is kept in the catalog
 * (supervisor-merge-queues) only so the owner hears, once after the
 * restart, which merges were dropped.
 */
import { randomUUID } from "node:crypto";
import { catalogDocuments } from "./catalog-documents";
import { personaName } from "./config";
import {
  ForceMergeError,
  formatForceMergeOutcome,
  openForceMerge,
  type ForceMergeOutcome,
  type ForceMergeRequest,
} from "./force-merge";
import type { MergeMethod } from "./pr-contract";
import type { PrReadinessTarget } from "./pr-merge-readiness";
import type { AskPatResult } from "./supervisor-ask-pat";
import type { PostSupervisorItemInput } from "./supervisor-inbox";

/** Updating a branch twice and still conflicting needs a person. */
export const MAX_PAT_ROUNDS = 2;

/** One session holds at most this many PRs of one repository. */
export const MAX_QUEUED_PER_REPO = 10;

/** Delivery ids of the outcome notices, for the receipts only. What keeps a
 *  notice in the conversation is the server-only `conversationNotice`
 *  delivery option; send_to_session refuses ids with this prefix. */
export const MERGE_CARD_DELIVERY_PREFIX = "merge-card:";

/** Where the queued PRs are kept for the restart notice. */
export const MERGE_QUEUE_NAMESPACE = "supervisor-merge-queues";

const MERGE_CARD_SOURCE = "merge-cards";

/** Kept in sync with SESSION_NOTICE_SENTINEL_RE in protocol notices.ts, so
 *  the notice never reads as words the owner typed. */
const SESSION_NOTICE = "<!--os:session-notice-->";

export interface MergeCardInput {
  target: PrReadinessTarget;
  reason: string;
  method?: MergeMethod;
  /** The only person who can confirm the card. */
  driver: { name: string; login: string };
  /** The session's owner, on whose behalf the persona is asked. */
  owner: string;
}

export interface MergeQueueDeps {
  open(
    sessionId: string,
    input: MergeCardInput,
  ): Promise<{
    request: ForceMergeRequest;
    outcome: Promise<ForceMergeOutcome>;
  }>;
  askPat(input: {
    owner: string;
    action: "auto_fix";
    repo: string;
    pr: number;
  }): Promise<AskPatResult>;
  /** Deliver a notice into the supervisor conversation. */
  tell(sessionId: string, text: string): Promise<void>;
  /** Whether GitHub reports the PR as conflicting with its base. */
  conflicts(target: PrReadinessTarget): Promise<boolean>;
  /** Post an item to the owner's supervisor inbox. */
  postItem(input: PostSupervisorItemInput): Promise<unknown>;
  /** Keep (or, with null, forget) a session's queued PRs for the restart
   *  notice. */
  save(sessionId: string, saved: SavedQueue | null): Promise<void>;
  /** Every session's saved queue, read once at boot. */
  saved(): Promise<Array<{ sessionId: string; saved: unknown }>>;
  persona(): string;
}

/** What the catalog keeps of a session's queue. */
export type SavedQueue = { owner: string; labels: string[] };

let documentsCache: ReturnType<typeof catalogDocuments> | undefined;
function documents() {
  return (documentsCache ??= catalogDocuments(MERGE_QUEUE_NAMESPACE));
}

const liveDeps: MergeQueueDeps = {
  open: (sessionId, input) =>
    openForceMerge(sessionId, {
      target: input.target,
      reason: input.reason,
      ...(input.method ? { method: input.method } : {}),
      driver: input.driver,
      requestedBy: "Blob",
    }),
  askPat: async (input) => (await import("./supervisor-ask-pat")).askPat(input),
  tell: async (sessionId, text) => {
    const { tryGetSessionControl } = await import("./session-control");
    await tryGetSessionControl()?.deliverToSession(
      sessionId,
      `${SESSION_NOTICE}\n${text}`,
      undefined,
      {
        deliveryId: `${MERGE_CARD_DELIVERY_PREFIX}${randomUUID()}`,
        conversationNotice: true,
      },
    );
  },
  conflicts: async (target) => {
    const { fetchPrReadinessSource } = await import("./pr-merge-readiness");
    const pr = await fetchPrReadinessSource(target);
    return (
      pr.mergeable === "CONFLICTING" ||
      pr.mergeStateStatus.toUpperCase() === "DIRTY"
    );
  },
  postItem: async (input) =>
    (await import("./supervisor-inbox")).postSupervisorItem(input),
  save: async (sessionId, saved) => {
    if (saved) await documents().set(sessionId, saved);
    else await documents().delete(sessionId);
  },
  saved: async () =>
    (await documents().list()).map(({ key, value }) => ({
      sessionId: key,
      saved: value,
    })),
  persona: () => personaName(),
};

let deps: MergeQueueDeps = liveDeps;

/** Test seam: replace any dependency; omitted ones keep their defaults. */
export function __setMergeQueueDepsForTest(
  overrides?: Partial<MergeQueueDeps>,
): void {
  deps = { ...liveDeps, ...overrides };
  queues.clear();
}

type Job = MergeCardInput & {
  label: string;
  patRounds: number;
  /** The owner already heard this PR conflicts. */
  toldConflict: boolean;
  /** The reason the owner gave, before any note about the persona's fix. */
  givenReason: string;
  /** The raising tool call's answer, while it is still waiting. */
  reply?: (text: string) => void;
};

type Queue = {
  /** The head is the open card, or the PR waiting on the persona. */
  jobs: Job[];
  lastMerged?: string;
};

/** A session is in this map while its queue has work. */
const queues = new Map<string, Queue>();

/** Keep the catalog's copy in step with the queue, for the restart notice.
 *  Writes to one key run in call order (catalog-documents.ts serial). */
function persist(sessionId: string, q: Queue): void {
  const saved = q.jobs.length
    ? { owner: q.jobs[0]!.owner, labels: q.jobs.map((j) => j.label) }
    : null;
  void deps
    .save(sessionId, saved)
    .catch((error) =>
      console.error("[merge-queue] couldn't save the queue:", error),
    );
}

function report(sessionId: string, job: Job, text: string): void {
  if (job.reply) {
    const reply = job.reply;
    delete job.reply;
    reply(text);
    return;
  }
  void deps
    .tell(sessionId, `Merge card: ${text}`)
    .catch((error) =>
      console.error("[merge-queue] couldn't deliver a notice:", error),
    );
}

/** Whether GitHub reports the PR as conflicting; unknown counts as no. */
async function conflicts(job: Job): Promise<boolean> {
  return deps.conflicts(job.target).catch((error) => {
    console.error("[merge-queue] couldn't read the PR's merge state:", error);
    return false;
  });
}

/** Fixed copy for a merge GitHub refused over permission or a branch rule,
 *  by its HTTP status; null for any other refusal. */
function refusalNotice(
  status: number | undefined,
  job: Job,
): { title: string; body: string } | null {
  const title = `Couldn't merge ${job.label}`;
  if (status === 401)
    return {
      title,
      body: `GitHub rejected your token, so nothing was merged. Reconnect GitHub in Settings, then ask Blob to merge ${job.label} again.`,
    };
  if (status === 403)
    return {
      title,
      body: `Your GitHub account can't merge in ${job.target.ghRepo}, so nothing was merged. Merging needs write access to the repository.`,
    };
  if (status === 405)
    return {
      title,
      body: `A branch rule blocks merging ${job.label}, so nothing was merged. A repository admin, or someone the rule lets bypass it, has to merge it on GitHub.`,
    };
  return null;
}

/** A refusal only the owner can clear goes to their inbox. */
function tellOwner(
  sessionId: string,
  job: Job,
  notice: { title: string; body: string },
): void {
  void deps
    .postItem({
      user: job.owner,
      source: MERGE_CARD_SOURCE,
      kind: "needs-you",
      title: notice.title,
      body: notice.body,
      dedupeKey: `${MERGE_CARD_SOURCE}:${sessionId}:${job.label}`,
    })
    .catch((error) =>
      console.error("[merge-queue] couldn't tell the owner:", error),
    );
}

/** Hand a conflicting PR to the persona; it stays at the head until done. */
async function handOff(
  sessionId: string,
  q: Queue,
  job: Job,
): Promise<"parked" | "dropped"> {
  const persona = deps.persona();
  const drop = (text: string) => {
    q.jobs.shift();
    report(sessionId, job, text);
    return "dropped" as const;
  };
  if (job.patRounds >= MAX_PAT_ROUNDS)
    return drop(
      `${job.label} still conflicts with its base after ${persona} updated it ${job.patRounds} times, so it left the merge queue. Nothing was merged.`,
    );
  job.patRounds++;
  let asked: AskPatResult;
  try {
    asked = await deps.askPat({
      owner: job.owner,
      action: "auto_fix",
      repo: job.target.repoId,
      pr: job.target.number,
    });
  } catch (error) {
    asked = {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (!asked.ok || !asked.done)
    return drop(
      `${job.label} conflicts with its base and ${persona} couldn't update it (${asked.message}). Nothing was merged; it left the merge queue.`,
    );
  if (!job.toldConflict) {
    job.toldConflict = true;
    const after = q.lastMerged ? ` now that ${q.lastMerged} merged` : "";
    report(
      sessionId,
      job,
      `${job.label} conflicts with its base${after}. I asked ${persona} to update the branch; its card comes back when ${persona} is done, and you'll hear how it ends.`,
    );
  }
  void asked.done
    .catch(() => undefined)
    .then(() => {
      // The card that comes back is for the head the persona pushed.
      job.reason = `New head includes ${persona}'s conflict fix. ${job.givenReason}`;
      return advance(sessionId, q);
    });
  return "parked";
}

async function settle(
  sessionId: string,
  q: Queue,
  job: Job,
  outcome: ForceMergeOutcome,
): Promise<void> {
  if (q.jobs[0] !== job) return;
  const { result } = outcome;
  if (result.status === "refused" && (await conflicts(job))) {
    if ((await handOff(sessionId, q, job)) === "parked") return;
  } else {
    q.jobs.shift();
    if (result.status === "merged") q.lastMerged = job.label;
    report(sessionId, job, formatForceMergeOutcome(outcome));
    const notice =
      result.status === "refused"
        ? refusalNotice(result.httpStatus, job)
        : null;
    if (notice) tellOwner(sessionId, job, notice);
  }
  await advance(sessionId, q);
}

/** Raise the head's card; on to the next while one can't be raised. */
async function advance(sessionId: string, q: Queue): Promise<void> {
  persist(sessionId, q);
  while (q.jobs.length) {
    const job = q.jobs[0]!;
    try {
      const { outcome } = await deps.open(sessionId, job);
      // Only the raising call hears this: a card coming up in the
      // background needs no notice, the owner sees it.
      if (job.reply)
        report(
          sessionId,
          job,
          `Card raised for ${job.label}; you'll hear when it's merged.`,
        );
      void outcome
        .then((o) => settle(sessionId, q, job, o))
        .catch((error) =>
          console.error("[merge-queue] couldn't settle a card:", error),
        );
      return;
    } catch (error) {
      if (error instanceof ForceMergeError && error.code === "conflict") {
        if ((await handOff(sessionId, q, job)) === "parked") return;
        continue;
      }
      q.jobs.shift();
      report(
        sessionId,
        job,
        `Couldn't raise the merge card for ${job.label}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  persist(sessionId, q);
  if (queues.get(sessionId) === q) queues.delete(sessionId);
}

/**
 * Raise a merge card for the supervisor without waiting for the owner's
 * answer. Resolves the tool's answer: the card is up, queued, handed to the
 * persona for a conflict, or why it couldn't be raised.
 */
export async function raiseMergeCard(
  sessionId: string,
  input: MergeCardInput,
): Promise<string> {
  const label = `${input.target.ghRepo}#${input.target.number}`;
  const busy = queues.get(sessionId);
  if (busy?.jobs.some((j) => j.label === label))
    return `${label} is already in the merge queue; you'll hear when it's merged.`;
  const sameRepo = busy?.jobs.filter(
    (j) => j.target.repoId === input.target.repoId,
  ).length;
  if (sameRepo !== undefined && sameRepo >= MAX_QUEUED_PER_REPO)
    return `The merge queue already holds ${MAX_QUEUED_PER_REPO} PRs from ${input.target.ghRepo}, so ${label} wasn't queued. Raise it again once some of them are done.`;
  const job: Job = {
    ...input,
    label,
    patRounds: 0,
    toldConflict: false,
    givenReason: input.reason,
  };
  if (busy) {
    busy.jobs.push(job);
    persist(sessionId, busy);
    const ahead = busy.jobs.slice(0, -1).map((j) => j.label);
    return `Queued ${label} behind ${ahead.join(", ")}. Its card comes up when the ones before it are done; you'll hear when it's merged.`;
  }
  const q: Queue = { jobs: [job] };
  queues.set(sessionId, q);
  let answer = "";
  job.reply = (text) => (answer = text);
  await advance(sessionId, q);
  delete job.reply;
  return answer || `Card raised for ${label}; you'll hear when it's merged.`;
}

/** The PRs waiting in a session's merge queue, the open card first. */
export function mergeQueue(sessionId: string): string[] {
  return queues.get(sessionId)?.jobs.map((j) => j.label) ?? [];
}

/** The restart notice: what was queued when the server stopped. */
export const DROPPED_TITLE = "Merges you queued were dropped";

function savedQueue(value: unknown): SavedQueue | null {
  if (!value || typeof value !== "object") return null;
  const { owner, labels } = value as Record<string, unknown>;
  if (typeof owner !== "string" || !owner.trim() || !Array.isArray(labels))
    return null;
  const kept = labels.filter(
    (l): l is string =>
      typeof l === "string" && /^[\w.-]+\/[\w.-]+#\d+$/.test(l),
  );
  return kept.length ? { owner, labels: kept } : null;
}

/**
 * Tell each owner, once, which queued merges a restart dropped, then forget
 * them. A session that raised a card since boot keeps its new copy.
 */
export async function tellDroppedMergeQueues(): Promise<void> {
  for (const { sessionId, saved: value } of await deps.saved()) {
    if (queues.has(sessionId)) continue;
    const saved = savedQueue(value);
    if (saved)
      await deps.postItem({
        user: saved.owner,
        source: MERGE_CARD_SOURCE,
        kind: "needs-you",
        title: DROPPED_TITLE,
        body: `The server restarted before these merge cards were confirmed, so nothing was merged: ${saved.labels.join(", ")}. Ask Blob to merge them again if you still want them.`,
        dedupeKey: `${MERGE_CARD_SOURCE}:restart:${sessionId}:${saved.labels.join(",")}`,
        once: true,
      });
    if (!queues.has(sessionId)) await deps.save(sessionId, null);
  }
}

/** Boot: the restart notice. Idempotent; a failure is retried next boot. */
export function startSupervisorMergeQueues(): void {
  const g = globalThis as { __supervisorMergeQueuesStarted?: boolean };
  if (g.__supervisorMergeQueuesStarted) return;
  g.__supervisorMergeQueuesStarted = true;
  tellDroppedMergeQueues().catch((error: unknown) =>
    console.error("[merge-queue] couldn't send the restart notice:", error),
  );
}
