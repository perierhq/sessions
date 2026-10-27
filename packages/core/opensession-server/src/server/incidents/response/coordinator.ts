// The fix loop's one effectful part. For an incident it syncs the agents'
// live status, builds the view, asks `decideNextStep` for one step, applies
// it and asks again, serialized per incident. Every intent and result is
// written into `incident.response` through the incident store's CAS write,
// so deadlines and restarts survive in the record. Woken by incident
// changes, session state events and a tick (`startIncidentResponse`, from
// boot). Owner decisions run through the same per-incident chain. Nothing
// runs at import.
import {
  type ActionRun,
  type AgentPullRequest,
  type AgentRole,
  type AgentRun,
  type AgentWorkspace,
  type CancelReason,
  type CandidateState,
  type IncidentProjectSettings,
  type IncidentResponse,
  type LedgerEntry,
  OWNER_DECISIONS,
  type OwnerDecision,
  type ProjectSpend,
  type ResponsePhase,
  SEND_BACK_NOTE_MAX,
  type SetupFix,
  roundOfMax,
} from "../../../shared/incident-response";
import { closesWhenRecovered } from "../../../shared/incident-recovery";
import {
  type Incident,
  type IncidentEvent,
  type IncidentState,
  type Observation,
  type Signal,
  type SignalEvaluation,
  isOpenIncident,
} from "../../../shared/incidents";
import type { Automation } from "../../automations";
import { serviceReadiness } from "../../service-readiness";
import { onSessionStateChange } from "../../session-state-events";
import { isShuttingDown } from "../../shutdown-state";
import { getRepo } from "../../worktree";
import {
  type AccessWidening,
  AgentAccessError,
  accessWidenedBeyond,
  resolveAgentAccess,
} from "../access/resolve";
import { type ConnectionProblem, connectionProblems } from "../access/mcp";
import { incidentAudit } from "../audit-sink";
import {
  getIncident,
  listIncidents,
  onIncidentChange,
  updateIncident,
} from "../incident-store";
import { appendEvent, transitionIncident } from "../lifecycle";
import { recentObservations } from "../observation-store";
import { trailingPasses } from "../rules";
import { getSignalEvaluation } from "../signal-runtime";
import { getSignal, setSignalRunOnCheck } from "../signal-store";
import { setProjectMonthSpend, startIncidentAccessGate } from "./access-gate";
import {
  newActionRunId,
  previousReleaseRef,
  runIncidentAction,
} from "./actions";
import {
  type AgentLive,
  type IncidentAgents,
  createIncidentAgents,
  ensureCoordinatorSession,
  ensureIncidentAutomation,
} from "./agents";
import {
  currentAgent,
  decideNextStep,
  manualRollbackAvailable,
  nextActionFor,
  rereadsReport,
  roundRan,
} from "./decide";
import { incidentWorkspaceFor } from "./host-agents";
import { appendLedger, emptyResponse, spendInMonth } from "./ledger";
import {
  type MergeGithub,
  assessAutoMerge,
  defaultMergeGithub,
  fetchPrSnapshot,
  mergeIncidentPr,
  parsePrUrl,
  prFilePaths,
} from "./merge";
import { independenceBetween, resolveRoleModels } from "./models";
import { budgetProblem } from "./policy";
import {
  getProjectSettings,
  latestForwardRelease,
  peekProjectSettings,
  projectAction,
  recordRelease,
  releaseToRollBack,
} from "./project-settings";
import { runProof } from "./proof";
import {
  INCIDENT_DOCS_DIR,
  buildInvestigatorPrompt,
  buildReminder,
  buildSendBackMessage,
  buildVerifierPrompt,
  notePathFor,
  runbookPathsFor,
} from "./prompts";
import type { CarriedWork } from "./prompts";
import { plainReportProblem } from "./reports";
import { productionRunOnProblem, runnerLabel } from "./runners";
import {
  PARALLEL_INVESTIGATOR_RETRY_MS,
  type ResponseStep,
  type ResponseView,
} from "./steps";

export const RESPONSE_TICK_MS = 5_000;
export const MAX_STEPS_PER_ADVANCE = 8;

export interface CoordinatorDeps {
  now: () => number;
  getIncident: typeof getIncident;
  updateIncident: typeof updateIncident;
  listIncidents: typeof listIncidents;
  settings: (project: string) => Promise<IncidentProjectSettings>;
  signal: (id: string) => Promise<Signal | null>;
  evaluation: (id: string) => SignalEvaluation | null;
  recent: (id: string) => Observation[];
  models: typeof resolveRoleModels;
  access: typeof resolveAgentAccess;
  /** Granted connections an agent can't open now (an expired sign-in). */
  connectionProblems: typeof connectionProblems;
  workspace: typeof incidentWorkspaceFor;
  automation: typeof ensureIncidentAutomation;
  coordinatorSession: (
    incident: Incident,
    automation: Automation,
  ) => Promise<string>;
  agents: (
    incident: Incident,
    ctx: { coordinatorSessionId: string; automation: Automation },
  ) => IncidentAgents;
  proof: typeof runProof;
  github: MergeGithub;
  /** The `owner/name` GitHub repository of a project. */
  ghRepoOf: (project: string) => string | undefined;
  /** The project's default branch, for the investigator's brief. */
  defaultBranch: (project: string) => string;
  runAction: typeof runIncidentAction;
  recordRelease: typeof recordRelease;
  /** The kill switch as this process last read or wrote it, checked again
   *  right before anything is merged or run on production. */
  agentsPaused: (project: string) => boolean;
  /** The service finished recovery and is not shutting down. Until then
   *  the tick and wake-ups do nothing. */
  ready: () => boolean;
}

function defaultDeps(): CoordinatorDeps {
  return {
    now: Date.now,
    getIncident,
    updateIncident,
    listIncidents,
    settings: getProjectSettings,
    signal: getSignal,
    evaluation: getSignalEvaluation,
    recent: (id) => recentObservations(id),
    models: resolveRoleModels,
    access: resolveAgentAccess,
    connectionProblems,
    workspace: incidentWorkspaceFor,
    automation: ensureIncidentAutomation,
    coordinatorSession: (incident, automation) =>
      ensureCoordinatorSession(incident, automation),
    agents: (incident, ctx) => createIncidentAgents(incident, ctx),
    proof: runProof,
    github: defaultMergeGithub(),
    ghRepoOf: (project) => getRepo(project).ghRepo,
    defaultBranch: (project) => {
      try {
        return getRepo(project).defaultBranch || "main";
      } catch {
        return "main";
      }
    },
    runAction: runIncidentAction,
    recordRelease,
    agentsPaused: (project) =>
      peekProjectSettings(project)?.agentsPaused === true,
    ready: () => serviceReadiness().phase === "ready" && !isShuttingDown(),
  };
}

let testDeps: Partial<CoordinatorDeps> | undefined;

/** Production deps, then the test seam, then `over`. */
export function resolveCoordinatorDeps(
  over: Partial<CoordinatorDeps> = {},
): CoordinatorDeps {
  return { ...defaultDeps(), ...testDeps, ...over };
}

export function __setCoordinatorDepsForTest(
  deps: Partial<CoordinatorDeps> | undefined,
): void {
  testDeps = deps;
}

// ── Process state ──────────────────────────────────────────────────────────

/** One promise chain per incident: advances never overlap. */
const chains = new Map<string, Promise<void>>();
/** Incidents with a scheduled advance that has not started yet. */
const queued = new Set<string>();
/** Action runs this process is executing. */
const liveActions = new Set<string>();
const agentHandles = new Map<
  string,
  { key: string; factory: CoordinatorDeps["agents"]; agents: IncidentAgents }
>();
/** Agent session id → incident id, for session state wake-ups. */
const sessionIndex = new Map<string, string>();
/** When a Stop arrived, by incident, until it is applied. Set before the
 *  decision is queued, so an advance already running sees it. */
const stopRequests = new Map<string, number>();
/** Incidents whose advance a pending Stop held back. */
const heldByStop = new Set<string>();

export function __resetCoordinatorForTest(): void {
  chains.clear();
  queued.clear();
  liveActions.clear();
  agentHandles.clear();
  sessionIndex.clear();
  stopRequests.clear();
  heldByStop.clear();
}

/** Resolves once no advance is queued or running. */
export async function __waitForCoordinatorForTest(): Promise<void> {
  while (chains.size) await Promise.allSettled([...chains.values()]);
}

function enqueue(id: string, fn: () => Promise<void>): Promise<void> {
  const previous = chains.get(id) ?? Promise.resolve();
  const run = previous.then(fn).catch((error: unknown) => {
    console.error(
      `[incidents] Fix loop for ${id} failed:`,
      error instanceof Error ? error.message : error,
    );
  });
  chains.set(id, run);
  void run.finally(() => {
    if (chains.get(id) === run) chains.delete(id);
  });
  return run;
}

/** Advance one incident until it needs nothing, serialized per incident. */
export function advanceIncident(
  incidentId: string,
  deps: Partial<CoordinatorDeps> = {},
): Promise<void> {
  return enqueue(incidentId, () =>
    advance(incidentId, resolveCoordinatorDeps(deps)),
  );
}

/** A wake-up: at most one queued advance per incident. */
export function scheduleAdvance(
  incidentId: string,
  deps: Partial<CoordinatorDeps> = {},
): void {
  if (queued.has(incidentId)) return;
  if (!resolveCoordinatorDeps(deps).ready()) return;
  queued.add(incidentId);
  void enqueue(incidentId, () => {
    queued.delete(incidentId);
    return advance(incidentId, resolveCoordinatorDeps(deps));
  });
}

/**
 * Runs `fn` in the incident's chain, after any advance already queued or
 * running, and resolves with its result. Owner decisions use it so they
 * never interleave with a step.
 */
export function runInIncidentChain<T>(
  incidentId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    void enqueue(incidentId, async () => {
      try {
        resolve(await fn());
      } catch (error) {
        reject(error);
      }
    });
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)) || "Failed";
}

function roleLabel(role: AgentRole): string {
  return role === "investigator" ? "Investigator" : "Verifier";
}

function monthOf(ms: number): string {
  return iso(ms).slice(0, 7);
}

function cents(usd: number): number {
  return Math.round(usd * 100) / 100;
}

/** `{ ...r, ...patch }` without keys set to undefined. */
function patched<T extends object>(base: T, patch: Partial<T> = {}): T {
  const out = { ...base, ...patch } as Record<string, unknown>;
  for (const key of Object.keys(out))
    if (out[key] === undefined) delete out[key];
  return out as T;
}

function event(
  incident: Incident,
  kind: IncidentEvent["kind"],
  at: string,
  detail: string,
): Incident {
  return appendEvent(incident, { at, kind, by: "sessions", detail });
}

function ledger(
  r: IncidentResponse,
  at: string,
  entry: Omit<LedgerEntry, "id" | "at">,
): IncidentResponse {
  return appendLedger(r, { at, ...entry });
}

function hhmm(at: string): string {
  return iso(Date.parse(at)).slice(11, 16);
}

async function agentsFor(
  incident: Incident,
  d: CoordinatorDeps,
): Promise<IncidentAgents | null> {
  const key = incident.response?.coordinatorSessionId;
  if (!key) return null;
  const cached = agentHandles.get(incident.id);
  if (cached && cached.key === key && cached.factory === d.agents)
    return cached.agents;
  const automation = await d.automation(incident.project);
  const agents = d.agents(incident, { coordinatorSessionId: key, automation });
  agentHandles.set(incident.id, { key, factory: d.agents, agents });
  return agents;
}

function liveRunStatus(live: AgentLive): AgentRun["status"] {
  switch (live.status) {
    case "running":
    case "waiting":
    case "error":
    case "cancelled":
      return live.status;
    default:
      return "done";
  }
}

/** Runs whose live status matters: working, or finished without a report. */
function watchedRun(run: AgentRun): boolean {
  return (
    run.status === "running" ||
    run.status === "waiting" ||
    (run.status === "done" && !run.report && !run.reportError)
  );
}

type Mutation =
  | { incident: Incident; response: IncidentResponse }
  | { error: string };

