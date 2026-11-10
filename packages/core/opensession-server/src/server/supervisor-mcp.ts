/**
 * opensession-supervisor: the supervisor's own hands on its inbox
 * (supervisor-inbox.ts). Mounted only on a supervisor session
 * (`session.supervisor`), next to the interactive set, the way a goal session
 * gets opensession-goal-self: read the items leads raised, record the
 * owner's answer when they give it in conversation, dismiss what no longer
 * matters, and raise a decision of its own to the owner.
 *
 * Every tool acts on the inbox of the session's owner (its creator), never on
 * anyone else's.
 */
import { z } from "zod";
import { createSdkMcpServer, tool } from "./inprocess-mcp";
import {
  answerSupervisorItem,
  dismissSupervisorItem,
  listSupervisorItems,
  MAX_LIST,
  postSupervisorItem,
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
  if (item.answer) lines.push(`  Answer: ${item.answer}`);
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
              await answerSupervisorItem(user, args.id, args.answer),
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
    ],
  });
}

/** The server for a supervisor session; nothing for any other session. */
export function supervisorMcpFor(
  session:
    | { supervisor?: boolean; createdBy?: string | null }
    | null
    | undefined,
): Record<string, ReturnType<typeof createSupervisorMcpServer>> {
  const user = session?.createdBy?.trim();
  if (!session?.supervisor || !user) return {};
  return { [SUPERVISOR_MCP_SERVER]: createSupervisorMcpServer({ user }) };
}
