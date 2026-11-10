// A project lead's goal (goals.ts): created when the lead is turned on,
// its mission rewritten from the charter whenever the project's settings
// change, paused when the lead is turned off or over its budget, and
// active again whenever the lead is on and nothing blocks it. Each wake
// asks leadWakeCheck first, which rebuilds the goal's fields from the
// settings. The owner's answers to the lead's proposals land in its ledger
// and wake it. Nothing runs at import: `startProjectLeads` registers the
// listeners, once.
import type { ProjectSettingsDocument } from "../../shared/project-settings";
import type { SupervisorAnswerer, SupervisorItem } from "../supervisor-inbox";
import { configuredRepos } from "../config";
import type { LeadGoalFields, LeadWakePlan } from "../goal-runner";
import {
  LEAD_UNAVAILABLE_REASON,
  WAKE_CHECK_FAILED_REASON,
  type Goal,
} from "../goals";
import { leadCharter } from "./charter";
import { LEAD_SOURCE_PREFIX, leadOwner, leadSource } from "./report";

export const LEAD_MIN_WAKE_MINUTES = 60;
export const LEAD_OFF_REASON = "The lead is off in the project settings";
export const KILL_SWITCH_REASON = "Agents are paused for this project";
const BUDGET_REASON_PREFIX = "Over the lead's budget";
/** A new goal waits under this until its id is in the settings. */
const STARTING_REASON = "Starting: the lead is recording its goal";
/** A goal leadProject names that the settings no longer point at. */
const NOT_THE_LEAD_REASON = "Another goal leads this project";
/** How often an idle tick may retry a pause the runner made. */
const RETRY_MS = 10 * 60_000;

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
): LeadGoalFields {
  return {
    name: `Lead: ${d.projectLabel(project) || project}`,
    mission: leadCharter({
      project,
      label: d.projectLabel(project),
      doc,
      owner: leadOwner(doc),
    }),
    mode: "ask",
    repo: d.isRepo(project) ? project : undefined,
    minWakeMinutes: LEAD_MIN_WAKE_MINUTES,
    // No external MCP servers: the lead reads through opensession-lead.
    mcpServers: [],
  };
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

function monthOf(at: number): string {
  return new Date(at).toISOString().slice(0, 7);
}

function spentThisMonth(goal: Pick<Goal, "spend">, now: number): number {
  return goal.spend?.month === monthOf(now) ? goal.spend.usd : 0;
}

/** Why the lead's goal must not run now, or null. */
export function leadBlockReason(
  doc: ProjectSettingsDocument,
  goal: Pick<Goal, "spend">,
  now: number,
): string | null {
  if (!doc.lead.enabled) return LEAD_OFF_REASON;
  if (doc.incidents.agentsPaused) return KILL_SWITCH_REASON;
  const spent = spentThisMonth(goal, now);
  if (!(spent < doc.lead.budgetUsdPerMonth))
    return `${BUDGET_REASON_PREFIX}: $${Number(spent.toFixed(2))} of $${doc.lead.budgetUsdPerMonth} this month`;
  return null;
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
 * again whenever the lead is on and nothing blocks it, whoever paused or
 * finished it. Serialized per project, so two settings writes never
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
    if (named && (!named.leadProject || named.leadProject === project))
      return named;
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
    { ...leadGoalFields(project, doc, d), createdBy: "Project lead" },
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
  const block = leadBlockReason(doc, created, now);
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
  const fields = leadGoalFields(project, doc, d);
  const now = d.now();
  const block = leadBlockReason(doc, existing, now);
  const resume = !block && existing.status !== "active";
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
    ...(resume && g.status !== "active"
      ? {
          status: "active" as const,
          pauseReason: undefined,
          doneReason: undefined,
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

/**
 * The wake check goal-runner runs before every wake of a lead's goal: it
 * doesn't wake while its lead is off, the project's kill switch is on, it
 * is over budget (which also asks the owner, once a month) or the settings
 * name another goal. Otherwise it runs on the fields the settings give it,
 * with what is left of this month's budget, and reads the web only past
 * the watch stage.
 */
export async function leadWakeCheck(goal: Goal): Promise<LeadWakePlan> {
  const project = goal.leadProject;
  if (!project) return { block: "Not a project lead's goal" };
  const d = deps();
  const doc = await d.projectDocument(project);
  if (doc.lead.goalId !== goal.id) return { block: NOT_THE_LEAD_REASON };
  const now = d.now();
  const reason = leadBlockReason(doc, goal, now);
  if (reason) {
    if (reason.startsWith(BUDGET_REASON_PREFIX))
      await askAboutBudget(project, doc, reason, now, d);
    return { block: reason };
  }
  return {
    fields: leadGoalFields(project, doc, d),
    budgetUsd: doc.lead.budgetUsdPerMonth - spentThisMonth(goal, now),
    web: doc.lead.stage !== "watch",
  };
}

const idleRetries = new Map<string, number>();

/**
 * On a tick, for a lead's goal that isn't active: a budget pause from an
 * earlier month lapses (its spend starts again at 0), and a pause the
 * runner made because it couldn't ask the lead is retried every few
 * minutes. Both go through ensureLeadGoal, which resumes the goal only
 * when nothing blocks it.
 */
export async function leadGoalIdle(goal: Goal, now: number): Promise<void> {
  const project = goal.leadProject;
  if (!project || goal.status === "active") return;
  const reason = goal.pauseReason ?? "";
  const monthTurned =
    reason.startsWith(BUDGET_REASON_PREFIX) &&
    goal.spend?.month !== monthOf(now);
  const runnerPause =
    reason === LEAD_UNAVAILABLE_REASON ||
    reason.startsWith(WAKE_CHECK_FAILED_REASON);
  if (!monthTurned && !runnerPause) return;
  if (runnerPause && now - (idleRetries.get(goal.id) ?? 0) < RETRY_MS) return;
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
 * One of the lead's items was answered. The owner's own answer lands in
 * the lead's ledger and wakes it soon, resuming it if nothing blocks it;
 * at the watch stage an approval changes nothing by itself: the next wake
 * prepares the change and proposes it. An answer the supervisor recorded
 * from a conversation is logged as such and approves nothing.
 */
export async function handleLeadAnswer(
  item: SupervisorItem,
  answer: string,
  answeredBy: SupervisorAnswerer,
): Promise<void> {
  if (!item.source.startsWith(LEAD_SOURCE_PREFIX)) return;
  const project = item.source.slice(LEAD_SOURCE_PREFIX.length);
  const d = deps();
  const doc = await d.projectDocument(project);
  if (!doc.lead.goalId) return;
  const goal = await d.getGoal(doc.lead.goalId);
  if (!goal) return;
  const what = `"${item.title}"${item.dedupeKey ? ` (${item.dedupeKey})` : ""}`;
  if (answeredBy !== "owner") {
    await d.appendLedger(
      goal,
      [
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
  await d.appendLedger(
    goal,
    [`Owner answered ${what}: ${answer}`, note].join("\n\n"),
  );
  await ensureLeadGoal(project);
  const now = new Date(d.now()).toISOString();
  await d.mutateGoal(goal.id, (g) =>
    g.status === "active" && g.nextWakeAt > now ? { ...g, nextWakeAt: now } : g,
  );
}

/** Register the lead's listeners: settings writes, the owner's answers and
 *  the goal runner's lead hooks. Idempotent; called from boot. */
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
  runner.registerLeadGoalHooks({ wake: leadWakeCheck, idle: leadGoalIdle });
}
