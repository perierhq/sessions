/**
 * Knowledge import jobs: one record per run in the catalog namespace
 * `knowledge-jobs` (key `<project>:<id>`), with its progress, so the
 * Knowledge page can show what an import did after the request that
 * started it ended. At most one running job per kind and project; a
 * second start is refused (409). A restart can't resume a run, so boot
 * marks what was left running as failed (failInterruptedJobs, from the
 * knowledge maintenance start). The newest MAX_LISTED_JOBS per project are
 * kept. Nothing runs at import.
 *
 * A run says what it is doing (`phase`, "Reading INBOX 120 of 900") and
 * counts what it made and skipped, by why. Those land on the job in this
 * process at once (listJobs reads them) and on its record at most every
 * JOB_WRITE_MS; each record write tells the project's clients
 * (broadcast.ts). The record keeps the last phase once the run ends.
 */
import { randomBytes } from "node:crypto";
import {
  type KnowledgeImportJob,
  type KnowledgeImportKind,
  type KnowledgeJobPhase,
  MAX_SKIP_REASONS,
  MAX_SKIPPED_RECORDED,
} from "../../../shared/knowledge";
import { catalogDocuments } from "../../catalog-documents";
import { MemoryRepoError } from "../../memory-repo/git-store";
import { knowledgeChanged } from "../broadcast";

export const JOB_RUNNING_COPY = "An import of this kind is running";
export const INTERRUPTED_COPY = "Interrupted by a restart. Start it again.";
export const CANCELLED_COPY = "Cancelled.";
export const DEADLINE_COPY =
  "The import took too long and stopped. Start it again to continue.";
/** How long an import run may take before it stops (DEADLINE_COPY). */
export const JOB_DEADLINE_MS = 30 * 60 * 1000;
/** How many jobs per project are listed (and kept). */
export const MAX_LISTED_JOBS = 20;
/** A running job's record is written at most this often. */
export const JOB_WRITE_MS = 500;
const MAX_ERROR_CHARS = 300;
const MAX_PHASE_CHARS = 120;
const STARTING: KnowledgeJobPhase = { text: "Starting" };

/** Counts a run reports with its phase. */
export interface PhaseCounts {
  done?: number;
  total?: number | null;
}

/** Say what a run is doing now; `counts` when they are known. */
export type ReportPhase = (label: string, counts?: PhaseCounts) => void;

/** Skipped inputs by why (a KNOWLEDGE_SKIP reason). */
export type SkipCounts = Record<string, number>;

/** Add `more` to `into`, in place; returns `into`. */
export function addSkips(into: SkipCounts, more: SkipCounts): SkipCounts {
  for (const [reason, n] of Object.entries(more))
    if (n > 0) into[reason] = (into[reason] ?? 0) + n;
  return into;
}

const whole = (n: number | null | undefined) =>
  typeof n === "number" && Number.isFinite(n)
    ? Math.max(0, Math.floor(n))
    : null;

/** "Reading INBOX 120 of 900", "Reading pages, 12 so far", "Pairing". */
export function phaseOf(
  label: string,
  counts: PhaseCounts = {},
): KnowledgeJobPhase {
  const head = label.replace(/\s+/g, " ").trim().slice(0, MAX_PHASE_CHARS);
  const done = whole(counts.done);
  const total = whole(counts.total);
  if (done !== null && total !== null)
    return {
      text: `${head} ${Math.min(done, total)} of ${total}`,
      done: Math.min(done, total),
      total,
    };
  if (done !== null) return { text: `${head}, ${done} so far`, done };
  return { text: head };
}

