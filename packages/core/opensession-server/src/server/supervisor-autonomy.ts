/**
 * Handled alone vs asked you: how often Blob takes something off the owner's
 * plate and how often it puts something on it, per local day, from what the
 * server already records. Nothing new is stored for it.
 *
 * Read, all catalog documents and all bounded:
 * - the owner's supervisor inbox (supervisor-inbox.ts, one document of at
 *   most 200 items, closed ones kept 30 days) with its brief record;
 * - the lead approvals (leads/approvals.ts, one document of at most 200
 *   records per project) of the projects whose lead answers to the owner,
 *   found through the project settings list.
 * No session is opened or scanned.
 *
 * Handled alone:
 * - a lead's proposal its own rules ran (`approval.rule` set, approved by
 *   "Blob (lead)"), on the day it was claimed; one with an autofix-pr step
 *   is also counted as an autofix run;
 * - a needs-you item the supervisor or the watch closed with a reason
 *   (close_items), on the day it was closed;
 * - a line of the latest brief's `handled` that names neither of those, on
 *   the brief's day (only the latest brief is kept).
 * Asked you: every other needs-you item, on the day it was raised, by
 * source and category, with how it ended: answered (by the owner, or the
 * supervisor recording their answer), dismissed, expired, settled by
 * whoever raised it, or still open.
 *
 * A category is the lead category of a lead's item (its proposal record,
 * else its dedupe key), else the source's first segment ("watch",
 * "supervisor").
 *
 * Asking less: over the last 14 days, when the owner answered every item a
 * project's lead raised in a category with its first option (approve), at
 * least AUTONOMY_REPEAT times, and the project's rule for it is still Asks
 * first, the brief turn gets one needs-you item asking "Let the lead do it
 * alone from now on?" (`prepareAutonomyProposal`). A dismissal, an expiry,
 * an answer the supervisor recorded or any other answer in the window
 * blocks it. Only the categories in PROPOSABLE are ever proposed; every
 * other one, and any category added later, changes only from the project's
 * settings. Only the owner's
 * own first-option answer, signed in (a GitHub login) to the revision they
 * saw, changes the rule, through the project settings' write path
 * (projects/store.ts updateProjectDocument), which lets only the instance
 * owner or the lead's owner give a lead more room. A recorded answer, a
 * dismiss or any other option changes nothing. Nothing runs at import:
 * `startSupervisorAutonomy` registers the answer handler, once.
 */
import {
  LEAD_CATEGORY_LABELS,
  isLeadCategory,
  isPinnedOnlyYou,
  leadLevel,
  type LeadCategory,
  type ProjectLeadSettings,
} from "../shared/project-lead";
import type { LeadRecord } from "./leads/approvals";
import {
  RESERVED_DEDUPE_PREFIX,
  supervisorInboxKey,
  type PostSupervisorItemInput,
  type SupervisorAnswerContext,
  type SupervisorAnswerer,
  type SupervisorBriefView,
  type SupervisorItem,
} from "./supervisor-inbox";
import { localClock } from "./supervisor-quiet-hours";

/** Every lead item's source prefix (leads/report.ts LEAD_SOURCE_PREFIX),
 *  repeated here so this module loads nothing of the leads at import. */
