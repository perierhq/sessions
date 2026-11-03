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
  PostReleaseVerdict,
  ProofDeferral,
  ReportIssue,
  ResponsePhase,
  SendBackReason,
  EarlierVerifierFindings,
  Verdict,
  VerifierFindings,
} from "../../../shared/incident-response";
import { claimKey, findingSetOf } from "../../../shared/findings";
import {
  WATCH_FAILURES_MAX,
  roundOfMax,
} from "../../../shared/incident-response";
import {
  RECOVERED_MIN_PASSES,
  closesWhenRecovered,
  recoveredCloseAt,
} from "../../../shared/incident-recovery";
import {
  type Incident,
  type IncidentState,
  type Observation,
  type Signal,
  type SignalState,
  isTerminalIncidentState,
} from "../../../shared/incidents";
import { recoveriesFor } from "../rules";
import { KNOWLEDGE_GLOB, changeFacts, globMatch } from "./facts";
import { assessAutoMerge, parsePrUrl } from "./merge";
import { agentOptionsFor, handReleaseOpen } from "./options";
import { movedPrs } from "./outside";
import {
  baseRateWatchMs,
  failingParts,
  failuresSince,
  releaseAfter,
  releaseObservable,
  samePart,
  spellLength,
  spellStarts,
} from "./watch";
import { budgetProblem, evaluatePolicy, fullyDown } from "./policy";
import { projectAction, releaseToRollBack } from "./project-settings";
import {
  REPORT_RULES,
  checkKnowledge,
  effectiveVerdict,
  parseInvestigatorReport,
  parsePostReleaseReport,
  parseVerifierReport,
  plainReportProblem,
  reportFindingsInput,
} from "./reports";
import { isSandboxImageBuildingError } from "../../sandbox/reliability";
import {
  AGENT_MAX_MS,
  FINAL_TEXT_GRACE_MS,
  ACTIONS_RECHECK_MS,
  CHECKS_RECHECK_MS,
  HAND_RELEASE_REFRESH_MS,
  PR_CHECKS_WAIT_MS,
  PR_REFRESH_MS,
  ROLLBACK_FIRST_WINDOW_MS,
  CHECK_MAX_MS,
  RELEASE_WAIT_MS,
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
  return r.agents.findLast((a) => a.role === role && !a.check);
}