export interface JobHandle {
  id: string;
  /** Aborted when a person cancels the job; the run stops at its next
   *  check (`signal.throwIfAborted()`). */
  signal: AbortSignal;
  /** Record that the run left part of its input out. */
  markTruncated(): Promise<void>;
  /** Name inputs the run skipped and why (kept up to
   *  MAX_SKIPPED_RECORDED); the count still goes through progress. */
  recordSkipped(
    skipped: Array<{ name: string; reason: string }>,
  ): Promise<void>;
  setTotal(n: number): Promise<void>;
  /** Add to the counts. `skippedBy` counts skipped inputs by why; when
   *  `skipped` is left out, it is their sum. */
  progress(
    delta: Partial<KnowledgeImportJob["created"]> & {
      done?: number;
      skippedBy?: SkipCounts;
    },
  ): Promise<void>;
  /** What the run is doing now. */
  phase: ReportPhase;
}

let jobDocs: ReturnType<typeof catalogDocuments> | undefined;
const docs = () => (jobDocs ??= catalogDocuments("knowledge-jobs"));

/** Kinds being started or run by this process, `<project>\0<kind>`. */
const claimed = new Set<string>();
/** Runs of this process, by job id. */
const running = new Map<string, Promise<void>>();
/** Their jobs as they are now, ahead of the throttled record, by job id. */
const live = new Map<string, KnowledgeImportJob>();
/** Their cancel switches, by job id. */
const controllers = new Map<string, { project: string; ac: AbortController }>();
let sequence = 0;

const keyOf = (project: string, id: string) => `${project}:${id}`;

function isJob(value: unknown): value is KnowledgeImportJob {
  const v = value as KnowledgeImportJob | null;
  return (
    !!v &&
    typeof v === "object" &&
    typeof v.id === "string" &&
    typeof v.project === "string" &&
    typeof v.kind === "string" &&
    typeof v.state === "string" &&
    typeof v.startedAt === "string"
  );
}

/** Newest first: by start time, then by id (ids sort by creation). */
function newestFirst(a: KnowledgeImportJob, b: KnowledgeImportJob): number {
  if (a.startedAt !== b.startedAt) return a.startedAt < b.startedAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

async function allJobs(project?: string): Promise<KnowledgeImportJob[]> {
  const jobs: KnowledgeImportJob[] = [];
  for (const { value } of await docs().list())
    if (isJob(value) && (project === undefined || value.project === project))
      jobs.push(live.get(value.id) ?? value);
  return jobs.sort(newestFirst);
}

/** Time-ordered, unique within the process and unguessable across. */
function newJobId(): string {
  const time = Date.now().toString(36).padStart(10, "0");
  const seq = (sequence++ % 1_679_616).toString(36).padStart(4, "0");
  return `kj_${time}${seq}${randomBytes(3).toString("hex")}`;
}

const active = (job: KnowledgeImportJob) =>
  job.state === "running" || job.state === "queued";

async function update(
  project: string,
  id: string,
  mutate: (job: KnowledgeImportJob) => KnowledgeImportJob,
): Promise<void> {
  await docs().update(keyOf(project, id), (value) =>
    isJob(value) ? mutate(value) : null,
  );
}

/** Drop finished jobs past the newest MAX_LISTED_JOBS of the project. */
async function prune(project: string): Promise<void> {
  const jobs = await allJobs(project);
  for (const job of jobs.slice(MAX_LISTED_JOBS))
    if (!active(job)) await docs().delete(keyOf(project, job.id));
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return (
    text.replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_CHARS) ||
    "The import failed."
  );
}

/** Stops a run: cancelled (CANCELLED_COPY) or past its deadline
 *  (DEADLINE_COPY). Callers that wrap errors rethrow it as it is. */
export class StopRun extends Error {}

/** A run's cancel and deadline check, called between steps. */
export type Step = () => void;

/** The check for a run that started now: throws StopRun once `signal` is
 *  aborted or `deadlineMs` have passed. */
export function stepper(signal: AbortSignal, deadlineMs: number): Step {
  const end = performance.now() + deadlineMs;
  return () => {
    if (signal.aborted) throw new StopRun(CANCELLED_COPY);
    if (performance.now() >= end) throw new StopRun(DEADLINE_COPY);
  };
}

