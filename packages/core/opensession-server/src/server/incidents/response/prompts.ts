// The briefs Sessions sends incident agents: the investigator's prompt, the
// verifier's prompt, send-back messages and the report reminder; plus the
// note, runbook and branch names both sides agree on. Prompts carry the
// redacted signal only, never an action's command, and the verifier's never
// carries the investigator's summary, cause or attempts.
import {
  describeIndependence,
  type AgentRole,
  type CandidateState,
  type IncidentAction,
  type Independence,
  type ProofResult,
  type ProofSample,
  type SendBackReason,
} from "../../../shared/incident-response";
import type {
  Incident,
  Observation,
  RedactedSignal,
  Signal,
  SignalEvaluation,
  SignalRule,
} from "../../../shared/incidents";
import { redactSignal } from "../signal-validation";
import { REPORT_FENCE } from "./reports";

const RUNBOOK = "docs/incidents/runbook.md";
const RECENT_LINES = 20;
const DETAIL_MAX = 300;
const SEND_BACK_TAIL =
  "Update the PR and the note, then end with a new incident-report block.";

export function slugify(text: string, max = 40): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return "incident";
  if (slug.length <= max) return slug;
  const cut = slug.slice(0, max);
  const dash = cut.lastIndexOf("-");
  return (dash > 0 ? cut.slice(0, dash) : cut).replace(/-+$/, "") || "incident";
}

function dateOf(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(iso)
    ? iso.slice(0, 10)
    : new Date(iso).toISOString().slice(0, 10);
}

function incidentStem(incident: Pick<Incident, "openedAt" | "title">): string {
  return `${dateOf(incident.openedAt)}-${slugify(incident.title)}`;
}

export function notePathFor(
  incident: Pick<Incident, "openedAt" | "title">,
): string {
  return `docs/incidents/${incidentStem(incident)}.md`;
}

export function runbookPathsFor(signal: Pick<Signal, "name">): string[] {
  return [RUNBOOK, `docs/incidents/runbooks/${slugify(signal.name)}.md`];
}

export function branchFor(
  incident: Pick<Incident, "openedAt" | "title">,
  role: AgentRole,
  round: number,
  attempt: number,
): string {
  const base = `incident/${incidentStem(incident)}`;
  const named = role === "verifier" ? `${base}-verify-r${round}` : base;
  return attempt > 1 ? `${named}-a${attempt}` : named;
}

// ── Shared pieces ───────────────────────────────────────────────────────────

function oneLine(text: string, max = DETAIL_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function minutes(ms: number): string {
  const m = ms / 60_000;
  return Number.isInteger(m) ? `${m} min` : `${Math.round(ms / 1000)} s`;
}

function describeRule(rule: SignalRule): string {
  switch (rule.kind) {
    case "consecutive":
      return `Fails after ${rule.failures} failures in a row`;
    case "rate":
      return `Fails at ${rule.atLeast} or more failures in ${minutes(rule.windowMs)}`;
    case "threshold":
      return `Fails above ${rule.above} for ${minutes(rule.forMs)}`;
    case "missing":
      return rule.everyMs !== undefined
        ? `Expects a check-in every ${minutes(rule.everyMs)}`
        : `Expects a check-in on the schedule ${rule.cron ?? "unknown"} (UTC)`;
    case "deadline":
      return `Warns ${rule.warnDays} days and fails ${rule.failDays} days before expiry`;
  }
}

/** The signal as the agent may see it: built from `redactSignal` only, and
 *  without its hook path (the path holds the hook secret). */
function describeSignal(signal: RedactedSignal): string[] {
  const lines = [`Signal ${signal.name} (${signal.id}), ${signal.severity}.`];
  const source = signal.source;
  switch (source.kind) {
    case "http": {
      lines.push(`- Request: ${source.method ?? "GET"} ${source.url}`);
      for (const [name, value] of Object.entries(source.headers ?? {}))
        lines.push(`- Header: ${name}: ${value}`);
      if (source.body !== undefined) lines.push("- With a request body");
      break;
    }
    case "webhook":
      lines.push("- Events pushed to Sessions (webhook)");
      break;
    case "heartbeat":
      lines.push("- Check-ins pushed to Sessions (heartbeat)");
      break;
    case "expiry":
      lines.push(`- TLS certificate of ${source.host}:${source.port ?? 443}`);
      break;
  }
  lines.push(`- ${describeRule(signal.rule)}`);
  return lines;
}

function mainLane(observations: Observation[], count: number): Observation[] {
  return observations
    .filter((o) => !o.lane)
    .map((o, i) => ({ o, i }))
    .sort((a, b) => (a.o.at === b.o.at ? a.i - b.i : a.o.at < b.o.at ? -1 : 1))
    .map(({ o }) => o)
    .slice(-count);
}

function sampleLine(o: Pick<Observation, "at" | "result" | "detail">): string {
  return `- ${o.at} · ${o.result} · ${oneLine(o.detail) || "no detail"}`;
}

function usd(amount: number): string {
  return `$${Number(amount.toFixed(2))}`;
}

function actionLine(a: IncidentAction): string {
  return [
    a.id,
    a.kind,
    a.label,
    a.reversible ? "reversible" : "not reversible",
    a.cost.kind === "amount" ? usd(a.cost.usd) : "free",
    a.needsSecret ? "needs a secret" : "no secret",
  ].join(" · ");
}

function signalOrigin(signal: Pick<Signal, "source">): string | null {
  if (signal.source.kind !== "http") return null;
  try {
    return new URL(signal.source.url).origin;
  } catch {
    return null;
  }
}

function hhmmUtc(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms)
    ? `${new Date(ms).toISOString().slice(11, 16)} UTC`
    : iso;
}

