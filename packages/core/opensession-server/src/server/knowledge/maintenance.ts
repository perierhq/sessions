/**
 * Knowledge upkeep, started from boot (never at import):
 *
 *   - an hourly tick runs each step of KNOWLEDGE_DAILY_STEPS for every
 *     project that has a knowledge repository, when that step's last run
 *     (catalog `knowledge-jobs`, key `<step>:<project>`) is older than its
 *     cadence (a day unless the step says otherwise). The first step is the
 *     full re-validation (freshness/revalidate.ts), which also re-fetches
 *     every page an item depends on and refreshes the web mirrors;
 *   - a push to a project's default branch nudges a repo-only re-validation,
 *     debounced to one run per project per minute (pr-webhook.ts);
 *   - a person asks for a run from the Knowledge page (requestRevalidation);
 *   - at boot, imports the last process left running are marked failed
 *     (ingest/jobs.ts failInterruptedJobs).
 *
 * Re-validations of one project run one at a time: a request while another
 * waits to start joins it (a full run covers a repo-only one). A step that
 * fails only logs and keeps its mark, so the next tick tries again; can't
 * tell (an unreadable mark) counts as due. Nothing runs while email support
 * is off.
 *
 * Adding a step (C7 known problems, C8 captures, C5 website crawl with
 * `everyMs: WEB_REFRESH_MS`) is one entry in KNOWLEDGE_DAILY_STEPS.
 */

import { KNOWLEDGE_REVALIDATE_MS } from "../../shared/knowledge";
import { MemoryRepoError } from "../memory-repo/git-store";
import { listProjects } from "../projects";
import { isShuttingDown } from "../shutdown-state";
import { emailSupportEnabled } from "../support/enabled";
import { knowledgeRepo } from "./client";
import type { RevalidateDeps, RevalidateResult } from "./freshness/revalidate";

/** How long a push nudge waits for more pushes before it runs. */
export const KNOWLEDGE_NUDGE_MS = 60_000;
/** How often the tick looks for due steps. */
export const KNOWLEDGE_TICK_MS = 60 * 60_000;
/** The first tick after boot, once the server has settled. */
const FIRST_TICK_MS = 5 * 60_000;

export interface KnowledgeStep {
  name: string;
  /** How often it runs per project; KNOWLEDGE_REVALIDATE_MS (a day) when
   *  unset. */
  everyMs?: number;
  run(project: string): Promise<unknown>;
}

export interface KnowledgeMaintenanceDeps {
  enabled(): boolean;
  /** Projects that can have knowledge (configured repositories). */
  projects(): string[];
  hasRepo(project: string): Promise<boolean>;
  revalidateProject(
    project: string,
    opts?: { scope?: "all" | "repo"; deps?: Partial<RevalidateDeps> },
  ): Promise<RevalidateResult>;
  fetchDefaultBranch(project: string): Promise<boolean>;
  /** When each step last finished, per project. */
  marks: {
    load(key: string): Promise<unknown>;
    save(key: string, value: { at: string }): Promise<void>;
  };
  now(): number;
  steps: KnowledgeStep[];
  /** At boot: imports the last process left running are marked failed. */
  failInterruptedJobs(): Promise<void>;
}

/** Per project, in order; each step's mark is `<name>:<project>`. */
export const KNOWLEDGE_DAILY_STEPS: KnowledgeStep[] = [
  { name: "revalidate", run: (project) => requestRevalidation(project) },
];

function catalogMarks(): KnowledgeMaintenanceDeps["marks"] {
  const docs = async () =>
    (await import("../catalog-documents")).catalogDocuments("knowledge-jobs");
  return {
    load: async (key) => (await docs()).get(key),
    save: async (key, value) => void (await (await docs()).set(key, value)),
  };
}

function defaultDeps(): KnowledgeMaintenanceDeps {
  return {
    enabled: emailSupportEnabled,
    projects: () =>
      listProjects()
        .filter((p) => p.kind === "repo")
        .map((p) => p.id),
    hasRepo: (project) => knowledgeRepo.call("hasRepo", project),
    revalidateProject: async (project, opts) =>
      (await import("./freshness/revalidate")).revalidateProject(project, opts),
    fetchDefaultBranch: async (project) =>
      (await import("./freshness/repo-changes")).fetchDefaultBranch(project),
    marks: catalogMarks(),
    now: Date.now,
    steps: KNOWLEDGE_DAILY_STEPS,
    failInterruptedJobs: async () =>
      (await import("./ingest/jobs")).failInterruptedJobs(),
  };
}

let deps: KnowledgeMaintenanceDeps | null = null;

function current(): KnowledgeMaintenanceDeps {
  return (deps ??= defaultDeps());
}

/** Replace some collaborators (tests); null restores the defaults and
 *  forgets pending nudges and queued runs. */
export function __setKnowledgeMaintenanceDepsForTest(
  over: Partial<KnowledgeMaintenanceDeps> | null,
): void {
  for (const timer of nudges.values()) clearTimeout(timer);
  nudges.clear();
  lanes.clear();
  deps = over ? { ...defaultDeps(), ...over } : null;
}

async function step(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    console.warn(`[knowledge] ${name} failed:`, error);
  }
}

// ── One re-validation at a time per project ────────────────────────────

type Scope = "all" | "repo";

