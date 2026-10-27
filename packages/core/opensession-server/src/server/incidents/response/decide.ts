// The whole fix loop as one pure function: given the stored incident and
// what is live right now, the single next step. The coordinator applies the
// step, writes the result into `incident.response` and asks again. Rules are
// in priority order; the first that matches wins.
import type {
  ActionRun,
  AgentRole,
  AgentRun,
  IncidentAction,
  IncidentProjectSettings,
  IncidentResponse,
  NeedsYouKind,
  NextAction,
  OwnerDecision,
  ReportIssue,
  ResponsePhase,
  SendBackReason,
  Verdict,
} from "../../../shared/incident-response";
import { roundOfMax } from "../../../shared/incident-response";
import {
  RECOVERED_MIN_PASSES,
  closesWhenRecovered,
  recoveredCloseAt,
} from "../../../shared/incident-recovery";
import {
  type Incident,
  type IncidentState,
  type Signal,
  isTerminalIncidentState,
} from "../../../shared/incidents";
import { recoveriesFor } from "../rules";
import { KNOWLEDGE_GLOB, changeFacts, globMatch } from "./facts";
import { assessAutoMerge } from "./merge";
import { budgetProblem, evaluatePolicy, fullyDown } from "./policy";
import { projectAction, releaseToRollBack } from "./project-settings";
import {
  REPORT_RULES,
  checkKnowledge,
  effectiveVerdict,
  parseInvestigatorReport,
  parseVerifierReport,
  plainReportProblem,
  reportFindingsInput,
} from "./reports";
import {
  AGENT_MAX_MS,
  FINAL_TEXT_GRACE_MS,
  PR_CHECKS_WAIT_MS,
  PR_REFRESH_MS,
  ROLLBACK_FIRST_WINDOW_MS,
  type ResponseStep,
  type ResponseView,
} from "./steps";

const NONE: ResponseStep = { step: "none" };

type RunStatus = AgentRun["status"];

/** The last run of that role. */
export function currentAgent(
  r: IncidentResponse,
  role: AgentRole,
): AgentRun | undefined {
  return r.agents.findLast((a) => a.role === role);
}

/** The incident's signals that still exist and are not a provider's. */
export function ownSignalIds(view: ResponseView): string[] {
  return view.incident.signalIds.filter((id) => {
    const signal = view.signals.get(id);
    return signal !== undefined && !signal.provider;
  });
}

/** Sessions' own word (cancelled, error) wins; otherwise the live status. */
function statusOf(view: ResponseView, run: AgentRun): RunStatus {
  if (run.status === "cancelled" || run.status === "error") return run.status;
  const live = view.agents.get(run.sessionId)?.status;
  if (live === undefined) return run.status;
  if (
    live === "running" ||
    live === "waiting" ||
    live === "error" ||
    live === "cancelled"
  )
    return live;
  return "done";
}

function isRunning(view: ResponseView, run: AgentRun): boolean {
  const s = statusOf(view, run);
  return s === "running" || s === "waiting";
}

function runningAgents(view: ResponseView): AgentRun[] {
  return (view.incident.response?.agents ?? []).filter((a) =>
    isRunning(view, a),
  );
}

