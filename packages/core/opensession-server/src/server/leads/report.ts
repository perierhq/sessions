// Where a lead's proposals go. Phase 1 records each one in the audit log
// and reports it queued; nothing reaches the owner yet.
// TODO(phase 2): deliver to the supervisor inbox (adrs/supervisor-and-leads.md
// section 5), which decides what reaches the owner and how loudly.
import type { LeadCategory, LeadDecision } from "../../shared/project-lead";
import { auditDurable, digest } from "../audit";

/** `proposal`: something the lead suggests; `needs-you`: something only the
 *  owner may do, prepared by the lead. */
export const LEAD_PROPOSAL_KINDS = ["proposal", "needs-you"] as const;
export type LeadProposalKind = (typeof LEAD_PROPOSAL_KINDS)[number];

export interface LeadProposal {
  kind: LeadProposalKind;
  category: LeadCategory;
  title: string;
  body: string;
  options: string[];
  /** The rules' verdict on the action, with the rule that made it. */
  decision: LeadDecision;
}

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

/** Hand a proposal on. Its body may quote customers, so the audit keeps a
 *  digest of it, never the text. */
export async function deliverLeadProposal(
  project: string,
  proposal: LeadProposal,
): Promise<{ queued: true }> {
  await leadAudit({
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
  });
  return { queued: true };
}