const LEAD_PREFIX = "lead:";
/** The source of the "let the lead do it alone" items: `autonomy:<project>`. */
export const AUTONOMY_SOURCE_PREFIX = RESERVED_DEDUPE_PREFIX;
/** Days of answers the proposals look at. */
export const AUTONOMY_WINDOW_DAYS = 14;
/** The same answer this many times, and never another, before Blob asks. */
export const AUTONOMY_REPEAT = 3;
/** Most days autonomy_report covers. */
export const AUTONOMY_MAX_DAYS = 14;
export const AUTONOMY_YES = "Yes, let it";
export const AUTONOMY_NO = "Keep asking";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The only categories Blob may propose letting a lead do alone. An
 *  allowlist: a category added to LEAD_CATEGORIES is never proposed until
 *  it is added here on purpose. Each one stays inside the project's own
 *  repositories and tooling, touches no money, identity, customer or
 *  production data, and can be undone by a later change:
 *  - signal-rule-change: edits the project's own alerting rules; a bad
 *    rule is visible in the next signals and reverted the same way.
 *  - dependency-major: lands as a pull request through the project's CI
 *    and merge gate; a bad upgrade is reverted with another.
 *  - public-release: cuts a release from code that already passed review
 *    and CI; a bad one is followed by a fix release.
 *  - ci-repair: fixes the project's own CI configuration or tests in a
 *    pull request; its default is already Alone, so proposing it only
 *    returns a rule the owner tightened to its default.
 *  Everything else, in particular PINNED_ONLY_YOU (money, contracts,
 *  production data), banning users, rotating keys and customer-facing
 *  replies, changes only from the project's settings. */
export const PROPOSABLE: readonly LeadCategory[] = [
  "signal-rule-change",
  "dependency-major",
  "public-release",
  "ci-repair",
];

// ── Types ───────────────────────────────────────────────────────────────────

export interface AutonomyCategoryCount {
  category: string;
  alone: number;
  asked: number;
}

/** One day as GET /api/supervisor/brief returns it. */
export interface AutonomyLedger {
  /** The owner's local day, `YYYY-MM-DD`. */
  day: string;
  handledAlone: number;
  askedYou: number;
  /** Most active first. */
  byCategory: AutonomyCategoryCount[];
}

export type AskedOutcome =
  | "open"
  | "answered"
  | "dismissed"
  | "expired"
  | "settled";

export type AloneVia = "lead-rule" | "close" | "brief";

/** How the owner answered: their first option, another option, or text of
 *  their own. */
export type AnswerKind = "approved" | "declined" | "other";

export type AutonomyEvent =
  | {
      kind: "alone";
      day: string;
      via: AloneVia;
      category: string;
      source: string;
      project?: string;
      autofix?: boolean;
    }
  | {
      kind: "asked";
      day: string;
      at: number;
      category: string;
      source: string;
      project?: string;
      outcome: AskedOutcome;
      /** Set when the owner answered it themselves. */
      ownerAnswer?: AnswerKind;
      answeredAt?: number;
    };

export interface AutonomyDay extends AutonomyLedger {
  alone: Record<AloneVia, number> & { autofixRuns: number };
  asked: {
    bySource: Array<{ source: string; count: number }>;
    outcomes: Record<AskedOutcome, number>;
  };
}

/** One project's lead as the ledger needs it. */
export interface AutonomyLeadProject {
  project: string;
  label: string;
  revision: number;
  lead: Pick<ProjectLeadSettings, "enabled" | "rules">;
}

/** The owner's answers to one project's lead category over the window. */
export interface AskedHistory {
  project: string;
  category: LeadCategory;
  asked: number;
  approved: number;
  declined: number;
  other: number;
  unanswered: number;
}

export interface AutonomyCandidate extends AskedHistory {
  label: string;
}

// ── Pure ────────────────────────────────────────────────────────────────────

function segment(value: string): string | null {
  return /^[a-z0-9][a-z0-9-]{0,39}$/.test(value) ? value : null;
}

/** The project a lead or autonomy source names. */
function sourceProject(source: string): string | undefined {
  for (const prefix of [LEAD_PREFIX, AUTONOMY_SOURCE_PREFIX])
    if (source.startsWith(prefix))
      return source.slice(prefix.length) || undefined;
  return undefined;
}

/** An item's category: its lead proposal's, else the lead category in its
 *  dedupe key (`lead:<project>:<category>:…`), else the source's family. */
export function itemCategory(
  item: Pick<SupervisorItem, "source" | "dedupeKey">,
  record?: LeadRecord,
): string {
  if (record) return record.proposal.category;
  if (item.source.startsWith(LEAD_PREFIX)) {
    const key = item.dedupeKey ?? "";
    const next = key.startsWith(`${item.source}:`)
      ? (key.slice(item.source.length + 1).split(":")[0] ?? "")
      : "";
    if (isLeadCategory(next)) return next;
    const part = segment(next);
    return part ? `lead-${part}` : "lead";
  }
  return segment(item.source.split(":")[0] ?? "") ?? "other";
}

