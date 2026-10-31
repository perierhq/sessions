/**
 * GitHub Actions workflow run reads for `wait_for` kind `workflow_run`.
 *
 * REST with the same installation credential PR check waits read with: the
 * read mint already carries `actions: read` (shared/github-app-permissions).
 * REST rather than GraphQL because GraphQL has no lookup of a run by workflow
 * and ref, and REST keeps these polls off the GraphQL budget that the PR
 * panels and pr_checks waits share.
 */
import { githubInstallationCredential } from "./github-app";
import {
  ghRateLimited,
  isGhRateLimitMsg,
  noteGhRateLimited,
} from "./github-limit";
import { fetchWithTimeout } from "./shared/fetch-with-timeout";

export interface WorkflowRun {
  id: number;
  name: string;
  /** queued | in_progress | completed | waiting | requested | pending */
  status: string;
  /** success | failure | cancelled | timed_out | action_required | skipped |
   * neutral | stale | startup_failure, or "" while running. */
  conclusion: string;
  url: string;
  headBranch: string;
  headSha: string;
  event: string;
  runNumber: number;
  runAttempt: number;
  createdAt: number;
}

export interface WorkflowRunJob {
  /** The job's id, which is also its check run's id. */
  id?: number;
  name: string;
  status: string;
  conclusion: string;
  /** Names of the steps that failed, in run order. */
  failedSteps: string[];
  /** How many steps the job has; 0 when it never started. */
  steps?: number;
}

/** A read GitHub answered with 404: the workflow, run, or repository does
 * not exist or this credential cannot see it. Polling again will not help. */
export class WorkflowRunNotFoundError extends Error {}

function toRun(raw: any): WorkflowRun {
  return {
    id: Number(raw?.id) || 0,
    name: String(raw?.name || raw?.display_title || "workflow"),
    status: String(raw?.status || ""),
    conclusion: String(raw?.conclusion || ""),
    url: String(raw?.html_url || ""),
    headBranch: String(raw?.head_branch || ""),
    headSha: String(raw?.head_sha || ""),
    event: String(raw?.event || ""),
    runNumber: Number(raw?.run_number) || 0,
    runAttempt: Number(raw?.run_attempt) || 1,
    createdAt: Date.parse(String(raw?.created_at || "")) || 0,
  };
}

/** Failed step conclusions, matching how a failed job is classified. */
export const FAILED_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "startup_failure",
]);

async function githubRest(
  repo: string,
  path: string,
  consumer: string,
): Promise<any> {
  const credential = await githubInstallationCredential({ repo });
  if (!credential)
    throw new Error("The selected GitHub bot credential is unavailable");
  if (await ghRateLimited("rest", credential))
    throw new Error("GitHub REST is rate-limited for this credential");
  const response = await fetchWithTimeout(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${credential.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "opensession",
    },
  });
  const body = (await response.json().catch(() => null)) as any;
  if (response.status === 404)
    throw new WorkflowRunNotFoundError(
      String(body?.message || "Not Found") +
        ` (${path.split("?")[0]}). Check the repository, workflow, and run id.`,
    );
  if (!response.ok) {
    const message = String(body?.message || `GitHub REST ${response.status}`);
    if (
      (response.status === 403 || response.status === 429) &&
      (response.headers.get("x-ratelimit-remaining") === "0" ||
        isGhRateLimitMsg(message))
    ) {
      const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
      await noteGhRateLimited(
        consumer,
        Number.isFinite(reset) ? reset : undefined,
        "rest",
        credential,
      );
    }
    throw new Error(message);
  }
  return body;
}

export async function getWorkflowRun(
  repo: string,
  runId: number,
): Promise<WorkflowRun> {
  return toRun(
    await githubRest(
      repo,
      `/repos/${repo}/actions/runs/${runId}`,
      "agent-wait:workflow-run",
    ),
  );
}

/** Whether a ref names a full commit sha rather than a branch or tag. */
export function isCommitSha(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref);
}

/**
 * The newest runs of a workflow (file name such as `release.yml`, or its
 * numeric id) for a branch, tag, or commit sha. GitHub reports a tag push's
 * tag as the run's `head_branch`, so the `branch` filter covers tags too.
 */
