// What people do to a conversation besides replying: move it to another
// project, set its owner, close or reopen it, and take it out of spam; and
// what Sessions closes on its own (a conversation quiet for 7 days).
//
// A move re-runs the conversation in the target project: the old support
// session is cancelled and a new one starts there through routing's
// startSupportSession, so the target's Support settings (model, connectors,
// where it runs) apply and nothing carries over from the source. Only a
// person moves a conversation; the agent has no move tool. The owner is a person
// on the roster, resolved as incidents resolve theirs (incidents/owner.ts).
// Nothing runs at import.

import {
  type SupportActor,
  type SupportConversation,
  WAITING_CLOSE_MS,
} from "../../shared/support";

const SESSIONS_ACTOR: SupportActor = { kind: "sessions" };
import { resolveOwner } from "../incidents/owner";
import { type SessionControl, getSessionControl } from "../session-control";
import { channelAdapterFor } from "./channel";
import { getInbox, projectExists } from "./inboxes";
import { discardDraft, stopVeto } from "./reply";
import { startSupportSession } from "./routing";
import { getConversation, listIndexRows, updateConversation } from "./store";

export const MOVE_LOCKED = "Only a person can move this conversation";
const MAX_REASON = 500;

export interface ActionDeps {
  cancelSession: SessionControl["cancelSession"];
  now: () => number;
}

let override: Partial<ActionDeps> | undefined;

/** Replace the actions' collaborators (tests); undefined restores them. */
export function __setActionDepsForTest(deps?: Partial<ActionDeps>): void {
  override = deps;
}

function deps(): ActionDeps {
  return {
    // Registered by opensession.ts at boot.
    cancelSession:
      override?.cancelSession ??
      ((id, opts) => getSessionControl().cancelSession(id, opts)),
    now: override?.now ?? Date.now,
  };
}

const iso = () => new Date(deps().now()).toISOString();

function actorName(actor: SupportActor): string {
  if (actor.kind === "person") return actor.name;
  if (actor.kind === "agent") return "The support agent";
  return "Sessions";
}

function event(
  kind: string,
  actor: SupportActor,
  detail: string,
): SupportConversation["events"][number] {
  return { at: iso(), kind, actor, detail };
}

/** Cancels a support session's run; a session that is gone or not running
 *  here is fine. */
async function cancel(sessionId: string): Promise<void> {
  try {
    await deps().cancelSession(sessionId);
  } catch (error) {
    console.warn(
      `[support] couldn't cancel ${sessionId}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

/** Starts a session; a failure is an event on the conversation, so the
 *  conversation waits for a person. */
async function startOrRecord(
  c: SupportConversation,
  why: "moved" | "person",
): Promise<void> {
  try {
    await startSupportSession(c, why);
  } catch (error) {
    console.warn(
      `[support] support agent for ${c.id} didn't start:`,
      error instanceof Error ? error.message : error,
    );
    await updateConversation(c.id, (x) => ({
      ...x,
      events: [
        ...x.events,
        event(
          "agent-cant-start",
          { kind: "sessions" },
          "Support agent can't start: the session couldn't be created",
        ),
      ],
    }));
  }
}

/** Moves conversation `id` to project `to` and starts its agent there. */
export async function moveConversation(
  id: string,
  to: string,
  by: SupportActor,
  reason: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const c = await getConversation(id);
  if (!c) return { ok: false, error: "Conversation not found" };
  const target = to.trim();
  const why = reason.replace(/\s+/g, " ").trim().slice(0, MAX_REASON);
  if (!why) return { ok: false, error: "Say why it moves" };
  if (!projectExists(target))
    return { ok: false, error: `There is no project called ${target}` };
  if (target === c.project)
    return { ok: false, error: `The conversation is already in ${target}` };
  if (by.kind !== "person") return { ok: false, error: MOVE_LOCKED };

  const at = iso();
  let previous: string | null = null;
  const moved = await updateConversation(id, (x) => {
    previous = x.sessionId;
    return {
      ...x,
      project: target,
      sessionId: null,
      moves: [...x.moves, { at, from: x.project, to: target, by, reason: why }],
      events: [
        ...x.events,
        event(
          "moved",
          by,
          `${actorName(by)} moved this from ${x.project} to ${target}: ${why}`,
        ),
      ],
    };
  });
  if (!moved) return { ok: false, error: "Conversation not found" };
  // After the move is stored: the agent moving its own conversation is
  // the run being cancelled.
  if (previous) await cancel(previous);
  // A closed or spam conversation moves without an agent.
  if (moved.status === "open" || moved.status === "waiting")
    await startOrRecord(moved, "moved");
  return { ok: true };
}

/** Sets the owner to a person on the roster. */
export async function setOwner(
  id: string,
  owner: string,
  by: string,
): Promise<{ ok: boolean; error?: string }> {
  const resolved = resolveOwner(owner);
  if (typeof resolved !== "string") return { ok: false, error: resolved.error };
  const actor: SupportActor = { kind: "person", name: by };
  const stored = await updateConversation(id, (c) =>
    c.owner === resolved
      ? null
      : {
          ...c,
          owner: resolved,
          events: [
            ...c.events,
            event("owner", actor, `${by} made ${resolved} the owner`),
          ],
        },
  );
  if (!stored) return { ok: false, error: "Conversation not found" };
  return { ok: true };
}

