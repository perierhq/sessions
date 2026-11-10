// Where a lead's proposals and digest notes go: the supervisor inbox of the
// person the lead answers to (adrs/supervisor-and-leads.md, section 5). A
// proposal is a needs-you item with numbered options, the first one
// recommended; a digest note is one fyi item per day. Repeats about the
// same subject update one item instead of adding another. Every proposal
// is audited with the rule that decided it. The server writes each item's
// title and the rule line. The body leads with the lead's first paragraph,
// what Blob says when it presents the decision (say and show,
// blob-surface.ts); the rule, the lead's title and the rest follow.
import {
  LEAD_CATEGORY_LABELS,
  type LeadCategory,
  type LeadDecision,
} from "../../shared/project-lead";
import type { ProjectSettingsDocument } from "../../shared/project-settings";
import { auditDurable, digest } from "../audit";
import { instanceOwner, personOwner } from "../incidents/owner";
import { BLOB_ACTOR } from "../session-actors";
import {
  listSupervisorItems,
  postSupervisorItem,
  type PostDelivery,
} from "../supervisor-inbox";

/** `proposal`: something the lead suggests; `needs-you`: something only the
 *  owner may do, prepared by the lead. */
export const LEAD_PROPOSAL_KINDS = ["proposal", "needs-you"] as const;
export type LeadProposalKind = (typeof LEAD_PROPOSAL_KINDS)[number];

export interface LeadProposal {
  kind: LeadProposalKind;
  category: LeadCategory;
  title: string;
  body: string;
  /** The owner's choices, the recommended one first. */
  options: string[];
  /** What the proposal is about, stable across wakes (a signal id and the
   *  rule field, a PR number); the title stands in when absent. */
  subject?: string;
  /** The rules' verdict on the action, with the rule that made it. */
  decision: LeadDecision;
}

export type LeadDelivery =
  | { queued: true; itemId: string; created: boolean; delivery: PostDelivery }
  | { queued: false; reason: string };

const NOBODY =
  "Nobody to report to: set the lead's owner in the project settings";

/** Why the lead may not report now, or null: it is off, or the project's
 *  kill switch is on. */
export function leadReportRefusal(
  doc: Pick<ProjectSettingsDocument, "lead" | "incidents">,
): string | null {
  if (!doc.lead.enabled) return "The lead is off in the project settings";
  if (doc.incidents.agentsPaused)
    return "Agents are paused for this project: the lead reports nothing until they run again";
  return null;
}

/** The title every proposal goes out under: the project and the kind of
 *  action, never the lead's own words. */
export function proposalTitle(label: string, category: LeadCategory): string {
  return `${label}: ${LEAD_CATEGORY_LABELS[category]}`;
}

/** The body: the lead's first paragraph (what Blob says), then the rule
 *  the server applied, the lead's title and the rest of its text (what Blob
 *  shows). */
