/**
 * Goals: long-running, stateful agent missions.
 *
 * Unlike an Automation — which fires a *fresh, amnesiac* session on a cron tick
 * (automations.ts) — a Goal is a single managed session pursued over days/weeks.
 * It carries context across wakes (the engine session is resumed each time, so
 * the SDK compacts rather than forgets), paces itself (each wake sets its own
 * next wake), pauses for human sign-off, and stops when its success condition is
 * met. The mission is just a prompt string — nothing domain-specific lives here.
 *
 * This module is the pure data layer: the store + validation. The runner (which
 * drives the session) and the ticker live in goal-runner.ts, because they need
 * the interactive MCP wiring; the two MCP surfaces (opensession-goals management
 * + opensession-goal-self self-cadence) live in src/agents/slack/goal-tools.ts.
 *
 * Records are documents on the `goals` application catalog namespace, keyed by
 * goal id (catalog-documents.ts imports the legacy `<id>.json` files once at
 * boot and mirrors every write back to them). Each goal's fact ledger stays a
 * real markdown file next to that mirror, `<id>.ledger.md`, because the goal's
 * agent reads it by path with its file tools.
 */
import { randomUUIDv7 } from "bun";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  catalogDocuments,
  isValidCatalogKey,
  legacyCatalogDirectory,
} from "./catalog-documents";

const NAMESPACE = "goals";

// Bound on first use, never at import: the catalog client is a live effect.
let documents: ReturnType<typeof catalogDocuments> | undefined;
function goalDocuments(): ReturnType<typeof catalogDocuments> {
  return (documents ??= catalogDocuments(NAMESPACE));
}

/** The directory holding the ledgers (and the catalog's JSON mirror). */
function goalsDirectory(): Promise<string> {
  return legacyCatalogDirectory(NAMESPACE);
}

export type GoalStatus = "active" | "paused" | "done" | "failed";

export interface Goal {
  id: string;
  name: string;
  /** The mission prompt — the whole point of the goal, restated every wake. */
  mission: string;
  status: GoalStatus;
  /** "ask" = read-only research/measure; "code" = persistent worktree + can open PRs. */
  mode: "ask" | "code";
  /** Repo id for code-mode worktrees (key in worktree.ts REPOS). Defaults to the instance default repo. */
  repo?: string;
  /** Open Session session this goal drives (context continuity). Set on first wake. */
  osSessionId?: string;
  /** Engine (Claude/Codex) session id to resume each wake. Set on first wake. */
  engineSessionId?: string;
  /** Persistent worktree path for code mode — stable cwd so resume keeps working. */
  worktreePath?: string;
  /** Branch the persistent worktree was created on (for revive-after-cleanup). */
  branch?: string;
  /** ISO8601 — the ticker wakes this goal at/after this instant. */
  nextWakeAt: string;
  /** Floor on self-scheduled cadence, so a buggy run can't hot-loop. */
  minWakeMinutes: number;
  /** Hard safety cap on total wakes; auto-pauses on hit. Unset = no cap. */
  maxWakes?: number;
  wakeCount: number;
  lastRunAt?: string;
  lastRunStatus?: "running" | "ok" | "error";
  lastRunError?: string;
  /** Agent-updated free text, e.g. "week 2: shipping roundup". */
  phase?: string;
  /** Set when status=paused — what/who it's blocked on. */
  pauseReason?: string;
  doneReason?: string;
  /** Path to the goal's append-only fact ledger (authoritative memory). */
  stateFile: string;
  model?: string;
  fallbackModel?: string;
  /** External MCP server allowlist for this goal's runs (least privilege). */
  mcpServers?: string[];
  /** The project this goal leads (server/leads/goal.ts). Server-owned: set
   *  at creation by the lead, never by a patch or the goals API. */
  leadProject?: string;
  /** The person whose background watch this goal is
   *  (supervisor-watch.ts). Server-owned like `leadProject`: set at
   *  creation by the watch, never by a patch or the goals API. */
  watchOwner?: string;
  /** What this goal's runs cost in one UTC month (`YYYY-MM`), as their
   *  terminal usage reported it. Runner-owned. */
  spend?: { month: string; usd: number };
  /** A project lead's loop guard: its wakes on one of the owner's local
   *  days and its last token trip. Runner- and lead-owned. */
  guard?: GoalGuard;
  /** Why a due wake is waiting instead of running (the provider's
   *  accounts are near their limits), and since when (ISO). Set by the
   *  runner, cleared when the wake starts. */
  waiting?: { reason: string; since: string };
  /** When an event asked to wake the goal now (ISO) while it was running
   *  or already due, so the next wake its run sets can't drop it
   *  (takePendingWake). Set by the project lead, cleared by the runner. */
  pendingWakeAt?: string;
  createdBy: string;
  createdAt: string;
}

