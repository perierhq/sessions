/**
 * opensession-supervisor: the supervisor's own hands on its inbox
 * (supervisor-inbox.ts). Mounted only on a supervisor session
 * (`session.supervisor`), next to the interactive set, the way a goal session
 * gets opensession-goal-self: read the items leads raised, record the
 * owner's answer when they give it in conversation, dismiss what no longer
 * matters, and raise a decision of its own to the owner.
 *
 * Every tool acts on the inbox of the session's owner (its creator), never on
 * anyone else's, and is mounted only for a turn that owner drives
 * (`supervisorInboxOwner`). `ask_pat` hands GitHub work to the instance
 * persona through the GitHub agent's existing entry point
 * (supervisor-ask-pat.ts) on the owner's behalf. `read_ledger` and
 * `append_ledger` are its memory across conversations (supervisor-ledger.ts).
 */
import { z } from "zod";
import { personaName } from "./config";
import { ASK_PAT_ACTIONS, askPat } from "./supervisor-ask-pat";
import { createSdkMcpServer, tool } from "./inprocess-mcp";
import { humanPrompter, sessionCreationOwner } from "./session-actors";
import {
  appendSupervisorLedger,
  LEDGER_ENTRY_MAX,
  LEDGER_READ_BYTES,
  readSupervisorLedgerTail,
} from "./supervisor-ledger";
import {
  answerSupervisorItem,
  dismissSupervisorItem,
  listSupervisorItems,
  MAX_LIST,
  postSupervisorItem,
  supervisorInboxKey,
  type CloseResult,
  type SupervisorItem,
} from "./supervisor-inbox";

export const SUPERVISOR_MCP_SERVER = "opensession-supervisor";

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

function format(item: SupervisorItem): string {
  const meta = [
    item.kind,
    item.state,
    item.urgency === "down" ? "down" : "",
    item.project ?? "",
    item.source,
    item.heldUntil !== undefined && item.state === "open"
      ? "held for quiet hours"
      : "",
  ]
    .filter(Boolean)
    .join(", ");
  const lines = [`- [${item.id}] ${item.title} (${meta})`];
  if (item.options?.length)
    lines.push(
      `  Options: ${item.options.map((o, i) => `${i + 1}. ${o}`).join("  ")}`,
    );
  if (item.answer)
    lines.push(
      `  Answer: ${item.answer}${item.answeredBy === "supervisor" ? " (recorded by you)" : ""}`,
    );
  return lines.join("\n");
}

function closed(result: CloseResult, verb: string): string {
  if (result.ok) return `${verb}: ${format(result.item)}`;
  if (result.error === "not-found") return "No item with that id.";
  if (result.error === "closed") return "That item is already closed.";
  return "The answer is empty.";
}

