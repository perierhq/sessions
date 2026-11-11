// A project lead's goal (goals.ts): created when the lead is turned on,
// its mission rewritten from the charter whenever the project's settings
// change, paused when the lead is turned off, trips its loop guard (too
// many wakes in the owner's day, or a wake past its token limit) or goes
// over an optional dollar cap, and active again whenever the lead is on and nothing blocks it. Each wake
// asks leadWakeCheck first, which rebuilds the goal's fields from the
// settings. The owner's answers to the lead's proposals land in its ledger
// and wake it. Nothing runs at import: `startProjectLeads` registers the
// listeners, once.
import type { ProjectSettingsDocument } from "../../shared/project-settings";
import type {
  SupervisorAnswerContext,
  SupervisorAnswerer,
  SupervisorItem,
} from "../supervisor-inbox";
import { configuredRepos } from "../config";
import type { LeadGoalFields, LeadWakePlan } from "../goal-runner";
import {
  LEAD_UNAVAILABLE_REASON,
  WAKE_CHECK_FAILED_REASON,
  goalGuardFor,
  goalMonthSpend,
  monthOf,
  type Goal,
} from "../goals";
import { PROJECT_LEAD_ACTOR } from "../session-actors";
import { supervisorInboxKey } from "../supervisor-inbox";
import { localClock } from "../supervisor-quiet-hours";
import {
  DEFAULT_REPORT_STYLE,
  type ReportStyle,
} from "../supervisor-report-style";
import { leadCharter } from "./charter";
import { describeCondition, type LeadCondition } from "./conditions";
import {
  LEAD_SOURCE_PREFIX,
  leadOwner,
  leadOwnerMember,
  leadSource,
} from "./report";

export const LEAD_MIN_WAKE_MINUTES = 60;
export const LEAD_OFF_REASON = "The lead is off in the project settings";
export const KILL_SWITCH_REASON = "Agents are paused for this project";
const BUDGET_REASON_PREFIX = "Over the lead's budget";
/** Pauses the loop guard makes; lifted by the owner's Resume, the owner's
 *  next local day (the wake limit) or LEAD_TRIP_HOLD_MS after the trip
 *  (the token limit). */
const GUARD_REASON_PREFIX = "Loop guard";
/** How long a wake past its token limit holds the lead without the
 *  owner's Resume: a fixed span, so a trip late in the day still holds. */
export const LEAD_TRIP_HOLD_MS = 12 * 60 * 60_000;
/** A lead whose due wake waits for headroom this long asks its owner. */
export const LEAD_WAIT_ASK_MS = 24 * 60 * 60_000;
export const RESUME_OPTION = "Resume";
export const KEEP_PAUSED_OPTION = "Keep paused";
/** A new goal waits under this until its id is in the settings. */
export const STARTING_REASON = "Starting: the lead is recording its goal";
/** A goal leadProject names that the settings no longer point at. */
const NOT_THE_LEAD_REASON = "Another goal leads this project";
/** How often an idle tick may retry a pause the runner made, or a budget
 *  pause from an earlier month. */
const RETRY_MS = 10 * 60_000;
/** Boot retries of the lead goals that failed, doubling up to the cap. */
const BOOT_RETRY_MS = 60_000;
const BOOT_RETRY_MAX_MS = 30 * 60_000;

export interface LeadGoalDeps {
  now(): number;
  projectDocument(project: string): Promise<ProjectSettingsDocument>;
  setGoalId(project: string, goalId: string): Promise<void>;
  projectLabel(project: string): string | undefined;
  /** Whether the project is a registered repository (the goal's repo). */
  isRepo(project: string): boolean;
  getGoal(id: string): Promise<Goal | null>;
  listGoals: (typeof import("../goals"))["listGoals"];
  createGoal: (typeof import("../goals"))["createGoal"];
  deleteGoal: (typeof import("../goals"))["deleteGoal"];
  mutateGoal: (typeof import("../goals"))["mutateGoal"];
  appendLedger: (typeof import("../goals"))["appendLedger"];
  postSupervisorItem: (typeof import("../supervisor-inbox"))["postSupervisorItem"];
  proposalForItem: (typeof import("./approvals"))["proposalForItem"];
  approve: (typeof import("./approvals"))["approve"];
  voidFor: (typeof import("./approvals"))["voidFor"];
  /** The owner's report style from their supervisor prefs. */
  reportStyle(owner: string): Promise<ReportStyle>;
  /** The owner's time zone: their supervisor prefs, else their profile. */
  timeZone(owner: string): Promise<string>;
  listProjectDocuments(): Promise<ProjectSettingsDocument[]>;
  /** Run `fn` once after `ms`; never holds the process open. */
  later(fn: () => void, ms: number): void;
}

