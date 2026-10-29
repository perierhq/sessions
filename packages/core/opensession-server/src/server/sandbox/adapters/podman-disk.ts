/**
 * Disk limits for "This machine (container)" sandboxes. Rootless podman
 * volumes have no size limit, so one session could fill the filesystem that
 * holds podman's storage (often the gateway's own). Starts are refused below
 * a free-space floor, and the idle sweep measures each sandbox's home volume:
 * over the warning size it is reported on the connection, over the quota the
 * pod is stopped and further starts are refused.
 *
 * The quota fails closed: cold starts are refused until a check has
 * succeeded since boot, and again once the last few checks have failed. The
 * over-quota list is kept in the sandbox state dir, so it survives restarts.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { OPENSESSION_SESSIONS_DIR } from "../../paths";
import { writeJsonAtomicAsync } from "../../shared/atomic-write";

export const GIB = 1024 ** 3;
/** Starts are refused while podman's storage has less than this free. */
export const PODMAN_MIN_FREE_BYTES = 5 * GIB;
/** A home volume this large is reported on the connection. */
export const PODMAN_VOLUME_WARN_BYTES = 10 * GIB;
/** A home volume this large stops its pod and refuses starts. */
export const PODMAN_VOLUME_QUOTA_BYTES = 20 * GIB;

/** Consecutive failed checks after which cold starts are refused. */
export const PODMAN_DISK_CHECK_FAILURE_LIMIT = 3;

export interface PodmanDiskReport {
  checkedAt: string;
  /** Bytes available on podman's storage filesystem, when measured. */
  freeBytes?: number;
  /** Home volumes at or over the warning size. After a failed check, the
   *  last successful check's. */
  volumes: { sandboxId: string; sessionId: string; bytes: number }[];
  /** Sessions whose home volume the check did not find: their quota state
   *  is unknown and left as it was. */
  unknownSessions?: string[];
  /** Why this check failed. */
  error?: string;
  /** Cold starts are refused until a check succeeds. */
  startsRefused?: boolean;
}

let lastReport: PodmanDiskReport | undefined;

// ── Check health ─────────────────────────────────────────────────────────────

let lastGoodCheckAt: string | undefined;
let failedChecksInRow = 0;
let lastCheckError: string | undefined;

/** Record a volume check's outcome: `error` when it failed. */
export function notePodmanDiskCheck(error?: string): void {
  if (error === undefined) {
    lastGoodCheckAt = new Date().toISOString();
    failedChecksInRow = 0;
    lastCheckError = undefined;
  } else {
    failedChecksInRow += 1;
    lastCheckError = error;
  }
}

/** Whether a volume check has succeeded since this process started. */
export function podmanDiskCheckedSinceBoot(): boolean {
  return lastGoodCheckAt !== undefined;
}

/** Why cold starts are refused now, or null. */
export function podmanDiskCheckRefusal(): string | null {
  if (!lastGoodCheckAt)
    return `no disk check has succeeded since the server started${lastCheckError ? ` (${lastCheckError})` : ""}`;
  if (failedChecksInRow >= PODMAN_DISK_CHECK_FAILURE_LIMIT)
    return `the last ${failedChecksInRow} disk checks failed (${lastCheckError ?? "unknown error"})`;
  return null;
}

// ── Over-quota list ──────────────────────────────────────────────────────────

/** Next to the sandbox state files, without their `<provider>-` prefix. */
function overQuotaPath(): string {
  return join(OPENSESSION_SESSIONS_DIR, "sandboxes", "quota-podman.json");
}

/** Pod name -> home volume bytes, for pods a check found over the quota.
 *  Loaded from disk on first use. */
let overQuota: Map<string, number> | undefined;
let overQuotaLoad: Promise<Map<string, number>> | undefined;
let overQuotaWrite: Promise<void> = Promise.resolve();