export interface GoalGuard {
  /** The owner's local day (`YYYY-MM-DD`) `wakes` and `lifted` are for. */
  day: string;
  /** Wakes started on `day`. */
  wakes: number;
  /** The owner's Resume lifted the daily wake limit for the rest of `day`. */
  lifted?: boolean;
  /** Token trips so far, never reset: each trip's question has its own key. */
  trips?: number;
  /** The last token trip: when (ISO) and the tokens its wake used. Cleared
   *  by the owner's Resume; lapses after a fixed span (leads/goal.ts). */
  trippedAt?: string;
  trippedTokens?: number;
}

/** The goal's guard for the owner's local `day`: a new day starts the wake
 *  count and the Resume again, and keeps the trip, which lapses on its own
 *  clock. */
export function goalGuardFor(
  goal: Pick<Goal, "guard">,
  day: string,
): GoalGuard {
  const guard = goal.guard;
  if (guard?.day === day) return guard;
  return {
    day,
    wakes: 0,
    ...(guard?.trips ? { trips: guard.trips } : {}),
    ...(guard?.trippedAt
      ? { trippedAt: guard.trippedAt, trippedTokens: guard.trippedTokens }
      : {}),
  };
}

/**
 * `goal` with its pending wake taken into its next wake: `nextWakeAt`
 * becomes the pending wake when that is earlier and came at or after
 * `since`, the start of the run setting the next wake (an earlier one that
 * run already saw). The runner takes it after a wake and clears it;
 * set_next_wake `keep`s it, since the runner may still replace the next
 * wake it set (a run that set none gets a day's default).
 */
export function takePendingWake<
  G extends Pick<Goal, "nextWakeAt" | "pendingWakeAt">,
>(goal: G, since: string | undefined, options: { keep?: boolean } = {}): G {
  const { pendingWakeAt, ...rest } = goal;
  if (!pendingWakeAt) return goal;
  const counts = !since || pendingWakeAt >= since;
  const nextWakeAt =
    counts && pendingWakeAt < goal.nextWakeAt ? pendingWakeAt : goal.nextWakeAt;
  return (
    options.keep ? { ...goal, nextWakeAt } : { ...rest, nextWakeAt }
  ) as G;
}

/** Why the runner paused a project lead's goal without running it: no lead
 *  on this server to ask, or asking it failed. The lead lifts both once it
 *  can answer again (server/leads/goal.ts). */
export const LEAD_UNAVAILABLE_REASON =
  "The project lead isn't running on this server";
export const WAKE_CHECK_FAILED_REASON = "Its wake check failed";
/** How a pause by a project lead's loop guard starts (server/leads/goal.ts). */
export const LEAD_GUARD_REASON_PREFIX = "Loop guard";
/** Why the runner paused a person's watch goal without running it: no
 *  watch on this server to ask (supervisor-watch.ts lifts it). */
export const WATCH_UNAVAILABLE_REASON =
  "The supervisor's watch isn't running on this server";

// ── Store ────────────────────────────────────────────────────

