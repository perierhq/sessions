/**
 * Resource-aware admission for detached run-host launches.
 *
 * Every accepted prompt used to launch its engine process unconditionally,
 * so the first hard wall under load was the machine itself: nothing stopped
 * the Nth engine from exhausting memory and taking the gateway and kernel
 * down with the agents. Before each launch the gateway now checks live
 * capacity — MemAvailable, CPU pressure (PSI), and the active host count —
 * and waits with bounded backoff instead of starting into an overload.
 *
 * Waiting is deliberately in-memory: the prompt's queue claim and run journal
 * are already durable, so a crash while waiting re-admits the same turn.
 * Missing signals fail open (a machine without /proc must not stop launches);
 * present signals fail the launch closed only after the configured patience
 * runs out, with a distinct error type so callers do not "fall back" to an
 * in-process run that would consume the same scarce memory.
 *
 * Gateway process: knobs read ~/.opensession.env (or a drop-in on
 * opensession.service).
 */
import { readFileSync } from "fs";
import { totalmem } from "node:os";
import { audit } from "./audit";
import { scaledMemoryFloorMb } from "./portal-memory-floor";
import { envCapacity } from "./shared/env-capacity";

/** Default free-memory floor: 5% of the host, at least 1 GiB, at most 4 GiB.
 *  A fixed 4 GiB refused most launches on a host that usually has 1–2.5 GiB
 *  free; the share keeps the control plane's headroom proportional instead.
 *  Same scaling as the Portal floor (portal-memory-floor.ts). */
const RUN_HOST_MEMORY_FLOOR_SHARE = 0.05;
const MIN_RUN_HOST_MEMORY_FLOOR_MB = 1_024;
const MAX_RUN_HOST_MEMORY_FLOOR_MB = 4_096;

export type HostAdmissionLimits = {
  /** Hard cap on concurrently active detached hosts. */
  maxActiveHosts: number;
  /** MemAvailable floor that must remain after reserving the new host. */
  minAvailableMb: number;
  /** Expected worst-typical footprint reserved for the host being admitted. */
  reservedPerHostMb: number;
  /** Maximum acceptable CPU PSI some avg10 percentage. */
  maxCpuPressure: number;
  /** How long a launch may wait for capacity before failing closed. */
  admissionTimeoutMs: number;
};

export function hostAdmissionLimits(
  env: Record<string, string | undefined> = process.env,
  totalMemoryBytes: number = totalmem(),
): HostAdmissionLimits {
  return {
    maxActiveHosts: envCapacity(
      "OPENSESSION_RUN_HOST_MAX_ACTIVE",
      128,
      1,
      4_096,
      env,
    ),
    minAvailableMb: envCapacity(
      "OPENSESSION_RUN_HOST_MIN_AVAILABLE_MB",
      scaledMemoryFloorMb(
        totalMemoryBytes / 1024 ** 2,
        RUN_HOST_MEMORY_FLOOR_SHARE,
        MIN_RUN_HOST_MEMORY_FLOOR_MB,
        MAX_RUN_HOST_MEMORY_FLOOR_MB,
      ),
      256,
      1_048_576,
      env,
    ),
    reservedPerHostMb: envCapacity(
      "OPENSESSION_RUN_HOST_RESERVED_MB",
      1_024,
      0,
      65_536,
      env,
    ),
    maxCpuPressure: envCapacity(
      "OPENSESSION_RUN_HOST_MAX_CPU_PRESSURE",
      85,
      1,
      100,
      env,
    ),
    // Short on purpose: a launch that waits holds its run open with nothing
    // to show for it. A refusal fails fast with its reason, and the caller
    // requeues the run with backoff (runHostAdmissionRetryDelayMs).
    admissionTimeoutMs:
      envCapacity(
        "OPENSESSION_RUN_HOST_ADMISSION_TIMEOUT_S",
        60,
        10,
        86_400,
        env,
      ) * 1_000,
  };
}

export type HostCapacitySnapshot = {
  /** MemAvailable in MiB, or null when the signal is unavailable. */
  memAvailableMb: number | null;
  /** CPU PSI `some avg10` percentage, or null when unavailable. */
  cpuSomeAvg10: number | null;
  /** Currently active detached hosts on this gateway. */
  activeHosts: number;
  /** Launches admitted but not yet reflected in MemAvailable. */
  pendingHosts: number;
};

export function readMemAvailableMb(
  read: (path: string) => string = readProcFile,
): number | null {
  const match = /MemAvailable:\s+(\d+)\s*kB/.exec(read("/proc/meminfo"));
  return match ? Math.floor(Number(match[1]) / 1_024) : null;
}

export function readCpuSomeAvg10(
  read: (path: string) => string = readProcFile,
): number | null {
  const match = /some avg10=([\d.]+)/.exec(read("/proc/pressure/cpu"));
  return match ? Number(match[1]) : null;
}

