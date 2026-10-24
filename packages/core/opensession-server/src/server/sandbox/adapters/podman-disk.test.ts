import { describe, expect, test } from "bun:test";
import { GIB, parseSystemDfVolumes, podmanDiskWarnings } from "./podman-disk";

describe("podman disk", () => {
  test("reads volume sizes from podman system df", () => {
    const output = JSON.stringify({
      Images: [],
      Containers: [],
      Volumes: [
        { VolumeName: "os-a-home", Links: 1, Size: 1234, ReclaimableSize: 0 },
        { VolumeName: "other", Links: 0, Size: 5, ReclaimableSize: 5 },
        { VolumeName: "broken" },
      ],
    });
    expect([...parseSystemDfVolumes(output)]).toEqual([
      ["os-a-home", 1234],
      ["other", 5],
    ]);
    expect(() => parseSystemDfVolumes("nope")).toThrow(/JSON/);
    expect(() => parseSystemDfVolumes("{}")).toThrow(/no volume list/);
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
