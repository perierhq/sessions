/**
 * The free-memory floor a host must keep before another host Portal may start.
 *
 * The default scales with the host: 15% of total memory, at least 2 GB and at
 * most 24 GB. A fixed 24 GB floor would refuse every Portal on a host with less
 * memory than that, so agents would start dev servers by hand instead.
 * `OPENSESSION_PORTAL_MIN_AVAILABLE_MEMORY_MB` overrides the default.
 */
import { readFile } from "node:fs/promises";

export const PORTAL_MEMORY_FLOOR_ENV =
  "OPENSESSION_PORTAL_MIN_AVAILABLE_MEMORY_MB";
export const PORTAL_MEMORY_FLOOR_SHARE = 0.15;
export const MIN_PORTAL_MEMORY_FLOOR_MB = 2 * 1024;
export const MAX_PORTAL_MEMORY_FLOOR_MB = 24 * 1024;

/** A free-memory floor that scales with the host: `share` of total memory,
 * clamped to [minMb, maxMb]. An unknown total keeps the ceiling. Run-host
 * admission (host-admission.ts) sizes its floor the same way. */
export function scaledMemoryFloorMb(
  totalMemoryMb: number | undefined,
  share: number,
  minMb: number,
  maxMb: number,
): number {
  if (!totalMemoryMb || !Number.isFinite(totalMemoryMb) || totalMemoryMb <= 0)
    return maxMb;
  return Math.min(maxMb, Math.max(minMb, Math.round(totalMemoryMb * share)));
}

/** Default floor for a host with `totalMemoryMb` of RAM. An unknown total keeps
 * the ceiling, the floor used before it scaled with the host. */
export function defaultPortalMemoryFloorMb(
  totalMemoryMb: number | undefined,
): number {
  return scaledMemoryFloorMb(
    totalMemoryMb,
    PORTAL_MEMORY_FLOOR_SHARE,
    MIN_PORTAL_MEMORY_FLOOR_MB,
    MAX_PORTAL_MEMORY_FLOOR_MB,
  );
}

/** The floor in effect: a positive integer override, else the host default. */
export function portalMemoryFloorMb(input: {
  totalMemoryMb: number | undefined;
  env?: Record<string, string | undefined>;
}): { floorMb: number; overridden: boolean } {
  const configured = Number(
    (input.env ?? process.env)[PORTAL_MEMORY_FLOOR_ENV],
  );
  if (Number.isSafeInteger(configured) && configured > 0)
    return { floorMb: configured, overridden: true };
  return {
    floorMb: defaultPortalMemoryFloorMb(input.totalMemoryMb),
    overridden: false,
  };
}

/** A warning when the floor can never be met on this host, else undefined. */
export function portalMemoryFloorWarning(input: {
  floorMb: number;
  totalMemoryMb: number | undefined;
  overridden: boolean;
}): string | undefined {
  if (!input.totalMemoryMb || input.floorMb < input.totalMemoryMb)
    return undefined;
  const source = input.overridden
    ? `${PORTAL_MEMORY_FLOOR_ENV}=${input.floorMb}`
    : `The Portal memory floor (${input.floorMb} MB)`;
  return `${source} is at or above this host's total memory (${Math.round(input.totalMemoryMb)} MB), so host Portals can never start. Lower ${PORTAL_MEMORY_FLOOR_ENV} or unset it to use the default (15% of total memory).`;
}

/** Parses a /proc/meminfo field in MB. */
export function meminfoMb(meminfo: string, field: string): number | undefined {
  const match = new RegExp(`^${field}:\\s+(\\d+)\\s+kB$`, "m").exec(meminfo);
  return match ? Number(match[1]) / 1024 : undefined;
}

// Total memory does not change under a running process; read it once.
let totalMemoryRead: Promise<number | undefined> | undefined;

/** Host total memory in MB from /proc/meminfo, or undefined off Linux. */
export function hostTotalMemoryMb(): Promise<number | undefined> {
  totalMemoryRead ??= readFile("/proc/meminfo", "utf8").then(
    (meminfo) => meminfoMb(meminfo, "MemTotal"),
    () => undefined,
  );
  return totalMemoryRead;
}

/** The floor in effect on this host. */
export async function hostPortalMemoryFloorMb(): Promise<number> {
  return portalMemoryFloorMb({ totalMemoryMb: await hostTotalMemoryMb() })
    .floorMb;
}

let floorChecked = false;

/** Logs once per process when the floor can never be met on this host. */
export async function warnIfPortalMemoryFloorUnreachable(
  log: (message: string) => void = console.warn,
): Promise<void> {
  if (floorChecked) return;
  floorChecked = true;
  const totalMemoryMb = await hostTotalMemoryMb();
  const warning = portalMemoryFloorWarning({
    ...portalMemoryFloorMb({ totalMemoryMb }),
    totalMemoryMb,
  });
  if (warning) log(`[portals] ${warning}`);
}
