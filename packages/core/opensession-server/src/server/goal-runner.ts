/**
 * Goals: long-running, self-pacing missions. A Goal drives ONE managed session
 * across many wakes, resuming the engine session each time (so context carries
 * and the SDK compacts rather than forgets), pacing itself via the
 * opensession-goal-self MCP, and stopping when done. The store + validation live in
 * goals.ts; this is the runner + ticker (they need the run/MCP wiring).
 */

import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { createHumansMcpServer } from "../agents/slack/humans-tools";
import { createGoalSelfMcpServer } from "../agents/slack/goal-tools";
import {
  cancelAgentRunToken,
  isAgentSessionBusy,
  runAgent,
  steerAgentRunToken,
} from "./agent-runner";
import { defaultRepo, personaName } from "./config";
import { isDevInstance } from "./dev-mode";
import {
  LEAD_UNAVAILABLE_REASON,
  WAKE_CHECK_FAILED_REASON,
  WATCH_UNAVAILABLE_REASON,
  addGoalSpend,
  getGoal,
  goalGuardFor,
  listGoals,
  mutateGoal,
  type Goal,
} from "./goals";
import { createLeadMcpServer } from "./leads/mcp";
import { createWatchMcpServer } from "./supervisor-watch-mcp";
import { automaticFallbackModel, providerFor, routeModel } from "./models";
import { engineSessionPatch } from "./sessions";
import { STRIPE_CONFIRM_TOOLS } from "./runner-shared";
import { checkoutHeadBranch } from "./session-branch-ownership";
import { gitIdentityFor } from "./shared/user-mappings";
import { createWorktree, getRepo, reviveWorktree } from "./worktree";
import { updateSessionFile } from "./session-cache";
import { attachSessionWatchersToEngineTranscript } from "./run-session";
import type { NativeSessionFile } from "./types";
import { shouldPersistModelSwitch } from "./run-events";
import { shellQuoteWord } from "./sandbox/adapters/bootstrap";
import { newSessionId } from "./paths";
import { createWebMcpServer } from "./web-mcp";
import {
  backgroundHeadroom,
  noteBackgroundUsageLimit,
  type HeadroomVerdict,
} from "./claude-headroom";
import { isPiUsageLimitShape } from "./pi-usage-limit";
import type { SessionUsage } from "./types";

const g = globalThis as any;

// ── Goals: long-running, self-pacing missions ───────────────────────────────
// A Goal drives ONE managed session across many wakes, resuming the engine
// session each time (so context carries and the SDK compacts rather than
// forgets), pacing itself via the opensession-goal-self MCP, and stopping when done.
// The store + validation live in src/server/goals.ts; this is the runner +
// ticker (here because they need the interactive MCP wiring), mirroring how the
// session loop ticker lives in this file.

export const runningGoals: Set<string> = (g.__runningGoals ??= new Set());

/** MCP surface for a goal's own run: pull-a-human-in + its self-cadence controls.
 *  Deliberately excludes opensession-admin / opensession-sessions — an autonomous,
 *  weeks-long run gets least privilege (can't reconfigure the agent or steer other
 *  sessions); human sign-off goes through opensession-humans ask_human.
 *  A project lead's goal reaches its owner only through the supervisor inbox
 *  (opensession-lead's propose), so it gets no ask_human. */
function goalMcpServers(
  osSessionId: string,
  goal: Pick<Goal, "id" | "leadProject" | "watchOwner">,
  createdBy: string,
  lead: LeadRunPlan | undefined,
): Record<string, unknown> {
  // A person's watch reports only through the supervisor inbox and the
  // ledger it shares with the conversation: no ask_human, no goal-self
  // status or cadence tools (the server owns its schedule), no web.
  if (goal.watchOwner)
    return {
      "opensession-watch": createWatchMcpServer({ user: goal.watchOwner }),
    };
  if (goal.leadProject)
    return {
      // TODO(coordinate/act stages): spawning fix workers
      // (opensession-sessions spawn_task, send_to_session) for leads past
      // watch. Out of scope while every lead watches.
      "opensession-lead": createLeadMcpServer(goal.leadProject),
      // Its status is its settings': no tools to pause or finish itself.
      "opensession-goal-self": createGoalSelfMcpServer(goal.id, {
        lead: true,
      }),
      // A watching lead reads the project, not the web: what it reads
      // there could carry instructions it has no business taking.
      ...(lead?.web
        ? { "opensession-web": createWebMcpServer({ sessionId: osSessionId }) }
        : {}),
    };
  return {
    "opensession-humans": createHumansMcpServer({
      sessionId: osSessionId,
      createdBy,
      isAdmin: true,
    }),
    "opensession-goal-self": createGoalSelfMcpServer(goal.id),
    // Goals often measure public URLs over time. Give them the same bounded,
    // SSRF-safe reader as interactive sessions instead of opening curl in the
    // ask-mode shell allowlist.
    "opensession-web": createWebMcpServer({ sessionId: osSessionId }),
  };
}