/** Whether a run's error is its cancellation: the signal's own reason
 *  (throwIfAborted, an aborted fetch) or an error carrying CANCELLED_COPY
 *  (the mailbox's StopRun). Anything else that went wrong while a cancel
 *  was pending is recorded as itself. */
function cancelled(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  if (error === signal.reason) return true;
  return error instanceof Error && error.message === CANCELLED_COPY;
}

/**
 * Record a running job and start `run` in the background; resolves with
 * the job as recorded. Rejects with a 409 while a job of `kind` runs for
 * `project` (also one a restart left running, until boot failed it). The
 * job ends `done` when `run` resolves and `failed` with its error message
 * when it throws.
 */
export async function startJob(
  project: string,
  kind: KnowledgeImportKind,
  options: Record<string, unknown>,
  run: (job: JobHandle) => Promise<void>,
): Promise<KnowledgeImportJob> {
  const slot = `${project}\u0000${kind}`;
  if (claimed.has(slot)) throw new MemoryRepoError(JOB_RUNNING_COPY, 409);
  claimed.add(slot);
  let job: KnowledgeImportJob;
  try {
    if ((await allJobs(project)).some((j) => j.kind === kind && active(j)))
      throw new MemoryRepoError(JOB_RUNNING_COPY, 409);
    job = {
      id: newJobId(),
      project,
      kind,
      state: "running",
      startedAt: new Date().toISOString(),
      done: 0,
      total: null,
      created: { trusted: 0, reference: 0, suggestions: 0, skipped: 0 },
      phase: STARTING,
      options,
    };
    await docs().set(keyOf(project, job.id), job);
  } catch (error) {
    claimed.delete(slot);
    throw error;
  }
  knowledgeChanged(project, "jobs");

  const id = job.id;
  const ac = new AbortController();
  controllers.set(id, { project, ac });
  live.set(id, job);

  // The job as it is now; written at most every JOB_WRITE_MS, in order.
  let current = job;
  let lastWrite = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writing: Promise<void> = Promise.resolve();
  /** Set once the run ended: a late report can't reopen the record. */
  let closed = false;
  const write = () => {
    timer = undefined;
    lastWrite = performance.now();
    const snapshot = current;
    writing = writing
      .then(() => update(project, id, () => snapshot))
      .then(() => knowledgeChanged(project, "jobs"))
      .catch((e) =>
        console.warn(`[knowledge] job ${id} not recorded:`, errorText(e)),
      );
  };
  const change = (mutate: (job: KnowledgeImportJob) => KnowledgeImportJob) => {
    if (closed) return Promise.resolve();
    current = mutate(current);
    live.set(id, current);
    if (timer) return Promise.resolve();
    const wait = lastWrite + JOB_WRITE_MS - performance.now();
    if (wait <= 0) write();
    else {
      timer = setTimeout(write, wait);
      (timer as { unref?: () => void }).unref?.();
    }
    return Promise.resolve();
  };

  const handle: JobHandle = {
    id,
    signal: ac.signal,
    markTruncated: () => change((j) => ({ ...j, truncated: true })),
    recordSkipped: (skipped) =>
      change((j) => ({
        ...j,
        skippedFiles: [
          ...(j.skippedFiles ?? []),
          ...skipped.map((s) => ({
            name: s.name.slice(0, MAX_ERROR_CHARS),
            reason: errorText(s.reason),
          })),
        ].slice(0, MAX_SKIPPED_RECORDED),
      })),
    setTotal: (n) => change((j) => ({ ...j, total: Math.max(0, n) })),
    progress: (delta) =>
      change((j) => {
        const by = delta.skippedBy ?? {};
        const skipped =
          delta.skipped ??
          Object.values(by).reduce((sum, n) => sum + Math.max(0, n), 0);
        return {
          ...j,
          done: j.done + (delta.done ?? 0),
          created: {
            trusted: j.created.trusted + (delta.trusted ?? 0),
            reference: j.created.reference + (delta.reference ?? 0),
            suggestions: j.created.suggestions + (delta.suggestions ?? 0),
            skipped: j.created.skipped + skipped,
          },
          ...(Object.keys(by).length
            ? { skippedReasons: skipReasons(j.skippedReasons, by) }
            : {}),
        };
      }),
    phase: (label, counts) => {
      const next = phaseOf(label, counts);
      phaseListener?.(project, id, next);
      void change((j) => ({ ...j, phase: next }));
    },
  };
  const finish = async (state: "done" | "failed", error?: string) => {
    closed = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    await writing;
    const { error: _previous, ...rest } = current;
    const ended: KnowledgeImportJob = {
      ...rest,
      state,
      finishedAt: new Date().toISOString(),
      ...(error ? { error } : {}),
    };
    live.delete(id);
    await update(project, id, () => ended);
    knowledgeChanged(project, "jobs");
  };

  const done = (async () => {
    try {
      await Promise.resolve().then(() => run(handle));
      await finish("done");
    } catch (error) {
      const why = cancelled(error, ac.signal)
        ? CANCELLED_COPY
        : errorText(error);
      await finish("failed", why).catch((e) =>
        console.warn(`[knowledge] job ${id} not recorded:`, errorText(e)),
      );
    } finally {
      live.delete(id);
      claimed.delete(slot);
      running.delete(id);
      controllers.delete(id);
      await prune(project).catch(() => undefined);
    }
  })();
  running.set(id, done);
  return job;
}

