// The fix loop's one effectful part. For an incident it syncs the agents'
// live status, builds the view, asks `decideNextStep` for one step, applies
// it and asks again, serialized per incident. Every intent and result is
// written into `incident.response` through the incident store's CAS write,
// so deadlines and restarts survive in the record. Woken by incident
// changes, session state events and a tick (started at boot, Task 18).
// Nothing runs at import.
import type {
  AgentRole,
  AgentRun,
  CandidateState,
  IncidentProjectSettings,
  IncidentResponse,
  LedgerEntry,
  ProjectSpend,
} from "../../../shared/incident-response";
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
import { modelUpstreamProvider } from "../../model-catalog";
import { onSessionStateChange } from "../../session-state-events";
import { getRepo } from "../../worktree";
import { AgentAccessError, resolveAgentAccess } from "../access/resolve";
import { incidentAudit } from "../audit-sink";
import {
  getIncident,
  listIncidents,
  onIncidentChange,
  updateIncident,
} from "../incident-store";
import { appendEvent, transitionIncident } from "../lifecycle";
import { recentObservations } from "../observation-store";
import { getSignalEvaluation } from "../signal-runtime";
import { getSignal } from "../signal-store";
import { setProjectMonthSpend } from "./access-gate";
import { runIncidentAction } from "./actions";
import {
  type AgentLive,
  type IncidentAgents,
  createIncidentAgents,
  ensureCoordinatorSession,
  ensureIncidentAutomation,
} from "./agents";
import { currentAgent, decideNextStep, nextActionFor } from "./decide";
import { incidentWorkspaceFor } from "./host-agents";
import { appendLedger, emptyResponse } from "./ledger";
import { type MergeGithub, defaultMergeGithub, fetchPrSnapshot } from "./merge";
import { independenceBetween, resolveRoleModels } from "./models";
import {
  getProjectSettings,
  latestRelease,
  projectAction,
  recordRelease,
} from "./project-settings";
import { runProof } from "./proof";
import {
  branchFor,
  buildInvestigatorPrompt,
  buildReminder,
  buildSendBackMessage,
  buildVerifierPrompt,
  notePathFor,
  runbookPathsFor,
} from "./prompts";
import { runnerLabel } from "./runners";
import type { ResponseStep, ResponseView } from "./steps";

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
/** Action runs this process is executing (Task 18 fills it). */
const liveActions = new Set<string>();
const agentHandles = new Map<
  string,
  { key: string; factory: CoordinatorDeps["agents"]; agents: IncidentAgents }
>();
/** Agent session id → incident id, for session state wake-ups. */
const sessionIndex = new Map<string, string>();

