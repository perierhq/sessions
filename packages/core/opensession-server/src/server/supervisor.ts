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
import { personaName } from "./config";
import { ensureDeskSession } from "./desk";
import { newSessionId } from "./paths";
import {
  enrichSessionRuntime,
  readNativeSessionAsync,
  updateSessionFile,
} from "./session-cache";
import { canonicalName } from "./shared/user-store-key";
import type { NativeSessionFile, UnifiedSession } from "./types";

/** Catalog namespace: canonicalName(user) → SupervisorRecord. */
export const SUPERVISORS_NAMESPACE = "supervisors";

const MINUTE_MS = 60_000;
/** A supervisor session older than this is rotated once it is idle. */
export const ROTATE_AGE_MS = 7 * 24 * 60 * MINUTE_MS;
/** Idle: no run in progress and nothing happened for this long. */
export const ROTATE_IDLE_MS = 30 * MINUTE_MS;
/** A supervisor session compacted this often is rotated once it is idle. */
export const ROTATE_COMPACTIONS = 3;
/** Retired sessions kept on the record, newest first. */
export const MAX_PREVIOUS = 50;

export interface SupervisorRecord {
  sessionId: string;
  createdAt: string;
  /** Sessions this person's supervisor ran in before, newest first. They
   *  stay as they are, hidden like the current one. */
  previous: string[];
  /** Compactions the current session went through (run-session.ts). */
  compactions: number;
}

export interface SupervisorEnsured {
  sessionId: string;
  /** Earlier supervisor sessions, newest first, for paging history across
   *  rotations. */
  previousSessionIds: string[];
}

function recordOf(value: unknown): SupervisorRecord | null {
  if (!value || typeof value !== "object") return null;
  const sessionId = Reflect.get(value, "sessionId");
  const createdAt = Reflect.get(value, "createdAt");
  const previous = Reflect.get(value, "previous");
  const compactions = Reflect.get(value, "compactions");
  return typeof sessionId === "string" && sessionId
    ? {
        sessionId,
        createdAt: typeof createdAt === "string" ? createdAt : "",
        previous: Array.isArray(previous)
          ? previous
              .filter(
                (id): id is string =>
                  typeof id === "string" && !!id && id !== sessionId,
              )
              .slice(0, MAX_PREVIOUS)
          : [],
        compactions:
          typeof compactions === "number" && Number.isFinite(compactions)
            ? Math.max(0, Math.floor(compactions))
            : 0,
      }
    : null;
}

function ensured(record: SupervisorRecord): SupervisorEnsured {
  return {
    sessionId: record.sessionId,
    previousSessionIds: record.previous,
  };
}

/** The catalog key for a person: the spelling every per-user store uses
 * (shared/user-store-key.ts), so a rename carries it (NAME_KEYED_STORES). */
export function supervisorKey(user: string): string {
  return canonicalName(user);
}

/** What rotation reads off the current session. */
export interface SupervisorSessionState {
  createdAt: string;
  lastActivity: string;
  /** A run is in progress or a queued prompt is being drained. */
  busy: boolean;
}

/**
 * Whether the person's supervisor should move to a fresh session: only when
 * it is idle (no run in progress, nothing for ROTATE_IDLE_MS), and then
 * when it is older than ROTATE_AGE_MS or went through ROTATE_COMPACTIONS
 * compactions. A month in one session would mean summaries of summaries;
 * the ledger and the seed context carry what matters into the new one.
 */
export function rotationDue(
  record: SupervisorRecord,
  session: SupervisorSessionState,
  now: number,
): boolean {
  if (session.busy) return false;
  const last = Date.parse(session.lastActivity);
  if (!Number.isFinite(last) || now - last <= ROTATE_IDLE_MS) return false;
  if (record.compactions >= ROTATE_COMPACTIONS) return true;
  const born = Date.parse(record.createdAt || session.createdAt);
  return Number.isFinite(born) && now - born > ROTATE_AGE_MS;
}