/**
 * One CAS write of the incident and its response. `guard` is what the step
 * was decided on: a write onto an incident that moved meanwhile is dropped.
 * Sets `next` and `updatedAt`; leaving `needs-you` clears `needsYou`.
 */
async function write(
  incidentId: string,
  d: CoordinatorDeps,
  settings: IncidentProjectSettings,
  guard: { state: IncidentState; phase?: string } | null,
  mutate: (c: Incident, r: IncidentResponse, at: string) => Mutation,
): Promise<Incident | null> {
  const result = await writeOrError(incidentId, d, settings, guard, mutate);
  if (result === null) return null;
  if ("error" in result) {
    console.warn(`[incidents] ${incidentId}: ${result.error}`);
    return null;
  }
  return result;
}

/** `write`, with the mutation's refusal returned instead of logged. */
async function writeOrError(
  incidentId: string,
  d: CoordinatorDeps,
  settings: IncidentProjectSettings,
  guard: { state: IncidentState; phase?: string } | null,
  mutate: (c: Incident, r: IncidentResponse, at: string) => Mutation,
): Promise<Incident | { error: string } | null> {
  const at = iso(d.now());
  const result = await d.updateIncident(incidentId, (c) => {
    if (guard && (c.state !== guard.state || c.response?.phase !== guard.phase))
      return { error: "The incident moved meanwhile" };
    const base =
      c.response ??
      emptyResponse({ now: at, maxRounds: settings.maxRounds, phase: "idle" });
    const out = mutate(c, base, at);
    if ("error" in out) return out;
    let r = out.response;
    if (c.state === "needs-you" && out.incident.state !== "needs-you")
      r = patched(r, { needsYou: undefined });
    const next: Incident = {
      ...out.incident,
      response: { ...r, updatedAt: at },
    };
    next.response!.next = nextActionFor(next, settings);
    return next;
  });
  return result;
}

function guardOf(view: ResponseView): { state: IncidentState; phase?: string } {
  return {
    state: view.incident.state,
    phase: view.incident.response?.phase,
  };
}

// ── Sync and view ──────────────────────────────────────────────────────────

/**
 * Copies the agents' live status into the record; one write at most. A run
 * that is no longer watched (it reported, stopped or failed) still has its
 * cost followed: a person may keep working in its session, and those turns
 * are the incident's too.
 */
async function syncAgents(
  incident: Incident,
  d: CoordinatorDeps,
  settings: IncidentProjectSettings,
): Promise<Incident> {
  const r = incident.response;
  if (!r?.agents.length) return incident;
  const agents = await agentsFor(incident, d);
  if (!agents) return incident;
  const lives = new Map<string, AgentLive>();
  const usages = new Map<string, { costUsd: number; tokens: number }>();
  for (const run of r.agents) {
    try {
      if (watchedRun(run))
        lives.set(run.sessionId, await agents.status(run.sessionId));
      else {
        const usage = await agents.usage(run.sessionId);
        if (usage) usages.set(run.sessionId, usage);
      }
    } catch (error) {
      console.warn(
        `[incidents] Could not read agent ${run.sessionId}:`,
        errorMessage(error),
      );
    }
  }
  const costChanged = (run: AgentRun): boolean => {
    const usage = usages.get(run.sessionId);
    return (
      !!usage &&
      !watchedRun(run) &&
      (usage.costUsd !== run.costUsd || usage.tokens !== run.tokens)
    );
  };
  const changed = (run: AgentRun): boolean => {
    const live = lives.get(run.sessionId);
    if (!live || !watchedRun(run)) return false;
    return (
      liveRunStatus(live) !== run.status ||
      live.costUsd !== run.costUsd ||
      live.tokens !== run.tokens ||
      (live.prUrl !== undefined && live.prUrl !== run.prUrl) ||
      (live.error !== undefined && live.error !== run.error)
    );
  };
  if (!r.agents.some((run) => changed(run) || costChanged(run)))
    return incident;

  const finished: AgentRun[] = [];
  const next = await write(incident.id, d, settings, null, (c, base, at) => {
    finished.length = 0;
    let response = base;
    const runs = response.agents.map((run) => {
      if (costChanged(run)) {
        const usage = usages.get(run.sessionId)!;
        return { ...run, costUsd: usage.costUsd, tokens: usage.tokens };
      }
      if (!changed(run)) return run;
      const live = lives.get(run.sessionId)!;
      const status = liveRunStatus(live);
      const updated = patched(run, {
        status,
        costUsd: live.costUsd,
        tokens: live.tokens,
        ...(live.prUrl !== undefined ? { prUrl: live.prUrl } : {}),
        ...(live.error !== undefined ? { error: live.error } : {}),
        ...(status === "running" || status === "waiting"
          ? { endedAt: undefined }
          : {}),
      });
      const wasWorking = run.status === "running" || run.status === "waiting";
      if (wasWorking && status !== "running" && status !== "waiting") {
        updated.endedAt = at;
        finished.push(updated);
      }
      return updated;
    });
    response = {
      ...response,
      agents: runs,
      costUsd: cents(runs.reduce((sum, a) => sum + (a.costUsd || 0), 0)),
    };
    for (const run of finished)
      response = ledger(response, at, {
        actor: run.role,
        kind: "agent-finished",
        detail:
          run.status === "done"
            ? `${roleLabel(run.role)} finished round ${run.round}`
            : run.status === "error"
              ? `${roleLabel(run.role)} stopped: ${run.error ?? "error"}`
              : `${roleLabel(run.role)} was cancelled`,
        sessionId: run.sessionId,
        costUsd: run.costUsd,
      });
    return { incident: c, response };
  });
  if (!next) return incident;
  for (const run of finished)
    incidentAudit({
      kind: "incident_agent_finished",
      incidentId: incident.id,
      role: run.role,
      round: run.round,
      sessionId: run.sessionId,
      status: run.status,
      costUsd: run.costUsd,
    });
  return next;
}

async function monthSpendWithout(
  project: string,
  now: number,
  exclude: string | undefined,
  d: CoordinatorDeps,
): Promise<number> {
  const month = monthOf(now);
  let sum = 0;
  for (const i of await d.listIncidents({ project }))
    if (i.id !== exclude) sum += spendInMonth(i.response, month, now);
  return cents(sum);
}

/** The project's agent spend this UTC month; the access gate reads it. */
export async function projectMonthSpend(
  project: string,
  now: number,
  deps: Partial<CoordinatorDeps> = {},
): Promise<ProjectSpend> {
  const d = resolveCoordinatorDeps(deps);
  const settings = await d.settings(project);
  const monthUsd = await monthSpendWithout(project, now, undefined, d);
  setProjectMonthSpend(project, monthUsd);
  return {
    month: monthOf(now),
    monthUsd,
    perMonthUsd: settings.budget.perMonthUsd,
  };
}

export async function buildResponseView(
  incident: Incident,
  deps: CoordinatorDeps,
  knownSettings?: IncidentProjectSettings,
): Promise<ResponseView> {
  const d = deps;
  const now = d.now();
  const settings = knownSettings ?? (await d.settings(incident.project));
  const signals = new Map<string, Signal>();
  const evaluations = new Map<string, SignalEvaluation>();
  for (const id of incident.signalIds) {
    const signal = await d.signal(id);
    if (!signal) continue;
    signals.set(id, signal);
    const evaluation = d.evaluation(id);
    if (evaluation) evaluations.set(id, evaluation);
  }
  const monthCostUsd = await monthSpendWithout(
    incident.project,
    now,
    incident.id,
    d,
  );
  setProjectMonthSpend(
    incident.project,
    cents(monthCostUsd + spendInMonth(incident.response, monthOf(now), now)),
  );

  const agents = new Map<string, AgentLive & { finalText?: string }>();
  const r = incident.response;
  // A report refused for want of a pull request is read again on a Retry.
  const reread = (run: AgentRun) => !!r && rereadsReport(r, run);
  const watched = (r?.agents ?? []).filter(
    (run) => watchedRun(run) || reread(run),
  );
  const handle = watched.length ? await agentsFor(incident, d) : null;
  if (handle)
    for (const run of watched) {
      try {
        const live = await handle.status(run.sessionId);
        const finalText =
          liveRunStatus(live) === "done" &&
          !run.report &&
          (!run.reportError || (reread(run) && live.prUrl))
            ? await handle.finalText(run.sessionId, run.turnSentAt)
            : undefined;
        agents.set(run.sessionId, {
          ...live,
          ...(finalText !== undefined ? { finalText } : {}),
        });
      } catch (error) {
        console.warn(
          `[incidents] Could not read agent ${run.sessionId}:`,
          errorMessage(error),
        );
      }
    }

  const models = d.models(settings.agents);
  let passes: Map<string, number> | undefined;
  if (closesWhenRecovered(incident)) {
    passes = new Map();
    for (const [id, signal] of signals)
      passes.set(id, trailingPasses(signal, d.recent(id)));
  }
  const setup =
    incident.state === "needs-you" &&
    incident.response?.needsYou?.kind === "setup"
      ? await setupReadiness(incident.project, models, d)
      : undefined;

  return {
    now,
    incident,
    settings,
    signals,
    evaluations,
    primaryRecent: d.recent(incident.primarySignalId),
    ...(passes ? { passes } : {}),
    ...(setup ? { setup } : {}),
    monthCostUsd,
    agents,
    liveActionRunIds: new Set(liveActions),
    models,
  };
}

/** Whether incident agents could start for `project` now: a model, then a
 *  workspace. Not, with where that is fixed. */
async function setupReadiness(
  project: string,
  models: ResponseView["models"],
  d: CoordinatorDeps,
): Promise<{ ready: boolean; fix?: SetupFix }> {
  if ("error" in models) return { ready: false, fix: "providers" };
  try {
    const workspace = await d.workspace(project, models.investigator.model);
    return "error" in workspace
      ? { ready: false, fix: "sandboxes" }
      : { ready: true };
  } catch {
    return { ready: false, fix: "sandboxes" };
  }
}

// ── The loop ───────────────────────────────────────────────────────────────

async function advance(incidentId: string, d: CoordinatorDeps): Promise<void> {
  for (let i = 0; i < MAX_STEPS_PER_ADVANCE; i++) {
    if (!d.ready()) return;
    let incident = await d.getIncident(incidentId);
    if (!incident) return;
    const settings = await d.settings(incident.project);
    if (i === 0) await retireSuperseded(incident, d);
    incident = await syncAgents(incident, d, settings);
    for (const run of incident.response?.agents ?? [])
      sessionIndex.set(run.sessionId, incident.id);
    const view = await buildResponseView(incident, d, settings);
    const step = decideNextStep(view);
    if (step.step === "none") return;
    if (shipsOrLeavesVeto(view, step) && heldBeforeEffect(view, d)) return;
    let more: boolean;
    try {
      more = await applyStep(view, step, d);
    } catch (error) {
      console.error(
        `[incidents] ${incidentId}: ${step.step} failed:`,
        errorMessage(error),
      );
      return;
    }
    if (!more) return;
  }
}

/**
 * Archive every agent a fresh session took over from whose session is
 * still open: the archive right after the takeover may have failed. Those
 * sessions are refused every turn and tool call meanwhile.
 */
async function retireSuperseded(
  incident: Incident,
  d: CoordinatorDeps,
): Promise<void> {
  const superseded = (incident.response?.agents ?? []).filter(
    (a) => a.supersededBy,
  );
  if (!superseded.length) return;
  const agents = await agentsFor(incident, d);
  if (!agents) return;
  for (const run of superseded) await retire(agents, run.sessionId);
}

async function retire(agents: IncidentAgents, sessionId: string) {
  try {
    await agents.retire(sessionId);
  } catch (error) {
    console.warn(
      `[incidents] Could not archive superseded agent ${sessionId}:`,
      errorMessage(error),
    );
  }
}

/** Steps that merge, run an action on production, or end a veto window
 *  to ship. */
function shipsOrLeavesVeto(view: ResponseView, step: ResponseStep): boolean {
  return (
    step.step === "merge" ||
    step.step === "run-action" ||
    (view.incident.state === "veto" &&
      step.step === "transition" &&
      step.to === "deploying")
  );
}

