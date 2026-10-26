/**
 * Knowledge import jobs: one record per run in the catalog namespace
 * `knowledge-jobs` (key `<project>:<id>`), with its progress, so the
 * Knowledge page can show what an import did after the request that
 * started it ended. At most one running job per kind and project; a
 * second start is refused (409). A restart can't resume a run, so boot
 * marks what was left running as failed (failInterruptedJobs, from the
 * knowledge maintenance start). The newest MAX_LISTED_JOBS per project are
 * kept. Nothing runs at import.
 */
import { randomBytes } from "node:crypto";
import type {
  KnowledgeImportJob,
  KnowledgeImportKind,
} from "../../../shared/knowledge";
import { catalogDocuments } from "../../catalog-documents";
import { MemoryRepoError } from "../../memory-repo/git-store";

export const JOB_RUNNING_COPY = "An import of this kind is running";
export const INTERRUPTED_COPY = "Interrupted by a restart. Start it again.";
export const CANCELLED_COPY = "Cancelled.";
/** How many jobs per project are listed (and kept). */
export const MAX_LISTED_JOBS = 20;
const MAX_ERROR_CHARS = 300;

export interface JobHandle {
  id: string;
  /** Aborted when a person cancels the job; the run stops at its next
   *  check (`signal.throwIfAborted()`). */
  signal: AbortSignal;
  /** Record that the run left part of its input out. */
  markTruncated(): Promise<void>;
  setTotal(n: number): Promise<void>;
  progress(
    delta: Partial<KnowledgeImportJob["created"]> & { done?: number },
  ): Promise<void>;
}

let jobDocs: ReturnType<typeof catalogDocuments> | undefined;
const docs = () => (jobDocs ??= catalogDocuments("knowledge-jobs"));

/** Kinds being started or run by this process, `<project>\0<kind>`. */
const claimed = new Set<string>();
/** Runs of this process, by job id. */
const running = new Map<string, Promise<void>>();
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
      jobs.push(value);
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
      options,
    };
    await docs().set(keyOf(project, job.id), job);
  } catch (error) {
    claimed.delete(slot);
    throw error;
  }

  const id = job.id;
  const ac = new AbortController();
  controllers.set(id, { project, ac });
  const handle: JobHandle = {
    id,
    signal: ac.signal,
    markTruncated: () =>
      update(project, id, (j) => ({ ...j, truncated: true })),
    setTotal: (n) =>
      update(project, id, (j) => ({ ...j, total: Math.max(0, n) })),
    progress: (delta) =>
      update(project, id, (j) => ({
        ...j,
        done: j.done + (delta.done ?? 0),
        created: {
          trusted: j.created.trusted + (delta.trusted ?? 0),
          reference: j.created.reference + (delta.reference ?? 0),
          suggestions: j.created.suggestions + (delta.suggestions ?? 0),
          skipped: j.created.skipped + (delta.skipped ?? 0),
        },
      })),
  };
  const finish = (state: "done" | "failed", error?: string) =>
    update(project, id, (j) => {
      const { error: _previous, ...rest } = j;
      return {
        ...rest,
        state,
        finishedAt: new Date().toISOString(),
        ...(error ? { error } : {}),
      };
    });

  const done = (async () => {
    try {
      await Promise.resolve().then(() => run(handle));
      await finish("done");
    } catch (error) {
      const why = ac.signal.aborted ? CANCELLED_COPY : errorText(error);
      await finish("failed", why).catch((e) =>
        console.warn(`[knowledge] job ${id} not recorded:`, errorText(e)),
      );
    } finally {
      claimed.delete(slot);
      running.delete(id);
      controllers.delete(id);
      await prune(project).catch(() => undefined);
    }
  })();
  running.set(id, done);
  return job;
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
  return isJob(value) ? value : null;
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

/** Resolves when this process's run of `id` ended (tests). */
export async function __waitForJobForTest(id: string): Promise<void> {
  await running.get(id);
}