export async function listWorkflowRuns(
  repo: string,
  workflow: string,
  ref: string,
): Promise<WorkflowRun[]> {
  const filter = ref
    ? isCommitSha(ref)
      ? `&head_sha=${encodeURIComponent(ref)}`
      : `&branch=${encodeURIComponent(ref)}`
    : "";
  const body = await githubRest(
    repo,
    `/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=20${filter}`,
    "agent-wait:workflow-runs",
  );
  const runs = Array.isArray(body?.workflow_runs) ? body.workflow_runs : [];
  return runs.map(toRun);
}

/** The latest attempt's jobs, with the steps that failed. */
export async function listWorkflowRunJobs(
  repo: string,
  runId: number,
): Promise<WorkflowRunJob[]> {
  const body = await githubRest(
    repo,
    `/repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
    "agent-wait:workflow-jobs",
  );
  const jobs = Array.isArray(body?.jobs) ? body.jobs : [];
  return jobs.map((job: any) => ({
    id: Number(job?.id) || 0,
    name: String(job?.name || "job"),
    status: String(job?.status || ""),
    conclusion: String(job?.conclusion || ""),
    failedSteps: (Array.isArray(job?.steps) ? job.steps : [])
      .filter((step: any) => FAILED_CONCLUSIONS.has(String(step?.conclusion)))
      .map((step: any) => String(step?.name || "step")),
    steps: Array.isArray(job?.steps) ? job.steps.length : 0,
  }));
}

/** The messages of a check run's annotations (an Actions job's id is its
 *  check run's id): where GitHub says why a job was not started. */
export async function listCheckRunAnnotations(
  repo: string,
  checkRunId: number,
): Promise<string[]> {
  const body = await githubRest(
    repo,
    `/repos/${repo}/check-runs/${checkRunId}/annotations?per_page=20`,
    "incident:check-run-annotations",
  );
  return (Array.isArray(body) ? body : [])
    .map((a: any) => String(a?.message || ""))
    .filter(Boolean);
}

const ACTIONS_JOB_URL = /\/actions\/runs\/(\d+)\/job\/(\d+)/;
/** At most this many workflow runs are read for one pull request. */
const ACTIONS_RUNS_MAX = 5;

/**
 * Why GitHub Actions ran none of a pull request's failing checks, or
 * undefined when it can't tell or the code ran. Every check must be an
 * Actions job that stopped before its first step (GitHub refused it: a
 * billing or spending limit, a disabled workflow); the reason is the
 * first job's annotation ("The job was not started because…"), else a
 * plain sentence. A failure of the code itself always has a step.
 */
export async function actionsNotRunning(
  repo: string,
  checks: ReadonlyArray<{ name: string; url?: string }>,
  deps: {
    jobs: (repo: string, runId: number) => Promise<WorkflowRunJob[]>;
    annotations: (repo: string, checkRunId: number) => Promise<string[]>;
  } = { jobs: listWorkflowRunJobs, annotations: listCheckRunAnnotations },
): Promise<string | undefined> {
  if (!checks.length) return undefined;
  const jobRuns = new Map<number, number>();
  for (const check of checks) {
    const m = ACTIONS_JOB_URL.exec(check.url ?? "");
    if (!m) return undefined;
    jobRuns.set(Number(m[2]), Number(m[1]));
  }
  const runs = [...new Set(jobRuns.values())];
  if (runs.length > ACTIONS_RUNS_MAX) return undefined;
  const jobs = new Map<number, WorkflowRunJob>();
  for (const run of runs)
    for (const job of await deps.jobs(repo, run))
      if (job.id) jobs.set(job.id, job);
  for (const id of jobRuns.keys())
    if ((jobs.get(id)?.steps ?? 1) > 0) return undefined;
  const first = jobRuns.keys().next().value!;
  const notes = await deps.annotations(repo, first).catch(() => []);
  const note = notes.find((n) =>
    /not (been )?started|spending limit|billing|payment/i.test(n),
  );
  if (!note) return "every job stopped before its first step";
  const sentence = note
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=\.)\s/)[0]!;
  const text = sentence.replace(/\.$/, "").slice(0, 200);
  return text.charAt(0).toLowerCase() + text.slice(1);
}
