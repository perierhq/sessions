import { describe, expect, spyOn, test } from "bun:test";
import {
  classifyTopology,
  parseRemotes,
  parseSha256Checksum,
  pruneReleases,
  releasesToKeep,
  restartReleaseWithRollback,
} from "./update";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

const UPSTREAM_HTTPS = "https://github.com/perierhq/sessions.git";
const UPSTREAM_SSH = "git@github.com:perierhq/sessions.git";
const FORK = "git@github.com:acme/opensession.git";

describe("parseSha256Checksum", () => {
  const digest = "a".repeat(64);

  test("accepts sha256sum sidecars and bare digests", () => {
    expect(
      parseSha256Checksum(`${digest}  opensession-linux-x64.tar.gz\n`),
    ).toBe(digest);
    expect(parseSha256Checksum(digest.toUpperCase())).toBe(digest);
  });

  test("rejects malformed or non-SHA-256 values", () => {
    expect(parseSha256Checksum("not-a-checksum file.tar.gz")).toBeUndefined();
    expect(parseSha256Checksum("a".repeat(63))).toBeUndefined();
    expect(parseSha256Checksum("")).toBeUndefined();
  });
});

describe("parseRemotes", () => {
  test("parses fetch remotes and ignores push duplicates", () => {
    const out = [
      `origin\t${FORK} (fetch)`,
      `origin\t${FORK} (push)`,
      `upstream\t${UPSTREAM_HTTPS} (fetch)`,
      `upstream\t${UPSTREAM_HTTPS} (push)`,
    ].join("\n");
    expect(parseRemotes(out)).toEqual([
      { name: "origin", url: FORK },
      { name: "upstream", url: UPSTREAM_HTTPS },
    ]);
  });

  test("empty input parses to no remotes", () => {
    expect(parseRemotes("")).toEqual([]);
  });
});

describe("classifyTopology", () => {
  test("origin = fork + upstream remote → fork topology from that remote", () => {
    for (const url of [UPSTREAM_HTTPS, UPSTREAM_SSH]) {
      expect(
        classifyTopology([
          { name: "origin", url: FORK },
          { name: "upstream", url },
        ]),
      ).toEqual({ source: "upstream", kind: "fork" });
    }
  });

  test("the upstream remote may have any name", () => {
    expect(
      classifyTopology([
        { name: "origin", url: FORK },
        { name: "tella", url: UPSTREAM_SSH },
      ]),
    ).toEqual({ source: "tella", kind: "fork" });
  });

  test("origin-only clone of the upstream project stays ff-only", () => {
    expect(classifyTopology([{ name: "origin", url: UPSTREAM_HTTPS }])).toEqual(
      {
        source: "origin",
        kind: "origin",
      },
    );
  });

  test("origin IS the upstream project even with extra remotes → ff-only origin", () => {
    // Both remotes point at the project (e.g. our own instance): fork-merge
    // semantics would be wrong; plain ff from origin is.
    expect(
      classifyTopology([
        { name: "origin", url: UPSTREAM_SSH },
        { name: "mirror", url: UPSTREAM_HTTPS },
      ]),
    ).toEqual({ source: "origin", kind: "origin" });
  });

  test("fork origin without an upstream remote stays ff-only against origin", () => {
    expect(classifyTopology([{ name: "origin", url: FORK }])).toEqual({
      source: "origin",
      kind: "origin",
    });
  });

  test("no remotes at all → conservative default", () => {
    expect(classifyTopology([])).toEqual({ source: "origin", kind: "origin" });
  });
});