const liveDeps: LeadGoalDeps = {
  now: () => Date.now(),
  projectDocument: async (project) =>
    (await import("../projects/store")).getProjectDocument(project),
  setGoalId: async (project, goalId) => {
    const { patchProjectDocumentAsServer } = await import("../projects/store");
    await patchProjectDocumentAsServer(project, (d) =>
      d.lead.goalId === goalId ? d : { ...d, lead: { ...d.lead, goalId } },
    );
  },
  projectLabel: (project) => configuredRepos()[project]?.label,
  isRepo: (project) => Object.hasOwn(configuredRepos(), project),
  getGoal: async (id) => (await import("../goals")).getGoal(id),
  listGoals: async () => (await import("../goals")).listGoals(),
  createGoal: async (...args) => (await import("../goals")).createGoal(...args),
  deleteGoal: async (id) => (await import("../goals")).deleteGoal(id),
  mutateGoal: async (...args) => (await import("../goals")).mutateGoal(...args),
  appendLedger: async (...args) =>
    (await import("../goals")).appendLedger(...args),
  postSupervisorItem: async (...args) =>
    (await import("../supervisor-inbox")).postSupervisorItem(...args),
  proposalForItem: async (...args) =>
    (await import("./approvals")).proposalForItem(...args),
  approve: async (...args) => (await import("./approvals")).approve(...args),
  voidFor: async (...args) => (await import("./approvals")).voidFor(...args),
  reportStyle: async (owner) =>
    (await import("../supervisor-inbox")).supervisorReportStyle(owner),
  timeZone: async (owner) =>
    (await (await import("../supervisor-inbox")).getSupervisorPrefs(owner))
      .effectiveTimezone,
  listProjectDocuments: async () =>
    (await import("../projects/store")).listProjectDocuments(),
  later: (fn, ms) => {
    setTimeout(fn, ms).unref?.();
  },
};

let override: Partial<LeadGoalDeps> | undefined;

export function __setLeadGoalDepsForTest(
  deps: Partial<LeadGoalDeps> | undefined,
): void {
  override = deps;
  idleRetries.clear();
}

function deps(): LeadGoalDeps {
  return { ...liveDeps, ...override };
}

/** The goal's fields the project's settings decide; goal-runner applies
 *  them at every wake, so nothing a patch left in the record runs. */
export function leadGoalFields(
  project: string,
  doc: ProjectSettingsDocument,
  d: Pick<LeadGoalDeps, "projectLabel" | "isRepo"> = deps(),
  reportStyle: ReportStyle = DEFAULT_REPORT_STYLE,
): LeadGoalFields {
  return {
    name: `Lead: ${d.projectLabel(project) || project}`,
    mission: leadCharter({
      project,
      label: d.projectLabel(project),
      doc,
      owner: leadOwner(doc),
      reportStyle,
    }),
    mode: "ask",
    repo: d.isRepo(project) ? project : undefined,
    minWakeMinutes: LEAD_MIN_WAKE_MINUTES,
    // No external MCP servers: the lead reads through opensession-lead.
    mcpServers: [],
  };
}

/** The fields with the owner's report style read from their prefs, so the
 *  lead writes proposals in it; the default when there is no owner or the
 *  read fails. */
async function leadGoalFieldsNow(
  project: string,
  doc: ProjectSettingsDocument,
  d: LeadGoalDeps,
): Promise<LeadGoalFields> {
  const owner = leadOwner(doc);
  const style = owner
    ? await d.reportStyle(owner).catch(() => DEFAULT_REPORT_STYLE)
    : DEFAULT_REPORT_STYLE;
  return leadGoalFields(project, doc, d, style);
}

