// The whole fix loop as one pure function: given the stored incident and
// what is live right now, the single next step. The coordinator applies the
// step, writes the result into `incident.response` and asks again. Rules are
// in priority order; the first that matches wins.
import type {
  AgentRole,
  AgentRun,
  IncidentProjectSettings,
  IncidentResponse,
  NeedsYouKind,
  NextAction,
  OwnerDecision,
  ResponsePhase,
  SendBackReason,
  Verdict,
} from "../../../shared/incident-response";
import {
  type Incident,
  type IncidentState,
  type Signal,
  isTerminalIncidentState,
} from "../../../shared/incidents";
import { budgetProblem } from "./policy";
import { latestRelease, projectAction } from "./project-settings";
import {
  checkKnowledge,
  effectiveVerdict,
  parseInvestigatorReport,
  parseVerifierReport,
} from "./reports";
import {
  AGENT_MAX_MS,
  FINAL_TEXT_GRACE_MS,
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
  const release = latestRelease(view.settings);
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
    case "budget":
    case "agent-error":
    case "no-report":
    case "setup":
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
      return `Investigator working, round ${r.round} of ${r.maxRounds}`;
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
    const { kind, reason } = r.needsYou;
    const rule = kind === "policy" ? r.decision?.rule : undefined;
    return {
      kind: "needs-you",
      reason,
      needsYou: kind,
      ...(rule ? { rule } : {}),
      options: needsYouOptions(kind, r),
    };
  }
  if (isTerminalIncidentState(incident.state))
    return {
      kind: "done",
      detail:
        incident.state === "resolved" ? "Resolved" : "Closed without action",
      options: rollback(),
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
        mergingSince: undefined,
      },
    };
  return {
    step: "needs-you",
    kind: "rounds",
    reason: `Not certain after ${r.maxRounds} rounds: ${firstReason}`,
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
    if (state === "rolled-back")
      return {
        step: "transition",
        to: "investigating",
        phase: "investigating",
        detail: "Agents paused",
      };
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
    return NONE;
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

  // 6. Budget, while agents are or will be working.
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
  const overdue = running.find(
    (a) =>
      statusOf(view, a) === "running" &&
      !(view.now - Date.parse(a.turnSentAt) <= AGENT_MAX_MS),
  );
  if (overdue)
    return {
      step: "cancel-agents",
      reason: `The ${overdue.role} ran for 2 h without finishing`,
      for: "timeout",
    };
  return undefined;
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

  // 9. No model to run agents on.
  if (
    "error" in view.models &&
    (!r ||
      r.phase === "idle" ||
      ((r.phase === "investigating" || r.phase === "verifying") &&
        runningAgents(view).length === 0))
  )
    return { step: "needs-you", kind: "setup", reason: view.models.error };

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
    if (r.round + 1 > r.maxRounds)
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
        round: r.round + 1,
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

function reports(view: ResponseView): ResponseStep | undefined {
  const r = view.incident.response!;
  const runs = [
    currentAgent(r, "investigator"),
    currentAgent(r, "verifier"),
  ].filter((a): a is AgentRun => a !== undefined);

  // 12. A finished agent's report.
  for (const run of runs) {
    if (statusOf(view, run) !== "done" || run.report || run.reportError)
      continue;
    const live = view.agents.get(run.sessionId);
    const text = live?.finalText;
    if (text === undefined) {
      // Finished without a word after its turn was sent.
      if (view.now - Date.parse(run.turnSentAt) > FINAL_TEXT_GRACE_MS)
        return {
          step: "record-report",
          sessionId: run.sessionId,
          error: "No incident-report block",
        };
      continue;
    }
    if (run.role === "investigator") {
      const target = httpTarget(primarySignal(view));
      const parsed = parseInvestigatorReport(text, {
        actionIds: new Set(view.settings.actions.map((a) => a.id)),
        actionKinds: new Map(view.settings.actions.map((a) => [a.id, a.kind])),
        signalOrigin: target?.origin ?? null,
        signalRequest: target
          ? { method: target.method, path: target.path }
          : null,
      });
      if ("error" in parsed)
        return {
          step: "record-report",
          sessionId: run.sessionId,
          error: parsed.error,
        };
      if (parsed.candidate !== null && !(live?.prUrl ?? run.prUrl))
        return {
          step: "record-report",
          sessionId: run.sessionId,
          error: "Open a pull request with the note and the runbook update",
        };
      return {
        step: "record-report",
        sessionId: run.sessionId,
        report: parsed,
      };
    }
    const parsed = parseVerifierReport(text, {
      claims: r.candidate?.claims ?? [],
    });
    return "error" in parsed
      ? { step: "record-report", sessionId: run.sessionId, error: parsed.error }
      : { step: "record-report", sessionId: run.sessionId, report: parsed };
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
      reason: `The investigator finished without a valid report: ${inv.reportError}`,
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
    default:
      return NONE;
  }
}