export function createSupervisorMcpServer(ctx: { user: string }) {
  const user = ctx.user;
  return createSdkMcpServer({
    name: SUPERVISOR_MCP_SERVER,
    version: "1.0.0",
    tools: [
      tool(
        "list_items",
        "List the owner's supervisor inbox: decisions leads raised (needs-you) and what ran alone (fyi). Newest first.",
        {
          state: z
            .enum(["open", "answered", "dismissed", "expired"])
            .optional()
            .describe("Only items in this state. Default: open."),
          kind: z.enum(["needs-you", "fyi"]).optional(),
          limit: z.number().int().min(1).max(MAX_LIST).optional(),
        },
        async (args) => {
          const items = await listSupervisorItems(user, {
            state: args.state ?? "open",
            kind: args.kind,
            limit: args.limit ?? 20,
          });
          return text(
            items.length ? items.map(format).join("\n") : "Nothing here.",
          );
        },
      ),
      tool(
        "answer_item",
        "Record the owner's answer to an inbox item, when they gave it to you in this conversation. Use the option's text or its number. The lead that raised it is told.",
        {
          id: z.string().max(80),
          answer: z.string().min(1).max(2000),
        },
        async (args) =>
          text(
            closed(
              await answerSupervisorItem(
                user,
                args.id,
                args.answer,
                "supervisor",
              ),
              "Answered",
            ),
          ),
      ),
      tool(
        "dismiss_item",
        "Dismiss an inbox item that no longer needs the owner.",
        { id: z.string().max(80) },
        async (args) =>
          text(closed(await dismissSupervisorItem(user, args.id), "Dismissed")),
      ),
      tool(
        "post_item",
        "Raise something to the owner. kind needs-you pushes their phone (held during their quiet hours unless urgency is down); fyi waits for the daily digest. Use needs-you only for a decision only they can make: two short lines and the options, recommended option first. The same dedupe_key updates an open item instead of adding another.",
        {
          kind: z.enum(["needs-you", "fyi"]),
          title: z.string().min(1).max(120).describe("One short line."),
          body: z
            .string()
            .max(4000)
            .optional()
            .describe("Markdown; may use the blocks of docs/blocks.md."),
          options: z.array(z.string().min(1).max(120)).max(6).optional(),
          project: z.string().max(80).optional(),
          dedupe_key: z.string().max(200).optional(),
          urgency: z
            .enum(["normal", "down"])
            .optional()
            .describe("down: something is fully down. Ignores quiet hours."),
        },
        async (args) => {
          const { item, created, delivery } = await postSupervisorItem({
            user,
            source: "supervisor",
            kind: args.kind,
            title: args.title,
            body: args.body,
            options: args.options,
            project: args.project,
            dedupeKey: args.dedupe_key,
            urgency: args.urgency,
          });
          return text(
            `${created ? "Posted" : "Updated"} (${delivery}): ${format(item)}`,
          );
        },
      ),
      tool(
        "read_ledger",
        "Read your ledger: the decisions the owner made, their standing preferences and the open threads, kept across conversations. Newest last; long ledgers return the latest entries.",
        {},
        async () => {
          const ledger = await readSupervisorLedgerTail(
            user,
            LEDGER_READ_BYTES,
          );
          if (!ledger.text) return text("The ledger is empty.");
          return text(
            ledger.truncated
              ? `(Older entries left out.)\n\n${ledger.text}`
              : ledger.text,
          );
        },
      ),
      tool(
        "append_ledger",
        `Add one entry to your ledger, dated for you: a decision the owner made, a standing preference, or a thread still open. Keep it short (at most ${LEDGER_ENTRY_MAX} characters). When it replaces an older fact, say so ("used to X, now Y").`,
        {
          text: z
            .string()
            .min(1)
            .max(LEDGER_ENTRY_MAX)
            .describe("The entry, in markdown."),
        },
        async (args) => {
          const result = await appendSupervisorLedger(user, args.text);
          if (result.ok) return text(`Added:\n${result.entry}`);
          return {
            ...text(
              result.error === "empty"
                ? "Nothing to add."
                : `Too long: keep it under ${LEDGER_ENTRY_MAX} characters.`,
            ),
            isError: true,
          };
        },
      ),
      tool(
        "ask_pat",
        `Hand GitHub work on a pull request to ${personaName()}, the public worker, through the existing flows: review_pr runs the PR review, fix_ci runs the auto-fix loop starting with the failing checks, auto_fix runs the full auto-fix loop (os-auto-fix). ${personaName()} posts the results on the PR. Takes no text: nothing you write goes to GitHub. Tell the owner you asked ${personaName()}.`,
        {
          action: z.enum(ASK_PAT_ACTIONS),
          repo: z
            .string()
            .min(1)
            .max(200)
            .describe("A registered repository: its id or GitHub owner/name."),
          pr: z.number().int().positive().describe("The PR number."),
        },
        async (args) => {
          const result = await askPat({
            owner: user,
            action: args.action,
            repo: args.repo,
            pr: args.pr,
          });
          return {
            ...text(result.message),
            ...(result.ok ? {} : { isError: true }),
          };
        },
      ),
    ],
  });
}

type SupervisorSessionShape = {
  supervisor?: boolean;
  createdBy?: string | null;
  startedBy?: string | null;
  lastPromptedBy?: string | null;
};

/**
 * The owner whose inbox a supervisor session's turn may touch: its creator,
 * and only while the person driving the turn is that creator (the same
 * person `sessionNotePerson` resolves for the Desk briefing). A teammate
 * typing into someone's supervisor session gets neither the inbox tools nor
 * the briefing. Undefined for any other session.
 */
export function supervisorInboxOwner(
  session: SupervisorSessionShape | null | undefined,
  turnUser: string | null | undefined,
): string | undefined {
  const owner = session?.createdBy?.trim();
  if (!session?.supervisor || !owner) return undefined;
  const person = humanPrompter(sessionCreationOwner(turnUser ?? "", session));
  if (!person || supervisorInboxKey(person) !== supervisorInboxKey(owner))
    return undefined;
  return owner;
}

/** The server for a supervisor session's turn by its owner; nothing for any
 *  other session or person. */
export function supervisorMcpFor(
  session: SupervisorSessionShape | null | undefined,
  turnUser: string | null | undefined,
): Record<string, ReturnType<typeof createSupervisorMcpServer>> {
  const user = supervisorInboxOwner(session, turnUser);
  if (!user) return {};
  return { [SUPERVISOR_MCP_SERVER]: createSupervisorMcpServer({ user }) };
}
