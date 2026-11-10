// One read-only view of a project for its lead: open incidents, how its
// signals flapped, support conversations waiting for a person, the inboxes'
// autonomy, open pull requests and their checks, and this month's spend.
// Every source is a catalog namespace or an in-memory projection; nothing
// here opens a session or its database. Lists are capped so the result fits
// a tool reply.
import type { Incident, Signal } from "../../shared/incidents";
import type { Goal } from "../goals";
import { isOpenIncident } from "../../shared/incidents";
import type { ProjectSettingsDocument } from "../../shared/project-settings";
import type { InboxConfig, SupportIndexRow } from "../../shared/support";
import { spendInMonth } from "../incidents/response/ledger";
import {
  type FlapReport,
  type RuleProposal,
  flapReportMarkdown,
  triageFlaps,
} from "./flaps";

/** Items listed per section; the counts stay whole. */
export const OVERVIEW_ITEMS = 8;
/** The markdown is cut here. */
export const OVERVIEW_MAX_CHARS = 8_000;
/** A pull request nobody touched for this long is stale. */
export const STALE_PR_MS = 7 * 86_400_000;
const SUBJECT_CHARS = 100;

/** An open pull request, as the PR cache keeps it in memory. */
export interface OverviewPr {
  repo: string;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  updatedAt: string;
  checks: { total: number; passed: number; failed: number; pending: number };
}

export interface LeadOverviewDeps {
  now(): number;
  projectDocument(project: string): Promise<ProjectSettingsDocument>;
  listSignals(): Promise<Signal[]>;
  listIncidents(project: string): Promise<Incident[]>;
  listInboxes(): Promise<InboxConfig[]>;
  /** Index rows of conversations that are open or waiting. */
  openSupportRows(): Promise<SupportIndexRow[]>;
  /** Open pull requests across projects, or null with no indexed source. */
  openPrs(): Promise<OverviewPr[] | null>;
  getGoal(id: string): Promise<Goal | null>;
}

export interface LeadOverview {
  project: string;
  at: string;
  lead: {
    enabled: boolean;
    stage: ProjectSettingsDocument["lead"]["stage"];
    owner: string | null;
    budgetUsdPerMonth: number;
  };
  incidents: {
    open: number;
    items: Array<{
      id: string;
      title: string;
      state: Incident["state"];
      severity: Incident["severity"];
      openedAt: string;
      signalId: string;
    }>;
  };
  flaps: {
    windowDays: number;
    counts: FlapReport["counts"];
    flapping: Array<{
      signalId: string;
      name: string;
      opened: number;
      selfClosed: number;
      proposal?: RuleProposal;
    }>;
    markdown: string;
  };
  support: {
    inboxes: Array<{
      id: string;
      label: string;
      enabled: boolean;
      autonomy: InboxConfig["autonomy"];
      vetoMinutes: number | null;
    }>;
    waiting: number;
    items: Array<{
      id: string;
      subject: string;
      waitingSince: string | null;
      draft: SupportIndexRow["draftState"];
    }>;
  };
  pullRequests:
    | {
        open: number;
        drafts: number;
        failingChecks: number;
        stale: number;
        items: Array<{
          number: number;
          title: string;
          url: string;
          failed: number;
          pending: number;
          stale: boolean;
        }>;
      }
    | { unavailable: string };
  ci: { unavailable: string };
  spend: {
    /** What the project's incident agents spent this UTC month. */
    incidentAgentsUsd: number;
    /** What the lead's own goal runs cost this UTC month; null without a
     *  lead goal. */
    leadUsd: number | null;
    leadBudgetUsdPerMonth: number;
  };
}

const CI_UNAVAILABLE =
  "Default-branch CI isn't indexed anywhere; only pull request checks are shown";
const PR_UNAVAILABLE = "No pull request cache on this server";

let depsOverride: Partial<LeadOverviewDeps> | undefined;

/** Replace the overview's sources (undefined restores the live ones). */
export function __setLeadOverviewDepsForTest(
  deps: Partial<LeadOverviewDeps> | undefined,
): void {
  depsOverride = deps;
}

// Imported on first use: the live sources pull in the catalog client and
// the PR cache, which reads its snapshot when loaded.
const liveDeps: LeadOverviewDeps = {
  now: () => Date.now(),
  projectDocument: async (project) =>
    (await import("../projects/store")).getProjectDocument(project),
  listSignals: async () =>
    (await import("../incidents/signal-store")).listSignals(),
  listIncidents: async (project) =>
    (await import("../incidents/incident-store")).listIncidents({ project }),
  listInboxes: async () => (await import("../support/inboxes")).listInboxes(),
  openSupportRows: async () =>
    (await import("../support/store")).listIndexRows({
      status: ["open", "waiting"],
    }),
  openPrs: async () => (await import("../pr-cache")).getOpenPrSummaries(),
  getGoal: async (id) => (await import("../goals")).getGoal(id),
};