function answerKind(item: SupervisorItem): AnswerKind {
  const answer = item.answer ?? "";
  const options = item.options ?? [];
  if (options.length && answer === options[0]) return "approved";
  return options.includes(answer) ? "declined" : "other";
}

function outcomeOf(item: SupervisorItem): AskedOutcome {
  if (item.state === "answered")
    return item.answeredBy ? "answered" : "settled";
  return item.state;
}

/**
 * Every handled-alone and asked-you event the records hold, each on the
 * owner's local day. Pure: `leads` are the approvals of the projects whose
 * lead answers to the owner.
 */
export function autonomyEvents(input: {
  items: readonly SupervisorItem[];
  brief?: { day: string; handled: ReadonlyArray<{ itemId?: string }> };
  leads: ReadonlyArray<{ project: string; records: readonly LeadRecord[] }>;
  timeZone: string;
}): AutonomyEvent[] {
  const dayOf = (at: number) => localClock(at, input.timeZone).day;
  const events: AutonomyEvent[] = [];
  const recordByItem = new Map<string, LeadRecord>();
  const counted = new Set<string>();
  for (const { project, records } of input.leads) {
    // Newest first: the newest proposal for an item names its category.
    for (const record of records) {
      const itemId = record.proposal.itemId;
      if (!recordByItem.has(itemId)) recordByItem.set(itemId, record);
      const approval = record.approval;
      if (!approval?.rule) continue;
      counted.add(itemId);
      events.push({
        kind: "alone",
        day: dayOf(approval.at),
        via: "lead-rule",
        category: record.proposal.category,
        source: `${LEAD_PREFIX}${project}`,
        project,
        autofix: record.proposal.steps.some((s) => s.kind === "autofix-pr"),
      });
    }
  }
  const byId = new Map(input.items.map((item) => [item.id, item]));
  for (const item of input.items) {
    if (item.kind !== "needs-you" || counted.has(item.id)) continue;
    const category = itemCategory(item, recordByItem.get(item.id));
    const project = item.project ?? sourceProject(item.source);
    if (item.closeReason) {
      counted.add(item.id);
      events.push({
        kind: "alone",
        day: dayOf(item.updatedAt),
        via: "close",
        category,
        source: item.source,
        ...(project ? { project } : {}),
      });
      continue;
    }
    const outcome = outcomeOf(item);
    events.push({
      kind: "asked",
      day: dayOf(item.createdAt),
      at: item.createdAt,
      category,
      source: item.source,
      ...(project ? { project } : {}),
      outcome,
      ...(outcome === "answered" && item.answeredBy === "owner"
        ? { ownerAnswer: answerKind(item), answeredAt: item.answeredAt }
        : {}),
    });
  }
  for (const line of input.brief?.handled ?? []) {
    if (line.itemId && counted.has(line.itemId)) continue;
    if (line.itemId) counted.add(line.itemId);
    const item = line.itemId ? byId.get(line.itemId) : undefined;
    events.push({
      kind: "alone",
      day: input.brief!.day,
      via: "brief",
      category: item
        ? itemCategory(item, recordByItem.get(item.id))
        : "supervisor",
      source: item?.source ?? "supervisor",
    });
  }
  return events;
}

