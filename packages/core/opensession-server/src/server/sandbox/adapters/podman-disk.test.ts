import { describe, expect, test } from "bun:test";
import { PODMAN_NAME_PREFIX } from "./podman-cli";
import {
  duErrorsOnlyVanished,
  GIB,
  parseDuTotals,
  parseVolumeMountpoints,
  podmanDiskWarnings,
} from "./podman-disk";
import {
  HOST_DU_DENIED_STDERR,
  HOST_DU_OUTPUT,
  HOST_DU_VANISHED_STDERR,
  HOST_MOUNTPOINT,
  HOST_VOLUME_LS_EMPTY,
  HOST_VOLUME_LS_JSON,
} from "./podman-host-fixture";

describe("podman disk", () => {
  test("reads sandbox volume mountpoints from podman volume ls", () => {
    expect([
      ...parseVolumeMountpoints(HOST_VOLUME_LS_JSON, PODMAN_NAME_PREFIX),
    ]).toEqual([["opensession-sbx-sess-1-home", HOST_MOUNTPOINT]]);
    expect(
      parseVolumeMountpoints(HOST_VOLUME_LS_EMPTY, PODMAN_NAME_PREFIX).size,
    ).toBe(0);
    // Not ours, or no usable mountpoint: left out.
    const odd = JSON.stringify([
      { Name: "someone-else", Mountpoint: "/data/a" },
      { Name: "opensession-sbx-a-home", Mountpoint: "relative/_data" },
      { Name: "opensession-sbx-b-home", Mountpoint: "/x\n/_data" },
      { Name: "opensession-sbx-c-home" },
    ]);
    expect(parseVolumeMountpoints(odd, PODMAN_NAME_PREFIX).size).toBe(0);
    expect(() => parseVolumeMountpoints("nope", PODMAN_NAME_PREFIX)).toThrow(
      /JSON/,
    );
    expect(() => parseVolumeMountpoints("{}", PODMAN_NAME_PREFIX)).toThrow(
      /no volume list/,
    );
  });

  test("reads du totals and tells vanished files from real errors", () => {
    expect([...parseDuTotals(HOST_DU_OUTPUT)]).toEqual([
      [HOST_MOUNTPOINT, 3002368],
    ]);
    expect(parseDuTotals("garbage\n\n12x\t/a\n").size).toBe(0);
    expect(duErrorsOnlyVanished(HOST_DU_VANISHED_STDERR)).toBe(true);
    expect(duErrorsOnlyVanished(HOST_DU_DENIED_STDERR)).toBe(false);
    expect(
      duErrorsOnlyVanished(HOST_DU_VANISHED_STDERR + HOST_DU_DENIED_STDERR),
    ).toBe(false);
    expect(duErrorsOnlyVanished("")).toBe(false);
  });

  test("warnings name low space and large volumes, largest first", () => {
    expect(podmanDiskWarnings(undefined)).toEqual([]);
    expect(
      podmanDiskWarnings({
        checkedAt: "2026-01-01T00:00:00.000Z",
        freeBytes: 2 * GIB,
        volumes: [
          { sandboxId: "os-a", sessionId: "a", bytes: 12 * GIB },
          { sandboxId: "os-b", sessionId: "b", bytes: 21 * GIB },
        ],
      }),
    ).toEqual([
      "Only 2.0 GiB free for sandbox storage: sandboxes will not start below 5.0 GiB",
      "Session b uses 21.0 GiB, over the 20.0 GiB limit: its sandbox is stopped",
      "Session a uses 12.0 GiB (stops at 20.0 GiB)",
    ]);
  });

  test("warnings name a failed check and homes it could not find", () => {
    const lines = podmanDiskWarnings({
      checkedAt: "2026-01-01T00:00:00.000Z",
      volumes: [],
      unknownSessions: ["a", "b"],
      error: "podman system df: database is locked",
      startsRefused: true,
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /^Disk check failed .*: podman system df: database is locked\. Sandboxes will not start until a check succeeds$/,
    );
    expect(lines[1]).toBe("Could not measure the home of sessions a, b");
  });
});