/** `into` with `more` added, at most MAX_SKIP_REASONS reasons (a new
 *  reason past it is counted in the total only). */
function skipReasons(
  into: SkipCounts | undefined,
  more: SkipCounts,
): SkipCounts {
  const out: SkipCounts = { ...into };
  for (const [raw, n] of Object.entries(more)) {
    if (!(n > 0)) continue;
    const reason = raw.replace(/\s+/g, " ").trim().slice(0, MAX_PHASE_CHARS);
    if (!reason) continue;
    if (
      out[reason] === undefined &&
      Object.keys(out).length >= MAX_SKIP_REASONS
    )
      continue;
    out[reason] = (out[reason] ?? 0) + Math.floor(n);
  }
  return out;
}

/** The project's import jobs, newest first, at most MAX_LISTED_JOBS. */
export async function listJobs(project: string): Promise<KnowledgeImportJob[]> {
  return (await allJobs(project)).slice(0, MAX_LISTED_JOBS);
}

/** Cancel `project`'s running job `id`; resolves with the job as recorded,
 *  or null when no such job runs in this process. The job ends failed
 *  with CANCELLED_COPY once its run stops. */
export async function cancelJob(
  project: string,
  id: string,
): Promise<KnowledgeImportJob | null> {
  const run = controllers.get(id);
  if (!run || run.project !== project) return null;
  run.ac.abort();
  const value = await docs().get(keyOf(project, id));
  return isJob(value) ? (live.get(id) ?? value) : null;
}

/** At boot: a job left running by the last process can't finish; mark it
 *  failed so the person sees it and may start it again. */
export async function failInterruptedJobs(): Promise<void> {
  for (const job of await allJobs()) {
    if (!active(job) || running.has(job.id)) continue;
    await update(job.project, job.id, (j) =>
      active(j) && !running.has(j.id)
        ? {
            ...j,
            state: "failed",
            finishedAt: new Date().toISOString(),
            error: INTERRUPTED_COPY,
          }
        : j,
    );
  }
}

let phaseListener:
  | ((project: string, id: string, phase: KnowledgeJobPhase) => void)
  | undefined;

/** Hear every phase a run reports, before the throttle (tests). */
export function __setJobPhaseListenerForTest(fn: typeof phaseListener): void {
  phaseListener = fn;
}

/** Resolves when this process's run of `id` ended (tests). */
export async function __waitForJobForTest(id: string): Promise<void> {
  await running.get(id);
}
