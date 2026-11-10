// A project lead's goal (goals.ts): created when the lead is turned on,
// its mission rewritten from the charter whenever the project's settings
// change, paused when the lead is turned off or over its budget. The
// owner's answers to the lead's proposals land in its ledger and wake it.
// Nothing runs at import: `startProjectLeads` registers the listeners, once.
import type { ProjectSettingsDocument } from "../../shared/project-settings";
import type { SupervisorItem } from "../supervisor-inbox";
import { configuredRepos } from "../config";
import type { Goal } from "../goals";
import { leadCharter } from "./charter";
import { LEAD_SOURCE_PREFIX, leadOwner, leadSource } from "./report";

export const LEAD_MIN_WAKE_MINUTES = 60;
export const LEAD_OFF_REASON = "The lead is off in the project settings";
export const KILL_SWITCH_REASON = "Agents are paused for this project";
const BUDGET_REASON_PREFIX = "Over the lead's budget";

export interface LeadGoalDeps {
  now(): number;
  projectDocument(project: string): Promise<ProjectSettingsDocument>;
  setGoalId(project: string, goalId: string): Promise<void>;
  projectLabel(project: string): string | undefined;
  /** Whether the project is a registered repository (the goal's repo). */
  isRepo(project: string): boolean;
  getGoal(id: string): Promise<Goal | null>;
  createGoal: (typeof import("../goals"))["createGoal"];
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
  createGoal: async (...args) => (await import("../goals")).createGoal(...args),
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
}

function deps(): LeadGoalDeps {
  return { ...liveDeps, ...override };
}

/** The goal's fields the project's settings decide. */
function leadGoalFields(
  project: string,
  doc: ProjectSettingsDocument,
  d: LeadGoalDeps,
) {
  return {
    name: `Lead: ${d.projectLabel(project) || project}`,
    mission: leadCharter({
      project,
      label: d.projectLabel(project),
      doc,
      owner: leadOwner(doc),
    }),
    mode: "ask" as const,
    repo: d.isRepo(project) ? project : undefined,
    minWakeMinutes: LEAD_MIN_WAKE_MINUTES,
    // No external MCP servers: the lead reads through opensession-lead.
    mcpServers: [] as string[],
  };
}

function sameFields(goal: Goal, fields: ReturnType<typeof leadGoalFields>) {
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

/** Pause reasons the lead itself set, which it lifts again when they no
 *  longer hold; a pause anyone else set stays. */
function leadPause(reason: string | undefined): boolean {
  return (
    reason === LEAD_OFF_REASON ||
    reason === KILL_SWITCH_REASON ||
    !!reason?.startsWith(BUDGET_REASON_PREFIX)
  );
}

/** Why the lead's goal must not run now, or null. */
export function leadBlockReason(
  doc: ProjectSettingsDocument,
  goal: Pick<Goal, "spend">,
  now: number,
): string | null {
  if (!doc.lead.enabled) return LEAD_OFF_REASON;
  if (doc.incidents.agentsPaused) return KILL_SWITCH_REASON;
  const month = new Date(now).toISOString().slice(0, 7);
  const spent = goal.spend?.month === month ? goal.spend.usd : 0;
  if (!(spent < doc.lead.budgetUsdPerMonth))
    return `${BUDGET_REASON_PREFIX}: $${Number(spent.toFixed(2))} of $${doc.lead.budgetUsdPerMonth} this month`;
  return null;
}

export type EnsureResult =
  | { action: "none" }
  | { action: "created" | "updated" | "paused" | "resumed"; goalId: string };

const chains = new Map<string, Promise<unknown>>();

/**
 * Bring the project's lead goal in line with its settings: create it when
 * the lead is on and has none (storing its id in the settings), rewrite its
 * charter when the settings changed, pause it when the lead is off or
 * blocked, and resume a pause the lead set once it no longer holds.
 * Serialized per project, so two settings writes never create two goals.
 */
export function ensureLeadGoal(project: string): Promise<EnsureResult> {
  const previous = chains.get(project) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(() => ensureNow(project));
  chains.set(project, run);
  void run.finally(() => {
    if (chains.get(project) === run) chains.delete(project);
  });
  return run;
}

async function ensureNow(project: string): Promise<EnsureResult> {
  const d = deps();
  const doc = await d.projectDocument(project);
  const existing = doc.lead.goalId ? await d.getGoal(doc.lead.goalId) : null;
  if (!doc.lead.enabled) {
    if (!existing || existing.status !== "active") return { action: "none" };
    await d.mutateGoal(existing.id, (g) =>
      g.status === "active"
        ? { ...g, status: "paused", pauseReason: LEAD_OFF_REASON }
        : g,
    );
    return { action: "paused", goalId: existing.id };
  }
  const fields = leadGoalFields(project, doc, d);
  if (!existing) {
    const created = await d.createGoal(
      { ...fields, createdBy: "Project lead" },
      { leadProject: project },
    );
    if ("error" in created) throw new Error(created.error);
    await d.setGoalId(project, created.id);
    return { action: "created", goalId: created.id };
  }
  const now = d.now();
  const block = leadBlockReason(doc, existing, now);
  const resume =
    !block && existing.status === "paused" && leadPause(existing.pauseReason);
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
    ...(resume && g.status === "paused" && leadPause(g.pauseReason)
      ? {
          status: "active" as const,
          pauseReason: undefined,
          nextWakeAt: new Date(now).toISOString(),
        }
      : {}),
  }));
  return { action: resume ? "resumed" : "updated", goalId: existing.id };
}

