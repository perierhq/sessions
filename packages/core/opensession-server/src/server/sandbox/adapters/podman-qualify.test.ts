import { describe, expect, test } from "bun:test";
import { getSandboxProvider } from "../index";
import {
  readRemoteState,
  remoteGuestHomeForProvider,
  remoteGuestOsForProvider,
  writeRemoteState,
} from "./bootstrap";
import {
  PodmanProvider,
  podmanActivityToucher,
  podmanTerminalTarget,
  qualifyPodmanConnection,
  type PodmanQualifyDeps,
} from "./podman";
import { podmanNames } from "./podman-cli";
import {
  fakePodman,
  fakeProviderDeps,
  IMAGE,
  type FakeOptions,
} from "./podman-test-fixture";

const INFO = JSON.stringify({
  version: { Version: "5.8.2" },
  host: {
    security: { rootless: true, selinuxEnabled: true },
    cgroupVersion: "v2",
    cgroupControllers: ["cpuset", "cpu", "io", "memory", "pids"],
  },
});

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

function setup(o: FakeOptions = {}) {
  return fakePodman({ info: INFO, ...o });
}

function removed(fake: ReturnType<typeof fakePodman>): boolean {
  return fake.calls.some(
    ({ argv }) => argv[0] === "pod" && argv[1] === "rm" && argv[2] === "-f",
  );
}

describe("podman provider registration", () => {
  test("the registry hands out the podman provider and keeps docker retired", () => {
    expect(getSandboxProvider("podman")).toBeInstanceOf(PodmanProvider);
    expect(() => getSandboxProvider("docker")).toThrow(/has been retired/);
  });

  test("podman sandboxes use the Linux guest layout", () => {
    expect(remoteGuestOsForProvider("podman")).toBe("linux");
    expect(remoteGuestHomeForProvider("podman")).toBe("/home/ubuntu");
  });
});

