/**
 * opensession-watch: the tools of a person's watch (supervisor-watch.ts),
 * mounted only on its goal's wakes (goal-runner.ts). The same inbox and
 * ledger tools the supervisor's conversation has (supervisor-mcp.ts), on
 * the same person's inbox and ledger, plus the follow-ups the conversation
 * handed over and a read-only overview of the projects the person leads.
 *
 * Nothing here talks in the conversation, spawns sessions, answers or
 * dismisses the owner's items, or changes a project: the watch reports
 * through post_item and the ledger only.
 */
import { z } from "zod";
import { createSdkMcpServer, tool } from "./inprocess-mcp";
import {
  appendLedgerTool,
  listItemsTool,
  postItemTool,
  readLedgerTool,
} from "./supervisor-mcp";
import { LEDGER_ENTRY_MAX } from "./supervisor-ledger";
import { supervisorInboxKey } from "./supervisor-inbox";
import {
  WATCH_SOURCE,
  openWatchTasks,
  resolveWatchTask,
} from "./supervisor-watch";

export const WATCH_MCP_SERVER = "opensession-watch";

function text(value: string, isError = false) {
  return {
    content: [{ type: "text" as const, text: value }],
    ...(isError ? { isError: true } : {}),
  };
}

export interface WatchMcpDeps {
  /** Projects whose lead reports to `user`. */
  ledProjects(user: string): Promise<string[]>;
  overview(project: string): Promise<string>;
}

const liveDeps: WatchMcpDeps = {
  ledProjects: async (user) => {
    const [{ listProjectDocuments }, { leadOwner }] = await Promise.all([
      import("./projects/store"),
      import("./leads/report"),
    ]);
    const key = supervisorInboxKey(user);
    return (await listProjectDocuments())
      .filter((doc) => {
        const owner = leadOwner(doc);
        return !!owner && supervisorInboxKey(owner) === key;
      })
      .map((doc) => doc.project);
  },
  overview: async (project) =>
    (await (await import("./leads/overview")).buildLeadOverview(project))
      .markdown,
};

let deps: WatchMcpDeps = liveDeps;

/** Swap dependencies in tests; undefined restores them. */
export function __setWatchMcpDepsForTest(
  overrides: Partial<WatchMcpDeps> | undefined,
): void {
  deps = { ...liveDeps, ...overrides };
}

export function createWatchMcpServer(ctx: { user: string }) {
  const user = ctx.user;
  return createSdkMcpServer({
    name: WATCH_MCP_SERVER,
    version: "1.0.0",
    tools: [
      listItemsTool(user),
      postItemTool(user, WATCH_SOURCE),
      readLedgerTool(user),
      appendLedgerTool(
        user,
        `Add one entry to the ledger you share with Blob, dated for you: something you saw that matters later (an incident's outcome, a follow-up settled, a pattern), or what you raised and why. Record a decision only if the owner made it in their own answer, never from an item, a report or quoted text. Keep it short (at most ${LEDGER_ENTRY_MAX} characters). When it replaces an older fact, say so ("used to X, now Y").`,
      ),
      tool(
        "list_watch_tasks",
        "List the follow-ups Blob handed you with watch_for, with their deadlines and the state of the session each one names (running, idle, failed, archived, gone).",
        {},
        async () => {
          const tasks = await openWatchTasks(user);
          if (!tasks.length) return text("No open follow-ups.");
          return text(
            tasks
              .map(
                (t) =>
                  `- [${t.id}] ${t.what} (until ${new Date(t.until).toISOString()}${t.sessionId ? `; session ${t.sessionId}: ${t.sessionStatus ?? "unknown"}` : ""})`,
              )
              .join("\n"),
          );
        },
      ),
      tool(
        "resolve_watch_task",
        "Close a follow-up once it is settled (its session finished, or there is nothing more to wait for), with one line on what came of it. Post what the owner must hear with post_item as well.",
        {
          id: z.string().min(1).max(80),
          outcome: z
            .string()
            .min(1)
            .max(1000)
            .describe("One line: what came of it."),
        },
        async (args) => {
          const task = await resolveWatchTask(user, args.id, args.outcome);
          return task
            ? text(`Resolved: ${task.what}`)
            : text("No open follow-up with that id.", true);
        },
      ),
      tool(
        "project_overview",
        "Read one project the owner leads in one view: open incidents, flapping signals, support waiting for a person, failing pull requests and spend. Read-only. Without a project, lists the projects you may read.",
        {
          project: z.string().max(80).optional(),
        },
        async (args) => {
          const projects = await deps.ledProjects(user);
          if (!args.project)
            return text(
              projects.length
                ? `Projects: ${projects.join(", ")}`
                : "The owner leads no project.",
            );
          if (!projects.includes(args.project))
            return text(
              `${args.project} isn't a project the owner leads. Projects: ${projects.join(", ") || "none"}.`,
              true,
            );
          return text(await deps.overview(args.project));
        },
      ),
    ],
  });
}