/**
 * Whether something that must win over the next effect has arrived: the
 * kill switch, or a Stop the owner sent while this advance was running.
 * During the veto a Stop counts only if it came before the deadline; once
 * shipping, it counts whenever it came, as long as Stop still applies
 * (nothing merged and nothing run yet). The advance ends; the guards or the
 * Stop go next.
 */
function heldBeforeEffect(view: ResponseView, d: CoordinatorDeps): boolean {
  if (d.agentsPaused(view.incident.project)) return true;
  const stopAt = stopRequests.get(view.incident.id);
  if (stopAt === undefined) return false;
  if (!decisionAllowed("stop", view.incident, view.settings)) return false;
  const deadline =
    view.incident.state === "veto"
      ? view.incident.response?.veto?.deadline
      : undefined;
  const cutoff =
    deadline === undefined ? Number.POSITIVE_INFINITY : Date.parse(deadline);
  const held = Number.isNaN(cutoff) || stopAt < cutoff;
  if (held) heldByStop.add(view.incident.id);
  return held;
}

/** Applies one step; false ends this advance. */
async function applyStep(
  view: ResponseView,
  step: ResponseStep,
  d: CoordinatorDeps,
): Promise<boolean> {
  switch (step.step) {
    case "none":
      return false;
    case "init":
      return init(view, step.rollbackFirst, d);
    case "start-agent":
      return startAgent(view, step, d);
    case "skip-parallel-investigator":
      return skipParallelInvestigator(view, step.outcome, step.reason, d);
    case "message-agent":
      return messageAgent(view, step, d);
    case "record-report":
      return recordReport(view, step, d);
    case "cancel-agents":
      return cancelAgents(view, step, d);
    case "run-proof":
      return proveCandidate(view, d);
    case "fetch-pr":
      return fetchPr(view, step.purpose, d);
    case "transition":
      return applyTransition(view, step, d);
    case "needs-you":
      return needsYou(view, step, d);
    case "open-veto":
      return openVeto(view, step, d);
    case "merge":
      return mergeCandidate(view, d);
    case "run-action":
      return runAction(view, step, d);
    case "start-watch":
      return startWatch(view, d);
    case "resolve":
      return resolveIncident(view, step, d);
    case "merge-note":
      return mergeNote(view, d);
  }
}

function setupProblem(
  view: ResponseView,
  d: CoordinatorDeps,
  reason: string,
  fix?: SetupFix,
): Promise<boolean> {
  return needsYou(
    view,
    {
      step: "needs-you",
      kind: "setup",
      reason,
      // A missing model or workspace stops a retry the same way.
      ...(fix ? { retryable: false, fix } : {}),
    },
    d,
  );
}

async function init(
  view: ResponseView,
  rollbackFirst: boolean,
  d: CoordinatorDeps,
): Promise<boolean> {
  const { incident, settings } = view;
  const release = rollbackFirst ? releaseToRollBack(settings) : undefined;
  const rollback = projectAction(settings, "rollback");
  // The coordinator session is created with the first agent
  // (withCoordinator), so an incident no agent ever starts on leaves no
  // empty session in the list.
  const primary = view.signals.get(incident.primarySignalId);
  const notePath = await incidentNotePath(incident, d);
  const next = await write(
    incident.id,
    d,
    settings,
    guardOf(view),
    (c, _base, at) => {
      if (c.response) return { error: "The fix loop already started" };
      let r = emptyResponse({
        now: at,
        maxRounds: settings.maxRounds,
        phase: release && rollback ? "deciding" : "investigating",
      });
      if (!release || !rollback) return { incident: c, response: r };
      const time = hhmm(release.at);
      const candidate: CandidateState = {
        round: 1,
        plan: { pr: false, actions: [rollback.id] },
        check: {
          kind: "after-deploy",
          reason: `Rolling back the release at ${time} UTC`,
        },
        claims: [],
        notePath,
        runbookPaths: runbookPathsFor(primary ?? { name: c.title }),
        rollbackFirst: true,
      };
      r = ledger({ ...r, candidate }, at, {
        actor: "sessions",
        kind: "release",
        detail: `Rolling back first: a release went out at ${time} UTC`,
      });
      const moved = transitionIncident(c, "fix-ready", {
        by: "sessions",
        detail: `Rolling back the release at ${time} UTC first`,
        at,
      });
      if ("error" in moved) return moved;
      return { incident: moved, response: r };
    },
  );
  return next !== null;
}

/** A run a fresh session takes over from, and why: the access that is
 *  wider, its branch is another incident's too (a `shared-branch` carry),
 *  or the project's sandbox changed since it ran (`moved`). `carry` set:
 *  the fresh session starts clean and brings the commits over (its brief
 *  says how); unset, it branches from the run's session. */
interface Supersede {
  run: AgentRun;
  widened: AccessWidening[];
  carry?: CarriedWork;
  moved?: boolean;
}

/** A carry for a branch another incident uses (#83's original case). */
function sharedCarry(carry: CarriedWork | undefined): boolean {
  return !!carry && (carry.reason ?? "shared-branch") === "shared-branch";
}

function sameWorkspace(a: AgentWorkspace, b: AgentWorkspace): boolean {
  return a.kind === "host"
    ? b.kind === "host" && a.user === b.user
    : b.kind === "sandbox" && a.provider === b.provider;
}

/**
 * Whether the project's agents now run somewhere other than where `run`'s
 * session did: its sandbox changed (or moved to or from the host) since.
 * That session can't take another turn there, so a new round goes to a
 * fresh one. False when the current workspace can't be read: the message
 * goes as before, and starting a session would report the setup problem.
 */
async function workspaceMoved(
  view: ResponseView,
  run: AgentRun,
  d: CoordinatorDeps,
): Promise<boolean> {
  const model =
    "error" in view.models ? run.model : view.models[run.role].model;
  try {
    const current = await d.workspace(view.incident.project, model);
    return !("error" in current) && !sameWorkspace(current, run.workspace);
  } catch {
    return false;
  }
}

async function startAgent(
  view: ResponseView,
  step: Extract<ResponseStep, { step: "start-agent" }>,
  d: CoordinatorDeps,
  supersede?: Supersede,
): Promise<boolean> {
  const { incident, settings } = view;
  const r = incident.response!;
  const { role, round, attempt } = step;
  // Rollback-first's investigator is best effort: whatever keeps it from
  // starting is recorded and the rollback goes on (rule 23).
  const parallel = parallelInvestigator(r, role);
  const problem = (reason: string, detail = reason): Promise<boolean> =>
    parallel
      ? skipParallelInvestigator(view, "unavailable", reason, d)
      : setupProblem(view, d, `Incident agents could not start: ${detail}`);
  if ("error" in view.models)
    return parallel
      ? skipParallelInvestigator(view, "unavailable", view.models.error, d)
      : setupProblem(view, d, view.models.error, "providers");
  const models = view.models;
  const primary = view.signals.get(incident.primarySignalId) ?? null;
  if (!primary)
    return problem(
      "The incident's primary signal no longer exists",
      "the incident's primary signal no longer exists",
    );

  let access;
  try {
    access = await d.access(role, incident, primary);
  } catch (error) {
    // The kill switch and budget: rules 3 and 6 see the same thing. For
    // the parallel investigator only the budget is final; anything else
    // (settings or spend not loaded yet) is tried again later.
    if (error instanceof AgentAccessError && error.code === "gate") {
      if (!parallel) return false;
      return overBudget(view)
        ? skipParallelInvestigator(view, "refused", errorMessage(error), d)
        : deferParallelInvestigator(view, errorMessage(error), d);
    }
    return problem(errorMessage(error));
  }
  // The role's model comes from the project (resolveRoleModels); access no
  // longer carries one.
  const { model, provider, label } = models[role];
  const investigator = currentAgent(r, "investigator");
  const independence =
    role === "verifier"
      ? independenceBetween(
          { model, provider },
          investigator
            ? { model: investigator.model, provider: investigator.provider }
            : models.investigator,
        )
      : undefined;

  // A granted connection it can't open is named in its brief and on the
  // card, so nobody spends a round finding out.
  const unavailable: ConnectionProblem[] = access.connections.length
    ? await d.connectionProblems(access.connections).catch(() => [])
    : [];
  const connections = { connections: access.connections, unavailable };

  const workspace = await d.workspace(incident.project, model);
  if ("error" in workspace)
    return parallel
      ? skipParallelInvestigator(view, "unavailable", workspace.error, d)
      : setupProblem(view, d, workspace.error, "sandboxes");

  // A new round in a fresh session carries the round before it: why the
  // work came back, what was found and its pull request.
  const earlier =
    role === "investigator" && investigator && investigator.round < round
      ? investigator
      : undefined;
  let prompt: string;
  if (role === "investigator") {
    const release = r.candidate?.rollbackFirst
      ? latestForwardRelease(settings)?.release
      : undefined;
    prompt = buildInvestigatorPrompt({
      incident,
      signal: primary,
      otherSignals: [...view.signals.values()].filter(
        (s) => s.id !== primary.id,
      ),
      evaluation: view.evaluations.get(primary.id) ?? null,
      recent: view.primaryRecent,
      actions: settings.actions,
      baseBranch: d.defaultBranch(incident.project),
      notePath: await incidentNotePath(incident, d),
      round,
      maxRounds: r.maxRounds,
      connections,
      ...(earlier
        ? {
            earlier: {
              round: earlier.round,
              ...(r.sendBack ? { sendBack: r.sendBack } : {}),
              ...(earlier.report?.role === "investigator"
                ? { report: earlier.report }
                : {}),
              ...(earlier.prUrl ? { prUrl: earlier.prUrl } : {}),
              ...(supersede?.carry ? { carry: supersede.carry } : {}),
            },
          }
        : r.sendBack
          ? { sendBack: r.sendBack }
          : {}),
      ...(release
        ? {
            rollbackFirst: {
              releaseAt: release.at,
              ...(release.ref ? { ref: release.ref } : {}),
            },
          }
        : {}),
    });
  } else {
    const candidate = r.candidate;
    if (!candidate?.pr || !r.proof)
      throw new Error("The verifier needs a measured candidate with its PR");
    prompt = buildVerifierPrompt({
      incident,
      signal: primary,
      candidate,
      headSha: candidate.pr.headSha,
      proof: r.proof,
      runnerLabel: runnerLabel(primary.runOn),
      independence: independence!,
      round,
      mode: access.mode,
      actions: settings.actions,
      connections,
    });
  }

  let sessionId: string;
  let branch: string;
  try {
    const agents = await agentsFor(
      await withCoordinator(incident, settings, d),
      d,
    );
    if (!agents) throw new Error("The incident has no coordinator session");
    ({ sessionId, branch } = await agents.spawn({
      role,
      round,
      attempt,
      prompt,
      model,
      // The verifier reads the investigator's work; a fresh investigator
      // starts from the work of the session it takes over from, unless
      // that session's branch is another incident's too: then it starts
      // clean and brings the commits over (its brief says how).
      ...(role === "verifier" && investigator
        ? { baseSessionId: investigator.sessionId }
        : supersede && !supersede.carry
          ? { baseSessionId: supersede.run.sessionId }
          : {}),
      access,
      workspace,
    }));
  } catch (error) {
    return problem(errorMessage(error));
  }
  sessionIndex.set(sessionId, incident.id);

  // The agent is running: it is recorded whatever moved meanwhile, and the
  // guards cancel it if it should not run.
  const next = await write(incident.id, d, settings, null, (c, base, at) => {
    if (base.agents.some((a) => a.sessionId === sessionId))
      return { incident: c, response: base };
    const superseded = supersede?.run.sessionId;
    const run: AgentRun = {
      role,
      round,
      attempt,
      sessionId,
      model,
      provider,
      ...(independence ? { independence } : {}),
      workspace,
      accessSummary: access.summary,
      accessRevision: access.revision,
      status: "running",
      startedAt: at,
      turnSentAt: at,
      costUsd: 0,
      tokens: 0,
      reminded: false,
    };
    const fresh = `${roleLabel(role)} started in a fresh session on ${label}, round ${round}`;
    const started = !supersede
      ? `${roleLabel(role)} started on ${label}, round ${round}`
      : sharedCarry(supersede.carry)
        ? `${fresh}: its branch is another incident's too (${supersede.carry!.branch})`
        : supersede.moved
          ? `${fresh}: the project's sandbox changed since its last session ran`
          : `${fresh}: its access was widened (${cappedList(supersede.widened.map((w) => w.item))})`;
    const detail = [
      started,
      ...unavailable.map((p) => `${p.connection} can't be used: ${p.reason}`),
    ].join(". ");
    const response = ledger(
      patched(base, {
        agents: [
          ...base.agents.map((a) =>
            a.sessionId === superseded
              ? patched(a, { supersededBy: sessionId })
              : a,
          ),
          run,
        ],
        retryRequested: undefined,
        parallelInvestigatorRetryAt: undefined,
        // The send-back reason went into the fresh session's brief.
        ...(role === "investigator" ? { sendBack: undefined } : {}),
      }),
      at,
      { actor: "sessions", kind: "agent-started", detail, sessionId },
    );
    return { incident: event(c, "agent", at, detail), response };
  });
  if (!next) return false;
  incidentAudit({
    kind: "incident_agent_started",
    incidentId: incident.id,
    role,
    round,
    attempt,
    sessionId,
    model,
    independence,
    workspace: workspace.kind,
    accessRevision: access.revision,
    ...(supersede ? { supersedes: supersede.run.sessionId } : {}),
  });
  if (supersede) {
    const agents = await agentsFor(next, d);
    if (agents) await retire(agents, supersede.run.sessionId);
    // A pull request on a shared branch is the other incident's: it stays.
    if (!sharedCarry(supersede.carry))
      await closeSupersededPr(
        view,
        supersede.run,
        {
          round,
          branch,
          why: supersede.moved
            ? "the project's sandbox changed since this session ran"
            : "the investigator's access was widened after it started",
        },
        d,
      );
  }
  return true;
}