function sameFields(goal: Goal, fields: LeadGoalFields) {
  return (
    goal.name === fields.name &&
    goal.mission === fields.mission &&
    goal.mode === fields.mode &&
    goal.repo === fields.repo &&
    goal.minWakeMinutes === fields.minWakeMinutes &&
    JSON.stringify(goal.mcpServers ?? null) ===
      JSON.stringify(fields.mcpServers)
  );
}

/** The owner's local day (`YYYY-MM-DD`) at `now`, the day a lead's wakes
 *  count towards. UTC without an owner or when their zone can't be read. */
export async function leadDay(
  doc: ProjectSettingsDocument,
  now: number,
  d: Pick<LeadGoalDeps, "timeZone">,
): Promise<string> {
  const owner = leadOwner(doc);
  const zone = owner ? await d.timeZone(owner).catch(() => "UTC") : "UTC";
  return localClock(now, zone).day;
}

/** Why the lead's goal must not run now, or null. `day` is the owner's
 *  local day at `now` (leadDay). */
export function leadBlockReason(
  doc: ProjectSettingsDocument,
  goal: Pick<Goal, "spend" | "guard">,
  now: number,
  day: string,
): string | null {
  if (!doc.lead.enabled) return LEAD_OFF_REASON;
  if (doc.incidents.agentsPaused) return KILL_SWITCH_REASON;
  const cap = doc.lead.budgetUsdPerMonth;
  const spent = goalMonthSpend(goal, now);
  if (cap !== null && !(spent < cap))
    return `${BUDGET_REASON_PREFIX}: $${Number(spent.toFixed(2))} of $${cap} this month`;
  return leadGuardHold(doc, goal, now, day)?.reason ?? null;
}

/** What the loop guard holds the lead for, or null: a wake went past its
 *  token limit less than LEAD_TRIP_HOLD_MS ago, or the owner's day reached
 *  its wake limit. Each hold has the key of the question that asks about
 *  it: one per trip, one per day. The owner's Resume on that question lifts
 *  that hold. */
export function leadGuardHold(
  doc: ProjectSettingsDocument,
  goal: Pick<Goal, "guard">,
  now: number,
  day: string,
): { kind: "trip" | "wakes"; reason: string; dedupeKey: string } | null {
  const guard = goalGuardFor(goal, day);
  const source = leadSource(doc.project);
  const trippedAt = guard.trippedAt ? Date.parse(guard.trippedAt) : NaN;
  if (now - trippedAt < LEAD_TRIP_HOLD_MS)
    return {
      kind: "trip",
      reason: `${GUARD_REASON_PREFIX}: a wake used ${(guard.trippedTokens ?? 0).toLocaleString("en-US")} tokens, over its limit of ${doc.lead.wakeTokenLimit.toLocaleString("en-US")}`,
      dedupeKey: `${source}:guard:trip:${guard.trips ?? 1}`,
    };
  if (!guard.lifted && guard.wakes >= doc.lead.dailyWakeLimit)
    return {
      kind: "wakes",
      reason: `${GUARD_REASON_PREFIX}: ${guard.wakes} wakes today, the daily limit is ${doc.lead.dailyWakeLimit}`,
      dedupeKey: `${source}:guard:wakes:${day}`,
    };
  return null;
}

/** Whether the lead's own rules made this pause (its settings, its
 *  budget, its start, or the runner failing to ask it), so the lead may
 *  lift it. A pause or a finish from the goals page or API is the owner's
 *  and stays until the owner resumes the goal. */
export function leadOwnsPause(goal: Pick<Goal, "status" | "pauseReason">) {
  if (goal.status !== "paused") return false;
  const reason = goal.pauseReason ?? "";
  return (
    reason === LEAD_OFF_REASON ||
    reason === KILL_SWITCH_REASON ||
    reason === STARTING_REASON ||
    reason === NOT_THE_LEAD_REASON ||
    reason === LEAD_UNAVAILABLE_REASON ||
    reason.startsWith(BUDGET_REASON_PREFIX) ||
    reason.startsWith(GUARD_REASON_PREFIX) ||
    reason.startsWith(WAKE_CHECK_FAILED_REASON)
  );
}