function roleLabel(role: AgentRole): string {
  return role === "investigator" ? "Investigator" : "Verifier";
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function stale(fetchedAt: string | undefined, now: number): boolean {
  if (fetchedAt === undefined) return true;
  const at = Date.parse(fetchedAt);
  return !(now - at <= PR_REFRESH_MS);
}

function liveActionRunning(view: ResponseView): boolean {
  return (view.incident.response?.actionRuns ?? []).some(
    (a) => a.status === "running" && view.liveActionRunIds.has(a.id),
  );
}

function primarySignal(view: ResponseView): Signal | undefined {
  return view.signals.get(view.incident.primarySignalId);
}

function httpTarget(
  signal: Signal | undefined,
): { origin: string; method: "GET" | "HEAD" | "POST"; path: string } | null {
  if (signal?.source.kind !== "http") return null;
  try {
    const url = new URL(signal.source.url);
    return {
      origin: url.origin,
      method: signal.source.method ?? "GET",
      path: url.pathname,
    };
  } catch {
    return null;
  }
}

export function rollbackFirstApplies(view: ResponseView): boolean {
  const release = releaseToRollBack(view.settings);
  if (!release || !projectAction(view.settings, "rollback")) return false;
  const at = Date.parse(release.at);
  const opened = Date.parse(view.incident.openedAt);
  return at <= opened && opened - at <= ROLLBACK_FIRST_WINDOW_MS;
}

/**
 * A person may roll back an agents' fix that went out: while it is watched,
 * or after it resolved. A rollback-first candidate has nothing to roll back
 * to.
 */
export function manualRollbackAvailable(
  incident: Incident,
  settings: IncidentProjectSettings,
): boolean {
  const r = incident.response;
  const rollback = projectAction(settings, "rollback");
  const deploy = projectAction(settings, "deploy");
  if (!r || !rollback || !deploy) return false;
  if (r.actionRuns.some((a) => a.status === "running")) return false;
  const shipped = r.actionRuns.some(
    (a) =>
      a.round === r.round &&
      a.actionId === deploy.id &&
      a.purpose === "plan" &&
      a.status === "ok",
  );
  if (!shipped) return false;
  return (
    incident.state === "watching" ||
    (incident.state === "resolved" &&
      (r.phase === "documenting" || r.phase === "done"))
  );
}

export function needsYouOptions(
  kind: NeedsYouKind,
  r: IncidentResponse,
): OwnerDecision[] {
  switch (kind) {
    case "policy":
    case "protection":
    case "stopped":
      return [
        ...(r.verdict?.verdict === "certain" || r.candidate?.rollbackFirst
          ? (["approve"] as const)
          : []),
        "send-back",
        "close",
      ];
    case "setup":
      // Starting again would fail the same way until the setup is fixed.
      return r.needsYou?.retryable === false
        ? ["resolve", "close"]
        : ["retry", "resolve", "close"];
    case "budget":
    case "agent-error":
    case "no-report":
      return ["retry", "resolve", "close"];
    case "question":
      return [];
    default:
      return ["send-back", "resolve", "close"];
  }
}

function runningActionLabel(r: IncidentResponse): string {
  return (
    r.actionRuns.findLast((a) => a.status === "running")?.label ?? "the deploy"
  );
}

function workingDetail(r: IncidentResponse): string {
  switch (r.phase) {
    case "investigating":
      return `Investigator working, round ${roundOfMax(r.round, r.maxRounds)}`;
    case "proving":
      return "Measuring the candidate from production";
    case "verifying":
      return `Verifier checking round ${r.round}`;
    case "deciding":
      return "Checking the policy";
    case "merging":
      return r.candidate?.pr
        ? `Merging PR #${r.candidate.pr.number}`
        : "Merging the fix";
    case "deploying":
      return `Running ${runningActionLabel(r)}`;
    case "rolling-back":
      return "Rolling back";
    case "documenting":
      return "Merging the incident note";
    default:
      return "Starting";
  }
}

export function nextActionFor(
  incident: Incident,
  settings: IncidentProjectSettings,
): NextAction {
  const r = incident.response;
  const rollback = (): OwnerDecision[] =>
    manualRollbackAvailable(incident, settings) ? ["roll-back"] : [];
  if (incident.state === "needs-you") {
    if (!r?.needsYou)
      return { kind: "info", detail: "This incident needs you" };
    const { kind, reason, fix } = r.needsYou;
    const rule = kind === "policy" ? r.decision?.rule : undefined;
    return {
      kind: "needs-you",
      reason,
      needsYou: kind,
      ...(rule ? { rule } : {}),
      ...(kind === "setup" && fix ? { fix } : {}),
      options: needsYouOptions(kind, r),
    };
  }
  if (isTerminalIncidentState(incident.state))
    return {
      kind: "done",
      detail:
        incident.state === "resolved" ? "Resolved" : "Closed without action",
      options:
        incident.state === "closed-without-action" && r?.openPrs?.length
          ? ["close-prs", "keep-prs"]
          : rollback(),
    };
  if (incident.state === "paused")
    return {
      kind: "info",
      detail: `Agents paused for ${incident.project}`,
      rule: "Kill switch, from the project settings",
    };
  if (incident.state === "veto" && r?.veto)
    return {
      kind: "veto",
      deadline: r.veto.deadline,
      rule: r.decision?.rule ?? "",
    };
  if (incident.state === "watching" && r?.watch)
    return {
      kind: "watching",
      deadline: r.watch.deadline,
      options: rollback(),
    };
  if (r?.phase === "watch-only")
    return {
      kind: "info",
      detail: `Watching only. Agents are off for ${incident.project}`,
      rule: "Watch, from the project settings",
    };
  if (!r) return { kind: "working", detail: "Starting" };
  return { kind: "working", detail: workingDetail(r) };
}

/** Where an incident goes when the kill switch is turned off. */
const RESUME: Partial<
  Record<ResponsePhase, { to: IncidentState; phase: ResponsePhase }>
> = {
  idle: { to: "investigating", phase: "investigating" },
  investigating: { to: "investigating", phase: "investigating" },
  proving: { to: "fix-ready", phase: "proving" },
  verifying: { to: "fix-ready", phase: "verifying" },
  // A fresh, full veto window.
  deciding: { to: "fix-ready", phase: "deciding" },
  veto: { to: "fix-ready", phase: "deciding" },
  merging: { to: "fix-ready", phase: "deciding" },
  deploying: { to: "deploying", phase: "deploying" },
  watching: { to: "watching", phase: "watching" },
  "rolling-back": { to: "investigating", phase: "rolling-back" },
  "watch-only": { to: "investigating", phase: "watch-only" },
};

/**
 * Send the work back for another round, or ask the owner once the rounds
 * are used up. Shared by verification, failed checks and rollbacks.
 */
export function sendBack(
  view: ResponseView,
  why: SendBackReason,
  firstReason: string,
  verdict?: Verdict,
): ResponseStep {
  const { incident } = view;
  const r = incident.response!;
  if (r.round < r.maxRounds)
    return {
      step: "transition",
      to: incident.state === "investigating" ? null : "investigating",
      phase: "investigating",
      detail: `Sent back: ${firstReason}`,
      patch: {
        round: r.round + 1,
        sendBack: why,
        verdict,
        proof: undefined,
        decision: undefined,
        veto: undefined,
        merge: undefined,
        mergingSince: undefined,
      },
    };
  return {
    step: "needs-you",
    kind: "rounds",
    reason: `Not certain after ${r.round} rounds: ${firstReason}`,
  };
}

/** A running agent's turn that has gone on too long: it is cancelled. */
function overdueStep(view: ResponseView): ResponseStep | undefined {
  const overdue = runningAgents(view).find(
    (a) =>
      statusOf(view, a) === "running" &&
      !(view.now - Date.parse(a.turnSentAt) <= AGENT_MAX_MS),
  );
  return overdue
    ? {
        step: "cancel-agents",
        reason: `The ${overdue.role} ran for 2 h without finishing`,
        for: "timeout",
      }
    : undefined;
}

function hhmmUtc(ms: number): string {
  return iso(ms).slice(11, 16);
}

/**
 * Waiting on a person before any agent ran (`closesWhenRecovered`), and
 * every own signal has passed since after the incident opened: outside
 * maintenance, for as many checks in a row as its rule takes to recover
 * (never fewer than RECOVERED_MIN_PASSES), and for RECOVERED_CLOSE_MS.
 * Nothing ran and nothing changed in production, so it closes without
 * action. Undefined while any of that is not so yet.
 */
export function recoveredOnItsOwn(
  view: ResponseView,
): ResponseStep | undefined {
  const { incident, passes } = view;
  if (!passes || !closesWhenRecovered(incident)) return undefined;
  const own = ownSignalIds(view);
  const watched = own.length ? own : [incident.primarySignalId];
  const opened = Date.parse(incident.openedAt);
  let since = Number.NEGATIVE_INFINITY;
  const names: string[] = [];
  for (const id of watched) {
    const signal = view.signals.get(id);
    const evaluation = view.evaluations.get(id);
    if (!signal || evaluation?.state !== "ok" || evaluation.inMaintenance)
      return undefined;
    const at = Date.parse(evaluation.since);
    if (!(at >= opened)) return undefined;
    const needed = Math.max(RECOVERED_MIN_PASSES, recoveriesFor(signal.rule));
    if (!((passes.get(id) ?? 0) >= needed)) return undefined;
    since = Math.max(since, at);
    names.push(signal.name);
  }
  if (!(view.now >= recoveredCloseAt(since))) return undefined;
  return {
    step: "transition",
    to: "closed-without-action",
    phase: "done",
    detail: `Recovered on its own before any agent ran: ${names.join(", ")} passing since ${hhmmUtc(since)} UTC`,
    fixedBy: "recovered",
  };
}

/** A setup problem whose readiness changed: Try again and the place to fix
 *  it follow what the agents would meet now. */
function setupChanged(view: ResponseView): ResponseStep | undefined {
  const ny = view.incident.response?.needsYou;
  if (ny?.kind !== "setup" || !view.setup) return undefined;
  const { ready, fix } = view.setup;
  if ((ny.retryable ?? true) === ready && ny.fix === fix) return undefined;
  const { retryable: _retryable, fix: _fix, ...rest } = ny;
  return {
    step: "transition",
    to: null,
    phase: "needs-you",
    detail: ready ? "Agents can start now" : "Agents still cannot start",
    patch: {
      needsYou: {
        ...rest,
        ...(ready ? {} : { retryable: false }),
        ...(fix ? { fix } : {}),
      },
    },
  };
}

function guards(view: ResponseView): ResponseStep | undefined {
  const { incident, settings } = view;
  const r = incident.response;
  const state = incident.state;
  const running = runningAgents(view);

  // 1. Terminal.
  if (isTerminalIncidentState(state)) {
    if (state === "closed-without-action" && running.length)
      return {
        step: "cancel-agents",
        reason: "Incident closed",
        for: "closed",
      };
    if (state === "resolved" && running.length && r?.phase !== "documenting")
      return {
        step: "cancel-agents",
        reason: "Incident resolved",
        for: "closed",
      };
    if (r && r.phase !== "done" && r.phase !== "documenting")
      return { step: "transition", to: null, phase: "done", detail: "Closed" };
    // The note waits for the investigator, but not past its time limit.
    if (state === "resolved" && r?.phase === "documenting")
      return overdueStep(view) ?? reports(view) ?? documenting(view);
    return NONE;
  }

  // 2. A heads-up or a provider outage: no agents.
  if (state === "heads-up" || state === "waiting-on-provider") {
    if (running.length)
      return {
        step: "cancel-agents",
        reason:
          state === "waiting-on-provider"
            ? "Waiting on a provider"
            : "Back to a heads-up",
        for: "provider",
      };
    if (r && r.phase !== "idle" && r.phase !== "done")
      return {
        step: "transition",
        to: null,
        phase: "idle",
        detail: "Agents stopped while waiting",
      };
    return NONE;
  }

  // 2b. Its signals came back before any agent ran.
  const recovered = recoveredOnItsOwn(view);
  if (recovered) return recovered;

  // 3. Kill switch: never mid-command.
  if (settings.agentsPaused) {
    if (running.length)
      return {
        step: "cancel-agents",
        reason: `Agents paused for ${incident.project}`,
        for: "paused",
      };
    if (state === "paused" || state === "needs-you" || liveActionRunning(view))
      return NONE;
    if (state === "rolled-back") return pausedRollback(view);
    return {
      step: "transition",
      to: "paused",
      phase: "paused",
      detail: `Agents paused for ${incident.project}`,
      patch: { pausedFrom: r?.phase ?? "idle", veto: undefined },
    };
  }

  // 4. Switch off again: back to where it was.
  if (state === "paused") {
    if (!r?.pausedFrom) return NONE;
    const back = RESUME[r.pausedFrom] ?? {
      to: "investigating",
      phase: "investigating",
    };
    return {
      step: "transition",
      to: back.to,
      phase: back.phase,
      detail: "Agents back on",
      patch: {
        pausedFrom: undefined,
        ...(back.phase === "watching" ? { watch: undefined } : {}),
      },
    };
  }

  // 5. Waiting on the owner; a question ends when the agent runs again.
  if (state === "needs-you") {
    const ny = r?.needsYou;
    if (
      ny?.kind === "question" &&
      !running.some((a) => statusOf(view, a) === "waiting")
    )
      return {
        step: "transition",
        to: incident.resumeState ?? "investigating",
        phase: ny.resumePhase,
        detail: "Question answered",
        patch: { needsYou: undefined },
      };
    return setupChanged(view) ?? NONE;
  }
  if (!r) return undefined;

  // The side states were left some other way: pick the work up again.
  if (r.phase === "paused")
    return {
      step: "transition",
      to: null,
      phase: (r.pausedFrom && RESUME[r.pausedFrom]?.phase) || "investigating",
      detail: "Agents back on",
      patch: { pausedFrom: undefined },
    };
  if (r.phase === "needs-you")
    return {
      step: "transition",
      to: null,
      phase: r.needsYou?.resumePhase ?? "investigating",
      detail: "Back from needs you",
      patch: { needsYou: undefined },
    };

  // 6. Budget, while agents are or will be working. A Retry does not get
  // past it on purpose (`retryRequested` is not read here): only a higher
  // budget, set by a signed-in person, lets the agents go on.
  if (
    (state === "investigating" || state === "fix-ready") &&
    (r.phase === "investigating" ||
      r.phase === "proving" ||
      r.phase === "verifying")
  ) {
    const problem = budgetProblem({
      incidentCostUsd: r.costUsd,
      monthCostUsd: view.monthCostUsd + r.costUsd,
      budget: settings.budget,
    });
    if (problem) {
      if (running.length)
        return { step: "cancel-agents", reason: problem.reason, for: "budget" };
      return {
        step: "needs-you",
        kind: "budget",
        reason: problem.reason,
        rule: problem.rule,
      };
    }
  }

  // 7. A turn that has run for too long.
  return overdueStep(view);
}

function starting(view: ResponseView): ResponseStep | undefined {
  const { incident, settings } = view;
  const r = incident.response;

  // 8. Watch level.
  if (settings.autonomy === "watch" && (!r || r.phase === "idle"))
    return {
      step: "transition",
      to: null,
      phase: "watch-only",
      detail: "Watching only",
    };
  if (r?.phase === "watch-only") {
    if (settings.autonomy === "watch") return NONE;
    return {
      step: "transition",
      to: null,
      phase:
        incident.state === "fix-ready" && r.verdict?.verdict === "certain"
          ? "deciding"
          : "idle",
      detail: "Agents on",
    };
  }

  // 9. No model to run agents on. A rollback-first incident still starts:
  // its rollback needs no agent.
  if (
    "error" in view.models &&
    (!r
      ? !(incident.state === "investigating" && rollbackFirstApplies(view))
      : r.phase === "idle" ||
        ((r.phase === "investigating" || r.phase === "verifying") &&
          runningAgents(view).length === 0))
  )
    return {
      step: "needs-you",
      kind: "setup",
      reason: view.models.error,
      retryable: false,
      fix: "providers",
    };

  // 10. First step.
  if (!r)
    return incident.state === "investigating"
      ? { step: "init", rollbackFirst: rollbackFirstApplies(view) }
      : NONE;

  // 11. Reopened, or back after a wait.
  if (
    (r.phase === "done" || r.phase === "documenting") &&
    incident.state === "investigating"
  ) {
    // A round no investigator worked in (closed before any agent could
    // start) is not used up: the reopen starts it.
    const ran = roundRan(r);
    if (ran && r.round + 1 > r.maxRounds)
      return {
        step: "needs-you",
        kind: "rounds",
        reason: `Reopened after ${r.round} rounds`,
      };
    const reopened = incident.events.findLast((e) => e.kind === "reopened");
    return {
      step: "transition",
      to: null,
      phase: "investigating",
      detail: "Reopened",
      patch: {
        round: ran ? r.round + 1 : r.round,
        sendBack: { kind: "reopened", detail: reopened?.detail ?? "Reopened" },
        candidate: undefined,
        proof: undefined,
        verdict: undefined,
        decision: undefined,
        veto: undefined,
        merge: undefined,
        watch: undefined,
        note: undefined,
        mergingSince: undefined,
        documentingSince: undefined,
        openPrs: undefined,
      },
    };
  }
  if (r.phase === "idle")
    return {
      step: "transition",
      to: incident.state === "investigating" ? null : "investigating",
      phase: "investigating",
      detail: "Agents back on",
    };
  return undefined;
}

/** Whether an investigator worked in the response's current round. A round
 *  closed before any agent started is not one of the rounds used. */
export function roundRan(r: IncidentResponse): boolean {
  return r.agents.some((a) => a.role === "investigator" && a.round === r.round);
}

/** Whether a Retry reads `run`'s refused report again rather than starting
 *  the agent over: the report was refused only for want of a pull request,
 *  which Sessions may have found since. */
export function rereadsReport(r: IncidentResponse, run: AgentRun): boolean {
  return (
    r.retryRequested === true &&
    run.role === "investigator" &&
    run.reportProblem === "pr" &&
    !run.report &&
    currentAgent(r, run.role)?.sessionId === run.sessionId
  );
}

/** A fix whose pull request Sessions has not seen. */
const NO_PR: ReportIssue = {
  rule: "pr",
  problem: REPORT_RULES.pr.problem,
  error: "Open a pull request with the note and the runbook update",
};

/** A refused report: every issue goes back to the agent, the first one
 *  is what the owner reads. */
function refused(
  run: AgentRun,
  issues: ReportIssue[],
): Extract<ResponseStep, { step: "record-report" }> {
  return {
    step: "record-report",
    sessionId: run.sessionId,
    error: issues[0]!.error,
    problem: issues[0]!.problem,
    issues,
  };
}

/** An accepted report's step, carrying the block's raw `findings` when it
 *  has the key. */
function withFindings(
  step: Extract<ResponseStep, { step: "record-report" }>,
  text: string,
): Extract<ResponseStep, { step: "record-report" }> {
  const findings = reportFindingsInput(text);
  if (findings !== undefined) step.findings = findings;
  return step;
}

function reports(view: ResponseView): ResponseStep | undefined {
  const r = view.incident.response!;
  const runs = [
    currentAgent(r, "investigator"),
    currentAgent(r, "verifier"),
  ].filter((a): a is AgentRun => a !== undefined);

  // 12. A finished agent's report; on a Retry, one refused for want of a
  // pull request is read again once its pull request is found. Read again
  // and still unusable, it is left to the Retry to start the agent over.
  for (const run of runs) {
    const reread = rereadsReport(r, run);
    if (
      statusOf(view, run) !== "done" ||
      run.report ||
      (run.reportError && !reread)
    )
      continue;
    const live = view.agents.get(run.sessionId);
    const prUrl = live?.prUrl ?? run.prUrl;
    if (reread && !prUrl) continue;
    const text = live?.finalText;
    if (text === undefined) {
      if (reread) continue;
      // Finished without a word after its turn was sent.
      if (view.now - Date.parse(run.turnSentAt) > FINAL_TEXT_GRACE_MS)
        return refused(run, [
          {
            rule: "block",
            problem: "missing",
            error: "No incident-report block",
          },
        ]);
      continue;
    }
    if (run.role === "investigator") {
      const target = httpTarget(primarySignal(view));
      const warnings: string[] = [];
      const parsed = parseInvestigatorReport(text, {
        warnings,
        actionIds: new Set(view.settings.actions.map((a) => a.id)),
        actionKinds: new Map(view.settings.actions.map((a) => [a.id, a.kind])),
        signalOrigin: target?.origin ?? null,
        signalRequest: target
          ? { method: target.method, path: target.path }
          : null,
      });
      if ("error" in parsed) {
        if (reread) continue;
        // A fix the report meant to propose needs its pull request too:
        // the agent hears about both in one reminder.
        return {
          ...refused(run, [
            ...parsed.issues,
            ...(parsed.candidate && !prUrl ? [NO_PR] : []),
          ]),
          error: parsed.error,
          problem: parsed.problem,
        };
      }
      if (parsed.candidate !== null && !prUrl) return refused(run, [NO_PR]);
      return withFindings(
        {
          step: "record-report",
          sessionId: run.sessionId,
          report: parsed,
          ...(warnings.length ? { warnings } : {}),
          ...(prUrl ? { prUrl } : {}),
          ...(reread ? { reread: true } : {}),
        },
        text,
      );
    }
    const warnings: string[] = [];
    const parsed = parseVerifierReport(text, {
      claims: r.candidate?.claims ?? [],
      warnings,
    });
    return "error" in parsed
      ? {
          ...refused(run, parsed.issues),
          error: parsed.error,
          problem: parsed.problem,
        }
      : withFindings(
          {
            step: "record-report",
            sessionId: run.sessionId,
            report: parsed,
            ...(warnings.length ? { warnings } : {}),
          },
          text,
        );
  }

  // 13. One reminder for a missing or invalid report.
  for (const run of runs)
    if (
      run.reportError &&
      !run.reminded &&
      !isRunning(view, run) &&
      statusOf(view, run) === "done"
    )
      return {
        step: "message-agent",
        sessionId: run.sessionId,
        message: "reminder",
      };
  return undefined;
}

/** Whether a run should be started again as a new attempt. */
function restart(
  view: ResponseView,
  run: AgentRun | undefined,
  retry: boolean,
): boolean {
  if (!run) return true;
  const status = statusOf(view, run);
  if (
    status === "cancelled" &&
    (run.cancelledFor === "paused" || run.cancelledFor === "provider")
  )
    return true;
  return (
    retry &&
    (status === "error" ||
      status === "cancelled" ||
      (run.reminded && run.reportError !== undefined))
  );
}

function agentProblem(
  view: ResponseView,
  run: AgentRun,
): ResponseStep | undefined {
  const status = statusOf(view, run);
  const label = roleLabel(run.role);
  if (status === "waiting")
    return {
      step: "needs-you",
      kind: "question",
      reason: `The ${run.role} asked a question`,
    };
  if (status === "error")
    return {
      step: "needs-you",
      kind: "agent-error",
      reason: `The ${run.role} stopped: ${view.agents.get(run.sessionId)?.error ?? run.error ?? `${label} failed`}`,
    };
  if (status === "cancelled" && run.cancelledFor === "timeout")
    return {
      step: "needs-you",
      kind: "agent-error",
      reason: run.error ?? `The ${run.role} ran for 2 h without finishing`,
    };
  // Stopped from outside Sessions (its own session's Stop).
  if (status === "cancelled" && run.cancelledFor === undefined)
    return {
      step: "needs-you",
      kind: "agent-error",
      reason: `The ${run.role} was stopped`,
    };
  return undefined;
}

function investigation(view: ResponseView): ResponseStep {
  const r = view.incident.response!;
  const inv = currentAgent(r, "investigator");

  // 14. Start, or start again.
  if (restart(view, inv, r.retryRequested === true) || !inv)
    return {
      step: "start-agent",
      role: "investigator",
      round: r.round,
      attempt: (inv?.attempt ?? 0) + 1,
    };
  const status = statusOf(view, inv);

  // 15. A new round for the same investigator.
  if (inv.round < r.round) {
    if (status === "done")
      return {
        step: "message-agent",
        sessionId: inv.sessionId,
        message: "send-back",
      };
    // Its session ended; the new round starts a fresh one.
    if (status === "error" || status === "cancelled")
      return {
        step: "start-agent",
        role: "investigator",
        round: r.round,
        attempt: inv.attempt + 1,
      };
    return NONE;
  }

  // 16. Problems.
  const problem = agentProblem(view, inv);
  if (problem) return problem;
  if (inv.reportError && inv.reminded)
    return {
      step: "needs-you",
      kind: "no-report",
      reason: plainReportProblem("investigator", inv.reportProblem),
    };

  const report = inv.report;
  if (report?.role !== "investigator") return NONE;
  // 17. No fix.
  if (report.candidate === null)
    return {
      step: "needs-you",
      kind: "no-candidate",
      reason: `No fix found: ${report.noCandidateReason ?? report.cause}`,
    };
  // 18. A candidate.
  return {
    step: "transition",
    to: "fix-ready",
    phase: "proving",
    detail: `Candidate from round ${r.round}: ${report.summary}`,
    patch: {
      candidate: {
        round: r.round,
        plan: report.candidate,
        check: report.check,
        claims: report.claims,
        notePath: report.notePath,
        runbookPaths: report.runbookPaths,
        ...(view.agents.get(inv.sessionId)?.prUrl || inv.prUrl
          ? { prUrl: view.agents.get(inv.sessionId)?.prUrl ?? inv.prUrl }
          : {}),
      },
      proof: undefined,
      verdict: undefined,
    },
  };
}

function proving(view: ResponseView): ResponseStep {
  const r = view.incident.response!;
  // 20.
  if (r.proof?.round !== r.round) return { step: "run-proof" };
  if (r.proof.baseline.verdict === "passes")
    return {
      step: "needs-you",
      kind: "proof-stopped",
      reason: "The problem stopped before the fix could be proven",
    };
  if (!r.candidate?.pr || stale(r.candidate.pr.fetchedAt, view.now))
    return { step: "fetch-pr", purpose: "verify" };
  return {
    step: "transition",
    to: null,
    phase: "verifying",
    detail: "Proof measured",
  };
}

function verifying(view: ResponseView): ResponseStep {
  const r = view.incident.response!;
  // 21. The current round's verifier.
  const ver = r.agents.findLast(
    (a) => a.role === "verifier" && a.round === r.round,
  );
  if (restart(view, ver, r.retryRequested === true) || !ver)
    return {
      step: "start-agent",
      role: "verifier",
      round: r.round,
      attempt: (ver?.attempt ?? 0) + 1,
    };
  const problem = agentProblem(view, ver);
  if (problem) return problem;
  const at = iso(view.now);
  if (ver.reportError && ver.reminded) {
    const reasons = ["The verifier did not return a valid report"];
    return sendBack(view, { kind: "not-certain", reasons }, reasons[0]!, {
      round: r.round,
      at,
      verdict: "not-certain",
      reasons,
    });
  }
  const report = ver.report;
  if (report?.role !== "verifier") return NONE;
  if (!r.candidate?.pr) return { step: "fetch-pr", purpose: "verify" };
  if (!r.proof) return { step: "run-proof" };

  // 22. Sessions' verdict over the verifier's.
  const verdict = effectiveVerdict({
    report,
    proof: r.proof,
    knowledge: checkKnowledge(r.candidate.pr.files, r.candidate),
  });
  if (verdict.verdict === "certain")
    return {
      step: "transition",
      to: null,
      phase: "deciding",
      detail: "Verifier is certain",
      patch: {
        verdict: {
          round: r.round,
          at,
          verdict: "certain",
          reasons: [],
          verifiedSha: r.candidate.pr.headSha,
        },
      },
    };
  const reasons = verdict.reasons.length
    ? verdict.reasons
    : ["The verifier was not certain"];
  return sendBack(view, { kind: "not-certain", reasons }, reasons[0]!, {
    round: r.round,
    at,
    verdict: "not-certain",
    reasons,
  });
}

/** A new round after a rollback: everything about the last candidate goes. */
function nextRound(
  r: IncidentResponse,
  detail: string,
): Partial<IncidentResponse> {
  return {
    round: r.round + 1,
    sendBack: { kind: "rolled-back", detail },
    candidate: undefined,
    proof: undefined,
    verdict: undefined,
    decision: undefined,
    veto: undefined,
    merge: undefined,
    watch: undefined,
    mergingSince: undefined,
    ownerRollback: undefined,
  };
}

function primaryName(view: ResponseView): string {
  return primarySignal(view)?.name ?? "The signal";
}

function primaryState(view: ResponseView): string {
  return (
    view.evaluations.get(view.incident.primarySignalId)?.state ?? "failing"
  );
}

function now(view: ResponseView): string {
  return iso(view.now);
}

// 23. A rollback-first candidate: the investigator studies the release in
// parallel. Its report is recorded and never changes the phase. It is best
// effort: over budget or without a model it is skipped (and recorded), and
// the rollback goes on. Refused by the access gate for a passing reason, it
// waits for its retry time while the rollback goes on.
function rollbackFirstInvestigator(
  view: ResponseView,
): ResponseStep | undefined {
  const r = view.incident.response!;
  if (
    !r.candidate?.rollbackFirst ||
    r.parallelInvestigator ||
    currentAgent(r, "investigator")
  )
    return undefined;
  const problem = budgetProblem({
    incidentCostUsd: r.costUsd,
    monthCostUsd: view.monthCostUsd + r.costUsd,
    budget: view.settings.budget,
  });
  if (problem)
    return {
      step: "skip-parallel-investigator",
      outcome: "refused",
      reason: problem.reason,
    };
  if ("error" in view.models)
    return {
      step: "skip-parallel-investigator",
      outcome: "unavailable",
      reason: view.models.error,
    };
  const retryAt = Date.parse(r.parallelInvestigatorRetryAt ?? "");
  if (view.now < retryAt) return undefined;
  return { step: "start-agent", role: "investigator", round: 1, attempt: 1 };
}

function afterVerification(view: ResponseView): ResponseStep {
  const r = view.incident.response!;
  switch (r.phase) {
    case "deciding":
      return deciding(view);
    case "veto":
      return vetoStep(view);
    case "deploying":
      return deployingStep(view);
    default:
      return watchingStep(view);
  }
}

function prRef(r: IncidentResponse): string {
  const n = r.candidate?.pr?.number;
  return n === undefined ? "the PR" : `PR #${n}`;
}

// 24.
function deciding(view: ResponseView): ResponseStep {
  const { settings } = view;
  const r = view.incident.response!;
  const c = r.candidate;
  if (!c)
    return {
      step: "needs-you",
      kind: "no-action",
      reason: "There is no candidate to decide on",
    };
  const plan = c.plan;
  if (plan.pr && (!c.pr || stale(c.pr.fetchedAt, view.now)))
    return { step: "fetch-pr", purpose: "merge" };
  const facts = changeFacts({
    plan,
    settings,
    prFiles: plan.pr ? (c.pr?.files ?? null) : [],
  });
  if ("error" in facts)
    return { step: "needs-you", kind: "no-action", reason: facts.error };
  const primary = primarySignal(view);
  const decision = evaluatePolicy({
    settings,
    facts: facts.facts,
    independence: currentAgent(r, "verifier")?.independence ?? "other-provider",
    now: view.now,
    fullyDown: primary
      ? fullyDown({
          ownSignalIds: ownSignalIds(view),
          evaluations: view.evaluations,
          primaryRecent: view.primaryRecent,
          primary,
          now: view.now,
        })
      : false,
  });
  if (decision.kind === "watch")
    return {
      step: "transition",
      to: null,
      phase: "watch-only",
      detail: "Watching only",
      patch: { decision },
    };
  if (decision.kind === "ask")
    return {
      step: "needs-you",
      kind: "policy",
      reason: decision.reason,
      rule: decision.rule,
      patch: { decision },
    };
  if (plan.pr && c.pr) {
    const a = assessAutoMerge(c.pr, r.verdict?.verifiedSha ?? "");
    if (a.kind === "needs-you")
      return {
        step: "needs-you",
        kind: a.needsYou,
        reason: a.reason,
        patch: { decision },
      };
    if (a.kind === "send-back")
      return sendBack(
        view,
        { kind: "check-failed", detail: a.reason },
        a.reason,
      );
  }
  if (decision.after === "veto") return { step: "open-veto", decision };
  return {
    step: "transition",
    to: "deploying",
    phase: plan.pr ? "merging" : "deploying",
    detail: decision.rule,
    patch: { decision, mergingSince: now(view) },
  };
}

// 25.
function vetoStep(view: ResponseView): ResponseStep {
  const r = view.incident.response!;
  if (!r.veto || !(view.now >= Date.parse(r.veto.deadline))) return NONE;
  return {
    step: "transition",
    to: "deploying",
    phase: r.candidate?.plan.pr ? "merging" : "deploying",
    detail: "Veto window elapsed",
    patch: { veto: undefined, mergingSince: now(view) },
  };
}

// 26. Only the verified head is ever merged.
function mergingStep(view: ResponseView): ResponseStep {
  const r = view.incident.response!;
  const n = prRef(r);
  if (r.merge?.status === "merged")
    return {
      step: "transition",
      to: null,
      phase: "deploying",
      detail: `Merged ${n}`,
    };
  if (r.merge?.status === "refused")
    return {
      step: "needs-you",
      kind: "merge",
      reason: r.merge.detail ?? `GitHub refused to merge ${n}`,
    };
  const pr = r.candidate?.pr;
  if (!pr || stale(pr.fetchedAt, view.now))
    return { step: "fetch-pr", purpose: "merge" };
  const verifiedSha = r.verdict?.verifiedSha ?? "";
  const a = assessAutoMerge(pr, verifiedSha);
  switch (a.kind) {
    case "ready":
      return { step: "merge" };
    case "merged":
      if (pr.headSha !== verifiedSha)
        return {
          step: "needs-you",
          kind: "merge",
          reason: `${n} was merged with changes after verification`,
        };
      return {
        step: "transition",
        to: null,
        phase: "deploying",
        detail: `${n} was already merged`,
        patch: {
          merge: {
            ghRepo: pr.ghRepo,
            number: pr.number,
            sha: verifiedSha,
            status: "merged",
            ...(pr.mergeCommitSha ? { mergedSha: pr.mergeCommitSha } : {}),
            at: now(view),
          },
        },
      };
    case "wait": {
      const since = Date.parse(r.mergingSince ?? "");
      if (!(view.now - since < PR_CHECKS_WAIT_MS))
        return {
          step: "needs-you",
          kind: "merge",
          reason: `Checks are still running on ${n} after ${PR_CHECKS_WAIT_MS / 60_000} min`,
        };
      return NONE;
    }
    case "needs-you":
      return { step: "needs-you", kind: a.needsYou, reason: a.reason };
    case "send-back":
      return sendBack(
        view,
        { kind: "check-failed", detail: a.reason },
        a.reason,
      );
  }
}

/** How a recorded action run goes on: wait, ask, or done. Never re-run. */
function actionRunProblem(
  view: ResponseView,
  run: ActionRun,
  failedReason: (detail: string) => string,
): ResponseStep | "ok" {
  switch (run.status) {
    case "running":
      if (view.liveActionRunIds.has(run.id)) return NONE;
      return interrupted(run);
    case "interrupted":
      return interrupted(run);
    case "unknown":
      return {
        step: "needs-you",
        kind: "action-failed",
        reason: `${run.label}: ${run.detail}`,
      };
    case "failed":
      return {
        step: "needs-you",
        kind: "action-failed",
        reason: failedReason(run.detail),
      };
    case "ok":
      return "ok";
  }
}

function interrupted(run: ActionRun): ResponseStep {
  return {
    step: "needs-you",
    kind: "interrupted",
    reason: `Sessions restarted while ${run.label} was running. Check production before going on.`,
  };
}

// 27. Each step once, in order.
function deployingStep(view: ResponseView): ResponseStep {
  const { settings } = view;
  const r = view.incident.response!;
  const c = r.candidate;
  if (!c)
    return {
      step: "needs-you",
      kind: "no-action",
      reason: "There is no candidate to deploy",
    };
  const facts = changeFacts({ plan: c.plan, settings, prFiles: [] });
  if ("error" in facts)
    return { step: "needs-you", kind: "no-action", reason: facts.error };
  const purpose: ActionRun["purpose"] = c.rollbackFirst
    ? "rollback-first"
    : "plan";
  for (const action of facts.steps) {
    if (action.kind === "deploy" && c.plan.pr && !r.merge?.mergedSha)
      return {
        step: "needs-you",
        kind: "merge",
        reason: `No merge commit to deploy for ${prRef(r)}`,
      };
    const run = r.actionRuns.findLast(
      (a) =>
        a.round === r.round &&
        a.actionId === action.id &&
        a.purpose === purpose,
    );
    if (!run) return { step: "run-action", actionId: action.id, purpose };
    const next = actionRunProblem(
      view,
      run,
      (detail) => `${run.label} failed: ${detail}`,
    );
    if (next !== "ok") return next;
  }
  return { step: "start-watch" };
}

// 28. Resolved when every own signal is back after the watch started.
function watchingStep(view: ResponseView): ResponseStep {
  const { settings } = view;
  const r = view.incident.response!;
  if (!r.watch) return { step: "start-watch" };
  const own = ownSignalIds(view);
  const watched = own.length ? own : [view.incident.primarySignalId];
  const started = Date.parse(r.watch.startedAt);
  const green = watched.every((id) => {
    const e = view.evaluations.get(id);
    return e?.state === "ok" && Date.parse(e.since) >= started;
  });
  if (green) {
    const names = watched.map((id) => view.signals.get(id)?.name ?? id);
    return {
      step: "resolve",
      fixedBy: r.ownerTouched ? "agents-with-you" : "agents",
      detail: `${names.join(", ")} back to normal after the release`,
    };
  }
  if (!(view.now >= Date.parse(r.watch.deadline))) return NONE;
  const name = primaryName(view);
  const state = primaryState(view);
  const steps = r.candidate
    ? changeFacts({ plan: r.candidate.plan, settings, prFiles: [] })
    : { error: "" };
  const onlyRollbacks =
    !("error" in steps) &&
    steps.steps.length > 0 &&
    steps.steps.every((s) => s.kind === "rollback");
  if (r.candidate?.rollbackFirst || onlyRollbacks)
    return {
      step: "needs-you",
      kind: "action-failed",
      reason: `The rollback did not bring ${name} back`,
    };
  if (projectAction(settings, "rollback"))
    return {
      step: "transition",
      to: "rolled-back",
      phase: "rolling-back",
      detail: `${name} still ${state} after the watch window`,
    };
  return {
    step: "needs-you",
    kind: "no-action",
    reason: `${name} is still ${state} after the release and there is no rollback action`,
  };
}

/** The purpose this round's rollback runs with. */
function rollbackPurpose(r: IncidentResponse): ActionRun["purpose"] {
  return r.ownerRollback ? "owner-rollback" : "auto-rollback";
}

/** This round's rollback run, if it started. */
function rollbackRun(
  r: IncidentResponse,
  rollback: IncidentAction,
): ActionRun | undefined {
  const purpose = rollbackPurpose(r);
  return r.actionRuns.findLast(
    (a) =>
      a.round === r.round &&
      a.actionId === rollback.id &&
      a.purpose === purpose,
  );
}

/**
 * The kill switch in `rolled-back`. A rollback that finished goes on to the
 * next round, which the next advance pauses. Otherwise the rollback does
 * not run while agents are paused, and the failed release is still out: a
 * person decides what happens next.
 */
function pausedRollback(view: ResponseView): ResponseStep {
  const r = view.incident.response;
  const rollback = projectAction(view.settings, "rollback");
  const run = r && rollback ? rollbackRun(r, rollback) : undefined;
  if (run?.status === "ok") return afterRollback(view);
  const why = !run
    ? "Agents were paused before the rollback ran"
    : `Agents were paused after the rollback ${
        run.status === "failed"
          ? "failed"
          : run.status === "unknown"
            ? "may not have run"
            : "was interrupted"
      } (${run.detail})`;
  return {
    step: "needs-you",
    kind: "action-failed",
    reason: `${why}; the release is still out`,
    via: "investigating",
    ...(r ? { patch: { ...nextRound(r, why), phase: "investigating" } } : {}),
  };
}

// 29. The rollback, then the next round.
function rollingBack(view: ResponseView): ResponseStep {
  const { incident, settings } = view;
  const r = incident.response!;
  const rollback = projectAction(settings, "rollback");
  if (!rollback)
    return {
      step: "needs-you",
      kind: "no-action",
      reason: `No rollback action is declared for ${incident.project}`,
    };
  const run = rollbackRun(r, rollback);
  if (!run)
    return {
      step: "run-action",
      actionId: rollback.id,
      purpose: rollbackPurpose(r),
    };
  const next = actionRunProblem(
    view,
    run,
    (detail) => `Rollback failed: ${detail}`,
  );
  if (next !== "ok") return next;
  return afterRollback(view);
}

/** The rollback finished: the next round. */
function afterRollback(view: ResponseView): ResponseStep {
  const { incident, settings } = view;
  const r = incident.response!;
  const owner = r.ownerRollback;
  const to = incident.state === "investigating" ? null : "investigating";
  // The owner asked, so the next round is not capped by max rounds.
  if (owner)
    return {
      step: "transition",
      to,
      phase: "investigating",
      detail: `Rolled back by ${owner.by}`,
      patch: {
        ...nextRound(r, `${owner.by} rolled back the release`),
        ownerRollback: undefined,
      },
    };
  if (r.round < r.maxRounds)
    return {
      step: "transition",
      to,
      phase: "investigating",
      detail: "Rolled back",
      patch: nextRound(
        r,
        `${primaryName(view)} was still ${primaryState(view)} ${Math.round(settings.watchMs / 60_000)} min after the release`,
      ),
    };
  return {
    step: "needs-you",
    kind: "rounds",
    reason: `Rolled back after ${r.round} rounds`,
  };
}

// 30. The incident note after resolution. Never wakes anyone.
function documenting(view: ResponseView): ResponseStep {
  const { settings } = view;
  const r = view.incident.response!;
  const inv = currentAgent(r, "investigator");
  if (inv && isRunning(view, inv)) return NONE;
  const done = (
    detail: string,
    note: NonNullable<IncidentResponse["note"]>,
  ): ResponseStep => ({
    step: "transition",
    to: null,
    phase: "done",
    detail,
    patch: { note },
  });
  if (r.candidate?.plan.pr && r.merge?.status === "merged")
    return done("Note merged with the fix", {
      ...(r.candidate.prUrl ? { prUrl: r.candidate.prUrl } : {}),
      merged: true,
    });
  const prUrl = inv
    ? (view.agents.get(inv.sessionId)?.prUrl ?? inv.prUrl)
    : undefined;
  if (!prUrl)
    return done("No note PR was opened", {
      merged: false,
      detail: "No note PR was opened",
    });
  const pr = r.note?.pr;
  if (!pr || stale(pr.fetchedAt, view.now))
    return { step: "fetch-pr", purpose: "note" };
  const note = r.note!;
  const n = `PR #${pr.number}`;
  const close = (detail: string, merged = false) =>
    done(detail, {
      ...note,
      prUrl,
      merged,
      ...(merged ? {} : { detail }),
    });
  if (pr.state === "MERGED") return close("Note merged", true);
  if (pr.files === null)
    return close(
      `Sessions could not read the files of ${n}, so it is left open for review`,
    );
  if (pr.files.some((f) => !globMatch(KNOWLEDGE_GLOB, f)))
    return close(`${n} has code changes, so it is left open for review`);
  if (settings.autonomy === "watch" || settings.autonomy === "propose")
    return close(`Note ${n} is waiting for you`);
  if (settings.agentsPaused)
    return close(`Note ${n} is waiting for you: agents are paused`);
  if (note.merged) return close("Note merged", true);
  if (note.detail) return close(note.detail);
  const a = assessAutoMerge(pr, pr.headSha);
  switch (a.kind) {
    case "ready":
      return { step: "merge-note" };
    case "merged":
      return close("Note merged", true);
    case "wait": {
      const since = Date.parse(r.documentingSince ?? "");
      if (view.now - since < PR_CHECKS_WAIT_MS) return NONE;
      return close(`Note ${n} is waiting for checks`);
    }
    default:
      return close(a.reason);
  }
}

export function decideNextStep(view: ResponseView): ResponseStep {
  const guarded = guards(view);
  if (guarded) return guarded;
  const started = starting(view);
  if (started) return started;
  const reported = reports(view);
  if (reported) return reported;
  const r = view.incident.response!;
  switch (r.phase) {
    case "investigating":
      return investigation(view);
    case "proving":
      return proving(view);
    case "verifying":
      return verifying(view);
    case "deciding":
    case "veto":
    case "deploying":
    case "watching":
      return rollbackFirstInvestigator(view) ?? afterVerification(view);
    case "merging":
      return mergingStep(view);
    case "rolling-back":
      return rollingBack(view);
    default:
      return NONE;
  }
}
