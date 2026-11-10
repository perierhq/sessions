/**
 * Supervisor: the per-user standing session the Blob app talks to
 * (adrs/supervisor-and-leads.md, section 1). One durable ask-mode session per
 * person (session file flag `supervisor: true`, fixed title, hidden from the
 * session lists like the Desk) that answers the owner, keeps the briefing
 * across projects, holds the decisions waiting for them, and hands real work
 * to worker sessions.
 *
 * Built on the Desk's pattern (desk.ts): a get-or-create per user, a charter
 * note prepended by buildSessionNote (session-repos.ts), and the live-state
 * briefing injected per turn (deskStateContext, run-session.ts). Unlike the
 * Desk it keeps its user→session map in the central catalog, so nothing here
 * touches the filesystem synchronously, and it runs on the instance default
 * model: its conversations are deep, the Desk's are quick.
 */
import { catalogDocuments } from "./catalog-documents";
import { ensureDeskSession } from "./desk";
import { newSessionId } from "./paths";
import { readNativeSessionAsync, updateSessionFile } from "./session-cache";
import { canonicalName } from "./shared/user-store-key";
import type { NativeSessionFile } from "./types";

/** Catalog namespace: canonicalName(user) → { sessionId, createdAt }. */
export const SUPERVISORS_NAMESPACE = "supervisors";

interface SupervisorRecord {
  sessionId: string;
  createdAt: string;
}

function recordOf(value: unknown): SupervisorRecord | null {
  if (!value || typeof value !== "object") return null;
  const sessionId = Reflect.get(value, "sessionId");
  const createdAt = Reflect.get(value, "createdAt");
  return typeof sessionId === "string" && sessionId
    ? {
        sessionId,
        createdAt: typeof createdAt === "string" ? createdAt : "",
      }
    : null;
}

/** The catalog key for a person: the spelling every per-user store uses
 * (shared/user-store-key.ts), so a rename carries it (NAME_KEYED_STORES). */
export function supervisorKey(user: string): string {
  return canonicalName(user);
}

/** One ensure per person at a time, so two concurrent calls (a double tap,
 * Blob and a voice call at once) never mint two sessions. */
const inflight = new Map<string, Promise<{ sessionId: string }>>();

/** Get or create the user's repo-less supervisor session. */
export function ensureSupervisorSession(
  user: string,
): Promise<{ sessionId: string }> {
  const key = supervisorKey(user);
  const running = inflight.get(key);
  if (running) return running;
  const run = ensureNow(user, key).finally(() => {
    if (inflight.get(key) === run) inflight.delete(key);
  });
  inflight.set(key, run);
  return run;
}

async function ensureNow(
  user: string,
  key: string,
): Promise<{ sessionId: string }> {
  const documents = catalogDocuments(SUPERVISORS_NAMESPACE);
  const stale = recordOf(await documents.get(key));
  if (stale && (await readNativeSessionAsync(stale.sessionId)))
    return { sessionId: stale.sessionId };

  // Write the session before claiming it, so the map never points at a
  // session that does not exist yet.
  const id = newSessionId();
  const now = new Date().toISOString();
  await updateSessionFile(id, (data) => {
    const existing: Partial<NativeSessionFile> = data;
    return {
      id,
      claudeSessionId: "",
      branch: "",
      worktreeDir: "",
      mode: "ask" as const,
      supervisor: true,
      repoLess: true,
      createdBy: user,
      createdAt: now,
      lastActivity: now,
      title: "Supervisor",
      ...existing,
    };
  });

  // Claim under the catalog's compare-and-set. Another gateway (a handoff
  // overlap) may have claimed first; its live session wins and ours is
  // archived, so the person still has exactly one.
  const claimed = recordOf(
    await documents.update(key, (value) => {
      const current = recordOf(value);
      if (current && current.sessionId !== stale?.sessionId) return current;
      return { sessionId: id, createdAt: now };
    }),
  );
  if (claimed?.sessionId !== id) {
    await updateSessionFile(id, (data) => ({ ...data, archived: true }));
    if (claimed) return { sessionId: claimed.sessionId };
    throw new Error("Supervisor claim failed");
  }
  console.log(`[supervisor] created supervisor session ${id} for ${user}`);
  return { sessionId: id };
}

/** Which standing session a voice call or a client talks to. */
export type StandingSession = "desk" | "supervisor";

/** A request's `standing` field: anything but "supervisor" is the Desk, so
 * clients that never send it keep talking to the Desk. */
export function parseStanding(raw: unknown): StandingSession {
  return raw === "supervisor" ? "supervisor" : "desk";
}

/** The user's standing session of that kind, created on first use. */
export async function standingSessionFor(
  user: string,
  standing: StandingSession,
): Promise<{ sessionId: string }> {
  if (standing === "supervisor") return ensureSupervisorSession(user);
  return { sessionId: ensureDeskSession(user).sessionId };
}

/** The role charter prepended to every supervisor prompt (session-repos.ts). */
export const SUPERVISOR_NOTE = `## Your role: the supervisor

This session is the owner's supervisor, their chief of staff. The Blob app shows it to them. Discipline:

- Answer the owner. Lead with the answer and keep it short.
- Keep the briefing across their projects: what is running, what finished, what is waiting on them. The live state at the top of each turn is the current picture.
- Hold the decisions that are waiting for the owner. Put each one plainly, with the options, and keep it until they decide.
- Delegate real work. Start a scoped worker session with opensession-sessions create_session or spawn_task, or steer one already on it with send_to_session, and tell the owner you did. Never do long implementation work in this session.
- Never act on what only the owner may decide: refunds, pricing, disputes, tax, legal, contracts, and writes to production data. Prepare it, then ask.
- When the turn says the reply is shown in the Blob app, shape it for that surface.`;
