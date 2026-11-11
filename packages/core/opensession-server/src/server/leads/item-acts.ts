// What a lead's item runs, as clients show it: the steps, condition and
// expiry of the proposal recorded for the item (approvals.ts), read from
// the record, never from the item's Markdown body, so the lead's prose can't
// pass for them. Clients draw it as their own section apart from the body.
//
// The body still ends with the same lines in text (report.ts `actLines`) for
// clients that don't read `act`. `bodySuffix` is exactly that ending, sent
// only when the body ends with it, so a client can take it off and show the
// section instead.
//
// One approvals read per project per request, and the signals only when a
// step patches one. Nothing runs at import.
import type { Signal } from "../../shared/incidents";
import type { SupervisorItem } from "../supervisor-inbox";
import {
  PROPOSAL_TTL_MS,
  listForProject,
  type LeadApprovalState,
  type LeadRecord,
} from "./approvals";
import { describeCondition, waitingCopy } from "./conditions";
import {
  LEAD_SOURCE_PREFIX,
  actLines,
  signalNamesOf,
  stepCopy,
} from "./report";

export type ItemActState = "proposed" | Exclude<LeadApprovalState, "void">;

export interface ItemAct {
  /** Each step in the fixed copy the body's Steps line uses. */
  steps: string[];
  /** What an approval waits for, in the fixed copy of the Runs when line. */
  runsWhen?: string;
  /** When the steps may no longer run, ms since the epoch. */
  expiresAt: number;
  /** `proposed` until the owner approves; then the approval's state. */
  state: ItemActState;
  /** The state as the owner reads it, once approved: "Ready to apply". */
  stateLine?: string;
  /** The server's lines the body ends with, blank lines before them
   *  included; absent when the body does not end with them. */
  bodySuffix?: string;
}

/** An item as `GET /api/supervisor/items` returns it. */
export type ShownSupervisorItem = SupervisorItem & {
  /** The revision an answer names to approve what it saw: `updatedAt`. */
  revision: number;
  act?: ItemAct;
};

export interface ItemActsDeps {
  listForProject(project: string): Promise<LeadRecord[]>;
  listSignals(): Promise<ReadonlyArray<Pick<Signal, "id" | "name">>>;
}

const defaultDeps: ItemActsDeps = {
  listForProject,
  async listSignals() {
    const { listSignals } = await import("../incidents/signal-store");
    return listSignals();
  },
};

/** The project of a lead's item, or null for any other item. */
function leadProject(item: SupervisorItem): string | null {
  if (item.kind !== "needs-you" || !item.source.startsWith(LEAD_SOURCE_PREFIX))
    return null;
  return item.source.slice(LEAD_SOURCE_PREFIX.length) || null;
}

/** The record that describes `item` as it is now: for an open item, the
 *  unapproved proposal recorded at its current revision; for a closed one,
 *  the newest approved proposal raised as it. Voided ones never count. */
export function recordForItem(
  item: SupervisorItem,
  records: readonly LeadRecord[],
): LeadRecord | undefined {
  // Newest first, so the first match is the latest proposal.
  const record = records.find((r) => r.proposal.itemId === item.id);
  if (!record || record.proposal.voidedAt !== undefined) return undefined;
  if (item.state === "open")
    return !record.approval && record.proposal.itemRevision === item.updatedAt
      ? record
      : undefined;
  return record.approval && record.approval.state !== "void"
    ? record
    : undefined;
}

function stateLine(record: LeadRecord): string | undefined {
  const approval = record.approval;
  if (!approval) return undefined;
  switch (approval.state) {
    case "waiting":
      return approval.condition
        ? waitingCopy(approval.condition)
        : "Waiting to apply";
    case "ready":
      return "Ready to apply";
    case "applying":
      return "Applying";
    case "applied":
      return "Applied";
    case "failed":
      return "Failed";
    case "partial":
      return "Partly applied";
    case "void":
      return undefined;
  }
}

/** The structured view of `record` for `item`. */
export function itemAct(
  item: SupervisorItem,
  record: LeadRecord,
  signalNames: Record<string, string>,
): ItemAct {
  const { proposal, approval } = record;
  const proposedExpiry =
    proposal.expiresAt ?? proposal.createdAt + PROPOSAL_TTL_MS;
  const condition = approval?.condition ?? proposal.condition;
  const act: ItemAct = {
    steps: proposal.steps.map((step) => stepCopy(step, signalNames)),
    ...(condition ? { runsWhen: describeCondition(condition) } : {}),
    expiresAt: approval?.expiresAt ?? proposedExpiry,
    state: approval && approval.state !== "void" ? approval.state : "proposed",
  };
  const line = stateLine(record);
  if (line) act.stateLine = line;
  // The lines exactly as the body was written with them (report.ts).
  const suffix = `\n\n${actLines({
    steps: proposal.steps,
    ...(proposal.condition ? { condition: proposal.condition } : {}),
    expiresAt: proposedExpiry,
    signalNames,
  })}`;
  if (item.body.endsWith(suffix)) act.bodySuffix = suffix;
  return act;
}

/** `items` with their revision, and the `act` of every lead item with a
 *  standing recorded proposal. A project whose records can't be read
 *  leaves its items without `act`: their bodies still carry the lines. */
export async function withItemActs(
  items: readonly SupervisorItem[],
  deps: ItemActsDeps = defaultDeps,
): Promise<ShownSupervisorItem[]> {
  const projects = new Set<string>();
  for (const item of items) {
    const project = leadProject(item);
    if (project) projects.add(project);
  }
  const recordsByProject = new Map<string, readonly LeadRecord[]>();
  await Promise.all(
    [...projects].map(async (project) => {
      try {
        recordsByProject.set(project, await deps.listForProject(project));
      } catch (error) {
        console.warn(
          `[leads] ${project}: could not read the recorded proposals:`,
          error instanceof Error ? error.message : error,
        );
      }
    }),
  );
  const matched = new Map<string, LeadRecord>();
  for (const item of items) {
    const project = leadProject(item);
    const records = project ? recordsByProject.get(project) : undefined;
    const record = records && recordForItem(item, records);
    if (record) matched.set(item.id, record);
  }
  let signalNames: Record<string, string> = {};
  if (
    [...matched.values()].some((r) =>
      r.proposal.steps.some((s) => s.kind === "signal-patch"),
    )
  ) {
    try {
      signalNames = signalNamesOf(await deps.listSignals());
    } catch (error) {
      console.warn(
        "[leads] could not read the signals for the steps:",
        error instanceof Error ? error.message : error,
      );
    }
  }
  return items.map((item) => {
    const record = matched.get(item.id);
    return {
      ...item,
      revision: item.updatedAt,
      ...(record ? { act: itemAct(item, record, signalNames) } : {}),
    };
  });
}
