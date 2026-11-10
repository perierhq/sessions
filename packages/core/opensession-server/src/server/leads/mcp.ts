// opensession-lead: a project lead's own tools, bound to one project and
// mounted on its goal (goal-runner.ts). Two read-only views (the project
// overview and the flap triage), `propose`, which checks the project's lead
// rules before raising a proposal in the owner's supervisor inbox, and
// `post_digest_note`, the day's note for the owner's digest. None of them
// changes the project.
import { z } from "zod";
import {
  LEAD_CATEGORIES,
  LEAD_CATEGORY_LABELS,
  leadDecision,
} from "../../shared/project-lead";
import { createSdkMcpServer, tool } from "../inprocess-mcp";
import { flapReportMarkdown } from "./flaps";
import { buildFlapReport, buildLeadOverview, leadSources } from "./overview";
import {
  LEAD_PROPOSAL_KINDS,
  type LeadDelivery,
  deliverLeadProposal,
  postLeadDigestNote,
} from "./report";

function text(s: string, isError = false) {
  return {
    content: [{ type: "text" as const, text: s }],
    ...(isError ? { isError: true } : {}),
  };
}

const FORMAT = z
  .enum(["markdown", "json"])
  .optional()
  .describe("markdown (default) or json");

export function createLeadMcpServer(project: string) {
  const tools = [
    tool(
      "project_overview",
      `Read ${project} in one view: open incidents, which signals flap and the rule change each needs, support conversations waiting for a person, each inbox's autonomy, open pull requests with failing checks, and this month's spend. Read-only.`,
      { format: FORMAT },
      async (args: { format?: "markdown" | "json" }) => {
        const { json, markdown } = await buildLeadOverview(project);
        return text(
          args.format === "json" ? JSON.stringify(json, null, 2) : markdown,
        );
      },
    ),
    tool(
      "flap_report",
      `Tell flaps from outages for ${project}'s signals: per signal, incidents opened, closed by themselves within N minutes, fixed, open times, and a concrete signal rule change for each one that only flaps. Read-only; propose a change with propose (category signal-rule-change).`,
      {
        windowDays: z
          .number()
          .int()
          .min(1)
          .max(90)
          .optional()
          .describe("Days to look back; default 14."),
        selfCloseMinutes: z
          .number()
          .int()
          .min(1)
          .max(240)
          .optional()
          .describe(
            "An incident that closed by itself within this many minutes is a flap; default 30.",
          ),
        format: FORMAT,
      },
      async (args: {
        windowDays?: number;
        selfCloseMinutes?: number;
        format?: "markdown" | "json";
      }) => {
        const report = await buildFlapReport(project, args);
        return text(
          args.format === "json"
            ? JSON.stringify(report, null, 2)
            : flapReportMarkdown(report),
        );
      },
    ),
    tool(
      "propose",
      `Propose an action for ${project} to its owner. The project's lead rules decide what the action needs; anything only the owner may do (refunds, pricing, disputes, tax and legal, contracts, writes to production data, and whatever the project keeps for the owner) is refused unless kind is needs-you: prepare it and ask the owner.`,
      {
        category: z
          .enum(LEAD_CATEGORIES)
          .describe("What kind of action this is."),
        title: z.string().min(1).max(200).describe("One line."),
        body: z
          .string()
          .min(1)
          .max(4000)
          .describe("What you found, what you propose and why, with numbers."),
        options: z
          .array(z.string().min(1).max(120))
          .max(5)
          .optional()
          .describe(
            "Choices for the owner, the one you recommend first. Default: Approve, Not now.",
          ),
        subject: z
          .string()
          .min(1)
          .max(120)
          .optional()
          .describe(
            "What this is about, stable across wakes (e.g. 'sig-status consecutive.failures', 'PR 42'); a repeat about the same subject updates the owner's item instead of adding one. Default: the title.",
          ),
        kind: z
          .enum(LEAD_PROPOSAL_KINDS)
          .optional()
          .describe(
            "proposal (default), or needs-you for something only the owner may do, prepared by you.",
          ),
      },
      async (args: {
        category: (typeof LEAD_CATEGORIES)[number];
        title: string;
        body: string;
        options?: string[];
        subject?: string;
        kind?: (typeof LEAD_PROPOSAL_KINDS)[number];
      }) => {
        const doc = await leadSources().projectDocument(project);
        const decision = leadDecision(
          { ...doc.lead, agentsPaused: doc.incidents.agentsPaused },
          args.category,
        );
        const kind = args.kind ?? "proposal";
        if (decision.effective === "prepare" && kind !== "needs-you")
          return text(
            `Only the owner decides ${LEAD_CATEGORY_LABELS[args.category].toLowerCase()} (${decision.rule}). Prepare it and ask the owner: call propose again with kind needs-you and what you prepared.`,
            true,
          );
        const delivered = await deliverLeadProposal(project, doc, {
          kind,
          category: args.category,
          title: args.title.trim(),
          body: args.body.trim(),
          options: (args.options ?? []).map((o) => o.trim()).filter(Boolean),
          ...(args.subject?.trim() ? { subject: args.subject.trim() } : {}),
          decision,
        });
        if (!delivered.queued) return text(delivered.reason, true);
        return text(
          `${delivered.created ? "Queued" : "Updated"} for the owner as ${kind === "needs-you" ? "needs you" : "a proposal"} (${delivered.itemId}). Rule: ${decision.rule}.`,
        );
      },
    ),
    tool(
      "post_digest_note",
      `Write today's note on ${project} for the owner's daily digest: what you saw, what you proposed, what is waiting. A later note today replaces this one, so include everything. Nobody is pushed for it.`,
      { text: z.string().min(1).max(4000).describe("Markdown, short.") },
      async (args: { text: string }) => {
        const sources = leadSources();
        const doc = await sources.projectDocument(project);
        const delivered: LeadDelivery = await postLeadDigestNote(
          project,
          doc,
          args.text.trim(),
          sources.now(),
        );
        if (!delivered.queued) return text(delivered.reason, true);
        return text(`Saved for today's digest (${delivered.itemId}).`);
      },
    ),
  ];
  return createSdkMcpServer({
    name: "opensession-lead",
    version: "1.0.0",
    tools,
  });
}