/** One day's counts. */
export function autonomyDay(
  events: readonly AutonomyEvent[],
  day: string,
): AutonomyDay {
  const categories = new Map<string, AutonomyCategoryCount>();
  const sources = new Map<string, number>();
  const alone = { "lead-rule": 0, close: 0, brief: 0, autofixRuns: 0 };
  const outcomes: Record<AskedOutcome, number> = {
    open: 0,
    answered: 0,
    dismissed: 0,
    expired: 0,
    settled: 0,
  };
  let handledAlone = 0;
  let askedYou = 0;
  for (const event of events) {
    if (event.day !== day) continue;
    const row = categories.get(event.category) ?? {
      category: event.category,
      alone: 0,
      asked: 0,
    };
    categories.set(event.category, row);
    if (event.kind === "alone") {
      handledAlone += 1;
      row.alone += 1;
      alone[event.via] += 1;
      if (event.autofix) alone.autofixRuns += 1;
    } else {
      askedYou += 1;
      row.asked += 1;
      outcomes[event.outcome] += 1;
      sources.set(event.source, (sources.get(event.source) ?? 0) + 1);
    }
  }
  return {
    day,
    handledAlone,
    askedYou,
    byCategory: [...categories.values()].sort(
      (a, b) =>
        b.alone + b.asked - (a.alone + a.asked) ||
        a.category.localeCompare(b.category),
    ),
    alone,
    asked: {
      bySource: [...sources]
        .map(([source, count]) => ({ source, count }))
        .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source)),
      outcomes,
    },
  };
}

/** The brief's shape of a day: the counts only. */
export function ledgerOf(day: AutonomyDay): AutonomyLedger {
  return {
    day: day.day,
    handledAlone: day.handledAlone,
    askedYou: day.askedYou,
    byCategory: day.byCategory,
  };
}

/** The owner's answers per project and lead category, over the items
 *  raised since `since`. */
export function askedHistory(
  events: readonly AutonomyEvent[],
  since: number,
): AskedHistory[] {
  const groups = new Map<string, AskedHistory>();
  for (const event of events) {
    if (event.kind !== "asked" || event.at < since || !event.project) continue;
    if (!event.source.startsWith(LEAD_PREFIX)) continue;
    if (!isLeadCategory(event.category)) continue;
    const key = `${event.project}\u0000${event.category}`;
    const row = groups.get(key) ?? {
      project: event.project,
      category: event.category,
      asked: 0,
      approved: 0,
      declined: 0,
      other: 0,
      unanswered: 0,
    };
    groups.set(key, row);
    row.asked += 1;
    if (event.ownerAnswer) row[event.ownerAnswer] += 1;
    else row.unanswered += 1;
  }
  return [...groups.values()].sort(
    (a, b) =>
      b.asked - a.asked ||
      a.project.localeCompare(b.project) ||
      a.category.localeCompare(b.category),
  );
}

/** Whether Blob may ever ask to let the lead do `category` alone: it is
 *  in PROPOSABLE, never pinned to the owner, and the rule is Asks first
 *  now. */
export function proposable(
  category: LeadCategory,
  lead: Pick<ProjectLeadSettings, "rules">,
): boolean {
  return (
    PROPOSABLE.includes(category) &&
    !isPinnedOnlyYou(category) &&
    leadLevel(lead.rules, category) === "asks-first"
  );
}

/** The groups where the owner approved every item asked in the window, at
 *  least AUTONOMY_REPEAT times, in a project whose lead is on and still
 *  asks first for them. A dismissed, expired, still open, settled or
 *  supervisor-recorded item, a decline or any other answer blocks the
 *  group. Most approvals first. */
export function autonomyCandidates(
  history: readonly AskedHistory[],
  leads: readonly AutonomyLeadProject[],
): AutonomyCandidate[] {
  const byProject = new Map(leads.map((l) => [l.project, l]));
  return history
    .flatMap((row): AutonomyCandidate[] => {
      const lead = byProject.get(row.project);
      if (!lead?.lead.enabled || !proposable(row.category, lead.lead))
        return [];
      if (row.approved < AUTONOMY_REPEAT || row.approved !== row.asked)
        return [];
      return [{ ...row, label: lead.label }];
    })
    .sort((a, b) => b.approved - a.approved);
}

export function autonomyDedupeKey(
  project: string,
  category: LeadCategory,
): string {
  return `${AUTONOMY_SOURCE_PREFIX}${project}:${category}`;
}