/** Up to three items in a sentence; more are counted ("a, b and 4 more"). */
function cappedList(items: string[]): string {
  const unique = [...new Set(items)];
  if (unique.length > 3)
    return `${unique.slice(0, 2).join(", ")} and ${unique.length - 2} more`;
  return unique.length > 1
    ? `${unique.slice(0, -1).join(", ")} and ${unique.at(-1)}`
    : (unique[0] ?? "");
}

/**
 * Close the superseded run's pull request with a comment naming the fresh
 * session's branch, which starts from its work. Best effort: a pull request
 * in another repository, or one GitHub refuses to close, is left open.
 */
async function closeSupersededPr(
  view: ResponseView,
  run: AgentRun,
  fresh: { round: number; branch: string; why: string },
  d: CoordinatorDeps,
): Promise<void> {
  const prUrl = view.agents.get(run.sessionId)?.prUrl ?? run.prUrl;
  const pr = prUrl ? parsePrUrl(prUrl) : null;
  if (!pr) return;
  try {
    const own = d.ghRepoOf(view.incident.project);
    if (!own || own.toLowerCase() !== pr.ghRepo.toLowerCase()) return;
    const credential = await d.github.appCredential(pr.ghRepo);
    await d.github.comment(
      pr.ghRepo,
      pr.number,
      `Superseded: ${fresh.why}, so round ${fresh.round} continues in a fresh session on \`${fresh.branch}\`, which starts from this pull request's work. Closing this one.`,
      credential,
    );
    await d.github.close(pr.ghRepo, pr.number, credential);
  } catch (error) {
    console.warn(
      `[incidents] Could not close superseded pull request ${prUrl}:`,
      errorMessage(error),
    );
  }
}

/**
 * The run's branch and checkpoint when another incident's agent works on the
 * same branch. An older release named incident branches from the date and
 * title only, so the same signal failing twice in a day shared one branch
 * and its pull request; sending such a run back would push onto the other
 * incident's pull request. Sessions now take their own branches, so this
 * only finds runs started before that.
 */
async function sharedBranch(
  view: ResponseView,
  run: AgentRun,
  agents: IncidentAgents,
  d: CoordinatorDeps,
): Promise<CarriedWork | undefined> {
  const work = await agents.work(run.sessionId);
  if (!work?.branch) return undefined;
  const { incident } = view;
  for (const other of await d.listIncidents({ project: incident.project })) {
    if (other.id === incident.id) continue;
    for (const a of other.response?.agents ?? []) {
      if (!a.sessionId || a.sessionId === run.sessionId) continue;
      if ((await agents.work(a.sessionId))?.branch === work.branch) return work;
    }
  }
  return undefined;
}

/** The incident's note path, next to the project's other incidents. */
async function incidentNotePath(
  incident: Incident,
  d: CoordinatorDeps,
): Promise<string> {
  try {
    return notePathFor(
      incident,
      await d.listIncidents({ project: incident.project }),
    );
  } catch {
    return notePathFor(incident);
  }
}

/**
 * What the role's access allows now beyond what the run's session is bound
 * to. A running agent never gains access, so a wider access is for a fresh
 * session. Empty when it is the same or narrower, or when it can't be read:
 * the message then goes as before and its turn re-resolves the access.
 */
async function widenedSinceStart(
  view: ResponseView,
  run: AgentRun,
  agents: IncidentAgents,
  d: CoordinatorDeps,
): Promise<AccessWidening[]> {
  const primary = view.signals.get(view.incident.primarySignalId);
  if (!primary) return [];
  try {
    const bound = await agents.bound(run.sessionId);
    if (!bound) return [];
    const access = await d.access(run.role, view.incident, primary, {
      audit: false,
    });
    return accessWidenedBeyond(access, bound);
  } catch {
    return [];
  }
}

/**
 * The incident with its coordinator session, created now when the fix loop
 * started without one (watch only, then agents on). One the record got
 * meanwhile is reused, never a second one beside it. Recorded whatever moved
 * meanwhile: the session exists either way.
 */
async function withCoordinator(
  incident: Incident,
  settings: IncidentProjectSettings,
  d: CoordinatorDeps,
): Promise<Incident> {
  const r = incident.response;
  if (!r || r.coordinatorSessionId) return incident;
  const withSession = (ids: {
    coordinatorSessionId: string;
    automationId?: string;
  }): Incident => ({ ...incident, response: patched(r, ids) });
  const stored = (await d.getIncident(incident.id))?.response;
  if (stored?.coordinatorSessionId)
    return withSession({
      coordinatorSessionId: stored.coordinatorSessionId,
      automationId: stored.automationId ?? r.automationId,
    });
  const automation = await d.automation(incident.project);
  const created = await d.coordinatorSession(incident, automation);
  const next = await write(incident.id, d, settings, null, (c, base) => ({
    incident: c,
    response: base.coordinatorSessionId
      ? base
      : {
          ...base,
          coordinatorSessionId: created,
          automationId: automation.id,
        },
  }));
  // What the record holds wins: a session written meanwhile is the one.
  const kept = next?.response;
  return withSession(
    kept?.coordinatorSessionId
      ? {
          coordinatorSessionId: kept.coordinatorSessionId,
          automationId: kept.automationId ?? automation.id,
        }
      : { coordinatorSessionId: created, automationId: automation.id },
  );
}

/** Whether starting `role` now is rollback-first's parallel investigator. */
function parallelInvestigator(r: IncidentResponse, role: AgentRole): boolean {
  return (
    role === "investigator" &&
    r.candidate?.rollbackFirst === true &&
    r.phase !== "investigating"
  );
}

/**
 * Records that rollback-first's parallel investigator did not start, and
 * why, so the rollback goes on without it. Written whatever moved meanwhile:
 * it only ever stops a second try.
 */
async function skipParallelInvestigator(
  view: ResponseView,
  outcome: "unavailable" | "refused",
  reason: string,
  d: CoordinatorDeps,
): Promise<boolean> {
  const { incident, settings } = view;
  const detail = `Investigator not started alongside the rollback: ${reason}`;
  const next = await write(incident.id, d, settings, null, (c, base, at) => {
    if (
      !base.candidate?.rollbackFirst ||
      base.parallelInvestigator ||
      currentAgent(base, "investigator")
    )
      return { incident: c, response: base };
    return {
      incident: c,
      response: ledger(
        patched(base, {
          parallelInvestigator: outcome,
          parallelInvestigatorRetryAt: undefined,
        }),
        at,
        { actor: "sessions", kind: "policy", detail },
      ),
    };
  });
  return next !== null;
}

/** Whether the incident or the month is over its agent budget. */
function overBudget(view: ResponseView): boolean {
  const r = view.incident.response!;
  return (
    budgetProblem({
      incidentCostUsd: r.costUsd,
      monthCostUsd: view.monthCostUsd + r.costUsd,
      budget: view.settings.budget,
    }) !== null
  );
}

/**
 * Rollback-first's parallel investigator was refused by the access gate for
 * a passing reason: it is tried again after a while, and the rollback goes
 * on meanwhile. The first refusal is written to the ledger. Written
 * whatever moved meanwhile, like a skip.
 */
async function deferParallelInvestigator(
  view: ResponseView,
  reason: string,
  d: CoordinatorDeps,
): Promise<boolean> {
  const { incident, settings } = view;
  const retryAt = iso(d.now() + PARALLEL_INVESTIGATOR_RETRY_MS);
  const next = await write(incident.id, d, settings, null, (c, base, at) => {
    if (
      !base.candidate?.rollbackFirst ||
      base.parallelInvestigator ||
      currentAgent(base, "investigator")
    )
      return { incident: c, response: base };
    const first = base.parallelInvestigatorRetryAt === undefined;
    const response = { ...base, parallelInvestigatorRetryAt: retryAt };
    return {
      incident: c,
      response: first
        ? ledger(response, at, {
            actor: "sessions",
            kind: "policy",
            detail: `Investigator not started alongside the rollback yet: ${reason}. Trying again shortly`,
          })
        : response,
    };
  });
  return next !== null;
}

async function messageAgent(
  view: ResponseView,
  step: Extract<ResponseStep, { step: "message-agent" }>,
  d: CoordinatorDeps,
): Promise<boolean> {
  const { incident, settings } = view;
  const r = incident.response!;
  const run = r.agents.find((a) => a.sessionId === step.sessionId);
  if (!run) return false;
  const sendBack = step.message === "send-back";
  const agents = await agentsFor(incident, d);
  if (!agents) return false;
  // A new round for an agent whose access was widened since it started
  // goes to a fresh session; the old one is archived.
  if (sendBack) {
    const widened = await widenedSinceStart(view, run, agents, d);
    const shared = await sharedBranch(view, run, agents, d);
    const moved = await workspaceMoved(view, run, d);
    if (widened.length || shared || moved) {
      // The fresh session branches from this one only where the controller
      // would allow it: same workspace, its branch pushed at its last
      // commit and nothing uncommitted. Otherwise it starts clean and
      // brings the commits over from the session's checkpoint.
      let carry: CarriedWork | undefined = shared;
      if (!carry && (moved || !(await agents.stackable(run.sessionId)))) {
        const work = await agents.work(run.sessionId);
        carry = {
          branch: work?.branch ?? "",
          ...(work?.checkpoint ? { checkpoint: work.checkpoint } : {}),
          reason: moved ? "workspace" : "unpushed",
        };
      }
      return startAgent(
        view,
        {
          step: "start-agent",
          role: run.role,
          round: r.round,
          attempt: run.attempt + 1,
        },
        d,
        {
          run,
          widened,
          ...(carry ? { carry } : {}),
          ...(moved ? { moved } : {}),
        },
      );
    }
  }
  const text = sendBack
    ? buildSendBackMessage(
        r.round,
        r.maxRounds,
        r.sendBack ?? { kind: "reopened", detail: "The work was sent back" },
      )
    : buildReminder(
        // A run refused before every issue was kept has its first one.
        run.reportIssues ?? [
          {
            problem: run.reportProblem ?? "missing",
            error: run.reportError ?? "No incident-report block",
          },
        ],
        run.role,
      );
  await agents.send(
    run.sessionId,
    text,
    `incident:${incident.id}:msg:${r.round}:${r.ledger.length + r.droppedLedger}`,
  );
  const next = await write(
    incident.id,
    d,
    settings,
    guardOf(view),
    (c, base, at) => {
      const agentsNext = base.agents.map((a) => {
        if (a.sessionId !== run.sessionId) return a;
        return sendBack
          ? patched(a, {
              round: base.round,
              status: "running",
              turnSentAt: at,
              endedAt: undefined,
              report: undefined,
              reportError: undefined,
              reportProblem: undefined,
              reportIssues: undefined,
              reminded: false,
            })
          : patched(a, {
              status: "running",
              turnSentAt: at,
              endedAt: undefined,
              reportError: undefined,
              reportProblem: undefined,
              reportIssues: undefined,
              reminded: true,
            });
      });
      const detail = sendBack
        ? `Sent the ${run.role} round ${roundOfMax(base.round, base.maxRounds)}`
        : `Asked the ${run.role} for a valid report`;
      const response = ledger(
        patched(base, {
          agents: agentsNext,
          ...(sendBack ? { sendBack: undefined } : {}),
        }),
        at,
        {
          actor: "sessions",
          kind: "agent-message",
          detail,
          sessionId: run.sessionId,
        },
      );
      return { incident: event(c, "agent", at, detail), response };
    },
  );
  return next !== null;
}