export type EnsureResult =
  | { action: "none" }
  | { action: "created" | "updated" | "paused" | "resumed"; goalId: string };

const chains = new Map<string, Promise<unknown>>();

/**
 * Bring the project's lead goal in line with its settings: adopt a goal
 * that already leads the project, or create one when the lead is on and
 * has none (storing its id in the settings), rewrite its charter when the
 * settings changed, pause it when the lead is off, and make it active
 * again when the lead is on, nothing blocks it and the pause was its own
 * (leadOwnsPause). Serialized per project, so two settings writes never
 * create two goals.
 */
export function ensureLeadGoal(project: string): Promise<EnsureResult> {
  const previous = chains.get(project) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(() => ensureNow(project));
  chains.set(project, run);
  // The caller sees the failure; this bookkeeping branch must not raise it
  // again as an unhandled rejection.
  run
    .finally(() => {
      if (chains.get(project) === run) chains.delete(project);
    })
    .catch(() => {});
  return run;
}

/** The goal that leads `project`: the one its settings name, else one a
 *  crash left behind before its id was stored (adopted into the
 *  settings), else null. */
async function findLeadGoal(
  project: string,
  doc: ProjectSettingsDocument,
  d: LeadGoalDeps,
): Promise<Goal | null> {
  if (doc.lead.goalId) {
    const named = await d.getGoal(doc.lead.goalId);
    if (named?.leadProject === project) return named;
  }
  const orphan = (await d.listGoals())
    .filter((g) => g.leadProject === project)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  if (!orphan) return null;
  await d.setGoalId(project, orphan.id);
  return orphan;
}

/** Create the goal paused, store its id, then let it run: a goal whose id
 *  never reached the settings is deleted, not left to wake as a second
 *  lead. */
async function createLeadGoal(
  project: string,
  doc: ProjectSettingsDocument,
  d: LeadGoalDeps,
): Promise<string> {
  const created = await d.createGoal(
    {
      ...(await leadGoalFieldsNow(project, doc, d)),
      // A machine actor (session-actors.ts): the lead is Blob, never a person.
      createdBy: PROJECT_LEAD_ACTOR,
    },
    { leadProject: project, pauseReason: STARTING_REASON },
  );
  if ("error" in created) throw new Error(created.error);
  try {
    await d.setGoalId(project, created.id);
  } catch (error) {
    await d.deleteGoal(created.id).catch(() => false);
    throw error;
  }
  const now = d.now();
  const block = leadBlockReason(doc, created, now, await leadDay(doc, now, d));
  await d.mutateGoal(created.id, (g) =>
    g.status === "paused" && g.pauseReason === STARTING_REASON
      ? block
        ? { ...g, pauseReason: block }
        : {
            ...g,
            status: "active",
            pauseReason: undefined,
            nextWakeAt: new Date(now).toISOString(),
          }
      : g,
  );
  return created.id;
}

async function ensureNow(project: string): Promise<EnsureResult> {
  const d = deps();
  const doc = await d.projectDocument(project);
  const existing = await findLeadGoal(project, doc, d);
  if (!doc.lead.enabled) {
    if (!existing || existing.status !== "active") return { action: "none" };
    await d.mutateGoal(existing.id, (g) =>
      g.status === "active"
        ? { ...g, status: "paused", pauseReason: LEAD_OFF_REASON }
        : g,
    );
    return { action: "paused", goalId: existing.id };
  }
  if (!existing)
    return {
      action: "created",
      goalId: await createLeadGoal(project, doc, d),
    };
  const fields = await leadGoalFieldsNow(project, doc, d);
  const now = d.now();
  const block = leadBlockReason(doc, existing, now, await leadDay(doc, now, d));
  const resume = !block && leadOwnsPause(existing);
  if (
    sameFields(existing, fields) &&
    !resume &&
    existing.leadProject === project
  )
    return { action: "none" };
  await d.mutateGoal(existing.id, (g) => ({
    ...g,
    ...fields,
    leadProject: project,
    ...(resume && leadOwnsPause(g)
      ? {
          status: "active" as const,
          pauseReason: undefined,
          nextWakeAt: new Date(now).toISOString(),
        }
      : {}),
  }));
  return { action: resume ? "resumed" : "updated", goalId: existing.id };
}

