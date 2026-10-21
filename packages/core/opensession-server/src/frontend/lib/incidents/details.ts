// The incident page's summary rows (spec 4.1, workspace-summary grammar):
// Fix (the change, the incident note), Agents (investigator, verifier,
// cost, access) and History (earlier incidents). Change, Agent cost and
// Earlier incidents always render; the rest only with data. Pure.
import {
  type IncidentAgentsAccessView,
  incidentAllowsAgents,
} from "../../../shared/incident-access";
import {
  type AgentRole,
  type AgentRun,
  describeIndependence,
  describeWorkspace,
  type IncidentResponse,
} from "../../../shared/incident-response";
import {
  type Incident,
  type IncidentSummary,
  isTerminalIncidentState,
} from "../../../shared/incidents";
import { summarize } from "../pr-status-derive";
import type { PrDetails } from "../types";
import type { RunLedgerEntry } from "../../components/RunLedger";
import { formatSpan, formatUsd } from "./copy";
import { httpUrl } from "./links";

export type DetailRowKey =
  | "change"
  | "note"
  | "investigator"
  | "verifier"
  | "cost"
  | "access"
  | "earlier";

export type DetailTarget =
  | {
      kind: "pr";
      repo: string;
      number: number;
      /** The PR's head branch, so the app's own PR view can open it. */
      branch?: string;
      url?: string;
    }
  | { kind: "url"; url: string }
  | { kind: "session"; sessionId: string }
  | { kind: "sheet"; sheet: "cost" | "access" | "earlier" };

export interface DetailRow {
  key: DetailRowKey;
  band: "Fix" | "Agents" | "History";
  label: string;
  value: string;
  tone?: "green" | "yellow" | "red" | "faint";
  /** The leading part of `value` that takes `tone` ("Certain" in
   *  "Certain · sent round 1 back"); without it the whole value does. */
  emphasis?: string;
  /** The change's line counts, drawn before the value. */
  lines?: { additions: number; deletions: number };
  /** The cost against the budget, drawn after the value. */
  meter?: { pct: number; of: string };
  target: DetailTarget | null;
}

const EARLIER_MAX = 5;
const EARLIER_NAMED = 2;
/** Label plus value longer than this moves the value under the label on a
 *  390px phone, so neither truncates to nothing. */
const PHONE_ROW_CHARS = 40;

const ROLE_LABEL: Record<AgentRole, string> = {
  investigator: "Investigator",
  verifier: "Verifier",
};

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

const isWorking = (run: AgentRun) =>
  run.status === "running" || run.status === "waiting";

