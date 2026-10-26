/**
 * Where the sessions active at a graceful shutdown are kept for the boot
 * wake-up (run-session.ts, snapshotActiveSessions/resumeDrainedSessions):
 * beside the session store, not in it, because every file in `sessions/` is
 * read as a session record. An older install kept it inside; that file is
 * read once, moved here, and removed.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeJsonAtomic } from "./shared/atomic-write";

const FILE = "active-at-shutdown.json";

export function shutdownSnapshotPath(sessionsDir: string): string {
  return join(dirname(sessionsDir), FILE);
}

function legacyPath(sessionsDir: string): string {
  return join(sessionsDir, FILE);
}

function readList(path: string): unknown[] {
  const records = JSON.parse(readFileSync(path, "utf-8"));
  return Array.isArray(records) ? records : [];
}

/** The recorded list, `[]` when there is none. Throws on an unreadable file
 *  (the caller logs it). */
export function readShutdownSnapshot(sessionsDir: string): unknown[] {
  const path = shutdownSnapshotPath(sessionsDir);
  if (existsSync(path)) return readList(path);
  const legacy = legacyPath(sessionsDir);
  if (!existsSync(legacy)) return [];
  const records = readList(legacy);
  writeJsonAtomic(path, records, false);
  rmSync(legacy, { force: true });
  return records;
}

export function writeShutdownSnapshot(
  sessionsDir: string,
  records: unknown[],
): void {
  writeJsonAtomic(shutdownSnapshotPath(sessionsDir), records, false);
  rmSync(legacyPath(sessionsDir), { force: true });
}
