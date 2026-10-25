import { describe, expect, test } from "bun:test";
import {
  defaultPortalMemoryFloorMb,
  meminfoMb,
  PORTAL_MEMORY_FLOOR_ENV,
  portalMemoryFloorMb,
  portalMemoryFloorWarning,
  warnIfPortalMemoryFloorUnreachable,
} from "./portal-memory-floor";

const GB = 1024;

describe("Portal memory floor", () => {
  test("a small host gets the 2 GB minimum", () => {
    expect(defaultPortalMemoryFloorMb(4 * GB)).toBe(2 * GB);
    expect(defaultPortalMemoryFloorMb(8 * GB)).toBe(2 * GB);
  });

  test("a medium host gets 15% of total memory", () => {
    // A 23 GB host could never start a Portal under the old fixed 24 GB floor.
    expect(defaultPortalMemoryFloorMb(23 * GB)).toBe(3533);
    expect(defaultPortalMemoryFloorMb(64 * GB)).toBe(9830);
  });

  test("a huge host keeps the 24 GB ceiling", () => {
    expect(defaultPortalMemoryFloorMb(160 * GB)).toBe(24 * GB);
    expect(defaultPortalMemoryFloorMb(1024 * GB)).toBe(24 * GB);
  });

  test("an unknown total keeps the 24 GB ceiling", () => {
    expect(defaultPortalMemoryFloorMb(undefined)).toBe(24 * GB);
    expect(defaultPortalMemoryFloorMb(0)).toBe(24 * GB);
  });

  test("the env var overrides the host default", () => {
    expect(
      portalMemoryFloorMb({
        totalMemoryMb: 23 * GB,
        env: { [PORTAL_MEMORY_FLOOR_ENV]: "1024" },
      }),
    ).toEqual({ floorMb: 1024, overridden: true });
    expect(
      portalMemoryFloorMb({
        totalMemoryMb: 23 * GB,
        env: { [PORTAL_MEMORY_FLOOR_ENV]: "nope" },
      }),
    ).toEqual({ floorMb: 3533, overridden: false });
    expect(portalMemoryFloorMb({ totalMemoryMb: 23 * GB, env: {} })).toEqual({
      floorMb: 3533,
      overridden: false,
    });
  });

  test("warns when the floor is at or above total memory", () => {
    const warning = portalMemoryFloorWarning({
      floorMb: 24 * GB,
      totalMemoryMb: 23 * GB,
      overridden: true,
    });
    expect(warning).toContain(`${PORTAL_MEMORY_FLOOR_ENV}=24576`);
    expect(warning).toContain("can never start");
    expect(
      portalMemoryFloorWarning({
        floorMb: 23 * GB,
        totalMemoryMb: 23 * GB,
        overridden: true,
      }),
    ).toBeDefined();
    expect(
      portalMemoryFloorWarning({
        floorMb: 3533,
        totalMemoryMb: 23 * GB,
        overridden: false,
      }),
    ).toBeUndefined();
    expect(
      portalMemoryFloorWarning({
        floorMb: 24 * GB,
        totalMemoryMb: undefined,
        overridden: false,
      }),
    ).toBeUndefined();
  });

  test("the startup check logs at most once", async () => {
    const previous = process.env[PORTAL_MEMORY_FLOOR_ENV];
    process.env[PORTAL_MEMORY_FLOOR_ENV] = String(1024 * 1024 * GB);
    try {
      const logs: string[] = [];
      await warnIfPortalMemoryFloorUnreachable((message) => logs.push(message));
      await warnIfPortalMemoryFloorUnreachable((message) => logs.push(message));
      // Hosts without /proc/meminfo have no total to compare against.
      const linux = process.platform === "linux";
      expect(logs.length).toBe(linux ? 1 : 0);
      if (linux) expect(logs[0]).toContain(PORTAL_MEMORY_FLOOR_ENV);
    } finally {
      if (previous == null) delete process.env[PORTAL_MEMORY_FLOOR_ENV];
      else process.env[PORTAL_MEMORY_FLOOR_ENV] = previous;
    }
  });

  test("reads meminfo fields in MB", () => {
    const meminfo =
      "MemTotal:       24117248 kB\nMemFree:  1024 kB\nMemAvailable:   2097152 kB\n";
    expect(meminfoMb(meminfo, "MemTotal")).toBe(23552);
    expect(meminfoMb(meminfo, "MemAvailable")).toBe(2048);
    expect(meminfoMb(meminfo, "SwapTotal")).toBeUndefined();
  });
});
