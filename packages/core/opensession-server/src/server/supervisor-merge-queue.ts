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
 * the conflicts), and its card comes back when that run finishes. The
 * owner hears about the conflict once. A PR that still conflicts after
 * MAX_PAT_ROUNDS runs leaves the queue.
 *
 * Same lifetime as the cards: in memory, so a restart drops the queue and
 * nothing is merged.
 */
import { randomUUID } from "node:crypto";
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

/** Updating a branch twice and still conflicting needs a person. */
export const MAX_PAT_ROUNDS = 2;

/** Delivery ids of the outcome notices. supervisor-watch.ts keeps these in
 *  the conversation instead of routing them to the watch. */
export const MERGE_CARD_DELIVERY_PREFIX = "merge-card:";

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
  persona(): string;
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
      { deliveryId: `${MERGE_CARD_DELIVERY_PREFIX}${randomUUID()}` },
    );
  },
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

/** A refusal GitHub gives for a PR that conflicts with its base. */
function conflictRefusal(outcome: ForceMergeOutcome): boolean {
  return (
    outcome.result.status === "refused" &&
    /not mergeable|merge conflict/i.test(outcome.result.error)
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
  void asked.done.catch(() => undefined).then(() => advance(sessionId, q));
  return "parked";
}

async function settle(
  sessionId: string,
  q: Queue,
  job: Job,
  outcome: ForceMergeOutcome,
): Promise<void> {
  if (q.jobs[0] !== job) return;
  if (conflictRefusal(outcome)) {
    if ((await handOff(sessionId, q, job)) === "parked") return;
  } else {
    q.jobs.shift();
    if (outcome.result.status === "merged") q.lastMerged = job.label;
    report(sessionId, job, formatForceMergeOutcome(outcome));
  }
  await advance(sessionId, q);
}

/** Raise the head's card; on to the next while one can't be raised. */
async function advance(sessionId: string, q: Queue): Promise<void> {
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
  const job: Job = { ...input, label, patRounds: 0, toldConflict: false };
  if (busy) {
    busy.jobs.push(job);
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