/** The goal fields a project lead's settings decide, rebuilt every wake. */
export type LeadGoalFields = Pick<
  Goal,
  "name" | "mission" | "mode" | "repo" | "minWakeMinutes"
> & { mcpServers: string[] };

/** A lead's goal may wake: its fields from the settings, the owner's local
 *  day its wake counts towards, the tokens this wake may use, what it may
 *  still spend this month when it has a dollar cap (null: no cap), and
 *  whether it reads the web. */
export interface LeadRunPlan {
  fields: LeadGoalFields;
  day: string;
  wakeTokens: number;
  budgetUsd: number | null;
  web: boolean;
}

/** What a project lead's settings say about one wake of its goal
 *  (server/leads/goal.ts): why it must not run, or how it runs. */
export type LeadWakePlan = { block: string } | LeadRunPlan;

export interface LeadGoalHooks {
  /** Run at the start of every wake of a lead's goal. */
  wake(goal: Goal): Promise<LeadWakePlan>;
  /** Run on each tick for a lead's goal that isn't active, to lift a pause
   *  that no longer holds (a new month under the budget). */
  idle(goal: Goal, now: number): Promise<void>;
  /** Run on each tick a due wake of a lead's goal waits for headroom
   *  (goal.waiting set), so the lead can tell its owner when it has waited
   *  long. */
  waiting?(goal: Goal, now: number): Promise<void>;
}

/** Set by startProjectLeads. A lead's goal never runs without it. */
export function registerLeadGoalHooks(hooks: LeadGoalHooks): () => void {
  g.__leadGoalHooks = hooks;
  return () => {
    if (g.__leadGoalHooks === hooks) g.__leadGoalHooks = undefined;
  };
}

function leadHooks(): LeadGoalHooks | undefined {
  return g.__leadGoalHooks as LeadGoalHooks | undefined;
}

/** The lead's plan for this wake; fails closed: no hooks, or hooks that
 *  throw, block it. */
async function leadWakePlan(goal: Goal): Promise<LeadWakePlan> {
  const hooks = leadHooks();
  if (!hooks) return { block: LEAD_UNAVAILABLE_REASON };
  try {
    return await hooks.wake(goal);
  } catch (error) {
    console.error(`[goals] lead wake check for "${goal.name}" failed:`, error);
    return { block: `${WAKE_CHECK_FAILED_REASON}: ${errorText(error)}` };
  }
}

/** A lead's run past its token limit or dollar cap is asked once to
 *  finish, and stopped at this many times it (the incident post-release
 *  check's rule). A watch's run is held to its tokens the same way. */
const LEAD_WRAP_UP_FACTOR = 1.5;

/**
 * The tokens a wake used, for its loop guard: input, output and cache
 * writes in full, cache reads at a tenth. That is the weight they carry in
 * the run's cost (cache reads are billed at 0.1x), so a long wake that
 * mostly rereads its cached context isn't stopped for it. Usage is
 * run-cumulative.
 */
export function wakeTokens(usage: Partial<SessionUsage>): number {
  return Math.round(
    (usage.inputTokens ?? 0) +
      (usage.outputTokens ?? 0) +
      (usage.cacheCreationTokens ?? 0) +
      (usage.cacheReadTokens ?? 0) / 10,
  );
}

/** How long a background goal waits when its provider is low. */
export const HEADROOM_POSTPONE_MS = 30 * 60_000;

type HeadroomCheck = (route: string, now: number) => Promise<HeadroomVerdict>;
let headroomCheck: HeadroomCheck = backgroundHeadroom;

export function __setBackgroundHeadroomForTest(
  fn: HeadroomCheck | undefined,
): void {
  headroomCheck = fn ?? backgroundHeadroom;
}

/** The route (`pi/<provider>/<model>`) a goal's wake runs on. */
function goalRoute(goal: Pick<Goal, "model">): string {
  return routeModel(goal.model).model;
}
const LEAD_WRAP_UP =
  "You reached what this wake may spend. Stop reading and proposing now: append what you have to the ledger with append_ledger, set your next wake with set_next_wake, and end the wake.";
const WATCH_WRAP_UP =
  "You reached what this wake may use. Stop reading now: post what the owner must hear with post_item, append what you saw to the ledger with append_ledger, and end the wake.";

/** A person's watch goal may wake (supervisor-watch.ts): its fields from
 *  the charter, the prompt of this wake, the tokens it may use, and what
 *  to do once it ended. */
export interface WatchRunPlan {
  fields: LeadGoalFields;
  prompt: string;
  maxTokens: number;
  /** The model and effort every wake runs on, pinned by the server. */
  model: string;
  effort: string;
  /** Run once the wake ended, whatever way; resolves the next scheduled
   *  wake (ISO8601). The watch owns its schedule: the run sets none. */
  afterWake(ok: boolean): Promise<string>;
}