export async function listGoals(): Promise<Goal[]> {
  // SAFETY: only saveGoal and mutateGoal write this namespace, and the boot import seeds it
  // from the same records the file store held.
  const out = (await goalDocuments().list()).map((row) => row.value as Goal);
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Null for an unknown id, or one that can't be a goal id (a stray path
 *  segment from a URL is a miss, not an error). */
export async function getGoal(id: string): Promise<Goal | null> {
  if (!isValidCatalogKey(id)) return null;
  // SAFETY: as in listGoals, every document here is a saved Goal.
  return (await goalDocuments().get(id)) as Goal | null;
}

/** Whole-record write, for a new goal. Anything that starts from a stored
 *  copy goes through {@link mutateGoal}, so an overlapping writer is kept. */
export async function saveGoal(g: Goal): Promise<void> {
  await goalDocuments().set(g.id, g);
}

class GoalMissing extends Error {}

/**
 * Compare-and-set read-modify-write of one goal. `mutate` sees the freshest
 * committed record and runs again on a conflict, so the runner's bookkeeping,
 * the agent's own cadence tools and a pause from the UI never overwrite each
 * other from a stale read. Keep `mutate` free of side effects: it may run more
 * than once. Resolves null for an unknown id; nothing is created.
 */
export async function mutateGoal(
  id: string,
  mutate: (goal: Goal) => Goal,
): Promise<Goal | null> {
  if (!isValidCatalogKey(id)) return null;
  try {
    return await goalDocuments().update<Goal>(id, (value) => {
      // Abort without writing: returning null would store a tombstone.
      if (value === null) throw new GoalMissing();
      // SAFETY: as in listGoals, every document here is a saved Goal.
      return mutate(value as Goal);
    });
  } catch (error) {
    if (error instanceof GoalMissing) return null;
    throw error;
  }
}

export async function deleteGoal(id: string): Promise<boolean> {
  if (!isValidCatalogKey(id)) return false;
  if (!(await goalDocuments().delete(id))) return false;
  try {
    await rm(join(await goalsDirectory(), `${id}.ledger.md`), { force: true });
  } catch {}
  return true;
}

/** Append a timestamped entry to a goal's fact ledger (its durable memory). */
export async function appendLedger(goal: Goal, text: string): Promise<void> {
  const stamp = new Date().toISOString();
  await mkdir(dirname(goal.stateFile), { recursive: true });
  await appendFile(goal.stateFile, `\n\n## ${stamp}\n\n${text.trim()}\n`);
}

/** The ledger's contents, or "" when it is missing or unreadable. */
export async function readLedger(goal: Goal): Promise<string> {
  try {
    return await readFile(goal.stateFile, "utf-8");
  } catch {
    return "";
  }
}

// ── Create / update ──────────────────────────────────────────

const MIN_WAKE_FLOOR = 5; // never allow a cadence under 5 minutes

function sanitizeMcpList(list?: unknown): string[] | undefined {
  if (!Array.isArray(list)) return undefined;
  return list
    .filter((s): s is string => typeof s === "string" && !!s.trim())
    .map((s) => s.trim());
}

/** The UTC month (`YYYY-MM`) of `at`. */
export function monthOf(at: number): string {
  return new Date(at).toISOString().slice(0, 7);
}

/** What the goal's runs cost in the UTC month of `now`. */
export function goalMonthSpend(goal: Pick<Goal, "spend">, now: number): number {
  return goal.spend?.month === monthOf(now) ? goal.spend.usd : 0;
}

/** `spend` with `usd` more in the month of `at`; a new month starts at 0. */
export function addGoalSpend(
  spend: Goal["spend"],
  usd: number,
  at: number,
): Goal["spend"] {
  if (!(usd > 0)) return spend;
  const month = monthOf(at);
  const base = spend?.month === month ? spend.usd : 0;
  return { month, usd: Math.round((base + usd) * 10_000) / 10_000 };
}