async function loadOverQuota(): Promise<Map<string, number>> {
  const pods = new Map<string, number>();
  let raw: string;
  try {
    raw = await readFile(overQuotaPath(), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      console.warn(
        "[sandbox:podman] could not read the over-quota list:",
        error,
      );
    return pods;
  }
  try {
    const parsed = JSON.parse(raw) as { pods?: Record<string, unknown> };
    for (const [pod, bytes] of Object.entries(parsed?.pods ?? {}))
      if (typeof bytes === "number") pods.set(pod, bytes);
  } catch {
    console.warn("[sandbox:podman] the over-quota list is not JSON; ignored");
  }
  return pods;
}

/** The pods over the quota, as last measured (persisted across restarts). */
export function podmanOverQuota(): Promise<Map<string, number>> {
  if (overQuota) return Promise.resolve(overQuota);
  overQuotaLoad ??= loadOverQuota().then((pods) => (overQuota ??= pods));
  return overQuotaLoad;
}

/** Mark a pod over the quota (`bytes`) or not (undefined), persisting any
 *  change. A failed write is logged; the list in memory still applies. */
export async function setPodmanOverQuota(
  pod: string,
  bytes: number | undefined,
): Promise<void> {
  const pods = await podmanOverQuota();
  if (bytes === undefined ? !pods.has(pod) : pods.get(pod) === bytes) return;
  if (bytes === undefined) pods.delete(pod);
  else pods.set(pod, bytes);
  const snapshot = { pods: Object.fromEntries(pods) };
  overQuotaWrite = overQuotaWrite.then(() =>
    writeJsonAtomicAsync(overQuotaPath(), snapshot).catch((error) =>
      console.warn(
        "[sandbox:podman] could not save the over-quota list:",
        error,
      ),
    ),
  );
  await overQuotaWrite;
}

/** As after a restart: forget every check and the report, and reload the
 *  over-quota list from disk on next use. */
export async function forgetPodmanDiskState(): Promise<void> {
  await overQuotaWrite;
  lastReport = undefined;
  lastGoodCheckAt = undefined;
  failedChecksInRow = 0;
  lastCheckError = undefined;
  overQuota = undefined;
  overQuotaLoad = undefined;
  lastVolumeBytes = new Map();
}

/** Home volume name -> bytes, from the last successful check. */
let lastVolumeBytes = new Map<string, number>();

export function recordPodmanVolumeUsage(usage: Map<string, number>): void {
  lastVolumeBytes = new Map(usage);
}

/** The home volume size of `sandboxId` (its pod name) as last measured, or
 *  null when no check has measured it. Process-local, no podman call: the
 *  archive sweep reports what it reclaimed with it. */
export function podmanSandboxHomeBytes(sandboxId: string): number | null {
  return lastVolumeBytes.get(`${sandboxId}-home`) ?? null;
}

export function recordPodmanDiskReport(
  report: PodmanDiskReport | undefined,
): void {
  lastReport = report;
}

export function podmanDiskReport(): PodmanDiskReport | undefined {
  return lastReport;
}

export function formatGib(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GiB`;
}

/** The connection status lines for a report, most severe first. */
export function podmanDiskWarnings(
  report: PodmanDiskReport | undefined,
): string[] {
  if (!report) return [];
  const lines: string[] = [];
  if (report.error)
    lines.push(
      `Disk check failed ${new Date(report.checkedAt).toLocaleString()}: ${report.error}` +
        (report.startsRefused
          ? ". Sandboxes will not start until a check succeeds"
          : ""),
    );
  if (
    report.freeBytes !== undefined &&
    report.freeBytes < PODMAN_MIN_FREE_BYTES
  )
    lines.push(
      `Only ${formatGib(report.freeBytes)} free for sandbox storage: sandboxes will not start below ${formatGib(PODMAN_MIN_FREE_BYTES)}`,
    );
  const volumes = [...report.volumes].sort((a, b) => b.bytes - a.bytes);
  for (const volume of volumes)
    lines.push(
      volume.bytes > PODMAN_VOLUME_QUOTA_BYTES
        ? `Session ${volume.sessionId} uses ${formatGib(volume.bytes)}, over the ${formatGib(PODMAN_VOLUME_QUOTA_BYTES)} limit: its sandbox is stopped`
        : `Session ${volume.sessionId} uses ${formatGib(volume.bytes)} (stops at ${formatGib(PODMAN_VOLUME_QUOTA_BYTES)})`,
    );
  if (report.unknownSessions?.length)
    lines.push(
      `Could not measure the home of ${report.unknownSessions.length === 1 ? "session" : "sessions"} ${report.unknownSessions.join(", ")}`,
    );
  return lines;
}

/**
 * Volume name -> mountpoint, from `podman volume ls --format json` (an
 * array of `{Name, Mountpoint, ...}`). Only names starting with `prefix`
 * and absolute single-line mountpoints are kept. Throws on output that is
 * not a volume list.
 */
export function parseVolumeMountpoints(
  output: string,
  prefix: string,
): Map<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("podman volume ls did not return JSON");
  }
  if (!Array.isArray(parsed))
    throw new Error("podman volume ls returned no volume list");
  const mounts = new Map<string, string>();
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const { Name, Mountpoint } = entry as Record<string, unknown>;
    if (
      typeof Name === "string" &&
      Name.startsWith(prefix) &&
      typeof Mountpoint === "string" &&
      Mountpoint.startsWith("/") &&
      !/[\0\r\n\t]/.test(Mountpoint)
    )
      mounts.set(Name, Mountpoint);
  }
  return mounts;
}

/** Path -> bytes, from `du -s -B1` output (`<bytes>\t<path>` per line). */
export function parseDuTotals(output: string): Map<string, number> {
  const totals = new Map<string, number>();
  for (const line of output.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const bytes = line.slice(0, tab);
    if (/^\d+$/.test(bytes)) totals.set(line.slice(tab + 1), Number(bytes));
  }
  return totals;
}

/** Whether du's errors only name files removed while it walked (a busy
 *  sandbox), which leave its totals usable. */
export function duErrorsOnlyVanished(stderr: string): boolean {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    lines.length > 0 &&
    lines.every((line) => /: No such file or directory$/.test(line))
  );
}