interface SupervisorDeps {
  now(): number;
  busy(session: UnifiedSession): boolean;
}

const defaultDeps: SupervisorDeps = {
  now: Date.now,
  busy: (session) => {
    const live = enrichSessionRuntime([session])[0] ?? session;
    return !!live.isRunning || !!live.queueOwnerActive;
  },
};

let deps: SupervisorDeps = defaultDeps;

/** Swap the clock and the busy check in tests. Returns a restore function. */
export function __setSupervisorDepsForTest(
  overrides: Partial<SupervisorDeps>,
): () => void {
  const previous = deps;
  deps = { ...defaultDeps, ...overrides };
  return () => {
    deps = previous;
  };
}

/** One ensure or rotation per person at a time, so two concurrent calls (a
 * double tap, Blob and a voice call at once, the inbox sweep) never mint two
 * sessions. */
const inflight = new Map<string, Promise<SupervisorEnsured | null>>();

function serialized(
  key: string,
  run: () => Promise<SupervisorEnsured | null>,
): Promise<SupervisorEnsured | null> {
  const running = inflight.get(key);
  if (running) return running;
  const started = run().finally(() => {
    if (inflight.get(key) === started) inflight.delete(key);
  });
  inflight.set(key, started);
  return started;
}

/** Get or create the user's repo-less supervisor session, rotating it first
 *  when it is due (rotationDue). */
export async function ensureSupervisorSession(
  user: string,
): Promise<SupervisorEnsured> {
  const key = supervisorKey(user);
  // A rotation check from the sweep may be in flight and resolve to nothing
  // (no supervisor yet): then ensure for real.
  const result =
    (await serialized(key, () => ensureNow(user, key, "ensure"))) ??
    (await serialized(key, () => ensureNow(user, key, "ensure")));
  if (!result) throw new Error("Supervisor claim failed");
  return result;
}

/**
 * Rotate the person's supervisor when it is due, from the inbox sweep.
 * Creates nothing for a person who has no supervisor yet, and leaves a
 * mapping whose session is gone for the next ensure. Null when nothing
 * exists.
 */
export function rotateSupervisorIfDue(
  user: string,
): Promise<SupervisorEnsured | null> {
  const key = supervisorKey(user);
  return serialized(key, () => ensureNow(user, key, "rotate"));
}

async function ensureNow(
  user: string,
  key: string,
  mode: "ensure" | "rotate",
): Promise<SupervisorEnsured | null> {
  const documents = catalogDocuments(SUPERVISORS_NAMESPACE);
  const current = recordOf(await documents.get(key));
  if (current) {
    const session = await readNativeSessionAsync(current.sessionId);
    if (session) {
      const now = deps.now();
      const due = rotationDue(
        current,
        {
          createdAt: session.createdAt,
          lastActivity: session.lastActivity,
          busy: deps.busy(session),
        },
        now,
      );
      if (!due) return ensured(current);
      return mint(user, key, current, current.sessionId);
    }
    if (mode === "rotate") return ensured(current);
    // The mapped session is gone: replace it, keeping the history.
    return mint(user, key, current, undefined);
  }
  if (mode === "rotate") return null;
  return mint(user, key, null, undefined);
}