export function proposalBody(
  proposal: Pick<LeadProposal, "title" | "body" | "decision">,
): string {
  const [say = "", ...shown] = proposal.body.trim().split(/\n\s*\n/);
  return [
    say.trim(),
    `Rule: ${proposal.decision.rule}.`,
    proposal.title,
    shown.join("\n\n").trim(),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Every lead item's source: `lead:<project>`. */
export const LEAD_SOURCE_PREFIX = "lead:";
export const leadSource = (project: string) =>
  `${LEAD_SOURCE_PREFIX}${project}`;

const DEFAULT_OPTIONS: Record<LeadProposalKind, string[]> = {
  proposal: ["Approve", "Not now"],
  "needs-you": ["I'll do it", "Not now"],
};

export type LeadAuditSink = (
  event: Record<string, unknown>,
) => void | Promise<void>;

let sink: LeadAuditSink | undefined;

/** Replace the audit sink (undefined restores `auditDurable`); returns the
 *  previous one. */
export function __setLeadAuditForTest(
  next: LeadAuditSink | undefined,
): LeadAuditSink | undefined {
  const previous = sink;
  sink = next;
  return previous;
}

/** Audit one lead event. A lead is Blob working on one project, so every
 *  entry names Blob as the actor; the owner it answers to stays `user`. */
export async function leadAudit(event: Record<string, unknown>): Promise<void> {
  await (sink ?? auditDurable)({ actor: BLOB_ACTOR, ...event });
}

/** Who the lead answers to: its owner, else the instance owner; "" when
 *  there is nobody. */
export function leadOwner(doc: Pick<ProjectSettingsDocument, "lead">): string {
  return personOwner(doc.lead.owner) ?? instanceOwner();
}

/** A subject as a key: lower case, single spaces, bounded. */
export function subjectKey(subject: string): string {
  return subject.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 120);
}

/** The inbox key a proposal updates: one per project, category and subject. */
export function proposalDedupeKey(
  project: string,
  proposal: Pick<LeadProposal, "category" | "subject" | "title">,
): string {
  return `${leadSource(project)}:${proposal.category}:${subjectKey(proposal.subject || proposal.title)}`;
}

/** Hand a proposal to the owner's supervisor inbox, unless the lead is
 *  off or paused. Its title and body may quote customers, so the audit
 *  keeps digests of them, never the text. */
export async function deliverLeadProposal(
  project: string,
  doc: Pick<ProjectSettingsDocument, "lead" | "incidents">,
  proposal: LeadProposal,
  label: string = project,
): Promise<LeadDelivery> {
  const owner = leadOwner(doc);
  const dedupeKey = proposalDedupeKey(project, proposal);
  const base = {
    kind: "lead_proposal",
    project,
    proposalKind: proposal.kind,
    category: proposal.category,
    level: proposal.decision.level,
    effective: proposal.decision.effective,
    rule: proposal.decision.rule,
    titleDigest: digest(proposal.title),
    bodyDigest: digest(proposal.body),
    options: proposal.options.length,
    dedupeKey,
  };
  const refusal = leadReportRefusal(doc);
  if (refusal || !owner) {
    await leadAudit({ ...base, delivered: false });
    return { queued: false, reason: refusal ?? NOBODY };
  }
  const options = proposal.options.length
    ? proposal.options
    : DEFAULT_OPTIONS[proposal.kind];
  const posted = await postSupervisorItem({
    user: owner,
    source: leadSource(project),
    project,
    kind: "needs-you",
    title: proposalTitle(label, proposal.category),
    body: proposalBody(proposal),
    options,
    dedupeKey,
  });
  await leadAudit({
    ...base,
    delivered: true,
    owner,
    itemId: posted.item.id,
    created: posted.created,
  });
  return {
    queued: true,
    itemId: posted.item.id,
    created: posted.created,
    delivery: posted.delivery,
  };
}

/** The day's note for the owner's digest: one fyi item per project and UTC
 *  day; a later note replaces the earlier one, and a note after that day's
 *  digest went out starts a new item, so nothing is lost. */
export async function postLeadDigestNote(
  project: string,
  doc: Pick<ProjectSettingsDocument, "lead" | "incidents">,
  text: string,
  now: number,
  label: string = project,
): Promise<LeadDelivery> {
  const refusal = leadReportRefusal(doc);
  if (refusal) return { queued: false, reason: refusal };
  const owner = leadOwner(doc);
  if (!owner) return { queued: false, reason: NOBODY };
  const day = new Date(now).toISOString().slice(0, 10);
  const base = `${leadSource(project)}:digest:${day}`;
  // Today's notes only, found by their key however full the inbox is.
  const open = await listSupervisorItems(owner, {
    kind: "fyi",
    state: "open",
    dedupeKeyPrefix: base,
    limit: 100,
  });
  let dedupeKey = base;
  for (let n = 2; n < 50; n++) {
    const existing = open.find((item) => item.dedupeKey === dedupeKey);
    if (!existing || existing.digestedAt === undefined) break;
    dedupeKey = `${base}:${n}`;
  }
  const posted = await postSupervisorItem({
    user: owner,
    source: leadSource(project),
    project,
    kind: "fyi",
    title: `${label}: what the lead saw today`,
    body: text,
    dedupeKey,
  });
  return {
    queued: true,
    itemId: posted.item.id,
    created: posted.created,
    delivery: posted.delivery,
  };
}