function jsonBlock(tag: string, value: unknown): string {
  return ["```" + tag, JSON.stringify(value, null, 2), "```"].join("\n");
}

// ── Investigator ────────────────────────────────────────────────────────────

export interface InvestigatorPromptInput {
  incident: Incident;
  signal: Signal;
  otherSignals: Signal[];
  evaluation: SignalEvaluation | null;
  recent: Observation[];
  actions: IncidentAction[];
  baseBranch: string;
  round: number;
  maxRounds: number;
  rollbackFirst?: { releaseAt: string; ref?: string };
}

export function buildInvestigatorPrompt(
  input: InvestigatorPromptInput,
): string {
  const { incident, round, maxRounds } = input;
  const signal = redactSignal(input.signal);
  const origin = signalOrigin(signal);
  const notePath = notePathFor(incident);
  const runbooks = runbookPathsFor(signal);
  const out: string[] = [];

  out.push(`# Incident: ${incident.title}`, "");
  out.push(
    `Project ${incident.project} · opened ${incident.openedAt} · Round ${round} of ${maxRounds}`,
    "",
  );

  if (input.rollbackFirst) {
    const ref = input.rollbackFirst.ref ?? "no ref";
    out.push(
      `A release at ${hhmmUtc(input.rollbackFirst.releaseAt)} (${ref}) went out shortly before this started. Sessions is rolling it back now. Find what in that release broke ${signal.name}, write the note and runbook update, and propose a fix PR if one is needed. It will not be deployed while the rollback holds.`,
      "",
    );
  }

  out.push("## What is failing", "", ...describeSignal(signal), "");
  out.push(
    input.evaluation
      ? `State: ${input.evaluation.state}, ${oneLine(input.evaluation.reason)} (since ${input.evaluation.since})`
      : "State: not evaluated yet",
    "",
  );
  const recent = mainLane(input.recent, RECENT_LINES);
  out.push("Recent observations, oldest first (at · result · detail):");
  out.push(...(recent.length ? recent.map(sampleLine) : ["- none yet"]), "");
  if (input.otherSignals.length) {
    out.push("Other signals on this incident:");
    for (const other of input.otherSignals)
      out.push(
        `- ${other.name} (${other.id}) · ${other.enabled ? "enabled" : "disabled"}`,
      );
    out.push("");
  }

  out.push("## Read first", "");
  out.push(
    "Before anything else, read these and list each in readFirst, found or not:",
  );
  for (const path of runbooks) out.push(`- ${path}`);
  out.push(
    `- Earlier incident notes: every docs/incidents/*.md whose front matter lists ${signal.id} under signals, newest first, at most 10.`,
    "",
  );

  out.push("## How to work", "");
  out.push(
    "Work through the runbook's checklist cheapest-first: free checks before cheap ones before expensive ones. Record every attempt in the evidence table, including the ones that ruled something out.",
    "",
    "Do not conclude that something must be bought, scaled or given new credentials. Say so in noCandidateReason and Sessions will ask the owner.",
    "",
    "Sessions runs every action itself. You may propose actions by id; you cannot run them, deploy, merge or reach production.",
    "",
  );

  out.push("## Actions you may propose", "");
  if (input.actions.length) {
    out.push("id · kind · label · reversible · cost · secret");
    for (const action of input.actions) out.push(`- ${actionLine(action)}`);
    out.push(
      "",
      "A deploy action runs only with a PR: set candidate.pr to true and never list it in candidate.actions.",
    );
  } else out.push("No actions are set up for this project.");
  out.push("");

  out.push("## Deliverable", "");
  out.push(
    `Commit on this session's branch and open one pull request into ${input.baseBranch}. The PR holds the fix (if it is code), the incident note at ${notePath}, and an update to the runbook (${runbooks.join(" or ")}).`,
    "",
    "If the fix is an action rather than code, the PR contains only the note and the runbook update.",
    "",
    "Declare how Sessions should prove the fix (the check field), one of:",
    origin
      ? `- request: a request Sessions sends from production's own egress, before and after your fix. It must use the signal's origin ${origin}, and GET or HEAD unless it is the signal's own method and path. Send [redacted] for a stored secret and Sessions fills it in.`
      : "- request: request checks are not available for this signal.",
    "- after-deploy: when the fix can only be shown once it is released, with the reason.",
    "",
  );

  out.push("## Note template", "");
  out.push(
    "```markdown",
    "---",
    `incident: ${incident.id}`,
    "signals:",
    ...incident.signalIds.map((id) => `  - ${id}`),
    `opened: ${incident.openedAt}`,
    "---",
    "",
    `# ${incident.title}`,
    "",
    "## Symptoms",
    "",
    "## Timeline",
    "",
    "## Attempts",
    "",
    "| Step | Cost | Result | Evidence | Source |",
    "| --- | --- | --- | --- | --- |",
    "",
    "## Cause",
    "",
    "## Fix",
    "",
    "## Sources",
    "",
    "## Check first next time",
    "```",
    "",
  );

  out.push("## Report", "");
  out.push(
    `End your final message with exactly one fenced block tagged ${REPORT_FENCE}.`,
    "List at least one claim when there is a candidate; a claim's source must also be the source of one of your attempts. With nothing to run, set candidate to null and explain noCandidateReason.",
    "",
    jsonBlock(REPORT_FENCE, {
      role: "investigator",
      summary: "One line: what broke",
      cause: "What caused it, and how you know",
      readFirst: runbooks.map((path) => ({ path, found: true })),
      attempts: [
        {
          step: "Read the runbook",
          cost: "free",
          result: "ruled-out",
          evidence: "What you saw",
          source: RUNBOOK,
        },
      ],
      candidate: { pr: true, actions: [] },
      check: origin
        ? {
            kind: "request",
            source: { kind: "http", url: `${origin}/`, method: "GET" },
          }
        : {
            kind: "after-deploy",
            reason: "Why it can only be shown after release",
          },
      claims: [{ text: "A fact the fix depends on", source: RUNBOOK }],
      notePath,
      runbookPaths: [runbooks[1]],
    }),
  );
  return out.join("\n");
}