async function mint(
  user: string,
  key: string,
  base: SupervisorRecord | null,
  retire: string | undefined,
): Promise<SupervisorEnsured> {
  const documents = catalogDocuments(SUPERVISORS_NAMESPACE);
  // Write the session before claiming it, so the map never points at a
  // session that does not exist yet.
  const id = newSessionId();
  const now = new Date(deps.now()).toISOString();
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

  const previous = [...(retire ? [retire] : []), ...(base?.previous ?? [])]
    .filter(
      (sessionId, i, all) => sessionId !== id && all.indexOf(sessionId) === i,
    )
    .slice(0, MAX_PREVIOUS);
  // Claim under the catalog's compare-and-set. Another gateway (a handoff
  // overlap) may have claimed or rotated first; its live session wins and
  // ours is archived, so the person still has exactly one.
  const claimed = recordOf(
    await documents.update(key, (value) => {
      const current = recordOf(value);
      if (current && current.sessionId !== base?.sessionId) return current;
      const next: SupervisorRecord = {
        sessionId: id,
        createdAt: now,
        previous,
        compactions: 0,
      };
      return next;
    }),
  );
  if (claimed?.sessionId !== id) {
    await updateSessionFile(id, (data) => ({ ...data, archived: true }));
    if (claimed) return ensured(claimed);
    throw new Error("Supervisor claim failed");
  }
  console.log(
    retire
      ? `[supervisor] rotated ${user}'s supervisor from ${retire} to ${id}`
      : `[supervisor] created supervisor session ${id} for ${user}`,
  );
  return ensured(claimed);
}

class NotCurrent extends Error {}

/**
 * Count one compaction of a supervisor session on its record, so rotation
 * can see it. Nothing for any other session, or a retired supervisor.
 * Resolves the new count, or null when nothing was counted.
 */
export async function recordSupervisorCompaction(session: {
  id: string;
  supervisor?: boolean;
  createdBy?: string | null;
}): Promise<number | null> {
  const owner = session.createdBy?.trim();
  if (!session.supervisor || !owner) return null;
  let count: number | null = null;
  try {
    await catalogDocuments(SUPERVISORS_NAMESPACE).update(
      supervisorKey(owner),
      (value) => {
        const current = recordOf(value);
        // Abort without writing: returning null would store a tombstone.
        if (!current || current.sessionId !== session.id)
          throw new NotCurrent();
        count = current.compactions + 1;
        return { ...current, compactions: count };
      },
    );
  } catch (error) {
    if (error instanceof NotCurrent) return null;
    throw error;
  }
  return count;
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

/** The role charter prepended to every supervisor prompt (session-repos.ts).
 *  `persona` is the instance's public worker (config persona.name). */
export function supervisorNote(persona: string = personaName()): string {
  return `## Your role: the supervisor

This session is the owner's supervisor, their chief of staff. The Blob app shows it to them. Discipline:

- Answer the owner. Lead with the answer and keep it short.
- Keep the briefing across their projects: what is running, what finished, what is waiting on them. The live state at the top of each turn is the current picture.
- Hold the decisions that are waiting for the owner. Put each one plainly, with the options, and keep it until they decide.
- Delegate real work. Start a scoped worker session with opensession-sessions create_session or spawn_task, or steer one already on it with send_to_session, and tell the owner you did. Never do long implementation work in this session.
- Never act on what only the owner may decide: refunds, pricing, disputes, tax, legal, contracts, and writes to production data. Prepare it, then ask.
- When the turn says the reply is shown in the Blob app, shape it for that surface.

## Your ledger

This conversation is closed after about a week and a new one starts, so what has to last goes in your ledger (opensession-supervisor read_ledger and append_ledger).

- Read the ledger when you start a new conversation, before you answer.
- Append the decisions the owner made, their standing preferences, and the threads still open.
- One short entry per fact. Entries are dated for you.
- When a fact changes, append the new one and mark the old one superseded ("used to X, now Y").

## How Blob speaks

In the Blob app you are Blob, a character: warm, but not pretending to be human.

- Plain spoken words and contractions. Give an opinion when you have one ("I'd raise it"), and remember what was said before.
- No fake feelings, no filler ("Great question"), no small talk. Never say "as an AI".
- Never claim something you didn't do. When you don't know, say "I don't know" plainly.
- One or two sentences, then stop.
- Dry and slightly playful, never cute. No em dashes.
- ${persona} is the public worker. When you hand work to ${persona}, say so by name ("I've asked ${persona} to review it"); opensession-supervisor ask_pat hands ${persona} GitHub work.
- You never sign or post anything public yourself, and nothing public is ever signed Blob. Anything public goes out as ${persona} through the existing paths.`;
}