describe("podman qualification", () => {
  test("refuses anything but Linux before touching podman", async () => {
    const fake = setup();
    await expect(
      qualifyPodmanConnection(
        () => {},
        qualifyDeps(fake, { platform: "darwin" }),
      ),
    ).rejects.toThrow(
      "This machine (container) needs Linux with rootless Podman",
    );
    expect(fake.calls).toEqual([]);
  });

  test("refuses missing prerequisites and names the fix", async () => {
    const old = JSON.stringify({
      version: { Version: "4.9.4" },
      host: JSON.parse(INFO).host,
    });
    await expect(
      qualifyPodmanConnection(() => {}, qualifyDeps(setup({ info: old }))),
    ).rejects.toThrow(/Podman 5\.0 or newer/);
    const rootful = JSON.stringify({
      ...JSON.parse(INFO),
      host: { ...JSON.parse(INFO).host, security: { rootless: false } },
    });
    await expect(
      qualifyPodmanConnection(() => {}, qualifyDeps(setup({ info: rootful }))),
    ).rejects.toThrow(/rootless Podman/);
    await expect(
      qualifyPodmanConnection(
        () => {},
        qualifyDeps(setup(), { linger: () => false }),
      ),
    ).rejects.toThrow(/enable-linger/);
    await expect(
      qualifyPodmanConnection(
        () => {},
        qualifyDeps(setup(), { nftPresent: () => false }),
      ),
    ).rejects.toThrow(/nftables/);
  });

  test("passes the full self-test in a disposable sandbox, then removes it", async () => {
    const fake = setup();
    const facts = await qualifyPodmanConnection(
      () => {},
      qualifyDeps(fake, { cpuDelegated: () => false }),
    );
    expect(facts.imageTag).toBe(IMAGE);
    expect(facts.cpuLimited).toBe(false);
    expect(Date.parse(facts.selfTestAt)).toBeGreaterThan(0);
    expect(facts.warnings).toEqual([]);
    const scripts = fake.calls
      .filter(({ argv }) => argv[0] === "exec")
      .map(({ argv }) => argv.at(-1)!);
    // The full test probes host paths and process facts.
    expect(scripts.some((s) => s.includes("probe_file"))).toBe(true);
    expect(scripts.some((s) => s.includes("/opt/opensession"))).toBe(true);
    expect(scripts.some((s) => s.includes("probe_proc"))).toBe(true);
    expect(removed(fake)).toBe(true);
    const pod = fake.calls.find(
      ({ argv }) => argv[0] === "pod" && argv[1] === "create",
    )!.argv;
    expect(pod[pod.indexOf("--name") + 1]).toMatch(/^opensession-sbx-qual-/);
  });

  test("a progress callback that throws does not skip the cleanup", async () => {
    const fake = setup();
    await expect(
      qualifyPodmanConnection((stage) => {
        if (stage === "Removing the test sandbox") throw new Error("ui gone");
      }, qualifyDeps(fake)),
    ).resolves.toBeDefined();
    expect(removed(fake)).toBe(true);
  });

  test("test sandboxes left by an earlier run are removed first", async () => {
    const fake = setup();
    const leftover = "opensession-sbx-qual-0123456789ab";
    const orphanVolume = "opensession-sbx-qual-ba9876543210-home";
    const removedNames: string[] = [];
    const run = async (
      argv: string[],
      opts?: Parameters<typeof fake.run>[1],
    ) => {
      const [a, b] = argv;
      if (a === "pod" && b === "ps") {
        fake.calls.push({ argv, opts });
        return {
          exitCode: 0,
          stdout: `${leftover}\nsomeone-else\n`,
          stderr: "",
        };
      }
      if (a === "volume" && b === "ls") {
        fake.calls.push({ argv, opts });
        return {
          exitCode: 0,
          stdout: `${leftover}-home\n${orphanVolume}\nopensession-sbx-sess-1-home\n`,
          stderr: "",
        };
      }
      const target = argv.at(-1)!;
      if (target === "opensession-sbx-qual-ba9876543210")
        return b === "exists"
          ? { exitCode: 1, stdout: "", stderr: "" }
          : { exitCode: 125, stdout: "", stderr: "Error: no such pod" };
      if (target.startsWith(leftover) || target === orphanVolume) {
        fake.calls.push({ argv, opts });
        if (b === "inspect") return { exitCode: 0, stdout: "1\n", stderr: "" };
        if (b === "rm") removedNames.push(target);
        if (b === "exists") return { exitCode: 1, stdout: "", stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return fake.run(argv, opts);
    };
    await qualifyPodmanConnection(() => {}, qualifyDeps(fake, { run }));
    expect(removedNames.sort()).toEqual(
      [leftover, `${leftover}-home`, orphanVolume].sort(),
    );
    // Listed by the sandbox label only.
    const ps = fake.calls.find(({ argv }) => argv[1] === "ps")!.argv;
    expect(ps).toContain("label=opensession.sandbox=1");
    // Before the new test sandbox is created.
    const first = fake.calls.findIndex(({ argv }) => argv[1] === "rm");
    const create = fake.calls.findIndex(
      ({ argv }) => argv[0] === "pod" && argv[1] === "create",
    );
    expect(first).toBeLessThan(create);
  });

  test("a failed full self-test refuses and still removes the sandbox", async () => {
    const fake = setup({ selfTest: { "file:/opt/opensession": "present" } });
    await expect(
      qualifyPodmanConnection(() => {}, qualifyDeps(fake)),
    ).rejects.toThrow(/file:\/opt\/opensession/);
    expect(removed(fake)).toBe(true);
  });

  test("a sandbox in the gateway's own cgroup is refused", async () => {
    const fake = setup({
      cgroup: "/opensession.slice/opensession.service/libpod-x.scope",
    });
    await expect(
      qualifyPodmanConnection(() => {}, qualifyDeps(fake)),
    ).rejects.toThrow(/not under user@1001\.service/);
    expect(removed(fake)).toBe(true);
  });

  test("a tailnet or loopback callback is refused", async () => {
    for (const address of ["100.101.1.2", "127.0.0.1"]) {
      const fake = setup();
      await expect(
        qualifyPodmanConnection(
          () => {},
          qualifyDeps(fake, { lookup: async () => [address] }),
        ),
      ).rejects.toThrow(/private or host address/);
      expect(fake.calls.some(({ argv }) => argv[0] === "create")).toBe(false);
    }
  });
});

describe("podman terminal", () => {
  test("execs a login shell as the workload user with podman's env only", async () => {
    const fake = setup();
    const provider = new PodmanProvider(fakeProviderDeps(fake));
    const sandbox = await provider.ensure({
      sessionId: `bks-podman-term-${Date.now().toString(36)}`,
    });
    await provider.pause(sandbox.id);
    const target = await podmanTerminalTarget(sandbox.id, provider, 1001);
    // A sleeping sandbox is woken through the firewall first.
    expect(await sandbox.status()).toBe("running");
    expect(target.argv.slice(0, 2)).toEqual(["/usr/bin/env", "-i"]);
    const podman = target.argv.indexOf("podman");
    expect(target.argv.slice(podman, podman + 5)).toEqual([
      "podman",
      "exec",
      "-it",
      "--user",
      "1000:1000",
    ]);
    expect(target.argv).toContain("XDG_RUNTIME_DIR=/run/user/1001");
    expect(target.argv.slice(-3)).toEqual([
      `${sandbox.id}-ws`,
      "/bin/bash",
      "-l",
    ]);
    expect(target.cwd).toBe("/home/ubuntu/worktrees/acme-main");
  });

  test("waking for a terminal starts the infra, installs the rules, then the workload", async () => {
    const fake = setup();
    const provider = new PodmanProvider(fakeProviderDeps(fake));
    const sandbox = await provider.ensure({
      sessionId: `bks-podman-term-${Date.now().toString(36)}`,
    });
    await provider.pause(sandbox.id);
    fake.calls.length = 0;
    await podmanTerminalTarget(sandbox.id, provider, 1001);
    const steps = fake.calls
      .map(({ argv }) =>
        argv[0] === "start"
          ? `start ${argv.at(-1)}`
          : argv[0] === "unshare"
            ? argv.includes("-f")
              ? "nft install"
              : "nft list"
            : "",
      )
      .filter(Boolean);
    expect(steps.slice(0, 4)).toEqual([
      `start ${sandbox.id}-infra`,
      "nft install",
      "nft list",
      `start ${sandbox.id}-ws`,
    ]);
    expect(fake.state.execs.every((e) => e.filtered)).toBe(true);
  });

  test("a running workload this gateway never verified gets no shell until it passes", async () => {
    // Running, but its namespace holds no rules (as after a crash between a
    // failed verify and the stop).
    const fake = setup({ podExists: true, running: true, rulesInstalled: false });
    const provider = new PodmanProvider(fakeProviderDeps(fake));
    const sessionId = `bks-podman-term-${Date.now().toString(36)}-unverified`;
    const pod = podmanNames(sessionId).pod;
    writeRemoteState({
      sandboxId: pod,
      provider: "podman",
      sessionId,
      cwd: "/home/ubuntu/worktrees/acme-main",
      repoId: "acme",
      branch: "main",
      trustProfile: "interactive",
      egressAllowlist: [],
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    });
    await expect(podmanTerminalTarget(pod, provider, 1001)).rejects.toThrow(
      /do not match the policy/,
    );
    expect(fake.state.execs).toEqual([]);
    expect(fake.state.running).toBe(false);
  });

  test("an open terminal keeps the sandbox's activity fresh, throttled", async () => {
    const fake = setup();
    const provider = new PodmanProvider(fakeProviderDeps(fake));
    const sandbox = await provider.ensure({
      sessionId: `bks-podman-term-${Date.now().toString(36)}`,
    });
    const old = "2020-01-01T00:00:00.000Z";
    const reset = () =>
      writeRemoteState({
        ...readRemoteState("podman", sandbox.id)!,
        lastActivityAt: old,
      });
    reset();
    const target = await podmanTerminalTarget(sandbox.id, provider, 1001);
    // Opening the shell counts as activity.
    expect(readRemoteState("podman", sandbox.id)!.lastActivityAt).not.toBe(old);

    let now = 1_000_000;
    const touch = podmanActivityToucher(sandbox.id, () => now);
    reset();
    touch();
    expect(readRemoteState("podman", sandbox.id)!.lastActivityAt).not.toBe(old);
    reset();
    now += 30_000;
    touch();
    expect(readRemoteState("podman", sandbox.id)!.lastActivityAt).toBe(old);
    now += 31_000;
    touch();
    expect(readRemoteState("podman", sandbox.id)!.lastActivityAt).not.toBe(old);
    expect(typeof target.touch).toBe("function");
  });
});