/** Ask the owner, once a month, whether to raise the budget. A failure to
 *  ask never lets the wake run. */
async function askAboutBudget(
  project: string,
  doc: ProjectSettingsDocument,
  reason: string,
  now: number,
  d: LeadGoalDeps,
): Promise<void> {
  const owner = leadOwner(doc);
  if (!owner) return;
  try {
    await d.postSupervisorItem({
      user: owner,
      source: leadSource(project),
      project,
      kind: "needs-you",
      title: `${d.projectLabel(project) || project}: the lead is over its budget`,
      body: `${reason}. The lead stays paused until the budget is raised in the project settings or the month ends.`,
      options: ["Raise the budget", "Leave it paused"],
      dedupeKey: `${leadSource(project)}:budget:${monthOf(now)}`,
      // One a month, even after the owner answered or dismissed it.
      once: true,
    });
  } catch (error) {
    console.warn(
      `[leads] ${project}: could not ask about the budget:`,
      error instanceof Error ? error.message : error,
    );
  }
}

/** Ask the owner whether to resume a lead its loop guard holds: once per
 *  hold, so a trip after an earlier Resume asks again. A failure to ask
 *  never lets the wake run. */
async function askAboutGuard(
  project: string,
  doc: ProjectSettingsDocument,
  hold: NonNullable<ReturnType<typeof leadGuardHold>>,
  d: LeadGoalDeps,
): Promise<void> {
  const owner = leadOwner(doc);
  if (!owner) return;
  const what = hold.reason.slice(GUARD_REASON_PREFIX.length + 2);
  const after =
    hold.kind === "trip"
      ? "Resume lets it run again; otherwise it waits 12 hours."
      : "Resume lets it run for the rest of today; otherwise it starts again tomorrow.";
  try {
    await d.postSupervisorItem({
      user: owner,
      source: leadSource(project),
      project,
      kind: "needs-you",
      title: `${d.projectLabel(project) || project}: the lead paused itself`,
      body: `${what.charAt(0).toUpperCase()}${what.slice(1)}. The lead may be stuck in a loop. ${after}`,
      options: [RESUME_OPTION, KEEP_PAUSED_OPTION],
      dedupeKey: hold.dedupeKey,
      once: true,
    });
  } catch (error) {
    console.warn(
      `[leads] ${project}: could not ask about the loop guard:`,
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * The wake check goal-runner runs before every wake of a lead's goal: it
 * doesn't wake while its lead is off, the project's kill switch is on, its
 * loop guard holds it (which also asks the owner, once a hold), it is over
 * an optional dollar cap (which asks once a month) or the settings name
 * another goal. Otherwise it runs on the fields the settings give it, with
 * its token limit and what is left of a dollar cap, and reads the web only
 * past the watch stage.
 */
export async function leadWakeCheck(goal: Goal): Promise<LeadWakePlan> {
  const project = goal.leadProject;
  if (!project) return { block: "Not a project lead's goal" };
  const d = deps();
  const doc = await d.projectDocument(project);
  if (doc.lead.goalId !== goal.id) return { block: NOT_THE_LEAD_REASON };
  const now = d.now();
  const day = await leadDay(doc, now, d);
  const reason = leadBlockReason(doc, goal, now, day);
  if (reason) {
    if (reason.startsWith(BUDGET_REASON_PREFIX))
      await askAboutBudget(project, doc, reason, now, d);
    const hold = leadGuardHold(doc, goal, now, day);
    if (hold && reason === hold.reason)
      await askAboutGuard(project, doc, hold, d);
    return { block: reason };
  }
  const cap = doc.lead.budgetUsdPerMonth;
  return {
    fields: await leadGoalFieldsNow(project, doc, d),
    day,
    wakeTokens: doc.lead.wakeTokenLimit,
    budgetUsd: cap === null ? null : cap - goalMonthSpend(goal, now),
    web: doc.lead.stage !== "watch",
  };
}

const idleRetries = new Map<string, number>();

/**
 * On a tick, for a lead's goal that isn't active: a budget pause from an
 * earlier month lapses (its spend starts again at 0), a loop guard pause
 * lapses once its hold ends, and a pause the
 * runner made because it couldn't ask the lead is retried, each at most
 * every few minutes. Both go through ensureLeadGoal, which resumes the goal only
 * when nothing blocks it.
 */
export async function leadGoalIdle(goal: Goal, now: number): Promise<void> {
  const project = goal.leadProject;
  if (!project || goal.status === "active") return;
  const reason = goal.pauseReason ?? "";
  const monthTurned =
    reason.startsWith(BUDGET_REASON_PREFIX) &&
    goal.spend?.month !== monthOf(now);
  // A guard hold lapses on the owner's next local day or LEAD_TRIP_HOLD_MS
  // after its trip; ensureLeadGoal works out which, from the settings.
  const guardPause = reason.startsWith(GUARD_REASON_PREFIX);
  const runnerPause =
    reason === LEAD_UNAVAILABLE_REASON ||
    reason.startsWith(WAKE_CHECK_FAILED_REASON);
  if (!monthTurned && !guardPause && !runnerPause) return;
  // Each is retried at most every few minutes: a pause that still holds
  // would otherwise be retried each tick.
  if (now - (idleRetries.get(goal.id) ?? 0) < RETRY_MS) return;
  idleRetries.set(goal.id, now);
  try {
    await ensureLeadGoal(project);
  } catch (error) {
    console.warn(
      `[leads] ${project}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * On a tick a due wake of the lead's goal waited for headroom: once it has
 * waited LEAD_WAIT_ASK_MS, tell the owner, once per wait.
 */
export async function leadGoalWaiting(goal: Goal, now: number): Promise<void> {
  const project = goal.leadProject;
  const waiting = goal.waiting;
  if (!project || !waiting) return;
  if (!(now - Date.parse(waiting.since) >= LEAD_WAIT_ASK_MS)) return;
  const d = deps();
  const owner = leadOwner(await d.projectDocument(project));
  if (!owner) return;
  try {
    await d.postSupervisorItem({
      user: owner,
      source: leadSource(project),
      project,
      kind: "needs-you",
      title: `${d.projectLabel(project) || project}: the lead has waited a day to run`,
      body: `${waiting.reason}, so its wakes wait. It runs again once there is room.`,
      dedupeKey: `${leadSource(project)}:waiting:${waiting.since}`,
      once: true,
    });
  } catch (error) {
    console.warn(
      `[leads] ${project}: could not tell the owner the lead is waiting:`,
      error instanceof Error ? error.message : error,
    );
  }
}

/** The ledger's fixed line for an approval the owner's answer made. */
function approvedLine(title: string, condition?: LeadCondition): string {
  if (!condition) return `Approved: ${title}. Ready to apply.`;
  const what = describeCondition(condition);
  // A PR name leads its sentence as it is; the others start a clause.
  const clause =
    condition.kind === "pr-merged"
      ? what
      : `${what.charAt(0).toLowerCase()}${what.slice(1)}`;
  return `Approved: ${title}. Runs when ${clause}.`;
}

/**
 * Approve the recorded proposal the owner's answer is to, when it is the
 * first option, given signed in as the lead owner's GitHub login on the
 * roster to the item's current revision (the inbox hands the revision on
 * only then), and the proposal raised as this item still stands. It waits
 * on the proposal's condition, or is ready at once without one. Returns
 * the ledger line, or null when anything is missing or the approval is
 * refused: the answer then stays in the ledger only. An owner with no
 * GitHub login on the roster approves nothing; the line says so.
 */
async function approveFromAnswer(
  project: string,
  doc: Pick<ProjectSettingsDocument, "lead">,
  item: SupervisorItem,
  answer: string,
  context: SupervisorAnswerContext,
  d: LeadGoalDeps,
): Promise<string | null> {
  if (!item.options?.length || answer !== item.options[0]) return null;
  if (!context.login || context.revision === undefined) return null;
  try {
    const record = await d.proposalForItem(project, item.id);
    if (!record) return null;
    const { proposal } = record;
    // A first name can be shared: only the owner's own GitHub login, as
    // the roster has it, approves.
    const ownerLogin = leadOwnerMember(doc)?.github?.trim().toLowerCase();
    if (!ownerLogin)
      return "Nothing was approved: the lead's owner has no GitHub login on the team. Ask them to add it to their team entry, then propose this again.";
    if (context.login.trim().toLowerCase() !== ownerLogin) {
      console.warn(
        `[leads] ${project}: an answer signed in as ${context.login} is not the lead owner's, so it approves nothing`,
      );
      return null;
    }
    const result = await d.approve({
      project,
      proposalId: proposal.id,
      approvedBy: item.user,
      login: context.login,
      condition: proposal.condition,
      expiresAt: proposal.expiresAt,
      itemRevision: context.revision,
    });
    if (result.ok) return approvedLine(item.title, result.approval.condition);
    console.warn(
      `[leads] ${project}: the owner's answer approved nothing (${result.error}${"message" in result && result.message ? `: ${result.message}` : ""})`,
    );
  } catch (error) {
    console.warn(
      `[leads] ${project}: could not record the owner's approval:`,
      error instanceof Error ? error.message : error,
    );
  }
  return null;
}

/** Any option but the first declines: the proposal raised as the item, if
 *  still unapproved, is voided. A failure is logged; the answer stands. */
async function voidDeclined(
  project: string,
  item: SupervisorItem,
  answer: string,
  d: LeadGoalDeps,
): Promise<void> {
  const options = item.options ?? [];
  if (!options.includes(answer) || answer === options[0]) return;
  try {
    await d.voidFor(
      project,
      (record) => record.proposal.itemId === item.id && !record.approval,
      "declined",
    );
  } catch (error) {
    console.warn(
      `[leads] ${project}: could not void the declined proposal:`,
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * One of the lead's items was answered. The owner's own answer lands in
 * the lead's ledger and wakes it soon, resuming it from a pause of its
 * own if nothing blocks it. Their first option, given signed in to the
 * revision they saw, approves the proposal recorded for the item
 * (approveFromAnswer), except at the watch stage; any other option voids
 * it. Without a recorded proposal an approval changes nothing by itself:
 * at the watch stage the next wake prepares the change and proposes it.
 * An answer the supervisor recorded from a conversation, or one from
 * someone who isn't the lead's owner now, is logged as such and neither
 * approves nor voids anything.
 */
export async function handleLeadAnswer(
  item: SupervisorItem,
  answer: string,
  answeredBy: SupervisorAnswerer,
  context: SupervisorAnswerContext = {},
): Promise<void> {
  if (!item.source.startsWith(LEAD_SOURCE_PREFIX)) return;
  const project = item.source.slice(LEAD_SOURCE_PREFIX.length);
  const d = deps();
  const doc = await d.projectDocument(project);
  // Only the lead's owner answering in their own inbox counts as the
  // owner's answer: the item may sit in an earlier owner's inbox. Only
  // that answer approves or declines a proposal.
  const owner = leadOwner(doc);
  const ownersAnswer =
    answeredBy === "owner" &&
    !!owner &&
    supervisorInboxKey(item.user ?? "") === supervisorInboxKey(owner);
  if (ownersAnswer) await voidDeclined(project, item, answer, d);
  if (!doc.lead.goalId) return;
  const goal = await d.getGoal(doc.lead.goalId);
  if (!goal) return;
  const what = `"${item.title}"${item.dedupeKey ? ` (${item.dedupeKey})` : ""}`;
  if (!ownersAnswer) {
    await d.appendLedger(
      goal,
      answeredBy === "owner"
        ? [
            `${item.user || "Someone"} answered ${what}: ${answer}`,
            "They are not the lead's owner now, so it approves nothing. If it matters, propose it again so the owner answers it.",
          ].join("\n\n")
        : [
            `The supervisor recorded an answer to ${what}: ${answer}`,
            "This is the supervisor's note of a conversation, not the owner's answer: it approves nothing. If it matters, propose it again so the owner answers it.",
          ].join("\n\n"),
    );
    return;
  }
  const note =
    doc.lead.stage === "watch"
      ? "Watch stage: nothing was applied. If this approves a change, prepare it exactly on this wake and propose it again as ready to apply."
      : "Nothing was applied by answering; act on it within your rules.";
  // The owner's Resume on the question about the hold that holds the lead
  // now lifts it: the trip, and the wake limit for the rest of the owner's
  // day (a trip clears an earlier Resume, so its Resume restores it). The
  // next trip holds it again. Keep paused leaves it.
  const now0 = d.now();
  const day = await leadDay(doc, now0, d);
  const hold = leadGuardHold(doc, goal, now0, day);
  const resumeGuard =
    answer === RESUME_OPTION && !!hold && item.dedupeKey === hold.dedupeKey;
  // The watch stage changes nothing, so nothing is approved there either.
  const approved =
    resumeGuard || doc.lead.stage === "watch"
      ? null
      : await approveFromAnswer(project, doc, item, answer, context, d);
  if (resumeGuard)
    await d.mutateGoal(goal.id, (g) => {
      const {
        trippedAt: _at,
        trippedTokens: _tokens,
        ...guard
      } = goalGuardFor(g, day);
      return { ...g, guard: { ...guard, lifted: true } };
    });
  await d.appendLedger(
    goal,
    [
      `Owner answered ${what}: ${answer}`,
      resumeGuard
        ? "The loop guard is lifted for the rest of today, until a wake goes past its token limit again. Check the ledger for what kept you waking or spending, and change course."
        : (approved ?? note),
    ].join("\n\n"),
  );
  await ensureLeadGoal(project);
  const now = new Date(d.now()).toISOString();
  await d.mutateGoal(goal.id, (g) =>
    g.status === "active" && g.nextWakeAt > now ? { ...g, nextWakeAt: now } : g,
  );
}

/**
 * Bring the goal of every project whose lead is on, or has a goal, in line
 * with its settings, so a write the listener missed (a restart between the
 * write and its ensure) still lands. Projects still on their legacy
 * settings have no lead. Retried later, with a doubling delay, until every
 * one succeeds.
 */
export async function ensureLeadGoalsAtBoot(
  delayMs: number = BOOT_RETRY_MS,
): Promise<void> {
  const d = deps();
  let ok = true;
  try {
    for (const doc of await d.listProjectDocuments()) {
      if (!doc.lead.enabled && !doc.lead.goalId) continue;
      try {
        await ensureLeadGoal(doc.project);
      } catch (error) {
        ok = false;
        console.warn(
          `[leads] ${doc.project}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  } catch (error) {
    ok = false;
    console.warn(
      "[leads] could not list the project settings:",
      error instanceof Error ? error.message : error,
    );
  }
  if (ok) return;
  d.later(() => {
    void ensureLeadGoalsAtBoot(Math.min(delayMs * 2, BOOT_RETRY_MAX_MS));
  }, delayMs);
}

/** Register the lead's listeners: settings writes, the owner's answers and
 *  the goal runner's lead hooks, then bring every lead's goal in line once.
 *  Idempotent; called from boot. */
export async function startProjectLeads(): Promise<void> {
  const g = globalThis as { __projectLeadsStarted?: boolean };
  if (g.__projectLeadsStarted) return;
  g.__projectLeadsStarted = true;
  const [{ onProjectDocumentChange }, { onSupervisorAnswer }, runner] =
    await Promise.all([
      import("../projects/store"),
      import("../supervisor-inbox"),
      import("../goal-runner"),
    ]);
  onProjectDocumentChange((project) => {
    ensureLeadGoal(project).catch((error: unknown) => {
      console.warn(
        `[leads] ${project}:`,
        error instanceof Error ? error.message : error,
      );
    });
  });
  onSupervisorAnswer(LEAD_SOURCE_PREFIX, handleLeadAnswer);
  runner.registerLeadGoalHooks({
    wake: leadWakeCheck,
    idle: leadGoalIdle,
    waiting: leadGoalWaiting,
  });
  void ensureLeadGoalsAtBoot();
}
