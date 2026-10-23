/**
 * Disk limits for "This machine (container)" sandboxes. Rootless podman
 * volumes have no size limit, so one session could fill the filesystem that
 * holds podman's storage (often the gateway's own). Starts are refused below
 * a free-space floor, and the idle sweep measures each sandbox's home volume:
 * over the warning size it is reported on the connection, over the quota the
 * pod is stopped and further starts are refused.
 */

export const GIB = 1024 ** 3;
/** Starts are refused while podman's storage has less than this free. */
export const PODMAN_MIN_FREE_BYTES = 5 * GIB;
/** A home volume this large is reported on the connection. */
export const PODMAN_VOLUME_WARN_BYTES = 10 * GIB;
/** A home volume this large stops its pod and refuses starts. */
export const PODMAN_VOLUME_QUOTA_BYTES = 20 * GIB;

export interface PodmanDiskReport {
  checkedAt: string;
  /** Bytes available on podman's storage filesystem, when measured. */
  freeBytes?: number;
  /** Home volumes at or over the warning size. */
  volumes: { sandboxId: string; sessionId: string; bytes: number }[];
}

let lastReport: PodmanDiskReport | undefined;

export function recordPodmanDiskReport(report: PodmanDiskReport): void {
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
  report: PodmanDiskReport | undefined = lastReport,
): string[] {
  if (!report) return [];
  const lines: string[] = [];
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
  return lines;
}

/** Volume name -> bytes, from `podman system df -v --format json`. Throws
 *  on output that is not that report. */
export function parseSystemDfVolumes(output: string): Map<string, number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("podman system df did not return JSON");
  }
  const volumes =
    parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>).Volumes
      : undefined;
  if (!Array.isArray(volumes))
    throw new Error("podman system df returned no volume list");
  const sizes = new Map<string, number>();
  for (const entry of volumes) {
    if (!entry || typeof entry !== "object") continue;
    const { VolumeName, Size } = entry as Record<string, unknown>;
    if (typeof VolumeName === "string" && typeof Size === "number")
      sizes.set(VolumeName, Size);
  }
  return sizes;
}
