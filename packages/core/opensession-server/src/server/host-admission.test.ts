import { describe, expect, test } from "bun:test";
import {
  decideRunHostAdmission,
  hostAdmissionLimits,
  isRunHostAdmissionRefusal,
  runHostAdmissionRetryDelayMs,
  readCpuSomeAvg10,
  readMemAvailableMb,
  RunHostAdmissionError,
  waitForRunHostAdmission,
  type HostAdmissionLimits,
  type HostCapacitySnapshot,
} from "./host-admission";

const limits: HostAdmissionLimits = {
  maxActiveHosts: 4,
  minAvailableMb: 1_000,
  reservedPerHostMb: 500,
  maxCpuPressure: 85,
  admissionTimeoutMs: 10_000,
};

const roomy: HostCapacitySnapshot = {
  memAvailableMb: 8_000,
  cpuSomeAvg10: 5,
  activeHosts: 1,
  pendingHosts: 0,
};

describe("decideRunHostAdmission", () => {
  test("admits with headroom", () => {
    expect(decideRunHostAdmission(roomy, limits)).toEqual({ admit: true });
  });

  test("refuses at the active host cap", () => {
    const decision = decideRunHostAdmission(
      { ...roomy, activeHosts: 4 },
      limits,
    );
    expect(decision.admit).toBe(false);
    if (!decision.admit) expect(decision.reason).toContain("4/4");
  });

  test("refuses when reserving the host would break the memory floor", () => {
    // 1400 - 500 reserved = 900 < 1000 floor.
    const decision = decideRunHostAdmission(
      { ...roomy, memAvailableMb: 1_400 },
      limits,
    );
    expect(decision.admit).toBe(false);
    // Exactly at the floor admits.
    expect(
      decideRunHostAdmission({ ...roomy, memAvailableMb: 1_500 }, limits),
    ).toEqual({ admit: true });
  });

  test("reserves memory and host slots for pending launches", () => {
    expect(
      decideRunHostAdmission(
        { ...roomy, activeHosts: 2, pendingHosts: 2 },
        limits,
      ).admit,
    ).toBe(false);
    expect(
      decideRunHostAdmission(
        { ...roomy, memAvailableMb: 2_400, pendingHosts: 2 },
        limits,
      ).admit,
    ).toBe(false);
  });

  test("refuses under CPU pressure", () => {
    const decision = decideRunHostAdmission(
      { ...roomy, cpuSomeAvg10: 92.5 },
      limits,
    );
    expect(decision.admit).toBe(false);
  });

  test("missing signals fail open", () => {
    expect(
      decideRunHostAdmission(
        {
          memAvailableMb: null,
          cpuSomeAvg10: null,
          activeHosts: 0,
          pendingHosts: 0,
        },
        limits,
      ),
    ).toEqual({ admit: true });
  });
});

describe("proc parsing", () => {
  test("parses MemAvailable in MiB", () => {
    const read = () =>
      "MemTotal:       128000000 kB\nMemAvailable:   116736000 kB\n";
    expect(readMemAvailableMb(read)).toBe(114_000);
    expect(readMemAvailableMb(() => "")).toBeNull();
  });

  test("parses CPU PSI some avg10", () => {
    const read = () =>
      "some avg10=12.34 avg60=5.00 avg300=1.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n";
    expect(readCpuSomeAvg10(read)).toBe(12.34);
    expect(readCpuSomeAvg10(() => "")).toBeNull();
  });
});