function runMs(run: AgentRun, now: number): number {
  const end = run.endedAt ? Date.parse(run.endedAt) : now;
  const ms = end - Date.parse(run.startedAt);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

function runsOf(
  response: IncidentResponse | undefined,
  role: AgentRole,
): AgentRun[] {
  return response?.agents.filter((run) => run.role === role) ?? [];
}

/** The PR number at the end of a pull request link, if it has one. */
function prNumberFromUrl(url: string): number | null {
  const match = /\/(?:pull|pr|merge_requests)\/(\d+)\/?$/.exec(url);
  return match ? Number(match[1]) : null;
}

function checksWord(pr: PrDetails): Pick<DetailRow, "value" | "tone"> {
  const checks = summarize(pr.checks ?? []);
  if (checks.failed) return { value: "checks fail", tone: "red" };
  if (checks.pending) return { value: "checks running", tone: "yellow" };
  if (checks.passed) return { value: "checks pass", tone: "green" };
  return { value: "" };
}

function changeRow(incident: Incident, pr: PrDetails | null): DetailRow {
  const response = incident.response;
  // The investigator's run names its PR; a candidate restored without one
  // (an earlier round, a restart) still carries the PR it was built on.
  const prUrl =
    runsOf(response, "investigator").findLast((run) => run.prUrl)?.prUrl ??
    response?.candidate?.prUrl ??
    response?.candidate?.pr?.url;
  const row = { key: "change", band: "Fix" } as const;
  if (prUrl && pr)
    return {
      ...row,
      label: `PR #${pr.number} · ${pr.title}`,
      ...checksWord(pr),
      lines: { additions: pr.additions, deletions: pr.deletions },
      target: {
        kind: "pr",
        repo: incident.project,
        number: pr.number,
        branch: pr.headRefName || undefined,
        url: httpUrl(pr.url) ?? undefined,
      },
    };
  if (prUrl) {
    // The PR is still loading or could not be read: keep its number from
    // the link rather than flashing "No change yet".
    const number = response?.candidate?.pr?.number ?? prNumberFromUrl(prUrl);
    const url = httpUrl(prUrl);
    return {
      ...row,
      label: number === null ? "Pull request" : `PR #${number}`,
      value: "",
      target: url ? { kind: "url", url } : null,
    };
  }
  if (response?.candidate?.rollbackFirst)
    return {
      ...row,
      label: "Rollback",
      value: "rolls back to the last release",
      target: null,
    };
  return {
    ...row,
    label: "Change",
    // A closed incident will not get one.
    value: isTerminalIncidentState(incident.state)
      ? "No change"
      : "No change yet",
    tone: "faint",
    target: null,
  };
}

function noteRow(response: IncidentResponse | undefined): DetailRow | null {
  const note = response?.note;
  if (!note) return null;
  const value = note.merged
    ? "Merged"
    : note.prUrl && note.prUrl === response.candidate?.prUrl
      ? "Draft · merges with the fix"
      : "Draft";
  const url = httpUrl(note.prUrl);
  return {
    key: "note",
    band: "Fix",
    label: "Incident note",
    value,
    target: url ? { kind: "url", url } : null,
  };
}

function investigatorRow(
  response: IncidentResponse | undefined,
  now: number,
): DetailRow | null {
  const runs = runsOf(response, "investigator");
  const newest = runs.at(-1);
  if (!newest) return null;
  const row = {
    key: "investigator",
    band: "Agents",
    label: ROLE_LABEL.investigator,
    target: { kind: "session", sessionId: newest.sessionId },
  } as const;
  if (runs.some(isWorking)) return { ...row, value: "working", tone: "yellow" };
  const rounds = Math.max(...runs.map((run) => run.round));
  const ms = runs.reduce((sum, run) => sum + runMs(run, now), 0);
  return {
    ...row,
    value: `${plural(rounds, "round")} · ${formatSpan(ms, true)}`,
  };
}

function verifierRow(response: IncidentResponse | undefined): DetailRow | null {
  const runs = runsOf(response, "verifier");
  const newest = runs.at(-1);
  if (!newest) return null;
  const row = {
    key: "verifier",
    band: "Agents",
    label: ROLE_LABEL.verifier,
    target: { kind: "session", sessionId: newest.sessionId },
  } as const;
  if (runs.some(isWorking)) return { ...row, value: "working", tone: "yellow" };
  const verdict = response?.verdict?.verdict;
  const lead =
    verdict === "certain"
      ? ({ text: "Certain", tone: "green" } as const)
      : verdict === "not-certain"
        ? ({ text: "Not certain", tone: "yellow" } as const)
        : ({ text: "No verdict", tone: "faint" } as const);
  const parts: string[] = [lead.text];
  const sentBack = runs.findLast(
    (run) =>
      run.round < newest.round &&
      run.report?.role === "verifier" &&
      run.report.verdict === "not-certain",
  );
  if (sentBack) parts.push(`sent round ${sentBack.round} back`);
  if (newest.independence && newest.independence !== "other-provider")
    parts.push(
      describeIndependence(newest.independence).replace(/^Verifier · /, ""),
    );
  const verifier: DetailRow = {
    ...row,
    value: parts.join(" · "),
    tone: lead.tone,
  };
  if (parts.length > 1) verifier.emphasis = lead.text;
  return verifier;
}

function costRow(
  response: IncidentResponse | undefined,
  budgetUsd: number | null,
): DetailRow {
  const row = { key: "cost", band: "Agents", label: "Agent cost" } as const;
  if (!response)
    return { ...row, value: "No agents yet", tone: "faint", target: null };
  const value = formatUsd(response.costUsd);
  const target = { kind: "sheet", sheet: "cost" } as const;
  if (!(budgetUsd !== null && budgetUsd > 0)) return { ...row, value, target };
  const pct = Math.round((response.costUsd / budgetUsd) * 1000) / 10;
  return {
    ...row,
    value,
    meter: { pct, of: `of ${formatUsd(budgetUsd, { whole: true })}` },
    target,
  };
}

/** No row where agents cannot run (a heads-up, paused, closed): the server's
 *  refusal there says nothing the owner can act on. */
function accessRow(
  access: IncidentAgentsAccessView | null,
  state: Incident["state"],
): DetailRow | null {
  if (!access || !incidentAllowsAgents(state)) return null;
  const preview = access.investigator;
  const row = {
    key: "access",
    band: "Agents",
    label: "Access",
    target: { kind: "sheet", sheet: "access" },
  } as const;
  if (preview.access) return { ...row, value: preview.access.summary };
  return preview.error
    ? { ...row, value: preview.error, tone: "red" }
    : { ...row, value: "" };
}

function earlierRow(earlier: IncidentSummary[]): DetailRow {
  const row = {
    key: "earlier",
    band: "History",
    label: "Earlier incidents",
  } as const;
  if (!earlier.length)
    return { ...row, value: "None like this", tone: "faint", target: null };
  const named = earlier.slice(0, EARLIER_NAMED).map((i) => i.title);
  const more = earlier.length - named.length;
  return {
    ...row,
    value: more ? `${named.join(", ")} and ${more} more` : named.join(", "),
    target: { kind: "sheet", sheet: "earlier" },
  };
}

export function detailRows(input: {
  incident: Incident;
  earlier: IncidentSummary[];
  pr: PrDetails | null;
  budgetUsd: number | null;
  access: IncidentAgentsAccessView | null;
  now: number;
}): DetailRow[] {
  const response = input.incident.response;
  return [
    changeRow(input.incident, input.pr),
    noteRow(response),
    investigatorRow(response, input.now),
    verifierRow(response),
    costRow(response, input.budgetUsd),
    accessRow(input.access, input.incident.state),
    earlierRow(input.earlier),
  ].filter((row): row is DetailRow => row !== null);
}

/** Closed incidents that share a signal with this one, newest first. */
export function earlierIncidents(
  all: IncidentSummary[],
  incident: Pick<Incident, "id" | "signalIds">,
): IncidentSummary[] {
  const signals = new Set(incident.signalIds);
  return all
    .filter(
      (other) =>
        other.id !== incident.id &&
        isTerminalIncidentState(other.state) &&
        other.signalIds.some((id) => signals.has(id)),
    )
    .sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt))
    .slice(0, EARLIER_MAX);
}

