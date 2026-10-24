// The machine shape of a This machine (container) sandbox: memory, pids and
// cpu limits and its DNS resolvers. Pure, so the connection store can clamp
// what is saved and Settings can show what a sandbox actually gets.
import { availableParallelism, totalmem } from "node:os";
import { isIpv4 } from "./podman-cli";

export const PODMAN_DEFAULT_MEMORY_MB = 4096;
export const PODMAN_DEFAULT_PIDS_LIMIT = 4096;
export const PODMAN_DEFAULT_DNS = ["1.1.1.1", "9.9.9.9"];

/** Below this a sandbox cannot run the agent's tools at all. */
export const PODMAN_MIN_MEMORY_MB = 512;
/** Enough for a build; the ceiling keeps the fork-bomb guard meaningful. */
export const PODMAN_MIN_PIDS_LIMIT = 64;
export const PODMAN_MAX_PIDS_LIMIT = 65_536;
export const PODMAN_MIN_CPU = 0.1;

export interface PodmanSettings {
  memoryMb: number;
  pidsLimit: number;
  /** Applied only when this host delegates the cgroup `cpu` controller. */
  cpu?: number;
  /** The only resolvers the sandbox may reach (IPv4, public). */
  dns: string[];
}

/** What this host can give one sandbox at most. */
export interface PodmanHostShape {
  memoryMb: number;
  cpus: number;
}

export function podmanHostShape(): PodmanHostShape {
  return {
    memoryMb: Math.floor(totalmem() / (1024 * 1024)),
    cpus: availableParallelism(),
  };
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max));

const positive = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;

/**
 * The memory, pids and cpu limits in `raw` brought into bounds this host can
 * honour. A missing or invalid value stays absent, so the default applies.
 */
export function clampPodmanLimits(
  raw: { memoryMb?: unknown; pidsLimit?: unknown; cpu?: unknown },
  host: PodmanHostShape = podmanHostShape(),
): { memoryMb?: number; pidsLimit?: number; cpu?: number } {
  const memoryMb = positive(raw.memoryMb);
  const pidsLimit = positive(raw.pidsLimit);
  const cpu = positive(raw.cpu);
  return {
    ...(memoryMb !== undefined
      ? {
          memoryMb: clamp(
            Math.round(memoryMb),
            PODMAN_MIN_MEMORY_MB,
            host.memoryMb,
          ),
        }
      : {}),
    ...(pidsLimit !== undefined
      ? {
          pidsLimit: clamp(
            Math.round(pidsLimit),
            PODMAN_MIN_PIDS_LIMIT,
            PODMAN_MAX_PIDS_LIMIT,
          ),
        }
      : {}),
    ...(cpu !== undefined
      ? { cpu: clamp(cpu, PODMAN_MIN_CPU, Math.max(1, host.cpus)) }
      : {}),
  };
}

/** The connection's machine shape, in bounds, with defaults for anything
 *  missing or invalid. */
export function podmanSettings(
  raw: unknown,
  host: PodmanHostShape = podmanHostShape(),
): PodmanSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const limits = clampPodmanLimits(r, host);
  const dns = Array.isArray(r.dns)
    ? r.dns.filter((v): v is string => typeof v === "string" && isIpv4(v))
    : [];
  return {
    memoryMb: limits.memoryMb ?? PODMAN_DEFAULT_MEMORY_MB,
    pidsLimit: limits.pidsLimit ?? PODMAN_DEFAULT_PIDS_LIMIT,
    ...(limits.cpu !== undefined ? { cpu: limits.cpu } : {}),
    dns: dns.length ? dns : [...PODMAN_DEFAULT_DNS],
  };
}