/** After a close nothing goes out on its own: the support session's run
 *  stops (the session stays, so a reopen or a reply can resume it), an
 *  open veto window waits for a person, and a send waiting for its retry
 *  is dropped. The agent's later drafts wait for a person anyway (policy:
 *  closed). A person's fix session is theirs and keeps running. */
async function stopSending(
  c: SupportConversation,
  by: SupportActor,
): Promise<void> {
  if (c.sessionId) await cancel(c.sessionId);
  const draft = c.draft;
  // Settling a draft is a person's act; for anyone else the tick's policy
  // check (closed) holds a due veto or retry.
  if (!draft || by.kind !== "person") return;
  const settled =
    draft.state === "veto"
      ? await stopVeto(c.id, draft.id, by)
      : draft.state === "sending" && draft.nextAttemptAt
        ? await discardDraft(c.id, draft.id, by)
        : null;
  if (settled && !settled.ok)
    console.warn(
      `[support] couldn't stop the draft on ${c.id} when closing: ${settled.error}`,
    );
}

/** Closes the conversation and marks its mail handled in the mailbox. */
export async function closeConversation(
  id: string,
  by: SupportActor,
  /** What the event says; "<actor> closed this" by default. */
  detail?: string,
): Promise<{ ok: boolean }> {
  let changed = false;
  const closed = await updateConversation(id, (c) => {
    changed = c.status === "open" || c.status === "waiting";
    if (!changed) return null;
    return {
      ...c,
      status: "closed",
      closedAt: iso(),
      events: [
        ...c.events,
        event("closed", by, detail ?? `${actorName(by)} closed this`),
      ],
    };
  });
  if (!closed || !changed) return { ok: false };
  await stopSending(closed, by);
  const adapter = channelAdapterFor(closed.inboxId);
  if (adapter?.mark)
    await adapter.mark(closed, "handled").catch((error: unknown) => {
      console.warn(
        `[support] couldn't mark ${id} handled in the mailbox:`,
        error instanceof Error ? error.name : typeof error,
      );
    });
  return { ok: true };
}

export const QUIET_CLOSED =
  "No reply from the customer in 7 days. Closed without a reply";

/** Something on the conversation waits for a person: a draft that waits
 *  (or failed), a prepared issue, a fix task or a fix session. */
function waitsForPerson(c: SupportConversation): boolean {
  const d = c.draft;
  if (d && d.state !== "sent" && d.state !== "discarded") return true;
  return Boolean(c.pendingIssue || c.fixTask || c.fixSessionId);
}

/** Closes every conversation that has waited on the customer for
 *  WAITING_CLOSE_MS (our reply was the last message): no reminder mail.
 *  Skips one where something waits for a person (waitsForPerson). Reads
 *  the support-index projection, then the document. Returns how many
 *  closed. */
export async function closeQuietConversations(now: number): Promise<number> {
  let closed = 0;
  for (const row of await listIndexRows({ status: ["waiting"] })) {
    if (now - Date.parse(row.lastMessageAt) < WAITING_CLOSE_MS) continue;
    // The document decides: a customer message since makes it open.
    const c = await getConversation(row.id);
    if (!c || c.status !== "waiting") continue;
    if (now - Date.parse(c.lastMessageAt) < WAITING_CLOSE_MS) continue;
    if (waitsForPerson(c)) continue;
    if ((await closeConversation(c.id, SESSIONS_ACTOR, QUIET_CLOSED)).ok)
      closed++;
  }
  return closed;
}

/** Reopens a closed conversation. Spam leaves spam through markNotSpam. */
export async function reopenConversation(
  id: string,
  by: SupportActor,
): Promise<{ ok: boolean }> {
  let changed = false;
  const open = await updateConversation(id, (c) => {
    changed = c.status === "closed";
    if (!changed) return null;
    return {
      ...c,
      status: "open",
      closedAt: null,
      events: [
        ...c.events,
        event("reopened", by, `${actorName(by)} reopened this`),
      ],
    };
  });
  return { ok: open !== null && changed };
}

/** A person says it isn't spam: the conversation opens as work (no new
 *  triage, unknown topics), and its agent starts unless the inbox is Watch
 *  only. Mail
 *  already moved to the spam folder stays there. */
export async function markNotSpam(
  id: string,
  person: string,
): Promise<{ ok: boolean }> {
  const actor: SupportActor = { kind: "person", name: person };
  let changed = false;
  const open = await updateConversation(id, (c) => {
    changed = c.status === "spam";
    if (!changed) return null;
    return {
      ...c,
      status: "open",
      closedAt: null,
      // The verdict that called it spam is no guide to its topics:
      // unknown topics hold every send for a person.
      triage: {
        route: "work",
        reason: `${person} marked this as not spam`,
        topics: null,
        bug: c.triage?.bug ?? false,
        at: iso(),
      },
      events: [
        ...c.events,
        event("not-spam", actor, `${person} marked this as not spam`),
      ],
    };
  });
  if (!open || !changed) return { ok: false };
  const inbox = await getInbox(open.inboxId);
  if (inbox && inbox.autonomy !== "watch" && !open.sessionId)
    await startOrRecord(open, "person");
  return { ok: true };
}