/** The round's post-release check, newest attempt. */
export function postReleaseRun(r: IncidentResponse): AgentRun | undefined {
  return r.agents.findLast(
    (a) => a.check === "post-release" && a.round === r.round,
  );
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

/**
 * Why Deploy the fix can't work for the candidate now, as a clause; else
 * undefined. A required check failing sends the work back at the merge,
 * and a pull request with no deploy action stops after it.
 */
export function approveBlocked(
  r: IncidentResponse,
  settings: IncidentProjectSettings,
): string | undefined {
  const c = r.candidate;
  if (!c || c.rollbackFirst) return undefined;
  const pr = c.pr;
  if (c.plan.pr && pr && pr.state === "OPEN" && pr.failingChecks.length) {
    const checks = pr.failingChecks.slice(0, 3).join(", ");
    return `${pr.failingChecks.length === 1 ? "check" : "checks"} ${checks} ${pr.failingChecks.length === 1 ? "fails" : "fail"} on PR #${pr.number}`;
  }
  const facts = changeFacts({ plan: c.plan, settings, prFiles: [] });
  if ("error" in facts)
    return facts.error.charAt(0).toLowerCase() + facts.error.slice(1);
  return undefined;
}

/** Whether the owner may release the candidate's pull request by hand and
 *  have Sessions watch after: a verified head on an open pull request. */
export function handReleaseAvailable(r: IncidentResponse): boolean {
  return handReleaseOpen(r);
}

/** Whether `kind`'s card would offer Deploy the fix, before asking whether
 *  it can work. */
function offersApprove(kind: NeedsYouKind, r: IncidentResponse): boolean {
  switch (kind) {
    case "policy":
    case "protection":
    case "stopped":
      return r.verdict?.verdict === "certain" || !!r.candidate?.rollbackFirst;
    case "unproven":
      // Deploy the fix merges the head the verifier reviewed, and the watch
      // after release is the proof.
      return !!r.candidate && !!r.verdict?.verifiedSha;
    default:
      return false;
  }
}

/** `settings`, when given, keeps Deploy the fix off a card where it can't
 *  work (approveBlocked); the card says why instead. */
export function needsYouOptions(
  kind: NeedsYouKind,
  r: IncidentResponse,
  settings?: IncidentProjectSettings,
): OwnerDecision[] {
  const approve: OwnerDecision[] =
    offersApprove(kind, r) && !(settings && approveBlocked(r, settings))
      ? ["approve"]
      : [];
  switch (kind) {
    case "policy":
    case "protection":
    case "stopped":
      return [...approve, "send-back", "close"];
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
    case "proof-stopped":
      // Another round meets the same gate while the problem is away, so
      // Send it back is offered only while a round would be left after it.
      return sendBackLeavesARound(r)
        ? ["send-back", "resolve", "close"]
        : ["resolve", "close"];
    case "unproven":
      // The owner may also release it by hand (a project without a deploy
      // action, or checks that can't run) and have Sessions watch after.
      return [
        ...approve,
        ...(handReleaseAvailable(r) ? (["release-watch"] as const) : []),
        "send-back",
        "resolve",
        "close",
      ];
    case "rounds":
      // The rounds are used up, and the owner may still ship the reviewed
      // head by hand and have Sessions watch after.
      return [
        ...(handReleaseAvailable(r) ? (["release-watch"] as const) : []),
        "send-back",
        "resolve",
        "close",
      ];
    default:
      return ["send-back", "resolve", "close"];
  }
}

function sendBackLeavesARound(r: IncidentResponse): boolean {
  return r.round + 1 < r.maxRounds;
}

/** What the card says beyond the stored reason: why Send it back or
 *  Deploy the fix is not offered, and the incident's open pull requests. */
function needsYouReason(
  r: IncidentResponse,
  settings: IncidentProjectSettings,
): string {
  const ny = r.needsYou!;
  let reason = ny.reason;
  if (ny.kind === "proof-stopped" && !sendBackLeavesARound(r))
    reason +=
      ". Sending it back would spend the last round and stop here again while the problem is away; Sessions measures again if it fails again";
  const blocked = offersApprove(ny.kind, r)
    ? approveBlocked(r, settings)
    : undefined;
  if (blocked)
    reason = `${reason.replace(/\.$/, "")}. Deploy the fix isn't offered: ${blocked}.`;
  const others = r.otherFailures ?? [];
  if (others.length)
    reason = `${reason.replace(/\.$/, "")}. Another part failed meanwhile: ${others
      .slice(-3)
      .map((o) => `${o.detail} at ${hhmmUtc(Date.parse(o.at))} UTC`)
      .join("; ")}.`;
  const prs = ny.prs ?? [];
  if (!prs.length) return reason;
  const numbers = prs.map((p) => `#${p.number}`).join(", ");
  return `${reason.replace(/\.$/, "")}. Open pull ${prs.length === 1 ? "request" : "requests"}: ${numbers}.`;
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
      if (r.handRelease)
        return `Waiting for ${r.handRelease.by} to merge and release PR #${r.handRelease.number}`;
      return r.candidate?.pr
        ? `Merging PR #${r.candidate.pr.number}`
        : "Merging the fix";
    case "deploying":
      if (r.handRelease && !r.watch)
        return r.release
          ? "Starting the watch"
          : `Waiting for the release of PR #${r.handRelease.number}`;
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
    const { kind, fix } = r.needsYou;
    const rule = kind === "policy" ? r.decision?.rule : undefined;
    const own = agentOptionsFor(incident, settings);
    return {
      kind: "needs-you",
      reason: needsYouReason(r, settings),
      needsYou: kind,
      ...(rule ? { rule } : {}),
      ...(kind === "setup" && fix ? { fix } : {}),
      options: needsYouOptions(kind, r, settings),
      ...(own.options.length
        ? {
            agentOptions: own.options,
            ...(own.question ? { agentQuestion: own.question } : {}),
          }
        : {}),
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

const VERIFIER_CLAIMS_MAX = 10;
const VERIFIER_QUESTIONS_MAX = 8;
const VERIFIER_HYPOTHESES_MAX = 5;

/**
 * What round `round`'s verifier found: its verdict's reasons (Sessions'
 * own when given), its claim checks and its findings' questions and
 * hypotheses. Undefined when no verifier reported in that round.
 */
export function verifierFindingsOf(
  r: IncidentResponse,
  round: number,
  reasons?: string[],
): VerifierFindings | undefined {
  const report = r.agents.findLast(
    (a) => a.role === "verifier" && !a.check && a.round === round,
  )?.report;
  const set = findingSetOf(r, "verifier", round);
  if (report?.role !== "verifier" && !set) return undefined;
  const verifier = report?.role === "verifier" ? report : undefined;
  const blocks = set?.blocks ?? [];
  return {
    round,
    reasons:
      reasons ??
      (r.verdict?.round === round ? r.verdict.reasons : undefined) ??
      verifier?.reasons ??
      [],
    claims: (verifier?.claims ?? []).slice(0, VERIFIER_CLAIMS_MAX),
    questions: blocks
      .flatMap((b) =>
        b.kind === "question"
          ? [{ text: b.text, wouldAnswer: b.wouldAnswer }]
          : [],
      )
      .slice(0, VERIFIER_QUESTIONS_MAX),
    hypotheses: blocks
      .flatMap((b) => (b.kind === "hypothesis" ? [b.statement] : []))
      .slice(0, VERIFIER_HYPOTHESES_MAX),
  };
}

/**
 * What the verifiers of rounds before `round` found that is still open:
 * their reasons, questions and hypotheses and the claims they could not
 * verify, oldest round first. A text a later verifier (or `current`, the
 * round sent back) said again is kept only there, so each finding appears
 * once, in its newest words.
 */
export function earlierVerifierFindings(
  r: IncidentResponse,
  round: number,
  current?: VerifierFindings,
): EarlierVerifierFindings {
  const seen = new Set<string>();
  const fresh = (text: string) => {
    const key = claimKey(text);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  if (current) {
    current.reasons.forEach(fresh);
    current.claims.forEach((c) => fresh(c.text));
    current.questions.forEach((q) => fresh(q.text));
    current.hypotheses.forEach(fresh);
  }
  const out: VerifierFindings[] = [];
  for (let n = round - 1; n >= 1; n--) {
    const v = verifierFindingsOf(r, n);
    if (!v) continue;
    const kept: VerifierFindings = {
      round: n,
      reasons: v.reasons.filter(fresh),
      claims: v.claims.filter((c) => c.status !== "verified" && fresh(c.text)),
      questions: v.questions.filter((q) => fresh(q.text)),
      hypotheses: v.hypotheses.filter(fresh),
    };
    if (
      kept.reasons.length ||
      kept.claims.length ||
      kept.questions.length ||
      kept.hypotheses.length
    )
      out.push(kept);
  }
  return out.reverse();
}

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
        handRelease: undefined,
        release: undefined,
        watchFailures: undefined,
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
    ...(verdict ? { patch: { verdict } } : {}),
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

const ACTIONS_DOWN = "GitHub Actions can't run for";

/**
 * A setup card for checks GitHub Actions never ran (rule 20b): the pull
 * request is read again every ACTIONS_RECHECK_MS, and once its checks
 * run the work goes on where it stopped.
 */
function actionsDownWait(view: ResponseView): ResponseStep | undefined {
  const r = view.incident.response;
  const ny = r?.needsYou;
  const pr = r?.candidate?.pr;
  if (
    ny?.kind !== "setup" ||
    ny.resumePhase !== "proving" ||
    !ny.reason.startsWith(ACTIONS_DOWN) ||
    !pr
  )
    return undefined;
  if (!(view.now - Date.parse(pr.fetchedAt) < ACTIONS_RECHECK_MS))
    return { step: "fetch-pr", purpose: "recheck" };
  if (pr.actionsBlocked) return actionsBack(view) ?? NONE;
  return {
    step: "transition",
    to: view.incident.resumeState ?? "fix-ready",
    phase: "proving",
    detail: `GitHub Actions runs for ${pr.ghRepo} again`,
    patch: { needsYou: undefined },
  };
}

/**
 * A waiting card whose pull request's checks GitHub Actions never ran (a
 * billing or spending limit): any card on an open fix, not only the setup
 * card, since a card raised before Actions stopped keeps waiting too. The
 * tick reads such an incident; `actionsBack` decides.
 */
export function waitingOnActions(incident: Incident): boolean {
  const r = incident.response;
  const pr = r?.candidate?.pr;
  return (
    incident.state === "needs-you" &&
    !!r?.needsYou &&
    r.needsYou.kind !== "question" &&
    !!r.candidate?.plan.pr &&
    pr?.state === "OPEN" &&
    !!pr.actionsBlocked
  );
}

/** Every ACTIONS_RECHECK_MS, whether GitHub Actions works for the
 *  repository again (`actions-recheck`). */
function actionsBack(view: ResponseView): ResponseStep | undefined {
  const { incident } = view;
  if (!waitingOnActions(incident)) return undefined;
  const r = incident.response!;
  const last = Date.parse(r.actionsCheckedAt ?? r.needsYou!.since);
  return view.now - last >= ACTIONS_RECHECK_MS
    ? { step: "actions-recheck" }
    : undefined;
}

/**
 * A card that would offer Deploy the fix but holds it back because a check
 * fails on the pull request (approveBlocked): the pull request is read
 * again every CHECKS_RECHECK_MS, so the button comes back once the checks
 * pass. The tick reads such an incident.
 */
export function waitingOnChecks(incident: Incident): boolean {
  const r = incident.response;
  const ny = r?.needsYou;
  const pr = r?.candidate?.pr;
  return (
    incident.state === "needs-you" &&
    !!ny &&
    !!pr &&
    pr.state === "OPEN" &&
    pr.failingChecks.length > 0 &&
    offersApprove(ny.kind, r!)
  );
}

function checksRecheck(view: ResponseView): ResponseStep | undefined {
  if (!waitingOnChecks(view.incident)) return undefined;
  const pr = view.incident.response!.candidate!.pr!;
  return view.now - Date.parse(pr.fetchedAt) < CHECKS_RECHECK_MS
    ? undefined
    : { step: "fetch-pr", purpose: "recheck" };
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

/**
 * Whether a waiting card may say something no longer true: a proof that
 * stopped or a fix not proven before release whose signal failed again
 * since the card appeared, or a proof that stopped on a fix only a release
 * can prove (it goes on to the verifier now). The tick reads such an
 * incident again; `staleWaiting` decides.
 */
export function waitingMayBeStale(incident: Incident): boolean {
  const r = incident.response;
  const ny = r?.needsYou;
  if (incident.state !== "needs-you" || !r || !ny) return false;
  if (ny.kind !== "proof-stopped" && ny.kind !== "unproven") return false;
  const seen = Math.max(
    Date.parse(ny.since),
    ny.failedAgainAt ? Date.parse(ny.failedAgainAt) : Number.NEGATIVE_INFINITY,
  );
  if (Date.parse(incident.lastProblemAt) > seen) return true;
  return (
    ny.kind === "proof-stopped" && r.candidate?.check.kind === "after-deploy"
  );
}

const FAILED_AGAIN = / \(.+ failed again at \d\d:\d\d UTC(?:: .*)?\)$/;
/** Other parts' failures a waiting incident keeps. */
const OTHER_FAILURES_MAX = 5;

/** The detail of the primary signal's failed check at `at`: the newest
 *  failed check of its main lane no later than that. */
export function failedCheckAt(
  observations: readonly Observation[],
  at: number,
): Observation | undefined {
  let best: Observation | undefined;
  for (const o of observations) {
    if (o.lane || o.result !== "fail") continue;
    const t = Date.parse(o.at);
    if (!(t <= at)) continue;
    if (!best || t >= Date.parse(best.at)) best = o;
  }
  return best;
}

export { failingParts };

/** A waiting card brought up to date (see waitingMayBeStale): a proof that
 *  stopped is measured again, and an unproven fix says when its signal
 *  failed again and which part failed. A different part than the one the
 *  incident opened on is listed apart, and the owner is not asked again. */
function staleWaiting(view: ResponseView): ResponseStep | undefined {
  const { incident } = view;
  const r = incident.response;
  const ny = r?.needsYou;
  if (!ny || !r?.candidate || !waitingMayBeStale(incident)) return undefined;
  const problemAt = Date.parse(incident.lastProblemAt);
  const check = failedCheckAt(view.primaryRecent, problemAt);
  const detail = check?.detail.trim() ?? "";
  const when = `${hhmmUtc(problemAt)} UTC`;
  // An incident whose fix loop did not record it (one that started at the
  // watch level, or before this was recorded): the recent checks at its
  // open, while they still reach back that far.
  const cause = failingParts(
    r.openedOn?.detail ??
      failedCheckAt(view.primaryRecent, Date.parse(incident.openedAt))
        ?.detail ??
      "",
  );
  const parts = failingParts(detail);
  if (cause.length && parts.length && parts.every((p) => !cause.includes(p)))
    return {
      step: "transition",
      to: null,
      phase: "needs-you",
      detail: `A different part failed at ${when}: ${detail}. This incident is about ${cause.join(", ")}`,
      patch: {
        needsYou: { ...ny, failedAgainAt: incident.lastProblemAt },
        otherFailures: [
          ...(r.otherFailures ?? []),
          { at: incident.lastProblemAt, detail },
        ].slice(-OTHER_FAILURES_MAX),
      },
    };
  const again = `${primaryName(view)} failed again at ${when}${detail ? `: ${detail}` : ""}`;
  const back = Date.parse(incident.lastProblemAt) > Date.parse(ny.since);
  if (ny.kind === "proof-stopped")
    return {
      step: "transition",
      to: "fix-ready",
      phase: "proving",
      detail: back
        ? `${again}: measuring the fix again`
        : "The fix can only be proven after release: the verifier checks it",
      patch: { needsYou: undefined, proof: undefined },
    };
  return {
    step: "needs-you",
    kind: ny.kind,
    reason: `${ny.reason.replace(FAILED_AGAIN, "")} (${again})`,
    failedAgainAt: incident.lastProblemAt,
  };
}

/**
 * The incident's own pull request (any round's) merged outside Sessions
 * while the card waited on the owner: what the card said about it (its
 * checks, the verifier's doubt) is no longer the question, so the card
 * goes and the release watch takes over, as after "I'll release it
 * myself": the release when Sessions can see one, then the base-rate
 * watch and the post-release check. No verified head is needed: the
 * owner already shipped it. One closed without merging leaves the card.
 */
function movedOutside(view: ResponseView): ResponseStep | undefined {
  const { incident } = view;
  const r = incident.response;
  const ny = r?.needsYou;
  if (!r || !ny || !view.prs) return undefined;
  const { merged, closed } = movedPrs(incident, view.prs);
  const settled = [
    ...(r.settledPrs ?? []),
    ...merged.slice(0, 1).map((p) => p.url),
    ...closed.map((p) => p.url),
  ];
  const pr = merged[0];
  if (pr) {
    const c = r.candidate;
    const same = !!c && (c.prUrl ?? c.pr?.url) === pr.url;
    return {
      step: "transition",
      to: "deploying",
      phase: "deploying",
      detail: `Merged outside Sessions: #${pr.number}`,
      log: "merge",
      patch: {
        handRelease: {
          by: incident.owner,
          at: pr.updatedAt,
          prUrl: pr.url,
          number: pr.number,
        },
        merge: {
          ghRepo: parsePrUrl(pr.url)?.ghRepo ?? c?.pr?.ghRepo ?? "",
          number: pr.number,
          sha: pr.headSha ?? (same ? (c?.pr?.headSha ?? "") : ""),
          status: "merged",
          method: "outside",
          at: pr.updatedAt,
        },
        // The fix that went out is this pull request; another round's
        // claims are not its.
        ...(c
          ? {
              candidate: same
                ? {
                    ...c,
                    ...(c.pr
                      ? { pr: { ...c.pr, state: "MERGED" as const } }
                      : {}),
                  }
                : { ...c, prUrl: pr.url, pr: undefined, claims: [] },
            }
          : {}),
        settledPrs: settled,
        release: undefined,
        watch: undefined,
        watchFailures: undefined,
        veto: undefined,
        mergingSince: undefined,
      },
    };
  }
  if (!closed.length) return undefined;
  const gone = new Set(closed.map((p) => p.url));
  const numbers = closed.map((p) => `#${p.number}`).join(", ");
  const prs = (ny.prs ?? []).filter((p) => !gone.has(p.url));
  const { prs: _prs, ...rest } = ny;
  const c = r.candidate;
  const candidateClosed = !!c?.pr && gone.has(c.pr.url);
  return {
    step: "transition",
    to: null,
    phase: "needs-you",
    detail: `Closed without being merged: ${numbers}`,
    log: "merge",
    patch: {
      needsYou: {
        ...rest,
        reason: `${ny.reason.replace(/\.$/, "")}. ${closed.length === 1 ? `PR ${numbers} was` : `PRs ${numbers} were`} closed without being merged.`,
        ...(prs.length ? { prs } : {}),
      },
      ...(candidateClosed
        ? { candidate: { ...c!, pr: { ...c!.pr!, state: "CLOSED" as const } } }
        : {}),
      settledPrs: settled,
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
    return (
      movedOutside(view) ??
      actionsDownWait(view) ??
      actionsBack(view) ??
      setupChanged(view) ??
      staleWaiting(view) ??
      checksRecheck(view) ??
      NONE
    );
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
        handRelease: undefined,
        release: undefined,
        watchFailures: undefined,
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
    postReleaseRun(r),
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
    if (run.check) {
      const warnings: string[] = [];
      const parsed = parsePostReleaseReport(text, {
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

/** Attempts an agent gets while its Sandbox image is still being built. */
const SANDBOX_IMAGE_ATTEMPTS = 3;

/**
 * The run stopped only because its Sandbox image was still being built
 * after an update (a transient setup state: the start waited for the build
 * and ran out of time). A new attempt joins that build instead of asking
 * anyone, a bounded number of times. A build that failed is the provider's
 * refusal and still reaches the owner.
 */
function waitingOnSandboxImage(view: ResponseView, run: AgentRun): boolean {
  if (statusOf(view, run) !== "error") return false;
  if (run.attempt >= SANDBOX_IMAGE_ATTEMPTS) return false;
  return isSandboxImageBuildingError(
    view.agents.get(run.sessionId)?.error ?? run.error ?? "",
  );
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
  if (waitingOnSandboxImage(view, run)) return true;
  return (
    retry &&
    (status === "error" ||
      status === "cancelled" ||
      (run.reminded && run.reportError !== undefined))
  );
}

/**
 * The owner's answer waiting for `run`: sent once its session is idle,
 * never while it still works; a session that stopped can't read it, and the
 * owner hears so.
 */
function answerStep(
  view: ResponseView,
  run: AgentRun,
): ResponseStep | undefined {
  const answer = view.incident.response?.answer;
  if (!answer || answer.sessionId !== run.sessionId) return undefined;
  const status = statusOf(view, run);
  if (status === "done")
    return {
      step: "message-agent",
      sessionId: run.sessionId,
      message: "answer",
    };
  if (status === "error" || status === "cancelled")
    return {
      step: "needs-you",
      kind: "agent-error",
      reason: `The ${run.check ? "post-release check" : run.role} stopped before it could read your answer`,
      patch: { answer: undefined },
    };
  return NONE;
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
  const answered = answerStep(view, inv);
  if (answered) return answered;
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

const PROBLEM_STATES: ReadonlySet<SignalState> = new Set(["failing", "slow"]);

/** Separate spells of failed checks in a signal's recent main lane. */
function failingSpells(observations: readonly Observation[]): number {
  let spells = 0;
  let failing = false;
  for (const o of observations) {
    if (o.lane !== undefined) continue;
    if (o.result === "fail") {
      if (!failing) spells++;
      failing = true;
    } else if (o.result === "ok") failing = false;
  }
  return spells;
}

/** The primary signal turned failing or slow again after it passed while
 *  the incident was open, or reopened it. */
function cameBack(incident: Incident): boolean {
  const id = incident.primarySignalId;
  let bad = true;
  for (const e of incident.events) {
    if (e.kind === "reopened") {
      if (!bad) return true;
      bad = true;
    } else if (
      (e.kind === "signal-state" || e.kind === "signal-attached") &&
      e.signalId === id &&
      e.signalState
    ) {
      if (PROBLEM_STATES.has(e.signalState)) {
        if (!bad) return true;
        bad = true;
      } else if (e.signalState === "ok") bad = false;
    }
  }
  return false;
}

/** The incident's signal fails on and off: flaky now, quiet flaps, back
 *  after it passed, or more than one failing spell in its recent checks. */
export function intermittent(view: ResponseView): boolean {
  const { incident } = view;
  return (
    view.evaluations.get(incident.primarySignalId)?.state === "flaky" ||
    (incident.quiet?.flaps ?? 0) > 0 ||
    cameBack(incident) ||
    failingSpells(view.primaryRecent) >= 2
  );
}

/**
 * Why a baseline that does not fail now proves nothing either way, so the
 * proof goes on to the verifier, who decides what it can prove: the
 * investigator said the fix can only be shown after release, or the signal
 * comes and goes. Undefined for a one-off problem that stopped.
 */
export function proofDeferral(view: ResponseView): ProofDeferral | undefined {
  if (view.incident.response?.candidate?.check.kind === "after-deploy")
    return "after-release";
  return intermittent(view) ? "intermittent" : undefined;
}

const DEFERRAL_WHY: Record<ProofDeferral, string> = {
  "after-release": "the fix can only be proven after release",
  intermittent: "the problem comes and goes",
};

function proving(view: ResponseView): ResponseStep {
  const r = view.incident.response!;
  // 20.
  if (r.proof?.round !== r.round) return { step: "run-proof" };
  // A fix that can only be proven after release goes on to the verifier
  // whatever the baseline says: a failing one only shows the problem is
  // live, which is what an unreleased fix leaves it.
  const live = r.proof.baseline.verdict === "fails";
  const deferred = live
    ? r.candidate?.check.kind === "after-deploy"
      ? "after-release"
      : undefined
    : proofDeferral(view);
  if (r.proof.baseline.verdict === "passes" && !deferred)
    return {
      step: "needs-you",
      kind: "proof-stopped",
      reason: "The problem stopped before the fix could be proven",
    };
  if (!r.candidate?.pr || stale(r.candidate.pr.fetchedAt, view.now))
    return { step: "fetch-pr", purpose: "verify" };
  // 20a. Checks Sessions re-ran (GitHub Actions came back): the verifier
  // looks again once they finish, or after PR_CHECKS_WAIT_MS.
  if (
    r.reverify &&
    r.candidate.pr.pendingChecks.length > 0 &&
    view.now - Date.parse(r.reverify.at) < PR_CHECKS_WAIT_MS
  )
    return NONE;
  // 20b. GitHub Actions ran none of the checks (a billing or spending
  // limit, say): no verifier can be certain and no merge can pass until
  // the owner fixes it, so they are asked once instead.
  const blocked = r.candidate.pr.actionsBlocked;
  if (blocked)
    return {
      step: "needs-you",
      kind: "setup",
      reason: `${ACTIONS_DOWN} ${r.candidate.pr.ghRepo} (${blocked})`,
    };
  if (deferred)
    return {
      step: "transition",
      to: null,
      phase: "verifying",
      detail: `Proof measured: ${live ? `the problem was happening at ${hhmmUtc(Date.parse(r.proof.at))} UTC` : "the problem is not happening now"} and ${DEFERRAL_WHY[deferred]}, so the verifier judges what it can prove`,
      patch: { proof: { ...r.proof, deferred } },
    };
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
    (a) => a.role === "verifier" && !a.check && a.round === r.round,
  );
  if (restart(view, ver, r.retryRequested === true) || !ver)
    return {
      step: "start-agent",
      role: "verifier",
      round: r.round,
      attempt: (ver?.attempt ?? 0) + 1,
    };
  // The checks ran again since this verifier looked: a new attempt, in
  // the same round.
  if (
    r.reverify &&
    ver &&
    Date.parse(ver.startedAt) < Date.parse(r.reverify.at)
  )
    return {
      step: "start-agent",
      role: "verifier",
      round: r.round,
      attempt: ver.attempt + 1,
    };
  const answered = answerStep(view, ver);
  if (answered) return answered;
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
  const knowledge = checkKnowledge(r.candidate.pr.files, r.candidate);
  const verdict = effectiveVerdict({ report, proof: r.proof, knowledge });
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
  // 22b. Not proven before release, and nothing wrong with the fix itself
  // that another round could mend: the owner decides whether to merge it
  // and watch the release.
  const deferred = r.proof.deferred;
  if (
    deferred &&
    knowledge.note &&
    knowledge.runbook &&
    !report.claims.some((c) => c.status === "refuted")
  )
    return {
      step: "needs-you",
      kind: "unproven",
      reason: `${deferred === "intermittent" ? "The problem comes and goes, so the fix" : "The fix"} can only be proven after release${r.proof.baseline.verdict === "fails" ? ` (the problem was happening at ${hhmmUtc(Date.parse(r.proof.at))} UTC)` : ""}: ${reasons[0]}`,
      patch: {
        verdict: {
          round: r.round,
          at,
          verdict: "not-certain",
          reasons,
          verifiedSha: r.candidate.pr.headSha,
        },
      },
    };
  const verifier = verifierFindingsOf(r, r.round, reasons);
  const earlier = earlierVerifierFindings(r, r.round, verifier);
  return sendBack(
    view,
    {
      kind: "not-certain",
      reasons,
      ...(verifier ? { verifier } : {}),
      ...(earlier.length ? { earlier } : {}),
    },
    reasons[0]!,
    {
      round: r.round,
      at,
      verdict: "not-certain",
      reasons,
      // The head it reviewed: at the round limit the owner may still
      // release it by hand.
      verifiedSha: r.candidate.pr.headSha,
    },
  );
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
    handRelease: undefined,
    release: undefined,
    watchFailures: undefined,
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
  if (
    r.handRelease &&
    r.handRelease.merger !== "sessions" &&
    r.merge?.status !== "merged"
  )
    return handReleaseStep(view, r.handRelease);
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

/**
 * The owner merges and releases the fix: Sessions waits for the merge, as
 * the PR cache sees it (GitHub, now and then, when the cache doesn't know
 * the pull request), and then watches the signal. It merges nothing.
 */
function handReleaseStep(
  view: ResponseView,
  hand: NonNullable<IncidentResponse["handRelease"]>,
): ResponseStep {
  const r = view.incident.response!;
  const pr = r.candidate?.pr;
  const state = view.handReleasePr ?? pr?.state;
  const n = `PR #${hand.number}`;
  if (state === "MERGED")
    return {
      step: "transition",
      to: null,
      phase: "deploying",
      detail: `${n} was merged`,
      patch: {
        merge: {
          ghRepo: pr?.ghRepo ?? "",
          number: hand.number,
          sha: r.verdict?.verifiedSha ?? pr?.headSha ?? "",
          status: "merged",
          method: "by-hand",
          ...(pr?.mergeCommitSha ? { mergedSha: pr.mergeCommitSha } : {}),
          at: now(view),
        },
      },
    };
  if (state === "CLOSED")
    return {
      step: "needs-you",
      kind: "merge",
      reason: `${n} was closed without being merged`,
    };
  if (!view.handReleasePr) {
    if (!pr) return { step: "fetch-pr", purpose: "merge" };
    if (view.now - Date.parse(pr.fetchedAt) >= HAND_RELEASE_REFRESH_MS)
      return { step: "fetch-pr", purpose: "recheck" };
  }
  return NONE;
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
  // Released by hand: nothing to run. The watch starts at the release.
  if (r.handRelease) return awaitingRelease(view, r.handRelease);
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

/**
 * A fix released by hand, merged: the watch starts at its release, once
 * Sessions sees one after the merge (the release hook, a merged release
 * pull request). A project where no release can be seen starts it at the
 * merge. A day without a release asks the owner.
 */
function awaitingRelease(
  view: ResponseView,
  hand: NonNullable<IncidentResponse["handRelease"]>,
): ResponseStep {
  const { settings } = view;
  const r = view.incident.response!;
  // Only a release seen for this hand release counts, never an earlier
  // round's.
  if (r.release && Date.parse(r.release.at) >= Date.parse(hand.at))
    return { step: "start-watch", ms: watchLength(view) };
  const mergedAt = r.merge?.at ?? hand.at;
  const mergedMs = Date.parse(mergedAt);
  const src = {
    releases: settings.releases,
    hook: !!settings.releaseHookSecret,
    releasePrs: view.releasePrs ?? [],
  };
  const n = `PR #${hand.number}`;
  const seen = releaseAfter(src, mergedMs);
  if (seen)
    return {
      step: "transition",
      to: null,
      phase: "deploying",
      detail: `${n} went out${seen.ref ? ` in ${seen.ref}` : ""} at ${hhmmUtc(Date.parse(seen.at))} UTC (${seen.source === "hook" ? "the release hook" : "its release pull request"})`,
      log: "release",
      patch: { release: seen },
    };
  if (!releaseObservable(src))
    return {
      step: "transition",
      to: null,
      phase: "deploying",
      detail: `Sessions can't see ${view.incident.project}'s releases, so the watch starts at the merge of ${n}`,
      log: "release",
      patch: { release: { at: mergedAt, source: "merge" } },
    };
  if (view.now - mergedMs >= RELEASE_WAIT_MS)
    return {
      step: "needs-you",
      kind: "no-action",
      reason: `${n} was merged at ${hhmmUtc(mergedMs)} UTC and no release came in ${Math.round(RELEASE_WAIT_MS / 3_600_000)} h. Release it, then mark it fixed or send it back`,
    };
  return NONE;
}

/** How long the watch lasts: a hand release watches for a few of the
 *  signal's usual gaps between failures; anything else the project's
 *  window. */
function watchLength(view: ResponseView): number {
  const r = view.incident.response!;
  if (!r.handRelease) return view.settings.watchMs;
  return baseRateWatchMs(
    view.primaryRecent,
    primarySignal(view)?.rule,
    view.settings.watchMs,
  );
}

/** The failed check the incident opened on, as Sessions has it. */
function openedDetail(view: ResponseView): string {
  const { incident } = view;
  return (
    incident.response?.openedOn?.detail ??
    failedCheckAt(view.primaryRecent, Date.parse(incident.openedAt))?.detail ??
    ""
  );
}

/** Whether no post-release check runs for this round's fix: a rollback
 *  has nothing new to check. */
function noCheck(view: ResponseView): boolean {
  const r = view.incident.response!;
  if (!r.candidate || r.candidate.rollbackFirst) return true;
  if (r.handRelease) return false;
  const steps = changeFacts({
    plan: r.candidate.plan,
    settings: view.settings,
    prFiles: [],
  });
  return (
    !("error" in steps) &&
    steps.steps.length > 0 &&
    steps.steps.every((s) => s.kind === "rollback")
  );
}

/** What went out, for the check's brief and the record. */
function releasedWhat(view: ResponseView): { at: string; after: string } {
  const r = view.incident.response!;
  if (r.release) {
    const at = r.release.at;
    const when = `${hhmmUtc(Date.parse(at))} UTC`;
    return {
      at,
      after:
        r.release.source === "merge"
          ? `the merge at ${when}`
          : `${r.release.ref ? `${r.release.ref}, ` : ""}released at ${when}`,
    };
  }
  const run = r.actionRuns.findLast(
    (a) => a.round === r.round && a.purpose === "plan" && a.status === "ok",
  );
  const at = run?.endedAt ?? r.watch?.startedAt ?? iso(view.now);
  return {
    at,
    after: run
      ? `${run.label}${run.ref ? ` of ${run.ref}` : ""} at ${hhmmUtc(Date.parse(at))} UTC`
      : `the release at ${hhmmUtc(Date.parse(at))} UTC`,
  };
}

/** The round's post-release check record. */
function checkOf(r: IncidentResponse) {
  return r.postRelease?.round === r.round ? r.postRelease : undefined;
}

/**
 * 28a. The post-release check: a read-only verifier session that looks at
 * production once the fix is live. Started with the watch; its verdict is
 * recorded; a not-confirmed or regressed one goes to the owner with its
 * evidence (never a rollback). It is bounded: the budget, no model, an
 * error, no report or CHECK_MAX_MS skip it, and the watch decides alone.
 * Undefined when there is nothing to do for it now.
 */
function postReleaseStep(view: ResponseView): ResponseStep | undefined {
  const r = view.incident.response!;
  if (noCheck(view)) return undefined;
  const check = checkOf(r);
  const skip = (reason: string): ResponseStep => ({
    step: "transition",
    to: null,
    phase: "watching",
    detail: `Post-release check skipped: ${reason}. The watch decides`,
    log: "policy",
    patch: {
      postRelease: {
        round: r.round,
        status: "skipped",
        at: iso(view.now),
        after: check?.after ?? releasedWhat(view).after,
        ...(check?.sessionId ? { sessionId: check.sessionId } : {}),
        reasons: [reason],
      },
    },
  });
  if (!check) {
    const problem = budgetProblem({
      incidentCostUsd: r.costUsd,
      monthCostUsd: view.monthCostUsd + r.costUsd,
      budget: view.settings.budget,
    });
    if (problem) return skip(problem.reason);
    if ("error" in view.models) return skip(view.models.error);
    const prior = postReleaseRun(r);
    return {
      step: "start-agent",
      role: "verifier",
      round: r.round,
      attempt: (prior?.attempt ?? 0) + 1,
      check: "post-release",
      after: releasedWhat(view).after,
    };
  }
  if (check.status !== "running") return undefined;
  const run = postReleaseRun(r);
  if (!run) return undefined;
  const answered = answerStep(view, run);
  if (answered) return answered;
  const status = statusOf(view, run);
  if (status === "waiting") return agentProblem(view, run);
  if (status === "error")
    return skip(
      `it stopped (${view.agents.get(run.sessionId)?.error ?? run.error ?? "an error"})`,
    );
  if (status === "cancelled")
    return skip(
      run.cancelledFor === "timeout" ? "it ran out of time" : "it was stopped",
    );
  if (status === "running") {
    if (view.now - Date.parse(run.turnSentAt) > CHECK_MAX_MS)
      return {
        step: "cancel-agents",
        reason: "The post-release check ran out of time",
        for: "timeout",
      };
    return undefined;
  }
  if (run.reportError && run.reminded)
    return skip("it did not return a valid report");
  const report = run.report;
  if (report?.role !== "post-release") return undefined;
  const words: Record<PostReleaseVerdict, string> = {
    confirmed: "confirmed the fix in production",
    "not-confirmed": "could not confirm the fix in production",
    regressed: "found production worse after the release",
  };
  return {
    step: "transition",
    to: null,
    phase: "watching",
    detail: `Post-release check ${words[report.verdict]}${report.reasons[0] ? `: ${report.reasons[0]}` : ""}`,
    log: "verdict",
    patch: {
      postRelease: {
        ...check,
        status: report.verdict,
        at: iso(view.now),
        reasons: report.reasons,
        checks: report.checks,
      },
    },
  };
}

/** The check's word goes to the owner when it isn't a confirmation. */
function checkDoubt(view: ResponseView): ResponseStep | undefined {
  const check = checkOf(view.incident.response!);
  if (check?.status !== "not-confirmed" && check?.status !== "regressed")
    return undefined;
  const reason = check.reasons?.[0] ?? "it gave no reason";
  return {
    step: "needs-you",
    kind: "post-release",
    reason:
      check.status === "regressed"
        ? `After the release, production looks worse: ${reason}`
        : `After the release, the fix couldn't be confirmed in production: ${reason}`,
  };
}

/** Whether the post-release check still has its say: running, or not
 *  started yet where one runs. */
function checkPending(view: ResponseView): boolean {
  if (noCheck(view)) return false;
  const check = checkOf(view.incident.response!);
  return !check || check.status === "running";
}

/** A word on the check for the resolve line. */
function checkedWord(r: IncidentResponse): string {
  return checkOf(r)?.status === "confirmed"
    ? "; the post-release check confirmed it"
    : "";
}

/** "6 h", "40 min". */
function spanWords(ms: number): string {
  const hours = Math.round(ms / 3_600_000);
  return hours >= 1
    ? `${hours} h`
    : `${Math.max(1, Math.round(ms / 60_000))} min`;
}

/**
 * 28b. A hand-released fix's watch: it lasts a few of the signal's usual
 * gaps (watchLength). Each failed check is recorded with what it said; a
 * spell of the part the incident opened on, as long as the signal's rule
 * counts, means the fix didn't hold and goes to the owner. Other parts'
 * failures are recorded and don't count. Passing the whole watch, with
 * the check confirmed or skipped, is fixed.
 */
function handWatch(view: ResponseView): ResponseStep {
  const r = view.incident.response!;
  const watch = r.watch!;
  const started = Date.parse(watch.startedAt);
  const opened = openedDetail(view);
  // Failures after the newest one recorded: the list is trimmed to
  // WATCH_FAILURES_MAX, so a set of what it holds would read the trimmed
  // ones as new on every tick.
  const recorded = Math.max(
    started,
    ...(r.watchFailures ?? []).map((f) => Date.parse(f.at)),
  );
  const fresh = failuresSince(view.primaryRecent, started).filter(
    (o) => Date.parse(o.at) > recorded,
  );
  const name = primaryName(view);
  if (fresh.length) {
    const rows = fresh.map((o) => ({
      at: o.at,
      detail: o.detail.trim(),
      samePart: samePart(opened, o.detail),
    }));
    const shown = rows
      .slice(-3)
      .map(
        (f) =>
          `${hhmmUtc(Date.parse(f.at))} UTC${f.detail ? ` (${f.detail})` : ""}${f.samePart ? "" : ", another part"}`,
      )
      .join("; ");
    return {
      step: "transition",
      to: null,
      phase: "watching",
      detail: `${name} failed during the watch at ${shown}`,
      log: "policy",
      patch: {
        watchFailures: [...(r.watchFailures ?? []), ...rows].slice(
          -WATCH_FAILURES_MAX,
        ),
      },
    };
  }
  // A spell of the same part, as long as the rule counts; other parts'
  // failures are read as passes here.
  const counted = view.primaryRecent
    .filter((o) => o.lane === undefined && Date.parse(o.at) > started)
    .map((o) =>
      o.result === "fail" && !samePart(opened, o.detail.trim())
        ? { ...o, result: "ok" as const }
        : o,
    );
  if (spellStarts(counted, spellLength(primarySignal(view)?.rule)).length) {
    const last = (r.watchFailures ?? []).findLast((f) => f.samePart);
    return {
      step: "needs-you",
      kind: "post-release",
      reason: `${name} failed again at ${last ? `${hhmmUtc(Date.parse(last.at))} UTC` : "the watch"} after PR #${r.handRelease!.number} went out${last?.detail ? ` (${last.detail})` : ""}, so the fix didn't hold. Send it back, or mark it fixed if this is something else`,
    };
  }
  if (!(view.now >= Date.parse(watch.deadline))) return NONE;
  // Still failing at the end, by the signal's own word.
  const state = view.evaluations.get(view.incident.primarySignalId)?.state;
  if (state && PROBLEM_STATES.has(state))
    return {
      step: "needs-you",
      kind: "post-release",
      reason: `${name} is still ${state} after PR #${r.handRelease!.number} went out. If it isn't live yet, release it, then mark it fixed or send it back`,
    };
  if (checkPending(view)) return NONE;
  return {
    step: "resolve",
    fixedBy: "agents-with-you",
    detail: `${name} passed the ${spanWords(Date.parse(watch.deadline) - started)} watch after the release${checkedWord(r)}`,
  };
}

// 28. Resolved when every own signal is back after the watch started.
function watchingStep(view: ResponseView): ResponseStep {
  const { settings } = view;
  const r = view.incident.response!;
  if (!r.watch) return { step: "start-watch", ms: watchLength(view) };
  const checked = postReleaseStep(view) ?? checkDoubt(view);
  if (checked) return checked;
  if (r.handRelease) return handWatch(view);

  const own = ownSignalIds(view);
  const watched = own.length ? own : [view.incident.primarySignalId];
  const started = Date.parse(r.watch.startedAt);
  const green = watched.every((id) => {
    const e = view.evaluations.get(id);
    return e?.state === "ok" && Date.parse(e.since) >= started;
  });
  if (green && !checkPending(view)) {
    const names = watched.map((id) => view.signals.get(id)?.name ?? id);
    return {
      step: "resolve",
      fixedBy: r.ownerTouched ? "agents-with-you" : "agents",
      detail: `${names.join(", ")} back to normal after the release${checkedWord(r)}`,
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