async function recordReport(
  view: ResponseView,
  step: Extract<ResponseStep, { step: "record-report" }>,
  d: CoordinatorDeps,
): Promise<boolean> {
  const { incident, settings } = view;
  const run = incident.response!.agents.find(
    (a) => a.sessionId === step.sessionId,
  );
  if (!run) return false;
  const report = step.report;
  const reported = report
    ? report.role === "investigator"
      ? `Investigator reported: ${report.summary}`
      : `Verifier: ${report.verdict === "certain" ? "certain" : "not certain"}`
    : plainReportProblem(run.role, step.problem);
  const detail =
    report && step.reread && step.prUrl
      ? `Found the investigator's pull request ${step.prUrl}. ${reported}`
      : reported;
  if (!report)
    console.warn(
      `[incidents] ${incident.id}: ${run.role} report refused: ${step.error ?? "unknown"}`,
    );
  const warnings = report ? (step.warnings ?? []) : [];
  const shown = warnings.length
    ? `${detail}. Repaired: ${warnings.join("; ")}`
    : detail;
  const next = await write(
    incident.id,
    d,
    settings,
    guardOf(view),
    (c, base, at) => {
      const agentsNext = base.agents.map((a) =>
        a.sessionId !== run.sessionId
          ? a
          : patched(
              a,
              report
                ? {
                    report,
                    reportWarnings: warnings.length ? warnings : undefined,
                    // A report read again replaces the refusal.
                    reportError: undefined,
                    reportProblem: undefined,
                    reportIssues: undefined,
                    ...(step.prUrl ? { prUrl: step.prUrl } : {}),
                  }
                : {
                    reportError: step.error ?? "Invalid",
                    reportProblem: step.problem,
                    reportIssues: step.issues,
                  },
            ),
      );
      const response = ledger(
        patched(base, {
          agents: agentsNext,
          // The Retry is answered: nothing starts over.
          ...(report && step.reread ? { retryRequested: undefined } : {}),
        }),
        at,
        {
          actor: run.role,
          kind: report?.role === "verifier" ? "verdict" : "agent-finished",
          detail: shown,
          sessionId: run.sessionId,
        },
      );
      const withEvent =
        report?.role === "verifier" ? event(c, "verdict", at, detail) : c;
      return { incident: withEvent, response };
    },
  );
  if (!next) return false;
  if (report?.role === "verifier")
    incidentAudit({
      kind: "incident_verdict",
      incidentId: incident.id,
      round: run.round,
      verdict: report.verdict,
    });
  return true;
}

async function cancelAgents(
  view: ResponseView,
  step: Extract<ResponseStep, { step: "cancel-agents" }>,
  d: CoordinatorDeps,
): Promise<boolean> {
  const { incident, settings } = view;
  const r = incident.response!;
  const agents = await agentsFor(incident, d);
  const running = r.agents.filter((a) => {
    const live = view.agents.get(a.sessionId);
    const status = live ? liveRunStatus(live) : a.status;
    return (
      a.status !== "cancelled" &&
      a.status !== "error" &&
      (status === "running" || status === "waiting")
    );
  });
  const cancelled = new Set<string>();
  for (const run of running) {
    try {
      await agents?.cancel(
        run.sessionId,
        `incident:${incident.id}:cancel:${run.sessionId}:${run.turnSentAt}`,
      );
      cancelled.add(run.sessionId);
    } catch (error) {
      console.error(
        `[incidents] Could not cancel agent ${run.sessionId}:`,
        errorMessage(error),
      );
    }
  }
  if (!cancelled.size) return false;
  const next = await write(
    incident.id,
    d,
    settings,
    guardOf(view),
    (c, base, at) => {
      let response = patched(base, {
        agents: base.agents.map((a) =>
          cancelled.has(a.sessionId)
            ? patched(a, {
                status: "cancelled",
                cancelledFor: step.for,
                error: step.reason,
                endedAt: at,
              })
            : a,
        ),
      });
      for (const run of running)
        if (cancelled.has(run.sessionId))
          response = ledger(response, at, {
            actor: "sessions",
            kind: step.for === "budget" ? "budget" : "agent-finished",
            detail: `${roleLabel(run.role)} stopped: ${step.reason}`,
            sessionId: run.sessionId,
          });
      return {
        incident: event(c, "agent", at, `Agents stopped: ${step.reason}`),
        response,
      };
    },
  );
  if (!next) return false;
  if (step.for === "budget")
    incidentAudit({
      kind: "incident_budget",
      incidentId: incident.id,
      costUsd: r.costUsd,
      capUsd: settings.budget.perIncidentUsd,
    });
  return cancelled.size === running.length;
}

async function proveCandidate(
  view: ResponseView,
  d: CoordinatorDeps,
): Promise<boolean> {
  const { incident, settings } = view;
  const r = incident.response!;
  const primary = view.signals.get(incident.primarySignalId);
  if (!primary)
    return needsYou(
      view,
      {
        step: "needs-you",
        kind: "proof-stopped",
        reason: "The incident's primary signal no longer exists",
      },
      d,
    );
  if (!r.candidate) return false;
  const proof = await d.proof({
    signal: primary,
    evaluation: view.evaluations.get(primary.id) ?? null,
    recent: view.primaryRecent,
    check: r.candidate.check,
    round: r.round,
  });
  const fails = proof.baseline.samples.filter((s) => s.result === "fail");
  const detail = `Baseline ${proof.baseline.verdict} (${fails.length}/${proof.baseline.samples.length}), candidate ${proof.candidate.verdict} from ${runnerLabel(proof.runner)}`;
  const next = await write(
    incident.id,
    d,
    settings,
    guardOf(view),
    (c, base, at) => ({
      incident: event(c, "proof", at, detail),
      response: ledger(patched(base, { proof }), at, {
        actor: "sessions",
        kind: "proof",
        detail,
        ...(proof.runner ? { runner: proof.runner } : {}),
      }),
    }),
  );
  if (!next) return false;
  incidentAudit({
    kind: "incident_proof",
    incidentId: incident.id,
    round: proof.round,
    baseline: proof.baseline.verdict,
    candidate: proof.candidate.verdict,
    runner: proof.runner,
  });
  return true;
}

async function fetchPr(
  view: ResponseView,
  purpose: "verify" | "merge" | "note",
  d: CoordinatorDeps,
): Promise<boolean> {
  const { incident, settings } = view;
  const r = incident.response!;
  const note = purpose === "note";
  const investigator = currentAgent(r, "investigator");
  const prUrl = note
    ? (view.agents.get(investigator?.sessionId ?? "")?.prUrl ??
      investigator?.prUrl)
    : r.candidate?.prUrl;
  if (!prUrl) {
    if (note) return false;
    return needsYou(
      view,
      {
        step: "needs-you",
        kind: "merge",
        reason: "The candidate has no pull request",
      },
      d,
    );
  }
  const snapshot = await fetchPrSnapshot(
    { prUrl, repoId: incident.project, now: d.now() },
    d.github,
    { ghRepoOf: d.ghRepoOf },
  );
  if ("error" in snapshot) {
    if (!note)
      return needsYou(
        view,
        { step: "needs-you", kind: "merge", reason: snapshot.error },
        d,
      );
    return applyTransition(
      view,
      {
        step: "transition",
        to: null,
        phase: "done",
        detail: snapshot.error,
        patch: { note: { prUrl, merged: false, detail: snapshot.error } },
      },
      d,
    );
  }
  const next = await write(
    incident.id,
    d,
    settings,
    guardOf(view),
    (c, base) => {
      if (note)
        return {
          incident: c,
          response: patched(base, {
            note: {
              ...base.note,
              prUrl,
              pr: snapshot,
              merged: base.note?.merged ?? false,
            },
          }),
        };
      if (!base.candidate) return { error: "The candidate is gone" };
      return {
        incident: c,
        response: patched(base, {
          candidate: { ...base.candidate, pr: snapshot },
        }),
      };
    },
  );
  return next !== null;
}

async function applyTransition(
  view: ResponseView,
  step: Extract<ResponseStep, { step: "transition" }>,
  d: CoordinatorDeps,
): Promise<boolean> {
  const { incident, settings } = view;
  const next = await write(
    incident.id,
    d,
    settings,
    guardOf(view),
    (c, base, at) => {
      let moved: Incident = c;
      if (step.to) {
        const result = transitionIncident(c, step.to, {
          by: "sessions",
          detail: step.detail,
          at,
          ...(step.fixedBy ? { fixedBy: step.fixedBy } : {}),
        });
        if ("error" in result) return result;
        moved = result;
      }
      return {
        incident: moved,
        response: patched({ ...base, phase: step.phase }, step.patch),
      };
    },
  );
  if (next?.state === "closed-without-action")
    void enqueue(incident.id, () => settleAgentPrs(incident.id, d));
  return next !== null;
}

async function needsYou(
  view: ResponseView,
  step: Extract<ResponseStep, { step: "needs-you" }>,
  d: CoordinatorDeps,
): Promise<boolean> {
  const { incident, settings } = view;
  await write(incident.id, d, settings, guardOf(view), (c, base, at) => {
    const b = patched(base, step.patch);
    const resumePhase =
      b.phase === "needs-you"
        ? (b.needsYou?.resumePhase ?? "investigating")
        : b.phase;
    const response = ledger(
      patched(
        {
          ...b,
          phase: "needs-you" as const,
          needsYou: {
            kind: step.kind,
            reason: step.reason,
            since: at,
            resumePhase,
            ...(step.retryable === false ? { retryable: false } : {}),
            ...(step.fix ? { fix: step.fix } : {}),
          },
        },
        { retryRequested: undefined },
      ),
      at,
      {
        actor: "sessions",
        kind: step.kind === "budget" ? "budget" : "policy",
        detail: `Needs you: ${step.reason}`,
      },
    );
    if (c.state === "needs-you") return { incident: c, response };
    let from: Incident = c;
    if (step.via && c.state !== step.via) {
      const through = transitionIncident(c, step.via, {
        by: "sessions",
        detail: step.reason,
        at,
      });
      if ("error" in through) return through;
      from = through;
    }
    const moved = transitionIncident(from, "needs-you", {
      by: "sessions",
      detail: step.reason,
      at,
    });
    if ("error" in moved) return moved;
    return { incident: moved, response };
  });
  // Waiting on a person: nothing more to do in this advance.
  return false;
}

// ── Veto, merge, actions, watch, notes ─────────────────────────────────────

async function openVeto(
  view: ResponseView,
  step: Extract<ResponseStep, { step: "open-veto" }>,
  d: CoordinatorDeps,
): Promise<boolean> {
  const { incident, settings } = view;
  const deadline = iso(view.now + step.decision.vetoMs);
  const detail = `Deploys at ${deadline} unless stopped. ${step.decision.rule}`;
  const next = await write(
    incident.id,
    d,
    settings,
    guardOf(view),
    (c, base, at) => {
      const moved = transitionIncident(c, "veto", {
        by: "sessions",
        detail: step.decision.rule,
        at,
      });
      if ("error" in moved) return moved;
      return {
        incident: event(moved, "policy", at, detail),
        response: ledger(
          {
            ...base,
            phase: "veto",
            decision: step.decision,
            veto: { startedAt: at, deadline },
          },
          at,
          { actor: "sessions", kind: "veto", detail },
        ),
      };
    },
  );
  if (!next) return false;
  incidentAudit({
    kind: "incident_veto",
    incidentId: incident.id,
    event: "opened",
    deadline,
  });
  return true;
}

