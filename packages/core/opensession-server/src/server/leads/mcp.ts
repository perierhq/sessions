// opensession-lead: a project lead's own tools, bound to one project and
// mounted on its goal (goal-runner.ts). Two read-only views (the project
// overview and the flap triage), `propose`, which checks the project's lead
// rules before raising a proposal in the owner's supervisor inbox (with
// optional typed steps the server records for the owner's approval),
// `post_digest_note`, the day's note for the owner's digest, and
// `lead_apply`, which runs a recorded proposal's steps when the lead rules
// or the owner's approval allow it (apply.ts). Only lead_apply changes the
// project; it and the two that report refuse while the lead is off or the
// project's kill switch is on.
import { z } from "zod";
import {
  LEAD_CATEGORIES,
  LEAD_CATEGORY_LABELS,
  leadDecision,
} from "../../shared/project-lead";
import { createSdkMcpServer, tool } from "../inprocess-mcp";
import { leadApply } from "./apply";
import { flapReportMarkdown } from "./flaps";
import { buildFlapReport, buildLeadOverview, leadSources } from "./overview";
import {
  DEFAULT_EXPIRES_IN_DAYS,
  LEAD_PROPOSAL_KINDS,
  MAX_EXPIRES_IN_DAYS,
  type LeadAct,
  type LeadDelivery,
  checkLeadAct,
  deliverLeadProposal,
  leadReportRefusal,
  postLeadDigestNote,
} from "./report";

function text(s: string, isError = false) {
  return {
    content: [{ type: "text" as const, text: s }],
    ...(isError ? { isError: true } : {}),
  };
}

const GH_REPO = z
  .string()
  .describe("owner/name, one of this project's repositories");
const PR_NUMBER = z.number().int().positive();
const HEAD_SHA = z
  .string()
  .describe("The PR's full 40-character head commit, as you saw it");
const PATCH = z.object({
  rule: z.record(z.string(), z.unknown()).optional(),
  provider: z.boolean().nullable().optional(),
  dependsOn: z.array(z.string()).nullable().optional(),
});

const STEP = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("merge-pr"),
    ghRepo: GH_REPO,
    number: PR_NUMBER,
    headSha: HEAD_SHA,
    method: z.enum(["merge", "squash", "rebase"]).optional(),
  }),
  z.object({
    kind: z.literal("autofix-pr"),
    ghRepo: GH_REPO,
    number: PR_NUMBER,
    headSha: HEAD_SHA,
  }),
  z.object({
    kind: z.literal("spawn-worker"),
    prompt: z.string().describe("The worker's whole task, shown to the owner"),
  }),
  z.object({
    kind: z.literal("signal-patch"),
    signalId: z.string(),
    before: PATCH.describe(
      "The signal's current values of exactly the fields `after` changes; null for an unset provider or dependsOn",
    ),
    after: PATCH.describe(
      "The change, as flap_report proposes it (rule, provider, dependsOn)",
    ),
  }),
  z.object({
    kind: z.literal("support-send"),
    conversationId: z.string(),
    draftId: z.string(),
  }),
]);