export async function createGoal(
  input: {
    name: string;
    mission: string;
    mode?: "ask" | "code";
    repo?: string;
    model?: string;
    fallbackModel?: string;
    mcpServers?: string[];
    minWakeMinutes?: number;
    maxWakes?: number;
    /** ISO8601 first wake; omitted/empty = wake on the next tick. */
    firstWakeAt?: string;
    createdBy: string;
  },
  /** Server-owned fields, never taken from an API body. `pauseReason`
   *  creates the goal paused, so it can't wake before its owner has
   *  recorded it (a project lead stores the id in its settings first). */
  owned: {
    leadProject?: string;
    watchOwner?: string;
    pauseReason?: string;
  } = {},
): Promise<Goal | { error: string }> {
  if (!input.name?.trim()) return { error: "Name is required" };
  if (!input.mission?.trim()) return { error: "Mission is required" };

  let nextWakeAt = new Date().toISOString();
  if (input.firstWakeAt?.trim()) {
    const t = Date.parse(input.firstWakeAt.trim());
    if (Number.isNaN(t))
      return { error: `Invalid firstWakeAt: "${input.firstWakeAt}"` };
    nextWakeAt = new Date(t).toISOString();
  }

  const id = `goal-${randomUUIDv7()}`;
  const directory = await goalsDirectory();
  const minWakeMinutes = Math.max(
    MIN_WAKE_FLOOR,
    typeof input.minWakeMinutes === "number" && input.minWakeMinutes > 0
      ? input.minWakeMinutes
      : 30,
  );

  const g: Goal = {
    id,
    name: input.name.trim(),
    mission: input.mission.trim(),
    status: owned.pauseReason ? "paused" : "active",
    ...(owned.pauseReason ? { pauseReason: owned.pauseReason } : {}),
    mode: input.mode === "code" ? "code" : "ask",
    repo: input.repo?.trim() || undefined,
    nextWakeAt,
    minWakeMinutes,
    maxWakes:
      typeof input.maxWakes === "number" && input.maxWakes > 0
        ? Math.floor(input.maxWakes)
        : undefined,
    wakeCount: 0,
    stateFile: join(directory, `${id}.ledger.md`),
    model: input.model?.trim() || undefined,
    fallbackModel: input.fallbackModel?.trim() || undefined,
    mcpServers: sanitizeMcpList(input.mcpServers),
    ...(owned.leadProject ? { leadProject: owned.leadProject } : {}),
    ...(owned.watchOwner ? { watchOwner: owned.watchOwner } : {}),
    createdBy: input.createdBy || "Anonymous",
    createdAt: new Date().toISOString(),
  };
  await saveGoal(g);

  // Seed the ledger so the first wake has something to read.
  await mkdir(directory, { recursive: true });
  await writeFile(
    g.stateFile,
    `# Ledger — ${g.name}\n\n` +
      `This is the durable, authoritative record of this goal's work: baselines, ` +
      `decisions, shipped PRs and their measured effect. The agent reads it first ` +
      `every wake and appends to it last. It survives context compaction.\n\n` +
      `## Mission\n\n${g.mission}\n`,
  );
  return g;
}

/** Fields an operator (via opensession-goals or the goals API) may patch.
 *  Runtime/scheduling fields (engineSessionId, wakeCount, lastRun*,
 *  worktreePath, spend, guard, waiting, pendingWakeAt) are owned by the runner,
 *  `leadProject` by the project lead, `watchOwner` by the supervisor's
 *  watch, and `id` and `stateFile` are fixed
 *  at creation: the ledger tools read and write `stateFile` by path. */
const PATCHABLE_GOAL_FIELDS = [
  "name",
  "mission",
  "status",
  "mode",
  "repo",
  "nextWakeAt",
  "minWakeMinutes",
  "maxWakes",
  "model",
  "fallbackModel",
  "mcpServers",
  "phase",
  "pauseReason",
  "doneReason",
] as const satisfies readonly (keyof Goal)[];

export type GoalPatch = Partial<
  Pick<Goal, (typeof PATCHABLE_GOAL_FIELDS)[number]>
>;

/** Only the patchable fields, whatever the caller sent: an API body is
 *  untrusted, so the whitelist holds at runtime, not just in the type. */