/** The decision item for a candidate, in fixed copy. */
export function autonomyItem(
  user: string,
  candidate: AutonomyCandidate,
): PostSupervisorItemInput {
  const what = LEAD_CATEGORY_LABELS[candidate.category];
  const lower = what.charAt(0).toLowerCase() + what.slice(1);
  return {
    user,
    source: `${AUTONOMY_SOURCE_PREFIX}${candidate.project}`,
    project: candidate.project,
    kind: "needs-you",
    title:
      `${candidate.label}: let the lead do ${lower} alone from now on?`.slice(
        0,
        120,
      ),
    body: [
      `You approved ${lower} for ${candidate.label} all ${candidate.approved} times the lead asked in the last ${AUTONOMY_WINDOW_DAYS} days.`,
      `"${AUTONOMY_YES}" changes the project's lead rule for ${lower} from Asks first to Alone, so the lead stops asking you about it. You can change it back in the project's settings.`,
    ].join("\n\n"),
    options: [AUTONOMY_YES, AUTONOMY_NO],
    dedupeKey: autonomyDedupeKey(candidate.project, candidate.category),
    once: true,
  };
}

function dayList(now: number, timeZone: string, days: number): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < days && i < days + 2; i++) {
    const day = localClock(now - i * DAY_MS, timeZone).day;
    if (!out.includes(day)) out.push(day);
  }
  return out;
}

const OUTCOME_ORDER: AskedOutcome[] = [
  "answered",
  "dismissed",
  "expired",
  "settled",
  "open",
];

/** autonomy_report's text: per day, then the window's answers per lead
 *  category, then what Blob may propose. Pure. */
export function autonomyReportText(input: {
  days: readonly AutonomyDay[];
  history: readonly AskedHistory[];
  candidates: readonly AutonomyCandidate[];
  leads: readonly AutonomyLeadProject[];
}): string {
  const lines: string[] = ["Handled alone vs asked you, newest day first."];
  for (const d of input.days) {
    lines.push(
      "",
      `${d.day}: handled alone ${d.handledAlone}, asked you ${d.askedYou}.`,
    );
    if (d.handledAlone)
      lines.push(
        `- Alone: ${d.alone["lead-rule"]} by a lead's rules (${d.alone.autofixRuns} autofix runs), ${d.alone.close} closed with a reason, ${d.alone.brief} other brief lines.`,
      );
    if (d.askedYou) {
      const outcomes = OUTCOME_ORDER.filter((o) => d.asked.outcomes[o])
        .map((o) => `${d.asked.outcomes[o]} ${o}`)
        .join(", ");
      lines.push(
        `- Asked: ${outcomes}. By source: ${d.asked.bySource.map((s) => `${s.source} ${s.count}`).join(", ")}.`,
      );
    }
    for (const c of d.byCategory)
      lines.push(`- ${c.category}: alone ${c.alone}, asked ${c.asked}`);
  }
  const labels = new Map(input.leads.map((l) => [l.project, l]));
  lines.push(
    "",
    `Asked you per lead category, last ${AUTONOMY_WINDOW_DAYS} days, with the owner's own answers:`,
  );
  if (!input.history.length) lines.push("- Nothing.");
  for (const h of input.history) {
    const lead = labels.get(h.project);
    const level = lead ? leadLevel(lead.lead.rules, h.category) : "unknown";
    lines.push(
      `- ${h.project} ${h.category} (rule: ${level}): asked ${h.asked}; approved ${h.approved}, declined ${h.declined}, other ${h.other}, no owner answer ${h.unanswered}`,
    );
  }
  lines.push("", "Could ask the owner to let the lead do it alone:");
  if (!input.candidates.length)
    lines.push(
      `- Nothing yet: a category qualifies once the owner approved every item asked in it, at least ${AUTONOMY_REPEAT} times in ${AUTONOMY_WINDOW_DAYS} days, while its rule is Asks first. Only for ${PROPOSABLE.join(", ")}.`,
    );
  for (const c of input.candidates)
    lines.push(
      `- ${c.project} ${c.category}: approved ${c.approved} of ${c.asked}. The server raises the question before a brief; only the owner's own Yes changes the rule.`,
    );
  return lines.join("\n");
}