describe.each(["restart", "health"])(
  "release rollback after %s failure",
  (failure) => {
    test.each(["healthy", "restart fails", "health fails"])(
      "rollback: %s",
      async (outcome) => {
        const dir = mkdtempSync(join(tmpdir(), "opensession-rollback-test-"));
        const src = join(dir, "src");
        const previous = join(dir, "previous");
        symlinkSync(join(dir, "candidate"), src);
        const messages: string[] = [];
        const log = spyOn(console, "log").mockImplementation((message) => {
          messages.push(String(message));
        });
        const calls: string[] = [];
        let restarts = 0;
        try {
          const code = await restartReleaseWithRollback(
            src,
            previous,
            {},
            {
              healthBaseUrl: async () => "http://127.0.0.1:3850",
              service: {
                isInstalled: async () => true,
                restartExecutor: async () => {
                  calls.push("executor");
                  return 0;
                },
                control: async () => {
                  calls.push("restart");
                  restarts++;
                  if (restarts === 2) expect(readlinkSync(src)).toBe(previous);
                  if (restarts === 1) return failure === "restart" ? 1 : 0;
                  return outcome === "restart fails" ? 1 : 0;
                },
                waitHealthy: async () => {
                  calls.push("health");
                  return restarts === 2 && outcome === "healthy";
                },
              },
            },
          );
          expect(code).toBe(1); // An unsuccessful update still fails after recovery.
          expect(readlinkSync(src)).toBe(previous);
          const output = messages.join("\n");
          if (outcome === "healthy")
            expect(output).toContain("verified healthy");
          else {
            expect(output).toContain("rollback did not come back healthy");
            expect(output).toContain("opensession restart");
            expect(output).not.toContain("verified healthy");
          }
          expect(calls).toEqual([
            "executor",
            "restart",
            ...(failure === "health" ? ["health"] : []),
            "executor",
            "restart",
            ...(outcome === "restart fails" ? [] : ["health"]),
          ]);
        } finally {
          log.mockRestore();
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );
  },
);

describe("release retention", () => {
  function releasesDir(names: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "opensession-releases-test-"));
    names.forEach((name, index) => {
      const release = join(dir, name);
      mkdirSync(release);
      writeFileSync(join(release, "release.json"), "{}");
      // Oldest first: the order releases were built in.
      const at = new Date(Date.UTC(2026, 0, 1 + index));
      utimesSync(release, at, at);
    });
    return dir;
  }
  const names = (n: number) =>
    Array.from({ length: n }, (_, i) => `opensession-0.${i}.0-linux-arm64`);

  test("keeps the current release and the three before it", () => {
    const all = names(8);
    const dir = releasesDir(all);
    try {
      const removed = pruneReleases(dir, {
        current: join(dir, all[7]!),
        keep: 3,
        inUse: new Set(),
      });
      expect(removed.sort()).toEqual(all.slice(0, 4).sort());
      expect(readdirSync(dir).sort()).toEqual(all.slice(4).sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("never removes the rollback target, a release in use, or anything that is not a release", () => {
    const all = names(7);
    const dir = releasesDir(all);
    mkdirSync(join(dir, ".incoming.123"));
    mkdirSync(join(dir, "notes"));
    try {
      const removed = pruneReleases(dir, {
        // Rolled back: current is older than the newest unpacked one.
        current: join(dir, all[2]!),
        keep: 1,
        protect: [join(dir, all[0]!)],
        inUse: new Set([join(dir, all[1]!)]),
      });
      expect(removed.sort()).toEqual([all[3], all[4], all[5]].sort());
      expect(existsSync(join(dir, all[6]!))).toBe(true);
      expect(existsSync(join(dir, ".incoming.123"))).toBe(true);
      expect(existsSync(join(dir, "notes"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps everything when the current release is unknown", () => {
    const dir = releasesDir(names(6));
    try {
      expect(
        pruneReleases(dir, { current: "", keep: 0, inUse: new Set() }),
      ).toEqual([]);
      expect(readdirSync(dir)).toHaveLength(6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the number kept is configurable", () => {
    expect(releasesToKeep(undefined)).toBe(3);
    expect(releasesToKeep("5")).toBe(5);
    expect(releasesToKeep("0")).toBe(0);
    expect(releasesToKeep("-1")).toBe(3);
    expect(releasesToKeep("many")).toBe(3);
  });
});