/** The wake check goal-runner runs: a lead goal doesn't wake while its lead
 *  is off, the project's kill switch is on, or it is over budget. Over
 *  budget also asks the owner, once a month. */
export async function leadWakeCheck(goal: Goal): Promise<string | null> {
  if (!goal.leadProject) return null;
  const d = deps();
  const project = goal.leadProject;
  const doc = await d.projectDocument(project);
  const now = d.now();
  const reason = leadBlockReason(doc, goal, now);
  if (reason?.startsWith(BUDGET_REASON_PREFIX)) {
    const owner = leadOwner(doc);
    if (owner)
      await d.postSupervisorItem({
        user: owner,
        source: leadSource(project),
        project,
        kind: "needs-you",
        title: `${project} lead paused: over its budget`,
        body: `${reason}. It stays paused until the budget is raised in the project settings or the goal is resumed.`,
        options: ["Raise the budget", "Leave it paused"],
        dedupeKey: `${leadSource(project)}:budget:${new Date(now).toISOString().slice(0, 7)}`,
      });
  }
  return reason;
}

/** The owner answered one of the lead's items: write it into the lead's
 *  ledger and wake the lead soon. At the watch stage an approval changes
 *  nothing by itself: the next wake prepares the change and proposes it. */
export async function handleLeadAnswer(
  item: SupervisorItem,
  answer: string,
): Promise<void> {
  if (!item.source.startsWith(LEAD_SOURCE_PREFIX)) return;
  const project = item.source.slice(LEAD_SOURCE_PREFIX.length);
  const d = deps();
  const doc = await d.projectDocument(project);
  if (!doc.lead.goalId) return;
  const goal = await d.getGoal(doc.lead.goalId);
  if (!goal) return;
  const note =
    doc.lead.stage === "watch"
      ? "Watch stage: nothing was applied. If this approves a change, prepare it exactly on this wake and propose it again as ready to apply."
      : "Nothing was applied by answering; act on it within your rules.";
  await d.appendLedger(
    goal,
    [
      `Owner answered "${item.title}"${item.dedupeKey ? ` (${item.dedupeKey})` : ""}: ${answer}`,
      note,
    ].join("\n\n"),
  );
  const now = new Date(d.now()).toISOString();
  await d.mutateGoal(goal.id, (g) =>
    g.status === "active" && g.nextWakeAt > now ? { ...g, nextWakeAt: now } : g,
  );
}

/** Register the lead's listeners: settings writes, the owner's answers and
 *  the wake check. Idempotent; called from boot. */
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
  runner.registerGoalWakeCheck(leadWakeCheck);
}