// ── Dependencies ────────────────────────────────────────────────────────────

export interface AutonomyDeps {
  now(): number;
  readView(user: string): Promise<SupervisorBriefView>;
  /** The projects whose lead answers to `user`. */
  leadProjects(user: string): Promise<AutonomyLeadProject[]>;
  /** One project's approval records, newest first. */
  records(project: string): Promise<LeadRecord[]>;
  post(input: PostSupervisorItemInput): Promise<{
    item: SupervisorItem;
    created: boolean;
  }>;
  /** The project's lead settings, read fresh. */
  leadProject(project: string): Promise<AutonomyLeadProject | null>;
  /** The settings write the project page uses, as the signed-in owner. */
  setRule(
    project: string,
    revision: number,
    category: LeadCategory,
    actor: { name: string; login: string },
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  /** The lead's owner, as leads/report.ts leadOwner names them. */
  leadOwner(project: string): Promise<string>;
  audit(event: Record<string, unknown>): Promise<void>;
}

async function leadProjectOf(
  doc: import("../shared/project-settings").ProjectSettingsDocument,
): Promise<AutonomyLeadProject> {
  const { configuredRepos } = await import("./config");
  return {
    project: doc.project,
    label: configuredRepos()[doc.project]?.label || doc.project,
    revision: doc.revision,
    lead: doc.lead,
  };
}

const liveDeps: AutonomyDeps = {
  now: Date.now,
  readView: async (user) =>
    (await import("./supervisor-inbox")).readSupervisorBriefView(user),
  leadProjects: async (user) => {
    const [{ listProjectDocuments }, { leadOwner }] = await Promise.all([
      import("./projects/store"),
      import("./leads/report"),
    ]);
    const key = supervisorInboxKey(user);
    const docs = (await listProjectDocuments()).filter((doc) => {
      const owner = leadOwner(doc);
      return !!owner && supervisorInboxKey(owner) === key;
    });
    return Promise.all(docs.map(leadProjectOf));
  },
  records: async (project) =>
    (await import("./leads/approvals")).listForProject(project),
  post: async (input) =>
    (await import("./supervisor-inbox")).postSupervisorItem(input),
  leadProject: async (project) => {
    const { getProjectDocument, projectExists } =
      await import("./projects/store");
    if (!projectExists(project)) return null;
    return leadProjectOf(await getProjectDocument(project));
  },
  setRule: async (project, revision, category, actor) => {
    const { updateProjectDocument } = await import("./projects/store");
    const result = await updateProjectDocument(
      project,
      { expectedRevision: revision, lead: { rules: { [category]: "alone" } } },
      { name: actor.name, verified: true, login: actor.login },
    );
    return "error" in result
      ? { ok: false, error: result.error }
      : { ok: true };
  },
  leadOwner: async (project) => {
    const [{ getProjectDocument, projectExists }, { leadOwner }] =
      await Promise.all([import("./projects/store"), import("./leads/report")]);
    if (!projectExists(project)) return "";
    return leadOwner(await getProjectDocument(project));
  },
  audit: async (event) => {
    const [{ auditDurable }, { BLOB_ACTOR }] = await Promise.all([
      import("./audit"),
      import("./session-actors"),
    ]);
    await auditDurable({ actor: BLOB_ACTOR, ...event });
  },
};

let deps: AutonomyDeps = liveDeps;

/** Swap dependencies in tests. Returns a restore function. */
export function __setAutonomyDepsForTest(
  overrides: Partial<AutonomyDeps>,
): () => void {
  const previous = deps;
  deps = { ...liveDeps, ...overrides };
  return () => {
    deps = previous;
  };
}

// ── Reading ─────────────────────────────────────────────────────────────────

interface Gathered {
  view: SupervisorBriefView;
  leads: AutonomyLeadProject[];
  events: AutonomyEvent[];
}

function briefOf(
  raw: Record<string, unknown> | undefined,
): { day: string; handled: Array<{ itemId?: string }> } | undefined {
  const brief = raw?.brief;
  if (!brief || typeof brief !== "object" || Array.isArray(brief))
    return undefined;
  const { day, handled } = brief as { day?: unknown; handled?: unknown };
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day))
    return undefined;
  return {
    day,
    handled: (Array.isArray(handled) ? handled : []).flatMap((h) =>
      h && typeof h === "object"
        ? [
            typeof (h as { itemId?: unknown }).itemId === "string"
              ? { itemId: (h as { itemId: string }).itemId }
              : {},
          ]
        : [],
    ),
  };
}

