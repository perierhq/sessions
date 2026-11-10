// Where a lead's proposals and digest notes go: the supervisor inbox of the
// person the lead answers to (adrs/supervisor-and-leads.md, section 5). A
// proposal is a needs-you item with numbered options, the first one
// recommended; a digest note is one fyi item per day. Repeats about the
// same subject update one item instead of adding another. Every proposal
// is audited with the rule that decided it.
import type { LeadCategory, LeadDecision } from "../../shared/project-lead";
import type { ProjectSettingsDocument } from "../../shared/project-settings";
import { auditDurable, digest } from "../audit";
import { instanceOwner, personOwner } from "../incidents/owner";
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

export async function leadAudit(event: Record<string, unknown>): Promise<void> {
  await (sink ?? auditDurable)(event);
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

/** Hand a proposal to the owner's supervisor inbox. Its body may quote
 *  customers, so the audit keeps a digest of it, never the text. */
export async function deliverLeadProposal(
  project: string,
  doc: Pick<ProjectSettingsDocument, "lead">,
  proposal: LeadProposal,
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
    title: proposal.title.slice(0, 200),
    bodyDigest: digest(proposal.body),
    options: proposal.options.length,
    dedupeKey,
  };
  if (!owner) {
    await leadAudit({ ...base, delivered: false });
    return {
      queued: false,
      reason:
        "Nobody to report to: set the lead's owner in the project settings",
    };
  }
  const options = proposal.options.length
    ? proposal.options
    : DEFAULT_OPTIONS[proposal.kind];
  const posted = await postSupervisorItem({
    user: owner,
    source: leadSource(project),
    project,
    kind: "needs-you",
    title: proposal.title,
    body: `${proposal.body}\n\nRule: ${proposal.decision.rule}.`,
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
  doc: Pick<ProjectSettingsDocument, "lead">,
  text: string,
  now: number,
): Promise<LeadDelivery> {
  const owner = leadOwner(doc);
  if (!owner)
    return {
      queued: false,
      reason:
        "Nobody to report to: set the lead's owner in the project settings",
    };
  const day = new Date(now).toISOString().slice(0, 10);
  const base = `${leadSource(project)}:digest:${day}`;
  const open = await listSupervisorItems(owner, {
    kind: "fyi",
    state: "open",
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
    title: `${project}: what the lead saw today`,
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