function patchableFields(patch: unknown): GoalPatch {
  const out: Record<string, unknown> = {};
  if (!patch || typeof patch !== "object") return out;
  for (const key of PATCHABLE_GOAL_FIELDS)
    if (Object.hasOwn(patch, key))
      out[key] = (patch as Record<string, unknown>)[key];
  return out;
}

/** Fields a project lead's settings decide (server/leads/goal.ts), or a
 *  watch's charter (supervisor-watch.ts): a patch may not change them on
 *  such a goal, and each wake rebuilds them. */
export const LEAD_OWNED_GOAL_FIELDS = [
  "mission",
  "mode",
  "repo",
  "minWakeMinutes",
  "mcpServers",
] as const satisfies readonly (keyof Goal)[];

class LeadOwnedField extends Error {
  constructor(
    readonly fields: string[],
    readonly watch: boolean,
  ) {
    super(fields.join(", "));
  }
}

/** The lead-owned fields `fields` would change on `goal`. Sending a
 *  value it already has (a form that posts every field) changes nothing. */
function leadOwnedChanges(goal: Goal, fields: GoalPatch): string[] {
  if (!goal.leadProject && !goal.watchOwner) return [];
  return LEAD_OWNED_GOAL_FIELDS.filter(
    (key) =>
      key in fields &&
      JSON.stringify(fields[key] ?? null) !== JSON.stringify(goal[key] ?? null),
  );
}

export async function updateGoal(
  id: string,
  patch: GoalPatch,
): Promise<Goal | { error: string }> {
  const fields = patchableFields(patch);
  if ("mcpServers" in fields)
    fields.mcpServers = sanitizeMcpList(fields.mcpServers);
  try {
    const next = await mutateGoal(id, (g) => {
      const locked = leadOwnedChanges(g, fields);
      if (locked.length) throw new LeadOwnedField(locked, !!g.watchOwner);
      const merged: Goal = { ...g, ...fields };
      if (typeof merged.minWakeMinutes === "number")
        merged.minWakeMinutes = Math.max(MIN_WAKE_FLOOR, merged.minWakeMinutes);
      return merged;
    });
    return next ?? { error: "Goal not found" };
  } catch (error) {
    if (!(error instanceof LeadOwnedField)) throw error;
    return {
      error: error.watch
        ? `This goal is a supervisor's watch: its ${error.fields.join(", ")} come from the watch's charter`
        : `This goal is a project lead's: its ${error.fields.join(", ")} come from the project's lead settings`,
    };
  }
}

/** The guard with today's holds lifted, as the owner's Resume on the
 *  lead's question does: the wake limit for the rest of its day, and the
 *  token trip. */
export function liftGoalGuard(guard: GoalGuard): GoalGuard {
  const { trippedAt: _at, trippedTokens: _tokens, ...rest } = guard;
  return { ...rest, lifted: true };
}

/** Resume a paused/done goal: mark active and (re)schedule a wake. A
 *  project lead its loop guard paused has the guard lifted too, so the
 *  owner's resume here counts as their Resume on the lead's question
 *  (whose card the next wake check closes). */
export async function resumeGoal(
  id: string,
  firstWakeAt?: string,
): Promise<Goal | { error: string }> {
  let nextWakeAt = new Date().toISOString();
  if (firstWakeAt?.trim()) {
    const t = Date.parse(firstWakeAt.trim());
    if (Number.isNaN(t)) return { error: `Invalid time: "${firstWakeAt}"` };
    nextWakeAt = new Date(t).toISOString();
  }
  const next = await mutateGoal(id, (g) => ({
    ...g,
    status: "active",
    pauseReason: undefined,
    nextWakeAt,
    ...(g.leadProject &&
    g.guard &&
    g.status === "paused" &&
    g.pauseReason?.startsWith(LEAD_GUARD_REASON_PREFIX)
      ? { guard: liftGoalGuard(g.guard) }
      : {}),
  }));
  return next ?? { error: "Goal not found" };
}