function readProcFile(path: string): string {
  try {
    // Failures (macOS, containers without PSI) simply disable that signal.
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export type AdmissionDecision =
  | { admit: true }
  | { admit: false; reason: string };

/** Pure decision: admit unless a *present* signal says the machine is full. */
export function decideRunHostAdmission(
  snapshot: HostCapacitySnapshot,
  limits: HostAdmissionLimits,
): AdmissionDecision {
  const admittedHosts = snapshot.activeHosts + snapshot.pendingHosts;
  if (admittedHosts >= limits.maxActiveHosts)
    return {
      admit: false,
      reason: `active and pending run hosts at cap (${admittedHosts}/${limits.maxActiveHosts})`,
    };
  const reservedMb = limits.reservedPerHostMb * (snapshot.pendingHosts + 1);
  if (
    snapshot.memAvailableMb !== null &&
    snapshot.memAvailableMb - reservedMb < limits.minAvailableMb
  )
    return {
      admit: false,
      reason: `not enough free memory: ${snapshot.memAvailableMb} MiB free, ${limits.minAvailableMb + reservedMb} MiB needed (${limits.minAvailableMb} MiB kept free for the host + ${reservedMb} MiB for ${snapshot.pendingHosts ? `this and ${snapshot.pendingHosts} starting run${snapshot.pendingHosts === 1 ? "" : "s"}` : "this run"})`,
    };
  if (
    snapshot.cpuSomeAvg10 !== null &&
    snapshot.cpuSomeAvg10 > limits.maxCpuPressure
  )
    return {
      admit: false,
      reason: `CPU pressure some avg10 ${snapshot.cpuSomeAvg10}% exceeds ${limits.maxCpuPressure}%`,
    };
  return { admit: true };
}

const REFUSAL_PREFIX = "Run host launch refused: ";

/** Launch was refused because capacity never appeared within the timeout.
 * Callers must fail the turn visibly, not fall back to an in-process run. */
export class RunHostAdmissionError extends Error {
  constructor(reason: string) {
    super(`${REFUSAL_PREFIX}${reason}`);
    this.name = "RunHostAdmissionError";
  }
}

/** Whether a run's error text is an admission refusal: nothing ran, so the
 *  run can be requeued as it was. Matches the text because the error often
 *  reaches callers as a string (a run result or a ledger entry). */
export function isRunHostAdmissionRefusal(
  message: string | undefined,
): boolean {
  return !!message?.includes(REFUSAL_PREFIX);
}

/** Wait before requeueing a refused run: 2 minutes, doubling per attempt, at
 *  most 30. Memory pressure usually outlasts a few seconds of backoff. */
export function runHostAdmissionRetryDelayMs(attempt: number): number {
  return Math.min(30 * 60_000, 2 * 60_000 * 2 ** Math.max(0, attempt - 1));
}

export type WaitForAdmissionOptions = {
  sessionId: string;
  activeHosts: () => number;
  pendingHosts?: () => number;
  /** Reserve capacity synchronously with a successful decision. */
  onAdmit?: () => void;
  shouldCancel?: () => boolean;
  limits?: HostAdmissionLimits;
  snapshot?: (
    activeHosts: number,
    pendingHosts: number,
  ) => HostCapacitySnapshot;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

function defaultSnapshot(
  activeHosts: number,
  pendingHosts: number,
): HostCapacitySnapshot {
  return {
    memAvailableMb: readMemAvailableMb(),
    cpuSomeAvg10: readCpuSomeAvg10(),
    activeHosts,
    pendingHosts,
  };
}

/**
 * Wait until the machine can take one more run host. Returns "admitted" or
 * "cancelled"; throws RunHostAdmissionError when the timeout elapses while
 * the machine is still full.
 */
export async function waitForRunHostAdmission(
  options: WaitForAdmissionOptions,
): Promise<"admitted" | "cancelled"> {
  const limits = options.limits ?? hostAdmissionLimits();
  const snapshot = options.snapshot ?? defaultSnapshot;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = options.now ?? Date.now;
  const startedAt = now();
  let waited = false;
  let backoffMs = 1_000;
  let lastReason = "";
  for (;;) {
    if (options.shouldCancel?.()) return "cancelled";
    const decision = decideRunHostAdmission(
      snapshot(options.activeHosts(), options.pendingHosts?.() ?? 0),
      limits,
    );
    if (decision.admit) {
      if (waited)
        audit({
          msg: "run_host_admission_resumed",
          session_id: options.sessionId,
          waited_ms: now() - startedAt,
        });
      // No await separates the final capacity check from this reservation.
      // Concurrent callers therefore see it in their own pendingHosts count.
      options.onAdmit?.();
      return "admitted";
    }
    if (!waited || decision.reason !== lastReason) {
      audit({
        msg: "run_host_admission_wait",
        session_id: options.sessionId,
        reason: decision.reason,
      });
      console.warn(
        `[host-admission] deferring run host launch for ${options.sessionId}: ${decision.reason}`,
      );
    }
    waited = true;
    lastReason = decision.reason;
    if (now() - startedAt >= limits.admissionTimeoutMs) {
      audit({
        msg: "run_host_admission_refused",
        session_id: options.sessionId,
        reason: decision.reason,
        waited_ms: now() - startedAt,
      });
      throw new RunHostAdmissionError(decision.reason);
    }
    const remainingMs = limits.admissionTimeoutMs - (now() - startedAt);
    await sleep(Math.min(backoffMs, remainingMs));
    backoffMs = Math.min(30_000, backoffMs * 2);
  }
}
