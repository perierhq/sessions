/**
 * A session's pi files on this machine: the native session jsonl pi writes
 * for every turn (plus the turn checkpoint beside it) under
 * `<state>/pi/sessions/<session id>/`, and the checkout context mirrored for
 * a Sandbox session under `<state>/pi/remote-context/<session id>/`
 * (pi-session-setup.ts).
 *
 * Lifecycle, the same shape as session scratch (session-scratch.ts): removed
 * when the session is deleted (sessions.ts removeSessionArtifacts), and the
 * worktree reaper's hourly pass removes a dir whose session is gone (deleted
 * while the server was down, or before deletion removed these files) once
 * the dir itself has sat past the horizon. Unlike scratch, a live session's
 * dir is never idle-swept: it is the engine history a later turn resumes.
 *
 * Only dirs named after a session id are this module's. Workflow agents,
 * one-shots and comment answers key their dirs by run key and keep them.
 *
 * State-dir resolution is per call, never a module const (session-scratch.ts
 * explains why).
 */

import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { sanitizeId } from "./pi-common";
import { isNativeSessionId, stateDir } from "./paths";

const DAY = 24 * 60 * 60_000;

/** An ownerless dir younger than this stays: its session may be mid-create. */
const ORPHAN_AGE_DAYS = () => {
  const n = Number(process.env.OPENSESSION_PI_ORPHAN_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 7;
};

/** Dir name for a session id; null when it sanitizes to a path step. */
function dirName(sessionId: string): string | null {
  const name = sanitizeId(sessionId);
  return name && name !== "." && name !== ".." ? name : null;
}

function piSessionsRoot(): string {
  return join(stateDir("pi"), "sessions");
}

function piRemoteContextRoot(): string {
  return join(stateDir("pi"), "remote-context");
}

/** Where pi keeps a session's native session files. A path only. */
export function piSessionDir(sessionKey: string): string {
  return join(piSessionsRoot(), dirName(sessionKey) ?? "_");
}

/** Where a Sandbox session's checkout context is mirrored. A path only. */
export function piRemoteContextDir(sessionKey: string): string {
  return join(piRemoteContextRoot(), dirName(sessionKey) ?? "_");
}

/** Remove a session's pi files. Never throws: deletion must not block on
 *  a filesystem hiccup, and the orphan sweep retries what this misses. */
export async function removePiSessionFiles(sessionId: string): Promise<void> {
  const name = dirName(sessionId);
  if (!name) return;
  for (const root of [piSessionsRoot(), piRemoteContextRoot()]) {
    try {
      await rm(join(root, name), { recursive: true, force: true });
    } catch (e) {
      console.warn(`[pi-files] failed to remove ${root}/${name}:`, e);
    }
  }
}

export interface PiSessionDirInfo {
  name: string;
  mtimeMs: number;
}

export interface PiSessionOwner {
  id: string;
  aliasIds?: readonly string[];
}

/**
 * Pure sweep decision: the dir names no session owns, named like a session
 * id, older than the horizon. An empty session list sweeps nothing: it is a
 * missing snapshot, not proof that nobody owns anything.
 */
export function piSessionDirsToSweep(
  dirs: readonly PiSessionDirInfo[],
  sessions: readonly PiSessionOwner[],
  nowMs: number,
): string[] {
  if (sessions.length === 0) return [];
  const owned = new Set<string>();
  for (const session of sessions)
    for (const id of [session.id, ...(session.aliasIds || [])]) {
      const name = dirName(id);
      if (name) owned.add(name);
    }
  const cutoff = nowMs - ORPHAN_AGE_DAYS() * DAY;
  return dirs
    .filter(
      (dir) =>
        isNativeSessionId(dir.name) &&
        !owned.has(dir.name) &&
        dir.mtimeMs < cutoff,
    )
    .map((dir) => dir.name);
}

async function listDirs(root: string): Promise<PiSessionDirInfo[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return []; // store not created yet
  }
  const dirs: PiSessionDirInfo[] = [];
  for (const name of names) {
    try {
      const info = await stat(join(root, name));
      if (info.isDirectory()) dirs.push({ name, mtimeMs: info.mtimeMs });
    } catch {}
  }
  return dirs;
}

/**
 * Remove the pi files of sessions that no longer exist. Returns the dir
 * names removed. Callers pass the full session list, archived sessions
 * included (the worktree reaper already holds one per sweep).
 */
export async function sweepOrphanPiSessionFiles(
  sessions: readonly PiSessionOwner[],
): Promise<string[]> {
  const now = Date.now();
  const removed = new Set<string>();
  for (const root of [piSessionsRoot(), piRemoteContextRoot()]) {
    const doomed = piSessionDirsToSweep(await listDirs(root), sessions, now);
    for (const name of doomed) {
      try {
        await rm(join(root, name), { recursive: true, force: true });
        removed.add(name);
      } catch (e) {
        console.warn(`[pi-files] sweep failed for ${root}/${name}:`, e);
      }
    }
  }
  return [...removed];
}