/** What the watch says about one wake of its goal: why it must not run
 *  (paused), that nothing needs the model now (rescheduled, unrun), or how
 *  it runs. */
export type WatchWakePlan =
  | { block: string }
  | { skip: string; nextWakeAt: string }
  | WatchRunPlan;

export interface WatchGoalHooks {
  /** Run at the start of every wake of a watch goal. */
  wake(goal: Goal): Promise<WatchWakePlan>;
  /** Run on each tick for a watch goal that isn't active. */
  idle(goal: Goal, now: number): Promise<void>;
}

/** Set by startSupervisorWatch. A watch goal never runs without it. */
export function registerWatchGoalHooks(hooks: WatchGoalHooks): () => void {
  g.__watchGoalHooks = hooks;
  return () => {
    if (g.__watchGoalHooks === hooks) g.__watchGoalHooks = undefined;
  };
}

function watchHooks(): WatchGoalHooks | undefined {
  return g.__watchGoalHooks as WatchGoalHooks | undefined;
}

/** Whether a watch goal can wake: the watch registered its hooks. */
export function watchGoalHooksRegistered(): boolean {
  return !!watchHooks();
}

/** The watch's plan for this wake; fails closed like the lead's. */
async function watchWakePlan(goal: Goal): Promise<WatchWakePlan> {
  const hooks = watchHooks();
  if (!hooks) return { block: WATCH_UNAVAILABLE_REASON };
  try {
    return await hooks.wake(goal);
  } catch (error) {
    console.error(`[goals] watch wake check for "${goal.name}" failed:`, error);
    return { block: `${WAKE_CHECK_FAILED_REASON}: ${errorText(error)}` };
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildGoalWakePrompt(
  goal: Goal,
  wake: number,
  cwd: string,
  lead?: LeadRunPlan,
): string {
  const next = goal.leadProject
    ? `- Decide when you wake next with opensession-goal-self \`set_next_wake\`. If you set none, you'll be woken again in ~24h by default.\n`
    : `- Decide what happens next with opensession-goal-self: \`set_next_wake\` (e.g. "in 7 days" after shipping, so metrics can actually move before you re-measure), or \`mark_paused\` if you're blocked on a human decision, or \`mark_done\`/\`mark_failed\` when the mission is settled. If you set none, you'll be woken again in ~24h by default.\n`;
  const parts = [
    `# Your mission (pinned)\n\n${goal.mission}`,
    `---`,
    `## This is wake #${wake} of your mission.`,
    `Your durable fact ledger is at:\n    ${goal.stateFile}\nRead it FIRST every wake — it is the authoritative record of what you've baselined, decided, shipped, and measured. Your in-context memory may have been compacted; the ledger is not.`,
    `Do ONE meaningful increment this wake. Then, before you finish, ALWAYS:\n` +
      `- Append what you learned/did this wake (concrete numbers, PR URLs, decisions) to the ledger via the opensession-goal-self \`append_ledger\` tool.\n` +
      next +
      `- Keep \`update_phase\` current so progress is visible at a glance.`,
    goal.leadProject
      ? `Reaching the owner: only through opensession-lead \`propose\` and \`post_digest_note\`, which go to the supervisor inbox. Do NOT email, message or impersonate anyone.`
      : `Human gates: to get sign-off or a decision from a teammate, use the opensession-humans \`ask_human\` tool — it DMs them as ${personaName()} and folds their reply back into this session. Do NOT email or impersonate anyone.`,
  ];
  if (lead)
    parts.push(
      `Limits: this wake may use about ${lead.wakeTokens.toLocaleString("en-US")} tokens${lead.budgetUsd === null ? "" : ` and spend about $${Number(lead.budgetUsd.toFixed(2))}, what is left of this month's cap`}. At that you are asked to wrap up, and past it the wake is stopped and the lead pauses until the owner resumes it.`,
    );
  if (goal.mode === "code") {
    const repo = getRepo(goal.repo);
    const branchLabel = JSON.stringify(repo.defaultBranch);
    const branchArg = shellQuoteWord(repo.defaultBranch);
    const remoteRefArg = shellQuoteWord(`origin/${repo.defaultBranch}`);
    if (repo.sharedCheckout) {
      // Shared-checkout repos (opensession) have NO isolated worktree — `cwd` is
      // the live main checkout the running server and every other session share.
      // A `git checkout -B`/`reset`/`pull` here yanks the working tree out from
      // under everyone and orphans their un-pushed commits, so forbid it.
      parts.push(
        `Shipping code: you are in the SHARED, live main checkout at ${cwd} on branch ${branchLabel}. The running server and other sessions use this exact working tree at the same time. NEVER create or switch branches, \`reset\`, \`pull\`, \`stash\`, or \`checkout\` (that rips the tree out from under everyone and orphans their commits). Just edit files, then \`git add <your specific files>\` → \`git commit\` → \`git push origin ${branchArg}\`. Commit + push frequently. No feature branch and no PR. This repo ships directly from branch ${branchLabel}.`,
      );
    } else if (repo.host === "codestorage") {
      parts.push(
        `Shipping code: you are in a persistent worktree at ${cwd} (kept stable across wakes so your session resumes cleanly). For each change, start clean from the default branch (\`git fetch origin ${branchArg} && git checkout -B <feature-branch> ${remoteRefArg}\`), make edits, follow the repo's AGENTS.md and run its checks/format, then commit and push your branch with \`git push -u origin <feature-branch>\`. This repo is hosted on Code Storage; there is no gh CLI and no pull requests; a pushed branch IS the change request. NEVER merge into branch ${branchLabel}. The merge is the human gate.`,
      );
    } else {
      parts.push(
        `Shipping code: you are in a persistent worktree at ${cwd} (kept stable across wakes so your session resumes cleanly). For each change, start clean from the default branch (\`git fetch origin ${branchArg} && git checkout -B <feature-branch> ${remoteRefArg}\`), make edits, follow the repo's AGENTS.md and run its checks/format, then open a PR with \`gh pr create --base ${branchArg}\`. NEVER merge. A PR is the human gate.`,
      );
    }
  }
  return parts.join("\n\n");
}

/** Run one wake of a goal: resume (or create) its session, drive one increment,
 *  then persist whatever cadence/status the run chose (with a 24h fallback). */
export async function runGoal(stored: Goal): Promise<void> {
  if (runningGoals.has(stored.id)) return;
  runningGoals.add(stored.id);
  const startedAt = new Date();
  const wake = stored.wakeCount + 1;
  const bksId = stored.osSessionId || newSessionId();
  let goal = stored;
  // The run's cost so far: usage is run-cumulative, so the largest figure
  // seen is the cost. Recorded whatever way the wake ends.
  let runCostUsd = 0;
  let runTokens = 0;
  let spendRecorded = false;
  let watch: WatchRunPlan | undefined;
  let watchSettled = false;
  // The watch's own bookkeeping after a wake, once, whatever way it ended.
  const settleWatch = async (ok: boolean): Promise<string | undefined> => {
    if (!watch || watchSettled) return undefined;
    watchSettled = true;
    try {
      return await watch.afterWake(ok);
    } catch (error) {
      console.error(
        `[goals] "${stored.name}" watch bookkeeping failed:`,
        error,
      );
      return undefined;
    }
  };
  try {
    // A lead's goal runs on what its settings say now, never on what a
    // patch or an older record left in it. A watch's the same, from its
    // charter and its owner's prefs.
    let lead: LeadRunPlan | undefined;
    if (stored.leadProject) {
      const plan = await leadWakePlan(stored);
      if ("block" in plan) {
        await pauseBeforeWake(stored, plan.block);
        return;
      }
      lead = plan;
      goal = { ...stored, ...plan.fields };
    } else if (stored.watchOwner) {
      const plan = await watchWakePlan(stored);
      if ("block" in plan) {
        await pauseBeforeWake(stored, plan.block);
        return;
      }
      if ("skip" in plan) {
        await skipWake(stored, plan.skip, plan.nextWakeAt);
        return;
      }
      watch = plan;
      goal = { ...stored, ...plan.fields, model: plan.model };
    }
    // Code goals keep ONE persistent worktree so the engine session (keyed on
    // cwd) resumes cleanly across wakes; ask goals read the main checkout,
    // a lead's the checkout of its project.
    let cwd =
      goal.leadProject && goal.repo
        ? getRepo(goal.repo).repo
        : defaultRepo().repo;
    let branch = goal.branch || "";
    if (goal.mode === "code") {
      const repo = getRepo(goal.repo);
      branch = goal.branch || `goal-${goal.id.slice(-8)}`;
      if (goal.worktreePath && (await pathExists(goal.worktreePath))) {
        cwd = goal.worktreePath;
      } else {
        try {
          cwd = await reviveWorktree(branch, repo.id);
        } catch {
          cwd = await createWorktree(branch, repo.id);
        }
      }
    }

    // Merge onto the stored record: a deleted goal stays deleted.
    const started = await mutateGoal(goal.id, (current) => ({
      ...current,
      ...lead?.fields,
      ...watch?.fields,
      osSessionId: bksId,
      branch: branch || undefined,
      worktreePath: goal.mode === "code" ? cwd : undefined,
      lastRunAt: startedAt.toISOString(),
      lastRunStatus: "running",
      lastRunError: undefined,
      // A lead's wake counts towards its day's wakes when it starts, so a
      // wake that crashes still counts.
      ...(lead
        ? (() => {
            const today = goalGuardFor(current, lead.day);
            return { guard: { ...today, wakes: today.wakes + 1 } };
          })()
        : {}),
      waiting: undefined,
    }));
    if (!started) {
      console.log(`[goals] "${goal.name}" was deleted; skipping its wake`);
      return;
    }

    const createdBy = `${goal.name} (goal)`;
    let effectiveModel = goal.model;
    let selectedModel = goal.model;
    let effectiveProvider = providerFor(effectiveModel);
    // Field-scoped write: creation fields are create-if-absent defaults (the
    // first wake creates the file, later wakes keep it); each wake owns the
    // engine-id/model fields plus the goal's live config projection
    // (mode/repo/worktree/branch/title track the goal record). Serialized
    // via updateSessionFile.
    const persistSession = async (engineSessionId: string) => {
      // Read before the mutator, which is synchronous.
      const head = goal.mode === "code" ? await checkoutHeadBranch(cwd) : null;
      await updateSessionFile(bksId, (data) => {
        // Widen to Partial: the file may not exist yet (create-if-absent).
        const existing: Partial<NativeSessionFile> = data;
        return {
          id: bksId,
          claudeSessionId: "",
          createdBy,
          createdAt: goal.createdAt,
          ...existing,
          ...(engineSessionId
            ? engineSessionPatch(effectiveProvider, engineSessionId)
            : {}),
          ...(engineSessionId ? { lastEngineProvider: effectiveProvider } : {}),
          ...(effectiveModel ? { lastEngineModel: effectiveModel } : {}),
          ...(selectedModel ? { model: selectedModel } : {}),
          // Actual worktree HEAD wins over the recorded name — the agent may
          // have switched branches mid-run (see run-session.ts's same sync).
          branch: goal.mode === "code" ? head || branch : "",
          worktreeDir: cwd,
          ...(goal.mode === "code" ? { repo: getRepo(goal.repo).id } : {}),
          title: `${goal.name} — goal`,
          mode: goal.mode,
          goalId: goal.id,
          // A project lead is Blob working on one project.
          ...(goal.leadProject ? { actedBy: "Blob" as const } : {}),
          lastActivity: new Date().toISOString(),
        };
      });
    };

    console.log(`[goals] Wake #${wake} of "${goal.name}" → ${bksId}`);

    let engineSessionId = goal.engineSessionId || "";
    let errorMsg = "";
    const runToken = randomUUID();
    let wrappedUp = false;
    let stopped = false;
    // A lead's wake past its token limit or dollar cap, or a watch's past
    // its tokens: asked once to wrap up, stopped if it keeps going.
    const over = (factor: number) =>
      lead
        ? runTokens >= lead.wakeTokens * factor ||
          (lead.budgetUsd !== null && runCostUsd >= lead.budgetUsd * factor)
        : !!watch && runTokens >= watch.maxTokens * factor;
    const wrapUp = lead ? LEAD_WRAP_UP : WATCH_WRAP_UP;
    const holdToBudget = async () => {
      if ((!lead && !watch) || stopped || !over(1)) return;
      if (!wrappedUp) {
        wrappedUp = true;
        if (steerAgentRunToken(runToken, wrapUp)) {
          console.log(`[goals] "${goal.name}" reached its limit; wrapping up`);
          return;
        }
      } else if (!over(LEAD_WRAP_UP_FACTOR)) return;
      // Only a cancel that landed counts: otherwise the next usage event
      // tries again.
      if (!(await cancelAgentRunToken(runToken).catch(() => false))) return;
      stopped = true;
      console.log(`[goals] "${goal.name}" is past its limit; stopped it`);
    };
    for await (const event of runAgent({
      prompt: watch ? watch.prompt : buildGoalWakePrompt(goal, wake, cwd, lead),
      sessionId: goal.engineSessionId || undefined,
      cwd,
      mode: goal.mode,
      model: goal.model,
      ...(watch ? { effort: watch.effort } : {}),
      // A lead never falls back to every connector: its list comes from its
      // settings, and is empty while it watches.
      // A watch's neither: it reads through opensession-watch only.
      mcpServers: goal.leadProject
        ? (lead?.fields.mcpServers ?? [])
        : goal.watchOwner
          ? (watch?.fields.mcpServers ?? [])
          : (goal.mcpServers ?? "all"),
      inProcessMcp: goalMcpServers(bksId, goal, createdBy, lead),
      confirmTools: STRIPE_CONFIRM_TOOLS,
      // A lead reads its project through opensession-lead; it gets no
      // cloud credentials.
      aws: !goal.leadProject && !goal.watchOwner,
      // A watch reads through opensession-watch only: no shell, files,
      // grep or web search, where untrusted text could lead it.
      ...(goal.watchOwner ? { disableLocalWorkspaceTools: true } : {}),
      startToken: runToken,
      author: gitIdentityFor(goal.name),
      // A goal runs on behalf of its creator; gate per-user MCP servers to them.
      user: createdBy,
      fallbackModel: watch
        ? automaticFallbackModel(goal.model)
        : goal.fallbackModel === "none"
          ? undefined
          : goal.fallbackModel || automaticFallbackModel(goal.model),
      journal: { osSessionId: bksId, kind: "goal" },
      // Headless: no onAskUser. Human gates go through opensession-humans ask_human
      // (async) and hard blocks through opensession-goal-self mark_paused.
    })) {
      if (event.type === "init") {
        engineSessionId = event.sessionId || engineSessionId;
        if (event.provider) effectiveProvider = event.provider;
        if (event.model) {
          effectiveModel = event.model;
          if (!selectedModel) selectedModel = event.model;
        }
        await persistSession(engineSessionId);
        // A goal wake's transcript file is new each wake — attach anyone
        // already viewing the goal session so the turn streams live.
        if (engineSessionId) {
          attachSessionWatchersToEngineTranscript(
            bksId,
            effectiveProvider,
            cwd,
            engineSessionId,
          );
        }
      }
      if (event.type === "model_switch") {
        const to = event.toModel || "";
        if (to) {
          effectiveModel = to;
          effectiveProvider = providerFor(to);
          if (shouldPersistModelSwitch(event)) {
            selectedModel = to;
            await mutateGoal(goal.id, (current) => ({ ...current, model: to }));
          }
        }
      }
      if (event.type === "done") {
        engineSessionId = event.sessionId || engineSessionId;
        if (event.provider) effectiveProvider = event.provider;
        if (event.model) effectiveModel = event.model;
      }
      if (event.type === "error") errorMsg = event.content || "Unknown error";
      // A run the provider refused for its usage limit holds the
      // provider's background goals for a while (claude-headroom.ts).
      if (event.type === "error" || event.type === "done") {
        const route = goalRoute({ model: effectiveModel });
        if (
          event.usageLimitExhausted === true ||
          (event.type === "error" &&
            isPiUsageLimitShape(errorMsg, route.split("/")[1] ?? ""))
        )
          noteBackgroundUsageLimit(route);
      }
      if (event.usage) {
        if (typeof event.usage.costUsd === "number")
          runCostUsd = Math.max(runCostUsd, event.usage.costUsd);
        runTokens = Math.max(runTokens, wakeTokens(event.usage));
        await holdToBudget();
      }
    }
    await persistSession(engineSessionId);
    // A wake stopped at its tokens did its work: its events are done, not
    // replayed.
    const watchNext = await settleWatch(!errorMsg || stopped);

    // The run, the UI or an operator may have rescheduled, paused or
    // finished the goal meanwhile (opensession-goal-self, the goals API).
    // Merge this wake's bookkeeping onto the current record so none of that
    // is lost, with a 24h fallback if it was left with no next wake.
    let defaulted = false;
    const next = await mutateGoal(goal.id, (fresh) => {
      const merged: Goal = {
        ...fresh,
        osSessionId: bksId,
        engineSessionId,
        model: selectedModel || fresh.model,
        branch: branch || fresh.branch,
        worktreePath: goal.mode === "code" ? cwd : fresh.worktreePath,
        wakeCount: wake,
        lastRunAt: startedAt.toISOString(),
        lastRunStatus: errorMsg ? "error" : "ok",
        lastRunError: errorMsg || undefined,
        spend: addGoalSpend(fresh.spend, runCostUsd, Date.now()),
      };
      if (stopped && !errorMsg)
        merged.lastRunError = "Stopped: it reached its limit";
      if (!merged.spend) delete merged.spend;
      // The watch's schedule is the server's, never the run's.
      if (watchNext && merged.status === "active") {
        merged.nextWakeAt = watchNext;
        return merged;
      }
      // A wake that went past its token limit trips the lead's guard. The
      // next wake's check pauses the lead and asks again, under a new key,
      // even if the owner lifted the guard earlier today. The next wake
      // stays where the lead (or the default below) put it: a trip never
      // wakes the lead early.
      if (lead && wrappedUp && runTokens >= lead.wakeTokens) {
        const { lifted: _lifted, ...guard } = goalGuardFor(merged, lead.day);
        merged.guard = {
          ...guard,
          trips: (guard.trips ?? 0) + 1,
          trippedAt: new Date().toISOString(),
          trippedTokens: runTokens,
        };
      }
      defaulted =
        merged.status === "active" &&
        Date.parse(merged.nextWakeAt) <= startedAt.getTime();
      if (defaulted) merged.nextWakeAt = dayAfter(startedAt);
      return merged;
    });
    spendRecorded = true;
    if (defaulted)
      console.log(
        `[goals] "${goal.name}" set no next wake — defaulting to +24h`,
      );
    console.log(
      `[goals] "${goal.name}" wake #${wake} ${errorMsg ? `error: ${errorMsg}` : "ok"} (status ${next?.status ?? "deleted"})`,
    );
  } catch (e: any) {
    console.error(`[goals] "${goal.name}" wake failed:`, e);
    try {
      // A watch goes back on its schedule; its daily wake cap stops a loop.
      const watchNext = await settleWatch(false);
      await mutateGoal(goal.id, (fresh) => ({
        ...fresh,
        lastRunAt: startedAt.toISOString(),
        lastRunStatus: "error",
        lastRunError: e?.message || String(e),
        // Back off a day on a hard failure so it can't hot-loop crashing.
        nextWakeAt:
          fresh.status === "active" &&
          Date.parse(fresh.nextWakeAt) <= startedAt.getTime()
            ? (watchNext ?? dayAfter(startedAt))
            : fresh.nextWakeAt,
      }));
    } catch (saveError) {
      // The catalog may be what failed; callers fire and forget this run.
      console.error(
        `[goals] "${goal.name}" could not record the failed wake:`,
        saveError,
      );
    }
  } finally {
    if (!spendRecorded && runCostUsd > 0)
      await mutateGoal(stored.id, (fresh) => ({
        ...fresh,
        spend: addGoalSpend(fresh.spend, runCostUsd, Date.now()),
      })).catch((error: unknown) =>
        console.error(
          `[goals] "${stored.name}" could not record its spend:`,
          error,
        ),
      );
    runningGoals.delete(stored.id);
  }
}

/** Put a watch goal that has nothing to do off to its next wake, unrun. */
async function skipWake(
  goal: Goal,
  reason: string,
  nextWakeAt: string,
): Promise<void> {
  await mutateGoal(goal.id, (current) =>
    current.status === "active" ? { ...current, nextWakeAt } : current,
  );
  console.log(`[goals] "${goal.name}" skipped its wake: ${reason}`);
}

/** Pause a goal that must not wake now, with the reason. */
async function pauseBeforeWake(goal: Goal, reason: string): Promise<void> {
  await mutateGoal(goal.id, (current) =>
    current.status === "active"
      ? {
          ...current,
          status: "paused",
          pauseReason: reason,
          waiting: undefined,
        }
      : current,
  );
  console.log(`[goals] "${goal.name}" paused before its wake: ${reason}`);
}

/** What boot recovery does with a goal's run a restart interrupted:
 *  `resume` it with the interactive server set (an ordinary goal, as
 *  before), or `rewake` it. A project lead's wake is never resumed: its
 *  tools, wake check and budget exist only inside runGoal, so the run is
 *  settled and the goal woken afresh. An unreadable goal is rewoken too,
 *  since it may be a lead's. */
export function goalRecoveryPlan(
  goal: Pick<Goal, "leadProject" | "watchOwner"> | null | undefined,
): "resume" | "rewake" {
  return goal && !goal.leadProject && !goal.watchOwner ? "resume" : "rewake";
}

/** The in-process servers a goal session's resumed run gets: the
 *  interactive set and its self-cadence tools for an ordinary goal, none
 *  for a lead's (settleInterruptedGoalRun keeps it from resuming at all). */
export async function goalRecoveryMcpServers(
  goalId: string,
  interactive: () => Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (goalRecoveryPlan(await getGoal(goalId)) !== "resume") return {};
  return {
    ...interactive(),
    "opensession-goal-self": createGoalSelfMcpServer(goalId),
  };
}

export const INTERRUPTED_WAKE_ERROR =
  "Interrupted by a restart: woken again instead of resumed";

/**
 * Boot recovery's hook for an interrupted run: true when it is a goal's run
 * that must not be resumed (goalRecoveryPlan says `rewake`). Its wake is
 * then recorded as interrupted and the goal is due now, so the ticker runs
 * a fresh runGoal. The goal is the one its session names, else, for a wake
 * stopped before its session file was written, the one whose session it
 * is. Fails closed: a goal it can't read is not resumed.
 */
export async function settleInterruptedGoalRun(
  run: { osSessionId?: string; kind?: string },
  sessionGoalId: string | undefined,
): Promise<boolean> {
  if (!sessionGoalId && run.kind !== "goal") return false;
  let goal: Goal | null;
  try {
    goal = sessionGoalId
      ? await getGoal(sessionGoalId)
      : ((await listGoals()).find(
          (g) => !!run.osSessionId && g.osSessionId === run.osSessionId,
        ) ?? null);
  } catch (error) {
    console.error(
      `[goals] could not read the goal of an interrupted run:`,
      error,
    );
    return true;
  }
  if (!sessionGoalId && !goal) return false;
  if (goalRecoveryPlan(goal) === "resume") return false;
  if (!goal) return true;
  const now = new Date().toISOString();
  await mutateGoal(goal.id, (current) => ({
    ...current,
    lastRunStatus: "error",
    lastRunError: INTERRUPTED_WAKE_ERROR,
    ...(current.status === "active" && current.nextWakeAt > now
      ? { nextWakeAt: now }
      : {}),
  })).catch((error: unknown) =>
    console.error(
      `[goals] "${goal.name}" could not record its interrupted wake:`,
      error,
    ),
  );
  console.log(`[goals] "${goal.name}" was interrupted; waking it afresh`);
  return true;
}

/**
 * Goals ticker: wake due goals (self-pacing, so this only fires them).
 * Called once from opensession.ts's boot block; idempotent, so a hot reload
 * never stacks a second interval. Never arm this at module scope — a wake is
 * a real engine run, so any script or test importing this module would start
 * driving live goals. Dev instances skip it (see src/server/dev-mode.ts).
 */
export function startGoalTicker(): void {
  if (g.__goalTicker || isDevInstance()) return;
  g.__goalTicker = setInterval(() => {
    tickGoals().catch((error) => console.error("[goals] tick failed:", error));
  }, 60_000);
}

// Listing is a catalog round trip; a tick still waiting on it is skipped
// rather than stacked behind.
let ticking = false;

/** One ticker pass: pause goals at their wake cap and fire due wakes without
 *  awaiting them. A pass that overlaps a running one does nothing. */
export async function tickGoals(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    const tick: TickState = { headroom: new Map(), startedWaiting: false };
    for (const goal of await listGoals()) {
      try {
        await tickGoal(goal, now, tick);
      } catch (error) {
        // One goal's failure must not hold back the others.
        console.error(`[goals] tick of "${goal.name}" failed:`, error);
      }
    }
  } finally {
    ticking = false;
  }
}

/** What one ticker pass shares across its goals: each route's headroom,
 *  asked once, and whether a goal that waited for it has started. */
interface TickState {
  headroom: Map<string, Promise<HeadroomVerdict>>;
  startedWaiting: boolean;
}

async function tickGoal(
  goal: Goal,
  now: number,
  tick: TickState,
): Promise<void> {
  if (goal.status !== "active") {
    // A lead's pause may lapse on its own (a new month under the budget).
    if (goal.leadProject) await leadHooks()?.idle(goal, now);
    if (goal.watchOwner) await watchHooks()?.idle(goal, now);
    return;
  }
  if (Date.parse(goal.nextWakeAt) > now) return;
  if (runningGoals.has(goal.id)) return;
  // Unattended work waits while its provider is low, so it never takes
  // the capacity the owner's own sessions need (claude-headroom.ts).
  // Postponed, not paused; the goal says why while it waits.
  const route = goalRoute(goal);
  let check = tick.headroom.get(route);
  if (!check) {
    check = headroomCheck(route, now).catch((): HeadroomVerdict => ({
      ok: true,
    }));
    tick.headroom.set(route, check);
  }
  const verdict = await check;
  if (!verdict.ok) {
    const nextWakeAt = new Date(now + HEADROOM_POSTPONE_MS).toISOString();
    const since = new Date(now).toISOString();
    const waited = await mutateGoal(goal.id, (current) =>
      current.status === "active" && current.nextWakeAt === goal.nextWakeAt
        ? {
            ...current,
            nextWakeAt,
            waiting: {
              reason: verdict.reason,
              since: current.waiting?.since ?? since,
            },
          }
        : current,
    );
    if (!goal.waiting)
      console.log(`[goals] "${goal.name}" waits: ${verdict.reason}`);
    if (waited?.leadProject && waited.waiting)
      await leadHooks()?.waiting?.(waited, now);
    return;
  }
  // A prior process's run may still be resuming from the journal — don't
  // double-drive the same engine session.
  if (isAgentSessionBusy(goal.engineSessionId, goal.osSessionId)) return;
  // Safety cap: stop an out-of-control mission until a human resumes it.
  if (goal.maxWakes && goal.wakeCount >= goal.maxWakes) {
    const pauseReason = `Hit safety cap of ${goal.maxWakes} wakes — resume to continue.`;
    await mutateGoal(goal.id, (current) =>
      current.status === "active"
        ? { ...current, status: "paused", pauseReason }
        : current,
    );
    console.log(`[goals] "${goal.name}" hit maxWakes ${goal.maxWakes}; paused`);
    return;
  }
  // Goals that waited start one a tick once there is room again, so they
  // don't all take the room that just came back at once.
  if (goal.waiting) {
    if (tick.startedWaiting) return;
    tick.startedWaiting = true;
  }
  void runGoal(goal);
}

function dayAfter(at: Date): string {
  return new Date(at.getTime() + 24 * 60 * 60 * 1000).toISOString();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
