import { describe, expect, test } from "bun:test";
import {
  clampPodmanLimits,
  PODMAN_MAX_PIDS_LIMIT,
  podmanSettings,
} from "./podman-settings";

const host = { memoryMb: 8192, cpus: 4 };

describe("podman machine shape bounds", () => {
  test("limits are clamped to what the host can honour", () => {
    expect(
      clampPodmanLimits({ memoryMb: 1e9, pidsLimit: 1e9, cpu: 64 }, host),
    ).toEqual({ memoryMb: 8192, pidsLimit: PODMAN_MAX_PIDS_LIMIT, cpu: 4 });
    expect(
      clampPodmanLimits({ memoryMb: 10, pidsLimit: 2, cpu: 0.01 }, host),
    ).toEqual({ memoryMb: 512, pidsLimit: 64, cpu: 0.1 });
    expect(
      clampPodmanLimits({ memoryMb: 2048.4, pidsLimit: 511.6 }, host),
    ).toEqual({ memoryMb: 2048, pidsLimit: 512 });
  });

  test("missing or invalid limits stay absent", () => {
    expect(
      clampPodmanLimits({ memoryMb: -1, pidsLimit: "4096", cpu: NaN }, host),
    ).toEqual({});
  });

  test("the effective shape clamps a stored value and defaults the rest", () => {
    expect(podmanSettings({ pidsLimit: 1e9, cpu: 32 }, host)).toEqual({
      memoryMb: 4096,
      pidsLimit: PODMAN_MAX_PIDS_LIMIT,
      cpu: 4,
      dns: ["1.1.1.1", "9.9.9.9"],
    });
  });
});