export function __resetCoordinatorForTest(): void {
  chains.clear();
  queued.clear();
  liveActions.clear();
  agentHandles.clear();
  sessionIndex.clear();
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
export function scheduleAdvance(incidentId: string): void {
  if (queued.has(incidentId)) return;
  queued.add(incidentId);
  void enqueue(incidentId, () => {
    queued.delete(incidentId);
    return advance(incidentId, resolveCoordinatorDeps());
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
  if (result === null) return null;
  if ("error" in result) {
    console.warn(`[incidents] ${incidentId}: ${result.error}`);
    return null;
  }
  return result;
}

function guardOf(view: ResponseView): { state: IncidentState; phase?: string } {
  return {
    state: view.incident.state,
    phase: view.incident.response?.phase,
  };
}

// ── Sync and view ──────────────────────────────────────────────────────────

/** Copies the agents' live status into the record; one write at most. */
async function syncAgents(
  incident: Incident,
  d: CoordinatorDeps,
  settings: IncidentProjectSettings,
): Promise<Incident> {
  const r = incident.response;
  if (!r) return incident;
  const watched = r.agents.filter(watchedRun);
  if (!watched.length) return incident;
  const agents = await agentsFor(incident, d);
  if (!agents) return incident;
  const lives = new Map<string, AgentLive>();
  for (const run of watched) {
    try {
      lives.set(run.sessionId, await agents.status(run.sessionId));
    } catch (error) {
      console.warn(
        `[incidents] Could not read agent ${run.sessionId}:`,
        errorMessage(error),
      );
    }
  }
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
  if (!r.agents.some(changed)) return incident;

  const finished: AgentRun[] = [];
  const next = await write(incident.id, d, settings, null, (c, base, at) => {
    finished.length = 0;
    let response = base;
    const runs = response.agents.map((run) => {
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
    if (i.id !== exclude && i.openedAt.slice(0, 7) === month)
      sum += i.response?.costUsd ?? 0;
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
  const own = incident.response?.costUsd ?? 0;
  setProjectMonthSpend(
    incident.project,
    cents(
      monthCostUsd + (incident.openedAt.slice(0, 7) === monthOf(now) ? own : 0),
    ),
  );

  const agents = new Map<string, AgentLive & { finalText?: string }>();
  const watched = (incident.response?.agents ?? []).filter(watchedRun);
  const handle = watched.length ? await agentsFor(incident, d) : null;
  if (handle)
    for (const run of watched) {
      try {
        const live = await handle.status(run.sessionId);
        const finalText =
          liveRunStatus(live) === "done" && !run.report && !run.reportError
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

  return {
    now,
    incident,
    settings,
    signals,
    evaluations,
    primaryRecent: d.recent(incident.primarySignalId),
    monthCostUsd,
    agents,
    liveActionRunIds: new Set(liveActions),
    models: d.models(settings.agents),
  };
}

// ── The loop ───────────────────────────────────────────────────────────────

async function advance(incidentId: string, d: CoordinatorDeps): Promise<void> {
  for (let i = 0; i < MAX_STEPS_PER_ADVANCE; i++) {
    let incident = await d.getIncident(incidentId);
    if (!incident) return;
    const settings = await d.settings(incident.project);
    incident = await syncAgents(incident, d, settings);
    for (const run of incident.response?.agents ?? [])
      sessionIndex.set(run.sessionId, incident.id);
    const view = await buildResponseView(incident, d, settings);
    const step = decideNextStep(view);
    if (step.step === "none") return;
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
    case "merge":
    case "run-action":
    case "start-watch":
    case "resolve":
    case "merge-note":
      throw new Error(`Not implemented: ${step.step}`);
  }
}

function setupProblem(
  view: ResponseView,
  d: CoordinatorDeps,
  reason: string,
): Promise<boolean> {
  return needsYou(view, { step: "needs-you", kind: "setup", reason }, d);
}

async function init(
  view: ResponseView,
  rollbackFirst: boolean,
  d: CoordinatorDeps,
): Promise<boolean> {
  const { incident, settings } = view;
  let automation: Automation;
  let coordinatorSessionId: string;
  try {
    automation = await d.automation(incident.project);
    coordinatorSessionId = await d.coordinatorSession(incident, automation);
  } catch (error) {
    return setupProblem(
      view,
      d,
      `Incident agents could not start: ${errorMessage(error)}`,
    );
  }
  const release = rollbackFirst ? latestRelease(settings) : undefined;
  const rollback = projectAction(settings, "rollback");
  const primary = view.signals.get(incident.primarySignalId);
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
        coordinatorSessionId,
        automationId: automation.id,
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
        notePath: notePathFor(c),
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

async function startAgent(
  view: ResponseView,
  step: Extract<ResponseStep, { step: "start-agent" }>,
  d: CoordinatorDeps,
): Promise<boolean> {
  const { incident, settings } = view;
  const r = incident.response!;
  const { role, round, attempt } = step;
  if ("error" in view.models) return setupProblem(view, d, view.models.error);
  const models = view.models;
  const primary = view.signals.get(incident.primarySignalId) ?? null;
  if (!primary)
    return setupProblem(
      view,
      d,
      "Incident agents could not start: the incident's primary signal no longer exists",
    );

  let access;
  try {
    access = await d.access(role, incident, primary);
  } catch (error) {
    // The kill switch and budget: rules 3 and 6 see the same thing.
    if (error instanceof AgentAccessError && error.code === "gate")
      return false;
    return setupProblem(
      view,
      d,
      `Incident agents could not start: ${errorMessage(error)}`,
    );
  }
  const model = access.model ?? models[role].model;
  const provider =
    model === models[role].model
      ? models[role].provider
      : (modelUpstreamProvider(model) ?? models[role].provider);
  const label = model === models[role].model ? models[role].label : model;
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

  const workspace = await d.workspace(incident.project, model);
  if ("error" in workspace) return setupProblem(view, d, workspace.error);

  let prompt: string;
  if (role === "investigator") {
    const release = r.candidate?.rollbackFirst
      ? latestRelease(settings)
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
      round,
      maxRounds: r.maxRounds,
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
    });
  }

  let sessionId: string;
  try {
    const agents = await agentsFor(incident, d);
    if (!agents) throw new Error("The incident has no coordinator session");
    ({ sessionId } = await agents.spawn({
      role,
      round,
      attempt,
      prompt,
      model,
      branch: branchFor(incident, role, round, attempt),
      ...(role === "verifier" && investigator
        ? { baseSessionId: investigator.sessionId }
        : {}),
      access,
      workspace,
    }));
  } catch (error) {
    return setupProblem(
      view,
      d,
      `Incident agents could not start: ${errorMessage(error)}`,
    );
  }
  sessionIndex.set(sessionId, incident.id);

  const next = await write(
    incident.id,
    d,
    settings,
    guardOf(view),
    (c, base, at) => {
      if (base.agents.some((a) => a.sessionId === sessionId))
        return { incident: c, response: base };
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
      const detail = `${roleLabel(role)} started on ${label}, round ${round}`;
      const response = ledger(
        patched(base, {
          agents: [...base.agents, run],
          retryRequested: undefined,
        }),
        at,
        { actor: "sessions", kind: "agent-started", detail, sessionId },
      );
      return { incident: event(c, "agent", at, detail), response };
    },
  );
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
  });
  return true;
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
  const text = sendBack
    ? buildSendBackMessage(
        r.round,
        r.maxRounds,
        r.sendBack ?? { kind: "reopened", detail: "The work was sent back" },
      )
    : buildReminder(run.reportError ?? "No incident-report block");
  const agents = await agentsFor(incident, d);
  if (!agents) return false;
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
              reminded: false,
            })
          : patched(a, {
              status: "running",
              turnSentAt: at,
              endedAt: undefined,
              reportError: undefined,
              reminded: true,
            });
      });
      const detail = sendBack
        ? `Sent the ${run.role} round ${base.round} of ${base.maxRounds}`
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
  const detail = report
    ? report.role === "investigator"
      ? `Investigator reported: ${report.summary}`
      : `Verifier: ${report.verdict === "certain" ? "certain" : "not certain"}`
    : `${roleLabel(run.role)} report was not valid: ${step.error ?? "unknown"}`;
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
              report ? { report } : { reportError: step.error ?? "Invalid" },
            ),
      );
      const response = ledger(patched(base, { agents: agentsNext }), at, {
        actor: run.role,
        kind: report?.role === "verifier" ? "verdict" : "agent-finished",
        detail,
        sessionId: run.sessionId,
      });
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
  return next !== null;
}