export function buildSendBackMessage(
  round: number,
  maxRounds: number,
  why: SendBackReason,
): string {
  let head: string;
  switch (why.kind) {
    case "not-certain":
      head = [
        `The verifier was not certain (round ${round} of ${maxRounds}):`,
        ...why.reasons.map((r) => `- ${r}`),
      ].join("\n");
      break;
    case "owner":
      head = `${why.by} sent this back: ${why.note}`;
      break;
    case "rolled-back":
      head = `Your fix was released and rolled back: ${why.detail}`;
      break;
    case "reopened":
      head = `The incident reopened after it was resolved: ${why.detail}`;
      break;
    case "check-failed":
      head = `A required check failed on the PR: ${why.detail}`;
      break;
  }
  return `${head}\n\n${SEND_BACK_TAIL}`;
}

// ── Verifier ────────────────────────────────────────────────────────────────

export interface VerifierPromptInput {
  incident: Incident;
  signal: Signal;
  candidate: CandidateState;
  headSha: string;
  proof: ProofResult;
  runnerLabel: string;
  independence: Independence;
  round: number;
  mode: "ask" | "code";
  /** The project's actions, for their labels; ids are shown otherwise. */
  actions?: IncidentAction[];
}

function proofSamples(samples: ProofSample[]): string[] {
  return samples.length ? samples.map(sampleLine) : ["- no samples"];
}

