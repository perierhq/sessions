// What This machine (container) refuses, and that a refusal leaves nothing
// behind: automation and source-verification runs create nothing, every
// unmet host prerequisite is named, a callback that resolves to anything but
// a public IPv4 address is refused before a container exists, and a
// qualification sandbox is removed even when its start fails.
import { describe, expect, test } from "bun:test";
import { findRemoteStateBySession } from "./bootstrap";
import {
  PodmanProvider,
  qualifyPodmanConnection,
  type PodmanQualifyDeps,
} from "./podman";
import {
  fakePodman,
  fakeProviderDeps,
  IMAGE,
  type FakeOptions,
} from "./podman-test-fixture";

const HOST = {
  security: { rootless: true, selinuxEnabled: true },
  cgroupVersion: "v2",
  cgroupControllers: ["cpuset", "cpu", "io", "memory", "pids"],
};
const info = (host: object = HOST) =>
  JSON.stringify({ version: { Version: "5.8.2" }, host });

function setup(o: FakeOptions = {}) {
  return fakePodman({ info: info(), ...o });
}

function qualifyDeps(
  fake: ReturnType<typeof fakePodman>,
  extra: Partial<PodmanQualifyDeps> = {},
): PodmanQualifyDeps {
  return {
    ...fakeProviderDeps(fake),
    platform: "linux",
    uid: 1001,
    linger: () => true,
    nftPresent: () => true,
    ensureImage: async () => IMAGE,
    hostControl: async () => true,
    hostPaths: ["/opt/opensession"],
    ...extra,
  };
}

const qualify = (
  fake: ReturnType<typeof fakePodman>,
  extra: Partial<PodmanQualifyDeps> = {},
) => qualifyPodmanConnection(() => {}, qualifyDeps(fake, extra));

const created = (fake: ReturnType<typeof fakePodman>) =>
  fake.calls.some(
    ({ argv }) =>
      argv[0] === "create" ||
      (argv[0] === "pod" && argv[1] === "create") ||
      (argv[0] === "volume" && argv[1] === "create"),
  );

const removed = (fake: ReturnType<typeof fakePodman>) =>
  fake.calls.some(
    ({ argv }) => argv[0] === "pod" && argv[1] === "rm" && argv[2] === "-f",
  );

let seq = 0;
const sessionId = () => `bks-podman-refuse-${Date.now().toString(36)}-${++seq}`;

describe("runs This machine (container) refuses", () => {
  test("automation and source-verification runs create nothing", async () => {
    for (const spec of [
      { trustProfile: "automation" as const },
      { sourceVerification: true },
    ]) {
      const fake = setup();
      const provider = new PodmanProvider(fakeProviderDeps(fake));
      const id = sessionId();
      await expect(provider.ensure({ sessionId: id, ...spec })).rejects.toThrow(
        "automation runs are not supported on This machine (container)",
      );
      expect(fake.calls).toEqual([]);
      expect(findRemoteStateBySession("podman", id)).toBeNull();
    }
  });
});

describe("host prerequisites", () => {
  test("podman not installed, or info that is not JSON", async () => {
    const missing = setup();
    const run: typeof missing.run = async (argv, opts) =>
      argv[0] === "info"
        ? { exitCode: 127, stdout: "", stderr: "podman: not found" }
        : missing.run(argv, opts);
    await expect(qualify(missing, { run })).rejects.toThrow(
      "This machine (container) needs Linux with rootless Podman: podman is not installed",
    );
    await expect(
      qualify(setup({ info: "WARN[0000] {not json" })),
    ).rejects.toThrow("podman info did not return JSON");
  });

  test("cgroups v1 and an undelegated memory or pids controller", async () => {
    await expect(
      qualify(setup({ info: info({ ...HOST, cgroupVersion: "v1" }) })),
    ).rejects.toThrow("This machine (container) needs cgroups v2");
    for (const controller of ["memory", "pids"]) {
      const fake = setup({
        info: info({
          ...HOST,
          cgroupControllers: HOST.cgroupControllers.filter(
            (c) => c !== controller,
          ),
        }),
      });
      await expect(qualify(fake)).rejects.toThrow(
        `needs the ${controller} cgroup controller delegated to this user`,
      );
      expect(created(fake)).toBe(false);
    }
    const none = setup({
      info: info({ ...HOST, cgroupControllers: undefined }),
    });
    await expect(qualify(none)).rejects.toThrow(/memory cgroup controller/);
  });
});

describe("callback address", () => {
  test("private, link-local and metadata addresses are refused before anything is created", async () => {
    for (const addresses of [
      ["10.1.2.3"],
      ["192.168.1.20"],
      ["169.254.169.254"],
      ["172.16.0.9"],
      // One private address among public ones is enough to refuse.
      ["203.0.113.7", "10.0.0.5"],
    ]) {
      const fake = setup();
      await expect(
        qualify(fake, { lookup: async () => addresses }),
      ).rejects.toThrow(/private or host address/);
      expect(created(fake)).toBe(false);
    }
  });

  test("an IPv6-only callback is refused", async () => {
    const noA = setup();
    await expect(qualify(noA, { lookup: async () => [] })).rejects.toThrow(
      "callback base URL has no IPv4 address",
    );
    expect(created(noA)).toBe(false);
    const literal = setup();
    await expect(
      qualify(literal, { callbackBaseUrl: () => "wss://[2001:db8::7]" }),
    ).rejects.toThrow("callback base URL has no IPv4 address");
    expect(created(literal)).toBe(false);
  });
});

describe("qualification cleanup", () => {
  test("a test sandbox that fails to start is still removed", async () => {
    const fake = setup({ nftInstallFails: true });
    await expect(qualify(fake)).rejects.toThrow(/Operation not permitted/);
    expect(created(fake)).toBe(true);
    expect(removed(fake)).toBe(true);
  });

  test("a test sandbox that cannot be removed fails qualification", async () => {
    const fake = setup({ podSurvivesRm: true });
    await expect(qualify(fake)).rejects.toThrow(/still exists after removal/);
    expect(removed(fake)).toBe(true);
  });
});