async function gather(
  user: string,
  view?: SupervisorBriefView,
): Promise<Gathered> {
  const [read, leads] = await Promise.all([
    view ? Promise.resolve(view) : deps.readView(user),
    deps.leadProjects(user),
  ]);
  const records = await Promise.all(
    leads.map(async (l) => ({
      project: l.project,
      records: await deps.records(l.project),
    })),
  );
  return {
    view: read,
    leads,
    events: autonomyEvents({
      items: read.items,
      brief: briefOf(read.brief),
      leads: records,
      timeZone: read.timeZone,
    }),
  };
}

/** Today's ledger for the brief, from the inbox view the brief already
 *  read. Rejects when a record can't be read. */
export async function autonomyLedger(
  user: string,
  view?: SupervisorBriefView,
): Promise<AutonomyLedger> {
  const { view: read, events } = await gather(user, view);
  return ledgerOf(
    autonomyDay(events, localClock(deps.now(), read.timeZone).day),
  );
}

/** autonomy_report: the last `days` days (1 to 14), the window's answers
 *  per lead category and what Blob may propose. Only reads. */
export async function autonomyReport(user: string, days = 7): Promise<string> {
  const count = Math.min(
    AUTONOMY_MAX_DAYS,
    Math.max(1, Math.floor(Number.isFinite(days) ? days : 7)),
  );
  const { view, leads, events } = await gather(user);
  const now = deps.now();
  const history = askedHistory(events, now - AUTONOMY_WINDOW_DAYS * DAY_MS);
  return autonomyReportText({
    days: dayList(now, view.timeZone, count).map((d) => autonomyDay(events, d)),
    history,
    candidates: autonomyCandidates(history, leads),
    leads,
  });
}

// ── Proposing ───────────────────────────────────────────────────────────────

/**
 * Before a brief turn: raise at most one "let the lead do it alone" item,
 * for the candidate with the most approvals that was never raised (an
 * item with its key, open or closed, stops it), and none while another is
 * still open. Normal urgency: it waits for the brief, which may pick it as
 * a decision. Resolves the item id raised, or null.
 */
export async function prepareAutonomyProposal(
  user: string,
): Promise<string | null> {
  const { view, leads, events } = await gather(user);
  const autonomyItems = view.items.filter((item) =>
    item.source.startsWith(AUTONOMY_SOURCE_PREFIX),
  );
  // An open fyi (the rule changed, or the change was refused) is no
  // decision waiting, so it does not hold the next proposal back.
  if (
    autonomyItems.some(
      (item) => item.kind === "needs-you" && item.state === "open",
    )
  )
    return null;
  const raised = new Set(autonomyItems.map((item) => item.dedupeKey));
  const history = askedHistory(
    events,
    deps.now() - AUTONOMY_WINDOW_DAYS * DAY_MS,
  );
  const next = autonomyCandidates(history, leads).find(
    (c) => !raised.has(autonomyDedupeKey(c.project, c.category)),
  );
  if (!next) return null;
  const posted = await deps.post(autonomyItem(user, next));
  if (posted.created)
    await deps.audit({
      kind: "autonomy_proposed",
      user,
      project: next.project,
      category: next.category,
      approved: next.approved,
      itemId: posted.item.id,
    });
  return posted.created ? posted.item.id : null;
}