async function needsYou(
  view: ResponseView,
  step: Extract<ResponseStep, { step: "needs-you" }>,
  d: CoordinatorDeps,
): Promise<boolean> {
  const { incident, settings } = view;
  await write(incident.id, d, settings, guardOf(view), (c, base, at) => {
    const resumePhase =
      base.phase === "needs-you"
        ? (base.needsYou?.resumePhase ?? "investigating")
        : base.phase;
    const response = ledger(
      patched(
        {
          ...patched(base, step.patch),
          phase: "needs-you" as const,
          needsYou: {
            kind: step.kind,
            reason: step.reason,
            since: at,
            resumePhase,
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
    const moved = transitionIncident(c, "needs-you", {
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

// ── Wake-ups ───────────────────────────────────────────────────────────────

/** Whether the tick should look at this incident at all. */
function needsAttention(
  incident: Incident,
  settings?: IncidentProjectSettings,
): boolean {
  const r = incident.response;
  const working = (r?.agents ?? []).some(
    (a) => a.status === "running" || a.status === "waiting" || watchedRun(a),
  );
  if (!isOpenIncident(incident)) return r?.phase === "documenting";
  if (
    (incident.state === "heads-up" ||
      incident.state === "waiting-on-provider") &&
    !working &&
    (!r || r.phase === "idle" || r.phase === "done")
  )
    return false;
  switch (r?.phase) {
    case "needs-you":
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
    if (!needsAttention(incident, settingsOf.get(incident.project))) continue;
    scheduleAdvance(incident.id);
    scheduled.push(incident.id);
  }
  void now;
  return scheduled;
}

/** Everything but `impact` and `updatedAt`, to ignore impact-only writes. */
function moved(next: Incident, previous: Incident | null): boolean {
  if (!previous) return true;
  const { impact: _a, updatedAt: _b, ...a } = next;
  const { impact: _c, updatedAt: _d, ...b } = previous;
  return JSON.stringify(a) !== JSON.stringify(b);
}

/**
 * Wakes the loop on incident changes and on its agents' session state.
 * Returns the unsubscribe function.
 */
export function watchResponseWakeups(): () => void {
  const offIncident = onIncidentChange((next, previous) => {
    if (!isOpenIncident(next) && next.response?.phase !== "documenting") return;
    if (moved(next, previous)) scheduleAdvance(next.id);
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