/** The live sources, with any test replacements. */
export function leadSources(): LeadOverviewDeps {
  return { ...liveDeps, ...depsOverride };
}
const deps = leadSources;

/** The project's flap triage over the last `windowDays`, from the live
 *  signals and incidents. */
export async function buildFlapReport(
  project: string,
  opts: { windowDays?: number; selfCloseMinutes?: number } = {},
): Promise<FlapReport> {
  const d = deps();
  const [signals, incidents] = await Promise.all([
    d.listSignals(),
    d.listIncidents(project),
  ]);
  return triageFlaps({
    project,
    signals,
    incidents,
    now: d.now(),
    ...(opts.windowDays ? { windowMs: opts.windowDays * 86_400_000 } : {}),
    ...(opts.selfCloseMinutes
      ? { selfCloseMinutes: opts.selfCloseMinutes }
      : {}),
  });
}

/** A conversation that waits for a person: unanswered with no reply on
 *  its way, or a draft a person must send or retry. */
export function waitsForPerson(row: SupportIndexRow): boolean {
  if (row.status !== "open" && row.status !== "waiting") return false;
  if (row.draftState === "needs-person" || row.draftState === "failed")
    return true;
  return (
    row.unansweredSince !== null &&
    row.draftState !== "veto" &&
    row.draftState !== "sending"
  );
}

function clip(text: string, chars: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > chars ? `${flat.slice(0, chars - 1)}…` : flat;
}

export async function buildLeadOverview(
  project: string,
): Promise<{ json: LeadOverview; markdown: string }> {
  const d = deps();
  const now = d.now();
  const doc = await d.projectDocument(project);
  const [signals, incidents, inboxes, rows, prs, goal] = await Promise.all([
    d.listSignals(),
    d.listIncidents(project),
    d.listInboxes(),
    d.openSupportRows(),
    d.openPrs(),
    doc.lead.goalId ? d.getGoal(doc.lead.goalId) : Promise.resolve(null),
  ]);
  const own = incidents.filter((i) => i.project === project);
  const open = own.filter(isOpenIncident);
  const flaps = triageFlaps({ project, signals, incidents: own, now });
  const projectInboxes = inboxes.filter((i) => i.project === project);
  const inboxIds = new Set(projectInboxes.map((i) => i.id));
  const waiting = rows
    .filter((r) => inboxIds.has(r.inboxId) && waitsForPerson(r))
    .sort(
      (a, b) =>
        (a.unansweredSince ?? a.lastMessageAt).localeCompare(
          b.unansweredSince ?? b.lastMessageAt,
        ) || a.id.localeCompare(b.id),
    );
  const month = new Date(now).toISOString().slice(0, 7);
  const monthUsd =
    Math.round(
      own.reduce((sum, i) => sum + spendInMonth(i.response, month, now), 0) *
        100,
    ) / 100;

  const json: LeadOverview = {
    project,
    at: new Date(now).toISOString(),
    lead: {
      enabled: doc.lead.enabled,
      stage: doc.lead.stage,
      owner: doc.lead.owner ?? null,
      budgetUsdPerMonth: doc.lead.budgetUsdPerMonth,
    },
    incidents: {
      open: open.length,
      items: open.slice(0, OVERVIEW_ITEMS).map((i) => ({
        id: i.id,
        title: clip(i.title, SUBJECT_CHARS),
        state: i.state,
        severity: i.severity,
        openedAt: i.openedAt,
        signalId: i.primarySignalId,
      })),
    },
    flaps: {
      windowDays: Math.round(flaps.windowMs / 86_400_000),
      counts: flaps.counts,
      flapping: flaps.signals
        .filter((s) => s.classification === "flapping")
        .slice(0, OVERVIEW_ITEMS)
        .map((s) => ({
          signalId: s.signalId,
          name: s.name,
          opened: s.opened,
          selfClosed: s.selfClosed.count,
          ...(s.proposal ? { proposal: s.proposal } : {}),
        })),
      markdown: flapReportMarkdown(flaps),
    },
    support: {
      inboxes: projectInboxes.map((i) => ({
        id: i.id,
        label: i.label,
        enabled: i.enabled,
        autonomy: i.autonomy,
        vetoMinutes: i.vetoMs === null ? null : Math.round(i.vetoMs / 60_000),
      })),
      waiting: waiting.length,
      items: waiting.slice(0, OVERVIEW_ITEMS).map((r) => ({
        id: r.id,
        subject: clip(r.subject || "(no subject)", SUBJECT_CHARS),
        waitingSince: r.unansweredSince,
        draft: r.draftState,
      })),
    },
    pullRequests: prs === null ? { unavailable: PR_UNAVAILABLE } : prSection(),
    ci: { unavailable: CI_UNAVAILABLE },
    spend: {
      incidentAgentsUsd: monthUsd,
      leadUsd:
        goal && goal.spend?.month === month ? goal.spend.usd : goal ? 0 : null,
      leadBudgetUsdPerMonth: doc.lead.budgetUsdPerMonth,
    },
  };

  function prSection(): LeadOverview["pullRequests"] {
    const mine = (prs ?? [])
      .filter((p) => p.repo === project)
      .sort(
        (a, b) =>
          b.checks.failed - a.checks.failed ||
          b.updatedAt.localeCompare(a.updatedAt) ||
          a.number - b.number,
      );
    const stale = (p: OverviewPr) =>
      now - Date.parse(p.updatedAt) > STALE_PR_MS;
    return {
      open: mine.length,
      drafts: mine.filter((p) => p.isDraft).length,
      failingChecks: mine.filter((p) => p.checks.failed > 0).length,
      stale: mine.filter(stale).length,
      items: mine.slice(0, OVERVIEW_ITEMS).map((p) => ({
        number: p.number,
        title: clip(p.title, SUBJECT_CHARS),
        url: p.url,
        failed: p.checks.failed,
        pending: p.checks.pending,
        stale: stale(p),
      })),
    };
  }

  return { json, markdown: overviewMarkdown(json) };
}