interface Lane {
  /** Settles when the last queued run has. */
  tail: Promise<void>;
  /** Runs queued but not started, by scope. */
  waiting: Map<Scope, Promise<RevalidateResult>>;
}

const lanes = new Map<string, Lane>();

function enqueue(
  project: string,
  scope: Scope,
  run: () => Promise<RevalidateResult>,
): Promise<RevalidateResult> {
  let lane = lanes.get(project);
  if (!lane) {
    lane = { tail: Promise.resolve(), waiting: new Map() };
    lanes.set(project, lane);
  }
  // A run that hasn't started yet sees every change made before it starts.
  const joined = lane.waiting.get("all") ?? lane.waiting.get(scope);
  if (joined) return joined;
  const own = lane;
  const promise: Promise<RevalidateResult> = own.tail.then(() => {
    if (own.waiting.get(scope) === promise) own.waiting.delete(scope);
    return run();
  });
  own.waiting.set(scope, promise);
  const settled = promise.then(
    () => undefined,
    () => undefined,
  );
  own.tail = settled;
  void settled.then(() => {
    if (own.tail === settled && lanes.get(project) === own)
      lanes.delete(project);
  });
  return promise;
}

/**
 * A full re-validation of one project, now (the Knowledge page's "Check
 * now"). Waits for a run already going; a request while another waits to
 * start gets that run's result.
 */
export function requestRevalidation(
  project: string,
): Promise<RevalidateResult> {
  const d = current();
  if (!d.enabled())
    return Promise.reject(new MemoryRepoError("Email support is off.", 404));
  return enqueue(project, "all", () => d.revalidateProject(project));
}

// ── Push nudges ────────────────────────────────────────────────────────

const nudges = new Map<string, ReturnType<typeof setTimeout>>();

async function runNudge(project: string): Promise<void> {
  const d = current();
  if (!d.enabled() || !(await d.hasRepo(project))) return;
  await enqueue(project, "repo", async () => {
    const fetched = await d.fetchDefaultBranch(project).catch(() => false);
    return d.revalidateProject(project, {
      scope: "repo",
      // Fetched just now: the run reads what is there.
      deps: { fetchRepo: async () => fetched },
    });
  });
}

/**
 * The project's default branch moved: re-check what depends on the code
 * repository a minute from the first push (later pushes in that minute
 * ride along).
 */
export function nudgeKnowledge(project: string): void {
  if (nudges.has(project) || !current().enabled()) return;
  const timer = setTimeout(() => {
    nudges.delete(project);
    void step(`nudge ${project}`, () => runNudge(project));
  }, KNOWLEDGE_NUDGE_MS);
  timer.unref?.();
  nudges.set(project, timer);
}

// ── The tick ───────────────────────────────────────────────────────────

async function due(
  d: KnowledgeMaintenanceDeps,
  key: string,
  everyMs: number,
  now: number,
): Promise<boolean> {
  let mark: unknown;
  try {
    mark = await d.marks.load(key);
  } catch (error) {
    console.warn(`[knowledge] reading ${key} failed:`, error);
    return true;
  }
  const at =
    mark && typeof mark === "object" && "at" in mark
      ? Date.parse(String((mark as { at: unknown }).at))
      : Number.NaN;
  // A mark in the future (clock moved back) can't vouch for anything.
  return !(at <= now) || now - at >= everyMs;
}

/** Run every due step for every project with knowledge. */
export async function runKnowledgeTick(now: number): Promise<void> {
  const d = current();
  if (!d.enabled()) return;
  for (const project of d.projects()) {
    if (isShuttingDown()) return;
    let has: boolean;
    try {
      has = await d.hasRepo(project);
    } catch (error) {
      console.warn(`[knowledge] ${project}: repository unreadable:`, error);
      continue;
    }
    if (!has) continue;
    for (const s of d.steps) {
      const key = `${s.name}:${project}`;
      if (!(await due(d, key, s.everyMs ?? KNOWLEDGE_REVALIDATE_MS, now)))
        continue;
      await step(`${s.name} ${project}`, async () => {
        await s.run(project);
        await d.marks.save(key, { at: new Date(now).toISOString() });
      });
    }
  }
}

const g = globalThis as typeof globalThis & {
  __osKnowledgeTimers?: ReturnType<typeof setTimeout>[];
};

/** Fail the imports a restart interrupted and arm the hourly tick (first
 *  one five minutes after boot). Idempotent; a no-op while email support
 *  is off. */
export function startKnowledgeMaintenance(): void {
  for (const timer of g.__osKnowledgeTimers ?? []) clearTimeout(timer);
  const timers: ReturnType<typeof setTimeout>[] = [];
  g.__osKnowledgeTimers = timers;
  const d = current();
  if (!d.enabled()) return;
  void step("interrupted imports", () => d.failInterruptedJobs());

  let ticking = false;
  const tick = () => {
    if (ticking || isShuttingDown()) return;
    ticking = true;
    void step("tick", () => runKnowledgeTick(Date.now())).finally(() => {
      ticking = false;
    });
  };
  const first = setTimeout(tick, FIRST_TICK_MS);
  first.unref?.();
  timers.push(first);
  const every = setInterval(tick, KNOWLEDGE_TICK_MS);
  every.unref?.();
  timers.push(every);
}