/** "Runs on this server, not in a sandbox" while the newest run of either
 *  role works on the host; a sandbox is the expected case and says nothing. */
export function agentsWorkspaceNote(
  response: IncidentResponse | undefined,
): string | null {
  for (const role of ["investigator", "verifier"] as const) {
    const newest = runsOf(response, role).at(-1);
    if (newest?.workspace.kind === "host")
      return describeWorkspace(newest.workspace);
  }
  return null;
}

const LEDGER_STATUS: Record<AgentRun["status"], RunLedgerEntry["status"]> = {
  running: "running",
  waiting: "running",
  done: "ok",
  error: "error",
  cancelled: "error",
};

/** The agents' runs for the cost sheet, newest first. */
export function ledgerEntries(
  response: IncidentResponse,
  now: number,
): RunLedgerEntry[] {
  return response.agents
    .map((run, index) => ({ run, index }))
    .sort(
      (a, b) =>
        Date.parse(b.run.startedAt) - Date.parse(a.run.startedAt) ||
        b.index - a.index,
    )
    .map(({ run }) => {
      const entry: RunLedgerEntry = {
        key: `${run.sessionId}:${run.round}:${run.attempt}`,
        status: LEDGER_STATUS[run.status],
        at: run.startedAt,
        meta: [
          `${ROLE_LABEL[run.role]} · round ${run.round}`,
          formatSpan(runMs(run, now), true),
          formatUsd(run.costUsd),
        ],
        sessionId: run.sessionId,
      };
      if (run.error) entry.error = run.error;
      return entry;
    });
}

/** Whether a row's value moves under its label on a phone. */
export function rowWrapsOnPhone(row: Pick<DetailRow, "label" | "value">) {
  return row.label.length + row.value.length > PHONE_ROW_CHARS;
}