function categoryOf(item: SupervisorItem): LeadCategory | null {
  const project = sourceProject(item.source);
  if (!project || !item.source.startsWith(AUTONOMY_SOURCE_PREFIX)) return null;
  const prefix = `${AUTONOMY_SOURCE_PREFIX}${project}:`;
  const rest = item.dedupeKey?.startsWith(prefix)
    ? item.dedupeKey.slice(prefix.length)
    : "";
  return isLeadCategory(rest) ? rest : null;
}

export type AutonomyAnswerResult =
  | { changed: true }
  | { changed: false; reason: string };

/**
 * The owner answered a "let the lead do it alone" item. Only their own
 * first option, given signed in to the revision they saw, in the inbox of
 * the lead's owner, changes the project's rule for the category from Asks
 * first to Alone, through the settings write that lets only the instance
 * owner or the lead's owner loosen a lead. Anything else changes nothing.
 * The changed rule, or a refused write, is told to the owner as an fyi.
 */
export async function handleAutonomyAnswer(
  item: SupervisorItem,
  answer: string,
  answeredBy: SupervisorAnswerer,
  context: SupervisorAnswerContext = {},
): Promise<AutonomyAnswerResult> {
  const project = sourceProject(item.source);
  const category = categoryOf(item);
  if (!project || !category)
    return { changed: false, reason: "not an autonomy item" };
  if (answeredBy !== "owner")
    return { changed: false, reason: "not the owner's own answer" };
  if (!item.options?.length || answer !== item.options[0])
    return { changed: false, reason: "not approved" };
  if (!context.login || context.revision === undefined)
    return { changed: false, reason: "not signed in to the item's revision" };
  const owner = await deps.leadOwner(project);
  if (!owner || supervisorInboxKey(owner) !== supervisorInboxKey(item.user))
    return { changed: false, reason: "not the lead's owner's inbox" };
  const lead = await deps.leadProject(project);
  if (!lead) return { changed: false, reason: "unknown project" };
  if (!proposable(category, lead.lead))
    return { changed: false, reason: "the rule is not Asks first any more" };
  const result = await deps.setRule(project, lead.revision, category, {
    name: item.user,
    login: context.login,
  });
  await deps.audit({
    kind: "autonomy_answered",
    user: item.user,
    project,
    category,
    itemId: item.id,
    changed: result.ok,
    ...(result.ok ? {} : { error: result.error }),
  });
  const what = LEAD_CATEGORY_LABELS[category].toLowerCase();
  if (result.ok) {
    await deps
      .post({
        user: item.user,
        source: item.source,
        project,
        kind: "fyi",
        title: `${lead.label} lead now does ${what} alone.`.slice(0, 120),
        body: `Change it back in Settings, ${lead.label}, Lead.`,
        dedupeKey: `${item.dedupeKey}:alone`,
      })
      .catch(() => {});
    return { changed: true };
  }
  await deps
    .post({
      user: item.user,
      source: item.source,
      project,
      kind: "fyi",
      title: `Couldn't let the lead do ${what} alone`,
      body: `The project's settings refused the change: ${result.error}. Change the rule in the project's settings instead.`,
      dedupeKey: `${item.dedupeKey}:refused`,
    })
    .catch(() => {});
  return { changed: false, reason: result.error };
}

/** Register the answer handler, once; called from boot. */
export async function startSupervisorAutonomy(): Promise<void> {
  const g = globalThis as { __supervisorAutonomyStarted?: boolean };
  if (g.__supervisorAutonomyStarted) return;
  g.__supervisorAutonomyStarted = true;
  const { onSupervisorAnswer } = await import("./supervisor-inbox");
  onSupervisorAnswer(AUTONOMY_SOURCE_PREFIX, async (...args) => {
    const result = await handleAutonomyAnswer(...args);
    if (!result.changed && result.reason !== "not approved")
      console.warn(
        `[autonomy] ${args[0].source}: the answer changed no rule (${result.reason})`,
      );
  });
}