function investigatorSummary(r: IncidentResponse): string | undefined {
  const report = currentAgent(r, "investigator")?.report;
  return report?.role === "investigator" ? report.summary : undefined;
}

/**
 * Merges the verified head. A fresh snapshot is read right before the
 * merge and assessed again: if anything moved (head, reviews, checks),
 * nothing is merged and the next step decides on the fresh snapshot.
 */
async function mergeCandidate(
  view: ResponseView,
  d: CoordinatorDeps,
): Promise<boolean> {
  const { incident, settings } = view;
  const r = incident.response!;
  const prUrl = r.candidate?.prUrl ?? r.candidate?.pr?.url;
  const verifiedSha = r.verdict?.verifiedSha ?? "";
  if (!prUrl || !verifiedSha)
    return needsYou(
      view,
      {
        step: "needs-you",
        kind: "merge",
        reason: "There is no verified pull request to merge",
      },
      d,
    );
  const fresh = await fetchPrSnapshot(
    { prUrl, repoId: incident.project, now: d.now() },
    d.github,
    { ghRepoOf: d.ghRepoOf },
  );
  if ("error" in fresh)
    return needsYou(
      view,
      { step: "needs-you", kind: "merge", reason: fresh.error },
      d,
    );
  if (assessAutoMerge(fresh, verifiedSha).kind !== "ready") {
    const next = await write(
      incident.id,
      d,
      settings,
      guardOf(view),
      (c, base) =>
        base.candidate
          ? {
              incident: c,
              response: {
                ...base,
                candidate: { ...base.candidate, pr: fresh },
              },
            }
          : { error: "The candidate is gone" },
    );
    return next !== null;
  }
  if (heldBeforeEffect(view, d)) return false;
  const record = await mergeIncidentPr(
    {
      incidentId: incident.id,
      pr: fresh,
      verifiedSha,
      title: investigatorSummary(r) ?? incident.title,
      now: d.now(),
    },
    d.github,
  );
  if (record.status === "merged" && !record.mergedSha) {
    const mergedSha = await d.github
      .mergeCommit(fresh.ghRepo, fresh.number)
      .catch(() => undefined);
    if (mergedSha) record.mergedSha = mergedSha;
  }
  const n = `PR #${fresh.number}`;
  const detail =
    record.status === "merged"
      ? `Merged ${n} at ${verifiedSha.slice(0, 7)} as the GitHub App`
      : `Did not merge ${n}: ${record.detail ?? "refused"}`;
  // The merge happened: it is recorded whatever moved meanwhile.
  const next = await write(incident.id, d, settings, null, (c, base, at) => ({
    incident: event(c, "merge", at, detail),
    response: ledger(
      {
        ...base,
        merge: record,
        ...(base.candidate
          ? { candidate: { ...base.candidate, pr: fresh } }
          : {}),
      },
      at,
      { actor: "sessions", kind: "merge", detail },
    ),
  }));
  return next !== null;
}

function actionLedgerDetail(run: ActionRun): string {
  return `${run.label} on ${runnerLabel(run.runner)}: ${run.status} (${run.detail})`;
}

/**
 * Runs one action on its production Runner. The intent is written first;
 * the run is live only in this process, so a restart finds it `running`
 * without a live id and never runs it again.
 */
async function runAction(
  view: ResponseView,
  step: Extract<ResponseStep, { step: "run-action" }>,
  d: CoordinatorDeps,
): Promise<boolean> {
  const { incident, settings } = view;
  const r = incident.response!;
  const action = settings.actions.find((a) => a.id === step.actionId);
  if (!action)
    return needsYou(
      view,
      {
        step: "needs-you",
        kind: "no-action",
        reason: `The action ${step.actionId} is no longer in the project settings`,
      },
      d,
    );
  if (heldBeforeEffect(view, d)) return false;
  const runId = newActionRunId();
  const ref = action.kind === "deploy" ? r.merge?.mergedSha : undefined;
  const previousRef =
    action.kind === "rollback" ? previousReleaseRef(settings) : undefined;
  const intent: ActionRun = {
    id: runId,
    round: r.round,
    actionId: action.id,
    kind: action.kind,
    label: action.label,
    runner: action.runner,
    status: "running",
    purpose: step.purpose,
    startedAt: iso(d.now()),
    detail: "Running",
    secretTouched: action.needsSecret,
  };
  liveActions.add(runId);
  let result: ActionRun;
  try {
    const started = await write(
      incident.id,
      d,
      settings,
      guardOf(view),
      (c, base) =>
        // The kill switch, read again as the intent commits.
        d.agentsPaused(incident.project)
          ? { error: `Agents paused for ${incident.project}` }
          : {
              incident: c,
              response: { ...base, actionRuns: [...base.actionRuns, intent] },
            },
    );
    if (!started) return false;
    try {
      result = await d.runAction({
        runId,
        incidentId: incident.id,
        round: r.round,
        project: incident.project,
        action,
        vars: {
          incident: incident.id,
          project: incident.project,
          ...(ref !== undefined ? { ref } : {}),
          ...(previousRef !== undefined ? { previousRef } : {}),
        },
        owner: incident.owner,
        purpose: step.purpose,
        ...(r.coordinatorSessionId
          ? { sessionId: r.coordinatorSessionId }
          : {}),
      });
    } catch (error) {
      result = {
        ...intent,
        status: "unknown",
        endedAt: iso(d.now()),
        detail: `${errorMessage(error)}. Check production before going on.`,
      };
    }
  } finally {
    liveActions.delete(runId);
  }
  const detail = actionLedgerDetail(result);
  const next = await write(incident.id, d, settings, null, (c, base, at) => ({
    incident: event(c, "action", at, detail),
    response: ledger(
      {
        ...base,
        actionRuns: base.actionRuns.map((a) =>
          a.id === runId ? { ...result, id: runId } : a,
        ),
      },
      at,
      {
        actor: "sessions",
        kind: "action",
        detail,
        runner: result.runner,
        secretTouched: result.secretTouched,
      },
    ),
  }));
  if (
    result.status === "ok" &&
    (action.kind === "deploy" || action.kind === "rollback")
  ) {
    const releaseRef = action.kind === "deploy" ? ref : previousRef;
    const refused = await d.recordRelease(incident.project, {
      at: result.endedAt ?? iso(d.now()),
      source: "action",
      ...(releaseRef !== undefined ? { ref: releaseRef } : {}),
      actionRunId: runId,
      ...(action.kind === "rollback" ? { rollback: true as const } : {}),
    });
    if (refused)
      console.warn(
        `[incidents] ${incident.id}: release not recorded: ${refused.error}`,
      );
  }
  return next !== null;
}

async function startWatch(
  view: ResponseView,
  d: CoordinatorDeps,
): Promise<boolean> {
  const { incident, settings } = view;
  const deadline = iso(view.now + settings.watchMs);
  const names = incident.signalIds
    .map((id) => view.signals.get(id)?.name)
    .filter((n): n is string => !!n);
  const detail = `Watching ${names.join(", ") || "the signal"} until ${deadline}`;
  const next = await write(
    incident.id,
    d,
    settings,
    guardOf(view),
    (c, base, at) => {
      let moved: Incident = c;
      if (c.state !== "watching") {
        const result = transitionIncident(c, "watching", {
          by: "sessions",
          detail,
          at,
        });
        if ("error" in result) return result;
        moved = result;
      }
      return {
        incident: moved,
        response: {
          ...base,
          phase: "watching",
          watch: { startedAt: at, deadline },
        },
      };
    },
  );
  return next !== null;
}

async function resolveIncident(
  view: ResponseView,
  step: Extract<ResponseStep, { step: "resolve" }>,
  d: CoordinatorDeps,
): Promise<boolean> {
  const { incident, settings } = view;
  const next = await write(
    incident.id,
    d,
    settings,
    guardOf(view),
    (c, base, at) => {
      const moved = transitionIncident(c, "resolved", {
        by: "sessions",
        detail: step.detail,
        at,
        fixedBy: step.fixedBy,
      });
      if ("error" in moved) return moved;
      return {
        incident: moved,
        response: patched(base, {
          phase: "documenting",
          documentingSince: at,
          watch: undefined,
        }),
      };
    },
  );
  return next !== null;
}

async function mergeNote(
  view: ResponseView,
  d: CoordinatorDeps,
): Promise<boolean> {
  const { incident, settings } = view;
  const note = incident.response!.note;
  const pr = note?.pr;
  if (!note || !pr) return false;
  // The kill switch: the next advance leaves the note open instead.
  if (d.agentsPaused(incident.project)) return false;
  const record = await mergeIncidentPr(
    {
      incidentId: incident.id,
      pr,
      verifiedSha: pr.headSha,
      title: `Incident note: ${incident.title}`,
      now: d.now(),
    },
    d.github,
  );
  const merged = record.status === "merged";
  const detail = merged
    ? `Merged the incident note, PR #${pr.number}`
    : `Did not merge the incident note, PR #${pr.number}: ${record.detail ?? "refused"}`;
  // Recorded whatever moved meanwhile, like the fix's merge.
  const next = await write(incident.id, d, settings, null, (c, base, at) => ({
    incident: event(c, "merge", at, detail),
    response: ledger(
      {
        ...base,
        note: patched(
          { ...(base.note ?? note), merged },
          { detail: merged ? undefined : record.detail },
        ),
      },
      at,
      { actor: "sessions", kind: "merge", detail },
    ),
  }));
  return next !== null;
}

// ── Pull requests after a close ────────────────────────────────────────────

const CLOSED_WITHOUT_ACTION_COMMENT =
  "The incident this pull request was opened for was closed without action, so Sessions is closing it. Reopen it if the change is still wanted.";

/**
 * Comments on and closes an agent's pull request in the project's own
 * repository. True, or why it was not closed.
 */
async function closeAgentPr(
  incident: Incident,
  prUrl: string,
  body: string,
  d: CoordinatorDeps,
): Promise<true | string> {
  const pr = parsePrUrl(prUrl);
  if (!pr) return "not a GitHub pull request";
  try {
    const own = d.ghRepoOf(incident.project);
    if (!own || own.toLowerCase() !== pr.ghRepo.toLowerCase())
      return "it is in another repository";
    const credential = await d.github.appCredential(pr.ghRepo);
    await d.github.comment(pr.ghRepo, pr.number, body, credential);
    await d.github.close(pr.ghRepo, pr.number, credential);
    return true;
  } catch (error) {
    return errorMessage(error);
  }
}

/** Whether every file is the incident's note or a runbook. Unreadable
 *  files count as code. */
function noteOnly(files: string[] | null): boolean {
  return !!files?.length && files.every((f) => f.startsWith(INCIDENT_DOCS_DIR));
}

/**
 * An incident closed without action: the open pull requests its own agents
 * opened are closed with a short comment, when nobody pushed to them after
 * the agent (the head is still the agent's last commit) and they hold only
 * the incident note and runbooks. A code fix is left open and asked about
 * on the card (`openPrs`). A merged or closed pull request, one in another
 * repository, and one whose head can't be matched to the agent are left
 * alone. Best effort: what was done is written to the ledger.
 */