export function buildVerifierPrompt(input: VerifierPromptInput): string {
  const { incident, candidate, proof } = input;
  const signal = redactSignal(input.signal);
  const prUrl = candidate.prUrl ?? candidate.pr?.url ?? "the incident PR";
  const labelOf = (id: string) =>
    input.actions?.find((a) => a.id === id)?.label ?? id;
  const steps = [
    ...(candidate.plan.pr ? ["merge and deploy"] : []),
    ...candidate.plan.actions.map(labelOf),
  ];
  const out: string[] = [];

  out.push(`# Verify a fix for: ${incident.title}`, "");
  out.push(
    "You are the verifier. You did not see how this fix was found. Do not edit, commit or push anything.",
    "",
  );
  out.push("## The candidate", "");
  out.push(
    `- PR: ${prUrl}`,
    `- Head commit: ${input.headSha}. If the PR's headRefOid is not this commit, say not-certain.`,
    `- Plan: ${steps.join(", then ") || "nothing"}`,
    `- Round ${input.round} · ${describeIndependence(input.independence)}`,
    "",
    ...describeSignal(signal),
    "",
  );

  out.push(
    `## The proof Sessions measured from ${input.runnerLabel} with the incident's own signal`,
    "",
  );
  out.push(`Baseline, before the fix: ${proof.baseline.verdict}`);
  out.push(...proofSamples(proof.baseline.samples), "");
  if (proof.candidate.kind === "after-deploy") {
    const reason =
      candidate.check.kind === "after-deploy" ? candidate.check.reason : "";
    out.push(
      `Candidate: proven only after release${reason ? `: ${oneLine(reason)}` : ""}. Accept that only if it holds, and say so in proofAccepted.`,
    );
  } else {
    out.push(
      `Candidate check: ${proof.candidate.verdict}${proof.candidate.refused ? ` (refused: ${proof.candidate.refused})` : ""}`,
    );
    out.push(...proofSamples(proof.candidate.samples));
  }
  out.push("");

  out.push("## What to check", "");
  out.push(
    "1. The proof holds: the baseline fails and the candidate passes, or proving it after release is acceptable (proofAccepted).",
    "2. Check every claim and source below. Open each source.",
    `3. The note at ${candidate.notePath} and one of ${candidate.runbookPaths.join(", ")} are in the PR and match the diff.`,
    input.mode === "ask"
      ? `4. The PR's checks pass. Read the change with gh pr view ${prUrl} --json files,headRefOid and gh pr checks ${prUrl}; you work read-only and cannot run the project's tests yourself.`
      : `4. The PR's checks pass, and run the project's checks that cover the change.`,
    "",
    "Say certain only if all of this holds.",
    "",
  );

  out.push("## Claims", "");
  if (candidate.claims.length)
    for (const claim of candidate.claims)
      out.push(
        `- ${claim.text}${claim.source ? ` (source: ${claim.source})` : ""}`,
      );
  else out.push("- none");
  out.push("");

  out.push("## Report", "");
  out.push(
    `End your final message with exactly one fenced block tagged ${REPORT_FENCE}.`,
    "List every claim above exactly once with its text unchanged; status is verified, refuted or unverifiable. With not-certain, give at least one reason.",
    "",
    jsonBlock(REPORT_FENCE, {
      role: "verifier",
      verdict: "certain",
      reasons: [],
      proofAccepted: true,
      claims: candidate.claims.map((c) => ({
        text: c.text,
        status: "verified",
        evidence: "What you saw",
        ...(c.source ? { source: c.source } : {}),
      })),
    }),
  );
  return out.join("\n");
}

export function buildReminder(error: string): string {
  return `Your last message did not end with a valid incident-report block: ${error}. Reply with only the corrected block.`;
}