function more(total: number, shown: number): string[] {
  return total > shown ? [`- and ${total - shown} more`] : [];
}

export function overviewMarkdown(o: LeadOverview): string {
  const lead = o.lead.enabled
    ? `on, ${o.lead.stage} stage`
    : `off (${o.lead.stage} stage when on)`;
  const lines = [
    `# ${o.project} at ${o.at}`,
    `Lead: ${lead}; owner ${o.lead.owner ?? "not set"}; budget $${o.lead.budgetUsdPerMonth} a month.`,
    "",
    `## Incidents: ${o.incidents.open} open`,
    ...o.incidents.items.map(
      (i) =>
        `- ${i.title} (\`${i.id}\`): ${i.state}, ${i.severity}, since ${i.openedAt}`,
    ),
    ...more(o.incidents.open, o.incidents.items.length),
    "",
    "## Signals",
    o.flaps.markdown,
    "",
    `## Support: ${o.support.waiting} waiting for a person`,
    ...(o.support.inboxes.length
      ? o.support.inboxes.map(
          (i) =>
            `- Inbox ${i.label}: ${i.enabled ? i.autonomy : "off"}${i.vetoMinutes !== null ? `, ${i.vetoMinutes} min veto` : ""}`,
        )
      : ["- No support inbox for this project"]),
    ...o.support.items.map(
      (c) =>
        `- ${c.subject} (\`${c.id}\`): ${c.draft ? `draft ${c.draft}` : "no draft"}${c.waitingSince ? `, since ${c.waitingSince}` : ""}`,
    ),
    ...more(o.support.waiting, o.support.items.length),
    "",
  ];
  const prs = o.pullRequests;
  if ("unavailable" in prs) lines.push("## Pull requests", prs.unavailable);
  else
    lines.push(
      `## Pull requests: ${prs.open} open, ${prs.failingChecks} with failing checks, ${prs.stale} stale, ${prs.drafts} drafts`,
      ...prs.items.map(
        (p) =>
          `- #${p.number} ${p.title}: ${p.failed ? `${p.failed} checks failing` : p.pending ? `${p.pending} checks pending` : "checks passing"}${p.stale ? ", stale" : ""} (${p.url})`,
      ),
      ...more(prs.open, prs.items.length),
    );
  lines.push(
    "",
    "## CI",
    o.ci.unavailable,
    "",
    "## Spend this month",
    `Incident agents: $${o.spend.incidentAgentsUsd}. The lead: ${o.spend.leadUsd === null ? "no goal yet" : `$${o.spend.leadUsd}`} of its $${o.spend.leadBudgetUsdPerMonth} a month.`,
  );
  const text = lines.join("\n");
  return text.length > OVERVIEW_MAX_CHARS
    ? `${text.slice(0, OVERVIEW_MAX_CHARS - 20)}\n… (cut to fit)`
    : text;
}