describe("waitForRunHostAdmission", () => {
  test("admits immediately without sleeping when capacity exists", async () => {
    let slept = 0;
    const result = await waitForRunHostAdmission({
      sessionId: "s1",
      activeHosts: () => 1,
      limits,
      snapshot: (activeHosts) => ({ ...roomy, activeHosts }),
      sleep: async () => {
        slept += 1;
      },
    });
    expect(result).toBe("admitted");
    expect(slept).toBe(0);
  });

  test("waits with backoff until capacity appears", async () => {
    const sleeps: number[] = [];
    let mem = 1_000;
    const result = await waitForRunHostAdmission({
      sessionId: "s2",
      activeHosts: () => 1,
      limits,
      snapshot: (activeHosts, pendingHosts) => ({
        ...roomy,
        memAvailableMb: mem,
        activeHosts,
        pendingHosts,
      }),
      sleep: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length === 3) mem = 8_000;
      },
      now: () => 0,
    });
    expect(result).toBe("admitted");
    expect(sleeps).toEqual([1_000, 2_000, 4_000]);
  });

  test("reserves admission before another caller can pass", async () => {
    const oneHostLimit = { ...limits, maxActiveHosts: 1 };
    let pendingHosts = 0;
    const first = await waitForRunHostAdmission({
      sessionId: "first",
      activeHosts: () => 0,
      pendingHosts: () => pendingHosts,
      onAdmit: () => {
        pendingHosts += 1;
      },
      limits: oneHostLimit,
      snapshot: (activeHosts, pending) => ({
        ...roomy,
        activeHosts,
        pendingHosts: pending,
      }),
    });
    expect(first).toBe("admitted");
    expect(pendingHosts).toBe(1);

    let slept = false;
    const second = await waitForRunHostAdmission({
      sessionId: "second",
      activeHosts: () => 0,
      pendingHosts: () => pendingHosts,
      onAdmit: () => {
        pendingHosts += 1;
      },
      limits: oneHostLimit,
      snapshot: (activeHosts, pending) => ({
        ...roomy,
        activeHosts,
        pendingHosts: pending,
      }),
      sleep: async () => {
        slept = true;
        pendingHosts -= 1;
      },
      now: () => 0,
    });
    expect(second).toBe("admitted");
    expect(slept).toBe(true);
    expect(pendingHosts).toBe(1);
  });

  test("cancellation wins over waiting", async () => {
    let cancelled = false;
    const result = await waitForRunHostAdmission({
      sessionId: "s3",
      activeHosts: () => 4,
      shouldCancel: () => cancelled,
      limits,
      snapshot: (activeHosts) => ({ ...roomy, activeHosts }),
      sleep: async () => {
        cancelled = true;
      },
      now: () => 0,
    });
    expect(result).toBe("cancelled");
  });

  test("fails closed with a distinct error after the timeout", async () => {
    let clock = 0;
    await expect(
      waitForRunHostAdmission({
        sessionId: "s4",
        activeHosts: () => 4,
        limits,
        snapshot: (activeHosts) => ({ ...roomy, activeHosts }),
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
      }),
    ).rejects.toBeInstanceOf(RunHostAdmissionError);
  });
});

describe("admission sized to the host", () => {
  const GIB = 1024 ** 3;

  test("the memory floor scales with the host instead of a fixed 4 GiB", () => {
    // A 22.9 GB host keeps about 5% free, not 4096 MiB it rarely has.
    const small = hostAdmissionLimits({}, 22.9e9);
    expect(small.minAvailableMb).toBeGreaterThan(1_000);
    expect(small.minAvailableMb).toBeLessThan(1_200);
    // A small host still keeps 1 GiB; a big one never more than 4 GiB.
    expect(hostAdmissionLimits({}, 8 * GIB).minAvailableMb).toBe(1_024);
    expect(hostAdmissionLimits({}, 256 * GIB).minAvailableMb).toBe(4_096);
    // An unknown total keeps the old ceiling.
    expect(hostAdmissionLimits({}, 0).minAvailableMb).toBe(4_096);
  });

  test("an explicit floor still wins", () => {
    expect(
      hostAdmissionLimits(
        { OPENSESSION_RUN_HOST_MIN_AVAILABLE_MB: "2048" },
        22.9e9,
      ).minAvailableMb,
    ).toBe(2_048);
  });

  test("a full host refuses within a minute, not fifteen", () => {
    expect(hostAdmissionLimits({}, 22.9e9).admissionTimeoutMs).toBe(60_000);
    expect(
      hostAdmissionLimits(
        { OPENSESSION_RUN_HOST_ADMISSION_TIMEOUT_S: "300" },
        22.9e9,
      ).admissionTimeoutMs,
    ).toBe(300_000);
  });

  test("the refusal says what was free and what the run needed", () => {
    const decision = decideRunHostAdmission(
      { ...roomy, memAvailableMb: 1_266 },
      { ...limits, minAvailableMb: 1_147, reservedPerHostMb: 1_024 },
    );
    expect(decision.admit).toBe(false);
    if (!decision.admit)
      expect(decision.reason).toBe(
        "not enough free memory: 1266 MiB free, 2171 MiB needed (1147 MiB kept free for the host + 1024 MiB for this run)",
      );
  });

  test("callers can tell a refusal apart and back off", () => {
    const error = new RunHostAdmissionError("not enough free memory");
    expect(isRunHostAdmissionRefusal(error.message)).toBe(true);
    expect(isRunHostAdmissionRefusal("pi: 429")).toBe(false);
    expect(
      [1, 2, 3, 4, 5, 6].map((attempt) =>
        runHostAdmissionRetryDelayMs(attempt),
      ),
    ).toEqual([
      2 * 60_000,
      4 * 60_000,
      8 * 60_000,
      16 * 60_000,
      30 * 60_000,
      30 * 60_000,
    ]);
  });
});