async function settleAgentPrs(
  incidentId: string,
  d: CoordinatorDeps,
): Promise<void> {
  const incident = await d.getIncident(incidentId);
  if (incident?.state !== "closed-without-action") return;
  const r = incident.response;
  if (!r?.agents.some((a) => a.role === "investigator")) return;
  const agents = await agentsFor(incident, d);
  if (!agents) return;
  const own = (() => {
    try {
      return d.ghRepoOf(incident.project)?.toLowerCase();
    } catch {
      return undefined;
    }
  })();
  const lines: string[] = [];
  const ask: AgentPullRequest[] = [];
  const seen = new Set<string>();
  for (const run of r.agents) {
    if (run.role !== "investigator") continue;
    let url = run.prUrl;
    if (!url)
      url = await agents
        .status(run.sessionId)
        .then((live) => live.prUrl)
        .catch(() => undefined);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const pr = parsePrUrl(url);
    if (!pr || !own || own !== pr.ghRepo.toLowerCase()) continue;
    try {
      const v = await d.github.verdict({
        repoId: incident.project,
        ghRepo: pr.ghRepo,
        number: pr.number,
      });
      if (v.state !== "OPEN") continue;
      const head = await agents.head(run.sessionId);
      if (!head || head !== v.pr.headSha) {
        lines.push(
          head
            ? `Left pull request #${pr.number} open: it changed after the investigator's last commit`
            : `Left pull request #${pr.number} open: Sessions can't tell whether anyone pushed to it after the investigator`,
        );
        continue;
      }
      if (!noteOnly(prFilePaths(await d.github.files(pr.ghRepo, pr.number)))) {
        ask.push({ url, number: pr.number, sessionId: run.sessionId });
        lines.push(
          `Left pull request #${pr.number} open for you: it changes code`,
        );
        continue;
      }
      const closed = await closeAgentPr(
        incident,
        url,
        CLOSED_WITHOUT_ACTION_COMMENT,
        d,
      );
      lines.push(
        closed === true
          ? `Closed the investigator's pull request #${pr.number}`
          : `Could not close pull request #${pr.number}: ${closed}`,
      );
    } catch (error) {
      lines.push(
        `Could not check pull request #${pr.number}: ${errorMessage(error)}`,
      );
    }
  }
  if (!lines.length) return;
  const settings = await d.settings(incident.project);
  await write(incidentId, d, settings, null, (c, base, at) => {
    if (c.state !== "closed-without-action")
      return { error: "The incident reopened meanwhile" };
    let response = patched(base, { openPrs: ask.length ? ask : undefined });
    for (const detail of lines)
      response = ledger(response, at, {
        actor: "sessions",
        kind: "merge",
        detail,
      });
    return { incident: c, response };
  });
}

// ── Wake-ups ───────────────────────────────────────────────────────────────

/** Whether the tick should look at this incident at all. `recovering`:
 *  its primary signal passes, so it may close by itself. */
function needsAttention(
  incident: Incident,
  settings?: IncidentProjectSettings,
  recovering = false,
): boolean {
  const r = incident.response;
  const working = (r?.agents ?? []).some(
    (a) => a.status === "running" || a.status === "waiting" || watchedRun(a),
  );
  if (!isOpenIncident(incident)) return r?.phase === "documenting";
  if (recovering && closesWhenRecovered(incident)) return true;
  if (
    (incident.state === "heads-up" ||
      incident.state === "waiting-on-provider") &&
    !working &&
    (!r || r.phase === "idle" || r.phase === "done")
  )
    return false;
  switch (r?.phase) {
    case "needs-you":
      // A setup problem: Try again follows whether the agents could start.
      return working || r?.needsYou?.kind === "setup";
    case "done":
      return working;
    case "paused":
      return working || !settings || !settings.agentsPaused;
    case "watch-only":
      return working || !settings || settings.autonomy !== "watch";
    default:
      return true;
  }
}

/** Schedules every incident with work to do; returns their ids. */
export async function runResponseTick(
  now: number,
  deps: Partial<CoordinatorDeps> = {},
): Promise<string[]> {
  const d = resolveCoordinatorDeps(deps);
  if (!d.ready()) return [];
  const incidents = await d.listIncidents();
  sessionIndex.clear();
  const settingsOf = new Map<string, IncidentProjectSettings | undefined>();
  const scheduled: string[] = [];
  for (const incident of incidents) {
    for (const run of incident.response?.agents ?? [])
      sessionIndex.set(run.sessionId, incident.id);
    if (!settingsOf.has(incident.project))
      settingsOf.set(
        incident.project,
        await d.settings(incident.project).catch(() => undefined),
      );
    const recovering = d.evaluation(incident.primarySignalId)?.state === "ok";
    if (!needsAttention(incident, settingsOf.get(incident.project), recovering))
      continue;
    scheduleAdvance(incident.id);
    scheduled.push(incident.id);
  }
  void now;
  return scheduled;
}

/**
 * Whether a write should wake the fix loop: everything but `impact`,
 * `updatedAt` and `response.findingSets`, so impact-only and findings-only
 * writes never wake it.
 */
export function responseMoved(
  next: Incident,
  previous: Incident | null,
): boolean {
  if (!previous) return true;
  return JSON.stringify(loopView(next)) !== JSON.stringify(loopView(previous));
}

function loopView(incident: Incident): Omit<Incident, "impact" | "updatedAt"> {
  const { impact: _impact, updatedAt: _updatedAt, ...rest } = incident;
  if (!rest.response) return rest;
  const { findingSets: _findingSets, ...response } = rest.response;
  return { ...rest, response };
}

/**
 * Wakes the loop on incident changes and on its agents' session state.
 * Returns the unsubscribe function.
 */
export function watchResponseWakeups(): () => void {
  const offIncident = onIncidentChange((next, previous) => {
    if (!isOpenIncident(next) && next.response?.phase !== "documenting") return;
    if (responseMoved(next, previous)) scheduleAdvance(next.id);
  });
  const offSession = onSessionStateChange((event) => {
    const incidentId = sessionIndex.get(event.sessionId);
    if (incidentId) scheduleAdvance(incidentId);
  });
  return () => {
    offIncident();
    offSession();
  };
}

/** Action runs this process is executing right now. */
export function liveActionRunIds(): ReadonlySet<string> {
  return liveActions;
}

// ── Owner decisions ────────────────────────────────────────────────────────

export type DecisionError = { error: string; status: 404 | 409 | 400 };

const REFUSALS: Record<OwnerDecision, string> = {
  stop: "Nothing to stop",
  "deploy-now": "No veto window is open",
  approve: "Nothing verified to approve",
  "send-back": "Nothing to send back",
  retry: "Nothing to retry",
  resolve: "This incident can't be resolved now",
  close: "This incident can't be closed now",
  "roll-back": "Nothing to roll back",
  "close-prs": "No pull request is waiting for you",
  "keep-prs": "No pull request is waiting for you",
};

const STOPPABLE_PHASES: ReadonlySet<ResponsePhase> = new Set([
  "investigating",
  "proving",
  "verifying",
  "deciding",
]);
const RETRYABLE: ReadonlySet<string> = new Set([
  "budget",
  "agent-error",
  "no-report",
  "setup",
]);
const APPROVABLE: ReadonlySet<string> = new Set([
  "policy",
  "protection",
  "stopped",
]);

function isOwnerDecision(value: unknown): value is OwnerDecision {
  return (OWNER_DECISIONS as readonly unknown[]).includes(value);
}

/** Whether `decision` applies to `c` now. */
function decisionAllowed(
  decision: OwnerDecision,
  c: Incident,
  settings: IncidentProjectSettings,
): boolean {
  const r = c.response;
  if (!r) return false;
  switch (decision) {
    case "stop":
      return (
        c.state === "veto" ||
        ((c.state === "investigating" || c.state === "fix-ready") &&
          STOPPABLE_PHASES.has(r.phase)) ||
        // Shipping, but nothing merged and no action of this round run
        // yet, nor running (waiting for checks).
        (c.state === "deploying" &&
          (r.phase === "merging" || r.phase === "deploying") &&
          !r.merge &&
          !r.actionRuns.some(
            (a) =>
              a.status === "running" ||
              (a.round === r.round &&
                (a.purpose === "plan" || a.purpose === "rollback-first")),
          ))
      );
    case "deploy-now":
      return c.state === "veto";
    case "approve":
      return (
        c.state === "needs-you" &&
        APPROVABLE.has(r.needsYou?.kind ?? "") &&
        !!r.candidate &&
        (r.verdict?.verdict === "certain" || r.candidate.rollbackFirst === true)
      );
    case "send-back":
      return c.state === "needs-you" || c.state === "veto";
    case "retry":
      return (
        c.state === "needs-you" &&
        RETRYABLE.has(r.needsYou?.kind ?? "") &&
        r.needsYou?.retryable !== false
      );
    case "resolve":
    case "close":
      return c.state === "needs-you" || c.state === "investigating";
    case "roll-back":
      return manualRollbackAvailable(c, settings);
    case "close-prs":
    case "keep-prs":
      return c.state === "closed-without-action" && !!r.openPrs?.length;
  }
}

/** Cancels the incident's working agents; returns the session ids stopped. */
async function cancelWorking(
  incident: Incident,
  d: CoordinatorDeps,
  why: CancelReason,
): Promise<Set<string>> {
  const working = (incident.response?.agents ?? []).filter(
    (a) => a.status === "running" || a.status === "waiting",
  );
  const cancelled = new Set<string>();
  if (!working.length) return cancelled;
  const agents = await agentsFor(incident, d);
  for (const run of working) {
    try {
      await agents?.cancel(
        run.sessionId,
        `incident:${incident.id}:cancel:${run.sessionId}:${run.turnSentAt}`,
      );
      cancelled.add(run.sessionId);
    } catch (error) {
      console.error(
        `[incidents] Could not cancel agent ${run.sessionId} (${why}):`,
        errorMessage(error),
      );
    }
  }
  return cancelled;
}

function markCancelled(
  r: IncidentResponse,
  cancelled: ReadonlySet<string>,
  why: CancelReason,
  reason: string,
  at: string,
): IncidentResponse {
  if (!cancelled.size) return r;
  return {
    ...r,
    agents: r.agents.map((a) =>
      cancelled.has(a.sessionId) &&
      (a.status === "running" || a.status === "waiting")
        ? patched(a, {
            status: "cancelled",
            cancelledFor: why,
            error: reason,
            endedAt: at,
          })
        : a,
    ),
  };
}

/** The decision's own move: the incident and response before the ledger. */
function decisionMove(
  decision: OwnerDecision,
  c: Incident,
  base: IncidentResponse,
  at: string,
  input: {
    by: string;
    note: string;
    cancelled: ReadonlySet<string>;
    /** Close it: the pull requests GitHub would not close. */
    stillOpen: ReadonlySet<string>;
  },
): Mutation {
  const { by } = input;
  const move = (
    to: Parameters<typeof transitionIncident>[1],
    detail: string,
    response: IncidentResponse,
    fixedBy?: "by-hand",
  ): Mutation => {
    const moved = transitionIncident(c, to, {
      by,
      detail,
      at,
      ...(fixedBy ? { fixedBy } : {}),
    });
    if ("error" in moved) return moved;
    return { incident: moved, response };
  };
  const toShip = (): Partial<IncidentResponse> => ({
    phase: base.candidate?.plan.pr ? "merging" : "deploying",
    mergingSince: at,
    veto: undefined,
  });
  switch (decision) {
    case "stop": {
      const reason = `Stopped by ${by}`;
      const r = markCancelled(base, input.cancelled, "stopped", reason, at);
      return move(
        "needs-you",
        reason,
        patched(r, {
          phase: "needs-you",
          veto: undefined,
          needsYou: {
            kind: "stopped",
            reason,
            since: at,
            resumePhase: base.phase === "veto" ? "deciding" : base.phase,
          },
        }),
      );
    }
    case "deploy-now":
      return move("deploying", `Deploy now, by ${by}`, patched(base, toShip()));
    case "approve":
      return move(
        "deploying",
        `Approved by ${by}`,
        patched(base, {
          ...toShip(),
          // Readiness is read again before anything is merged.
          ...(base.merge?.status === "refused" ? { merge: undefined } : {}),
          ...(base.candidate
            ? { candidate: patched(base.candidate, { pr: undefined }) }
            : {}),
        }),
      );
    case "send-back":
      return move(
        "investigating",
        `Sent back by ${by}`,
        patched(base, {
          phase: "investigating",
          // A round no investigator worked in is not used up: it is the
          // one sent back.
          round: roundRan(base) ? base.round + 1 : base.round,
          sendBack: { kind: "owner", by, note: input.note },
          candidate: undefined,
          proof: undefined,
          verdict: undefined,
          decision: undefined,
          veto: undefined,
          merge: undefined,
          mergingSince: undefined,
        }),
      );
    case "retry": {
      const resume = base.needsYou?.resumePhase ?? "investigating";
      return move(
        c.resumeState ?? "investigating",
        `Retry, by ${by}`,
        patched(base, {
          phase: resume === "idle" ? "investigating" : resume,
          retryRequested: true,
        }),
      );
    }
    case "resolve":
      return move(
        "resolved",
        `Resolved by ${by}`,
        patched(
          markCancelled(base, input.cancelled, "closed", "Resolved", at),
          { phase: "documenting", documentingSince: at },
        ),
        "by-hand",
      );
    case "close":
      return move(
        "closed-without-action",
        `Closed by ${by}`,
        patched(markCancelled(base, input.cancelled, "closed", "Closed", at), {
          phase: "done",
        }),
      );
    case "roll-back": {
      const patch: Partial<IncidentResponse> = {
        phase: "rolling-back",
        ownerRollback: { by, at },
        watch: undefined,
      };
      if (c.state === "watching")
        return move(
          "rolled-back",
          `Rolled back by ${by}`,
          patched(base, patch),
        );
      // A reopen: the rollback runs, then the next round (uncapped).
      return move(
        "investigating",
        `Rolled back by ${by}`,
        patched(base, {
          ...patch,
          note: undefined,
          documentingSince: undefined,
        }),
      );
    }
    case "close-prs":
    case "keep-prs": {
      // Closing them happened before the record; one GitHub refused stays.
      const left = (base.openPrs ?? []).filter((p) =>
        input.stillOpen.has(p.url),
      );
      return {
        incident: c,
        response: patched(base, { openPrs: left.length ? left : undefined }),
      };
    }
  }
}

