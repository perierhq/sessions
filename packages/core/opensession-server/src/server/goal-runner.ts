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
  addGoalSpend,
  listGoals,
  mutateGoal,
  type Goal,
} from "./goals";
import { createLeadMcpServer } from "./leads/mcp";
import { automaticFallbackModel, providerFor } from "./models";
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
  goal: Pick<Goal, "id" | "leadProject">,
  createdBy: string,
  lead: LeadRunPlan | undefined,
): Record<string, unknown> {
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

/** A lead's goal may wake: its fields from the settings, what it may still
 *  spend this month, and whether it reads the web. */
export interface LeadRunPlan {
  fields: LeadGoalFields;
  budgetUsd: number;
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

/** A lead's run past its budget is asked once to finish, and stopped at
 *  this many times its budget (the incident post-release check's rule). */
const LEAD_WRAP_UP_FACTOR = 1.5;
const LEAD_WRAP_UP =
  "You reached what this wake may spend. Stop reading and proposing now: append what you have to the ledger with append_ledger, set your next wake with set_next_wake, and end the wake.";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Says why a goal must not wake now (it is paused with that reason), or
 *  null. Registered by owners of goals with extra rules, such as a project
 *  lead's budget, so this runner stays generic. */
export type GoalWakeCheck = (goal: Goal) => Promise<string | null>;

const wakeChecks: Set<GoalWakeCheck> = (g.__goalWakeChecks ??= new Set());

/** Add a check run at the start of every wake; returns the unsubscribe. */
export function registerGoalWakeCheck(check: GoalWakeCheck): () => void {
  wakeChecks.add(check);
  return () => {
    wakeChecks.delete(check);
  };
}

/** The first reason a check gives. A check that throws is logged; it lets
 *  an ordinary goal's wake go ahead and blocks a project lead's. */
async function wakeBlocked(goal: Goal): Promise<string | null> {
  for (const check of [...wakeChecks]) {
    try {
      const reason = await check(goal);
      if (reason) return reason;
    } catch (error) {
      console.error(`[goals] wake check for "${goal.name}" failed:`, error);
      if (goal.leadProject)
        return `${WAKE_CHECK_FAILED_REASON}: ${errorText(error)}`;
    }
  }
  return null;
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
      `Budget: this wake may spend about $${Number(lead.budgetUsd.toFixed(2))}, what is left of this month's. At that you are asked to wrap up, and past it the wake is stopped.`,
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
  let spendRecorded = false;
  try {
    // A lead's goal runs on what its settings say now, never on what a
    // patch or an older record left in it.
    let lead: LeadRunPlan | undefined;
    if (stored.leadProject) {
      const plan = await leadWakePlan(stored);
      if ("block" in plan) {
        await pauseBeforeWake(stored, plan.block);
        return;
      }
      lead = plan;
      goal = { ...stored, ...plan.fields };
    }
    const blocked = await wakeBlocked(goal);
    if (blocked) {
      await pauseBeforeWake(goal, blocked);
      return;
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
      osSessionId: bksId,
      branch: branch || undefined,
      worktreePath: goal.mode === "code" ? cwd : undefined,
      lastRunAt: startedAt.toISOString(),
      lastRunStatus: "running",
      lastRunError: undefined,
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
    // A lead's wake past what it may spend: asked once to wrap up, stopped
    // if it keeps going.
    const holdToBudget = async () => {
      if (!lead || stopped || runCostUsd < lead.budgetUsd) return;
      if (!wrappedUp) {
        wrappedUp = true;
        if (steerAgentRunToken(runToken, LEAD_WRAP_UP)) {
          console.log(`[goals] "${goal.name}" reached its budget; wrapping up`);
          return;
        }
      } else if (runCostUsd < lead.budgetUsd * LEAD_WRAP_UP_FACTOR) return;
      stopped = true;
      console.log(`[goals] "${goal.name}" is past its budget; stopping it`);
      await cancelAgentRunToken(runToken).catch(() => false);
    };
    for await (const event of runAgent({
      prompt: buildGoalWakePrompt(goal, wake, cwd, lead),
      sessionId: goal.engineSessionId || undefined,
      cwd,
      mode: goal.mode,
      model: goal.model,
      // A lead never falls back to every connector: its list comes from its
      // settings, and is empty while it watches.
      mcpServers: goal.leadProject
        ? (lead?.fields.mcpServers ?? [])
        : (goal.mcpServers ?? "all"),
      inProcessMcp: goalMcpServers(bksId, goal, createdBy, lead),
      confirmTools: STRIPE_CONFIRM_TOOLS,
      // A lead reads its project through opensession-lead; it gets no
      // cloud credentials.
      aws: !goal.leadProject,
      startToken: runToken,
      author: gitIdentityFor(goal.name),
      // A goal runs on behalf of its creator; gate per-user MCP servers to them.
      user: createdBy,
      fallbackModel:
        goal.fallbackModel === "none"
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
      if (typeof event.usage?.costUsd === "number") {
        runCostUsd = Math.max(runCostUsd, event.usage.costUsd);
        await holdToBudget();
      }
    }
    await persistSession(engineSessionId);

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
        merged.lastRunError = "Stopped: it reached its budget";
      if (!merged.spend) delete merged.spend;
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
      await mutateGoal(goal.id, (fresh) => ({
        ...fresh,
        lastRunAt: startedAt.toISOString(),
        lastRunStatus: "error",
        lastRunError: e?.message || String(e),
        // Back off a day on a hard failure so it can't hot-loop crashing.
        nextWakeAt:
          fresh.status === "active" &&
          Date.parse(fresh.nextWakeAt) <= startedAt.getTime()
            ? dayAfter(startedAt)
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

/** Pause a goal that must not wake now, with the reason. */
async function pauseBeforeWake(goal: Goal, reason: string): Promise<void> {
  await mutateGoal(goal.id, (current) =>
    current.status === "active"
      ? { ...current, status: "paused", pauseReason: reason }
      : current,
  );
  console.log(`[goals] "${goal.name}" paused before its wake: ${reason}`);
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
    for (const goal of await listGoals()) {
      try {
        await tickGoal(goal, now);
      } catch (error) {
        // One goal's failure must not hold back the others.
        console.error(`[goals] tick of "${goal.name}" failed:`, error);
      }
    }
  } finally {
    ticking = false;
  }
}

async function tickGoal(goal: Goal, now: number): Promise<void> {
  if (goal.status !== "active") {
    // A lead's pause may lapse on its own (a new month under the budget).
    if (goal.leadProject) await leadHooks()?.idle(goal, now);
    return;
  }
  if (Date.parse(goal.nextWakeAt) > now) return;
  if (runningGoals.has(goal.id)) return;
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