const CONDITION = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("pr-merged"),
    ghRepo: GH_REPO,
    number: PR_NUMBER,
  }),
  z.object({
    kind: z.literal("checks-green"),
    ghRepo: GH_REPO,
    number: PR_NUMBER,
    headSha: HEAD_SHA,
  }),
  z.object({ kind: z.literal("incident-resolved"), id: z.string() }),
]);

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
      `Propose an action for ${project} to its owner. Write the body as Blob presents it: a leading \`\`\`say fence is spoken, the rest is shown, in the owner's report style. The project's lead rules decide what the action needs; anything only the owner may do (refunds, pricing, disputes, tax and legal, contracts, writes to production data, and whatever the project keeps for the owner) is refused unless kind is needs-you: prepare it and ask the owner. To have the approval run something, give steps (and optionally a condition and expiresInDays): the server checks them, records them for the owner's answer and adds the lines saying when they run, each step and when they expire; leave those lines out of the title and body, close every code fence and comment, and keep raw HTML out (Markdown only, or HTML in backticks). Steps fit their category: merge-pr for fix-verified, public-release or ci-repair; autofix-pr for ci-repair; spawn-worker for fix-verified or ci-repair; signal-patch for signal-rule-change; support-send for support-routine-reply. Pull requests must be in this project's repositories.`,
      {
        category: z
          .enum(LEAD_CATEGORIES)
          .describe("What kind of action this is."),
        title: z
          .string()
          .min(1)
          .max(200)
          .describe(
            "One line. It heads your text; the owner's item is titled with the project and the category.",
          ),
        body: z
          .string()
          .min(1)
          .max(4000)
          .describe(
            "Two parts. A ```say fence first: what Blob says aloud when it presents the decision, one to three spoken sentences with the bottom line or the ask, no numbers, lists or tables. After it, shown only: what you found, what you propose and why, with numbers, in the owner's report style (your charter).",
          ),
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
        steps: z
          .array(STEP)
          .min(1)
          .max(10)
          .optional()
          .describe(
            "What the owner's approval runs, in order. Without steps, approving runs nothing.",
          ),
        condition: CONDITION.optional().describe(
          "With steps: what must hold before they run (a PR merged, checks green at a head, an incident resolved).",
        ),
        expiresInDays: z
          .number()
          .int()
          .min(1)
          .max(MAX_EXPIRES_IN_DAYS)
          .optional()
          .describe(
            `With steps: days until they may no longer run, default ${DEFAULT_EXPIRES_IN_DAYS}.`,
          ),
      },
      async (args: {
        category: (typeof LEAD_CATEGORIES)[number];
        title: string;
        body: string;
        options?: string[];
        subject?: string;
        kind?: (typeof LEAD_PROPOSAL_KINDS)[number];
        steps?: unknown[];
        condition?: unknown;
        expiresInDays?: number;
      }) => {
        const sources = leadSources();
        const doc = await sources.projectDocument(project);
        const refusal = leadReportRefusal(doc);
        if (refusal) return text(refusal, true);
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
        if (!args.steps && (args.condition || args.expiresInDays))
          return text(
            "A condition or expiresInDays needs steps: give the steps the approval runs.",
            true,
          );
        let act: LeadAct | undefined;
        if (args.steps) {
          const checked = checkLeadAct(
            {
              category: args.category,
              steps: args.steps,
              condition: args.condition,
              expiresInDays: args.expiresInDays,
            },
            {
              project,
              now: sources.now(),
              repos: sources.projectGhRepos(project),
              signals: await sources.listSignals(),
            },
          );
          if (!checked.ok) return text(checked.error, true);
          act = checked.value;
        }
        const delivered = await deliverLeadProposal(
          project,
          doc,
          {
            kind,
            category: args.category,
            title: args.title.trim(),
            body: args.body.trim(),
            options: (args.options ?? []).map((o) => o.trim()).filter(Boolean),
            ...(args.subject?.trim() ? { subject: args.subject.trim() } : {}),
            decision,
            ...(act ? { act } : {}),
          },
          sources.projectLabel(project),
        );
        if (!delivered.queued) return text(delivered.reason, true);
        return text(
          `${delivered.created ? "Queued" : "Updated"} for the owner as ${kind === "needs-you" ? "needs you" : "a proposal"} (${delivered.itemId}). Rule: ${decision.rule}.${delivered.proposalId ? ` Steps recorded (${delivered.proposalId}).` : ""}`,
        );
      },
    ),
    tool(
      "post_digest_note",
      `Write today's note on ${project} for the owner's daily digest: what you saw, what you proposed, what is waiting. A later note today replaces this one, so include everything. Nobody is pushed for it.`,
      {
        text: z
          .string()
          .min(1)
          .max(4000)
          .describe(
            "Markdown, short. A ```say fence first: what Blob says aloud, one to three spoken sentences, no numbers, lists or tables. After it, shown only: the detail.",
          ),
      },
      async (args: { text: string }) => {
        const sources = leadSources();
        const doc = await sources.projectDocument(project);
        const delivered: LeadDelivery = await postLeadDigestNote(
          project,
          doc,
          args.text.trim(),
          sources.now(),
          sources.projectLabel(project),
        );
        if (!delivered.queued) return text(delivered.reason, true);
        return text(`Saved for today's digest (${delivered.itemId}).`);
      },
    ),
    tool(
      "lead_apply",
      `Run the steps recorded for one of ${project}'s proposals (propose returns its id), when the lead rules or the owner's approval allow it now. The server checks the rules, the approval, its expiry and its condition every time, runs the steps it recorded in order (merging a pull request as the GitHub App at the approved head; changing a signal only while it still has the proposed before values), stops at the first failure and tells the owner either way. A proposal runs at most once: whatever happens, never call it again for the same id; propose again instead.`,
      {
        proposalId: z
          .string()
          .min(1)
          .max(128)
          .describe("The id propose returned with the recorded steps."),
      },
      async (args: { proposalId: string }) => {
        const result = await leadApply(project, args.proposalId.trim());
        return text(result.text, !result.ok);
      },
    ),
  ];
  return createSdkMcpServer({
    name: "opensession-lead",
    version: "1.0.0",
    tools,
  });
}