async function ownerDecision(
  incidentId: string,
  decision: OwnerDecision,
  by: string,
  note: string | undefined,
  d: CoordinatorDeps,
): Promise<Incident | DecisionError> {
  const incident = await d.getIncident(incidentId);
  if (!incident) return { error: "Not found", status: 404 };
  const text = (note ?? "").trim();
  // Only Send it back reads the note; any other decision ignores one.
  if (decision === "send-back" && !text)
    return {
      error: "Send it back needs a note for the investigator",
      status: 400,
    };
  if (decision === "send-back" && text.length > SEND_BACK_NOTE_MAX)
    return {
      error: `The note is too long: ${SEND_BACK_NOTE_MAX.toLocaleString("en-US")} characters at most`,
      status: 400,
    };
  const refused: DecisionError = { error: REFUSALS[decision], status: 409 };
  // A repeat (a double tap, a retried request) gets the incident it made.
  if (alreadyDecided(incident, decision, by)) return incident;

  if (!incident.response) {
    if (decision !== "resolve" && decision !== "close") return refused;
    return bareDecision(incident, decision, by, d);
  }
  const settings = await d.settings(incident.project);
  if (!decisionAllowed(decision, incident, settings))
    return decision === "retry" &&
      incident.response.needsYou?.retryable === false
      ? { error: "Agents still can't start: fix the setup first", status: 409 }
      : refused;

  // Effects first, the record after: cancelling agents, closing pull
  // requests.
  const cancelled =
    decision === "stop" || decision === "resolve" || decision === "close"
      ? await cancelWorking(
          incident,
          d,
          decision === "stop" ? "stopped" : "closed",
        )
      : new Set<string>();
  const prLines: string[] = [];
  const stillOpen = new Set<string>();
  if (decision === "close-prs")
    for (const pr of incident.response.openPrs ?? []) {
      const closed = await closeAgentPr(
        incident,
        pr.url,
        "The incident this pull request was opened for was closed without action, and its owner chose to close it too. Reopen it if the change is still wanted.",
        d,
      );
      if (closed === true)
        prLines.push(`Closed the investigator's pull request #${pr.number}`);
      else {
        stillOpen.add(pr.url);
        prLines.push(`Could not close pull request #${pr.number}: ${closed}`);
      }
    }

  const result = await writeOrError(
    incidentId,
    d,
    settings,
    null,
    (c, base, at) => {
      if (!decisionAllowed(decision, c, settings))
        return { error: REFUSALS[decision] };
      const moved = decisionMove(decision, c, base, at, {
        by,
        note: text,
        cancelled,
        stillOpen,
      });
      if ("error" in moved) return moved;
      const detail = `${by}: ${decision}`;
      let response = ledger({ ...moved.response, ownerTouched: true }, at, {
        actor: "owner",
        kind: "decision",
        detail,
        by,
      });
      for (const line of prLines)
        response = ledger(response, at, {
          actor: "sessions",
          kind: "merge",
          detail: line,
        });
      return {
        incident: appendEvent(moved.incident, {
          at,
          kind: "decision",
          by,
          detail,
        }),
        response,
      };
    },
  );
  if (result === null) return { error: "Not found", status: 404 };
  if ("error" in result) return { error: result.error, status: 409 };

  incidentAudit({
    kind: "incident_decision",
    incidentId,
    decision,
    by,
  });
  // The agents' pull requests, after the close is recorded: in the chain,
  // so the decision returns without waiting on GitHub.
  if (decision === "close")
    void enqueue(incidentId, () => settleAgentPrs(incidentId, d));
  if (decision === "stop" && incident.state === "veto")
    incidentAudit({
      kind: "incident_veto",
      incidentId,
      event: "stopped",
      by,
    });
  if (decision === "deploy-now")
    incidentAudit({
      kind: "incident_veto",
      incidentId,
      event: "skipped",
      by,
    });
  if (decision === "roll-back")
    incidentAudit({
      kind: "incident_rollback_requested",
      incidentId,
      by,
      from: incident.state,
    });
  return result;
}

/**
 * Whether the incident still shows this person's same decision: it was the
 * last decision, and the incident has not changed state since. A repeat
 * writes nothing, so that decision stays the last one: every further retry
 * of it (not only the first) gets the same incident back, until a state
 * change or someone else's decision lands.
 */
function alreadyDecided(
  incident: Incident,
  decision: OwnerDecision,
  by: string,
): boolean {
  const last = incident.events.findLast(
    (e) => e.kind === "decision" || e.kind === "state" || e.kind === "reopened",
  );
  return (
    last?.kind === "decision" &&
    last.by === by &&
    last.detail === `${by}: ${decision}`
  );
}

/** Resolve or close an incident the fix loop never started on. */
async function bareDecision(
  incident: Incident,
  decision: "resolve" | "close",
  by: string,
  d: CoordinatorDeps,
): Promise<Incident | DecisionError> {
  const at = iso(d.now());
  const result = await d.updateIncident(incident.id, (c) => {
    if (c.state !== "needs-you" && c.state !== "investigating")
      return { error: REFUSALS[decision] };
    const moved =
      decision === "resolve"
        ? transitionIncident(c, "resolved", {
            by,
            detail: `Resolved by ${by}`,
            at,
            fixedBy: "by-hand",
          })
        : transitionIncident(c, "closed-without-action", {
            by,
            detail: `Closed by ${by}`,
            at,
          });
    if ("error" in moved) return moved;
    return appendEvent(moved, {
      at,
      kind: "decision",
      by,
      detail: `${by}: ${decision}`,
    });
  });
  if (result === null) return { error: "Not found", status: 404 };
  if ("error" in result) return { error: result.error, status: 409 };
  incidentAudit({
    kind: "incident_decision",
    incidentId: incident.id,
    decision,
    by,
  });
  return result;
}

/**
 * An owner's decision, applied in the incident's chain so it never
 * interleaves with a step; the loop is woken right after. `by` comes from
 * the route (a signed-in person where it matters).
 */
export async function applyOwnerDecision(
  incidentId: string,
  decision: OwnerDecision,
  by: string,
  note?: string,
  deps: Partial<CoordinatorDeps> = {},
): Promise<Incident | DecisionError> {
  if (!isOwnerDecision(decision))
    return { error: "Unknown decision", status: 400 };
  const d = resolveCoordinatorDeps(deps);
  // Recorded now, before queueing: an advance already running checks it
  // before it merges, runs an action or ends the veto window.
  const stopping = decision === "stop" && !stopRequests.has(incidentId);
  if (stopping) stopRequests.set(incidentId, d.now());
  let out: Incident | DecisionError;
  try {
    out = await runInIncidentChain(incidentId, () =>
      ownerDecision(incidentId, decision, by, note, d),
    );
  } catch (error) {
    out = { error: errorMessage(error), status: 409 };
  } finally {
    if (stopping) stopRequests.delete(incidentId);
  }
  // A refused Stop may have held an advance back: wake it again.
  const held = stopping && heldByStop.delete(incidentId);
  if (!("error" in out) || held) scheduleAdvance(incidentId, deps);
  return out;
}

// ── Restarts, Runner checks and boot ───────────────────────────────────────

/**
 * After a restart: every action recorded as running that this process is
 * not executing becomes `interrupted`. Nothing is ever run again; the
 * loop then asks the owner. Returns how many runs were marked.
 */
export async function recoverIncidentResponses(
  deps: Partial<CoordinatorDeps> = {},
): Promise<number> {
  const d = resolveCoordinatorDeps(deps);
  let count = 0;
  for (const incident of await d.listIncidents({ open: true })) {
    const stale = (incident.response?.actionRuns ?? []).filter(
      (a) => a.status === "running" && !liveActions.has(a.id),
    );
    if (!stale.length) continue;
    let settings: IncidentProjectSettings;
    try {
      settings = await d.settings(incident.project);
    } catch (error) {
      console.error(
        `[incidents] ${incident.id}: could not recover its actions:`,
        errorMessage(error),
      );
      continue;
    }
    let marked = 0;
    const next = await write(incident.id, d, settings, null, (c, base, at) => {
      marked = 0;
      let response = base;
      const runs = base.actionRuns.map((a) => {
        if (a.status !== "running" || liveActions.has(a.id)) return a;
        marked++;
        const run: ActionRun = {
          ...a,
          status: "interrupted",
          endedAt: at,
          detail: "Sessions restarted while this was running",
        };
        response = ledger(response, at, {
          actor: "sessions",
          kind: "action",
          detail: actionLedgerDetail(run),
          runner: run.runner,
          secretTouched: run.secretTouched,
        });
        return run;
      });
      return { incident: c, response: { ...response, actionRuns: runs } };
    });
    if (next) count += marked;
  }
  return count;
}

/** The signal store's `runOn` check: http only, from a production Runner
 *  of the signal's project. */
export async function incidentRunOnCheck(
  signal: Signal,
): Promise<string | null> {
  if (!signal.runOn) return null;
  if (signal.source.kind !== "http")
    return "Only http checks can run on a Runner";
  return productionRunOnProblem(signal.runOn, signal.project);
}

const START_KEY = "__incidentResponse";
type Started = { stop: () => void };
const started = globalThis as typeof globalThis & { [START_KEY]?: Started };

/**
 * Starts the fix loop once per process: the access gate and the Runner
 * check for signals now; once the service is ready (recovery done, not
 * shutting down), recovery of interrupted actions, wake-ups on incident and
 * session changes, and the 5 s tick. Call from boot only.
 */
export function startIncidentResponse(): void {
  if (started[START_KEY]) return;
  const state: Started = { stop: () => {} };
  started[START_KEY] = state;
  startIncidentAccessGate();
  setSignalRunOnCheck(incidentRunOnCheck);
  const { ready } = resolveCoordinatorDeps();
  let off: (() => void) | undefined;
  let ticking = false;
  const firstTick = async () => {
    try {
      const interrupted = await recoverIncidentResponses();
      if (interrupted)
        console.warn(
          `[incidents] ${interrupted} action ${interrupted === 1 ? "run was" : "runs were"} interrupted by the restart`,
        );
    } catch (error) {
      console.error(
        "[incidents] Could not recover incident actions:",
        errorMessage(error),
      );
    }
    off = watchResponseWakeups();
    console.log("[incidents] Fix loop started (5s tick)");
  };
  const timer = setInterval(() => {
    if (ticking || !ready()) return;
    ticking = true;
    (async () => {
      if (!off) await firstTick();
      await runResponseTick(Date.now());
    })()
      .catch((error) =>
        console.error("[incidents] Fix loop tick failed:", errorMessage(error)),
      )
      .finally(() => {
        ticking = false;
      });
  }, RESPONSE_TICK_MS);
  (timer as { unref?: () => void }).unref?.();
  state.stop = () => {
    off?.();
    clearInterval(timer);
  };
}
