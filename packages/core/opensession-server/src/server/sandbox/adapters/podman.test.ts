import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { podmanNames } from "./podman-cli";
import {
  fakeProviderDeps as deps,
  fakePodman,
  IMAGE,
} from "./podman-test-fixture";
import { readRemoteState, writeRemoteState } from "./bootstrap";
import { GIB } from "./podman-disk";
import {
  PodmanProvider,
  podmanDriver,
  sweepIdlePodmanSandboxes,
  podmanSandboxCwd,
  podmanSettings,
  podmanWorkspaceCwd,
} from "./podman";

let seq = 0;
function sessionId(): string {
  seq += 1;
  return `bks-podman-test-${Date.now().toString(36)}-${seq}`;
}

/** A compact label per call: the verb plus what it names. */
function verbs(calls: { argv: string[] }[]): string[] {
  return calls.map(({ argv }) => {
    if (argv[0] === "unshare")
      return argv.includes("-f") ? "nft install" : "nft list";
    if (argv[0] === "exec")
      return argv.at(-1)!.includes("probe_tcp") ? "exec selftest" : "exec";
    if (argv[0] === "container" && argv[1] === "inspect")
      return `inspect ${argv[3]} ${argv.at(-1)}`;
    if (argv[0] === "create") return "create workload";
    if (argv[0] === "start") return `start ${argv.at(-1)}`;
    return argv.slice(0, 2).join(" ");
  });
}

describe("podman settings", () => {
  test("defaults and validation", () => {
    expect(podmanSettings(undefined)).toEqual({
      memoryMb: 4096,
      pidsLimit: 4096,
      dns: ["1.1.1.1", "9.9.9.9"],
    });
    expect(
      podmanSettings({
        memoryMb: 2048,
        pidsLimit: 512,
        cpu: 2,
        dns: ["8.8.8.8"],
      }),
    ).toEqual({ memoryMb: 2048, pidsLimit: 512, cpu: 2, dns: ["8.8.8.8"] });
    expect(
      podmanSettings({ memoryMb: -1, cpu: "x", dns: ["not-an-ip"] }),
    ).toEqual({ memoryMb: 4096, pidsLimit: 4096, dns: ["1.1.1.1", "9.9.9.9"] });
  });
});

describe("podman provider ensure", () => {
  test("a new session creates, firewalls, self-tests, then prepares", async () => {
    const fake = fakePodman();
    const provider = new PodmanProvider(deps(fake));
    const id = sessionId();
    const names = podmanNames(id);
    const sandbox = await provider.ensure({ sessionId: id });
    expect(sandbox.id).toBe(names.pod);
    expect(sandbox.provider).toBe("podman");
    expect(sandbox.workspace).toBe("volume");
    expect(await sandbox.ports()).toEqual({});
    const seen = verbs(fake.calls);
    const order = [
      "volume create",
      "pod create",
      "create workload",
      `start ${names.infra}`,
      "nft install",
      "nft list",
      `start ${names.workload}`,
      `inspect {{.State.Pid}} ${names.workload}`,
      "exec selftest",
      "<prepare>",
    ];
    let at = -1;
    for (const step of order) {
      const next = seen.indexOf(step, at + 1);
      expect({ step, found: next > at }).toEqual({ step, found: true });
      at = next;
    }
    // The workload starts only after the rules were installed and verified.
    expect(seen.indexOf(`start ${names.workload}`)).toBeGreaterThan(
      seen.indexOf("nft list"),
    );
    // Never `pod start`, which races the rules.
    expect(
      fake.calls.some(({ argv }) => argv[0] === "pod" && argv[1] === "start"),
    ).toBe(false);
    // The workload's own namespace is re-verified after it starts.
    expect(
      fake.calls.some(
        ({ argv }) =>
          argv[0] === "unshare" &&
          argv.includes("--net=/proc/4242/ns/net") &&
          argv.includes("-j"),
      ),
    ).toBe(true);
  });

  test("rejects attached dirs and automation runs", async () => {
    const provider = new PodmanProvider(deps(fakePodman()));
    await expect(
      provider.ensure({ sessionId: sessionId(), attachedDirs: ["/x"] }),
    ).rejects.toThrow(/attached repos are not supported/);
    await expect(
      provider.ensure({ sessionId: sessionId(), trustProfile: "automation" }),
    ).rejects.toThrow(
      "automation runs are not supported on This machine (container)",
    );
  });

  test("a missing image asks for requalification", async () => {
    const fake = fakePodman({ imageExists: false });
    const provider = new PodmanProvider(deps(fake));
    await expect(provider.ensure({ sessionId: sessionId() })).rejects.toThrow(
      /Requalify This machine \(container\)/,
    );
    expect(verbs(fake.calls)).not.toContain("pod create");
  });

  test("a callback on a private or tailnet address is refused", async () => {
    const fake = fakePodman();
    const provider = new PodmanProvider(
      deps(fake, { lookup: async () => ["100.101.1.2"] }),
    );
    await expect(provider.ensure({ sessionId: sessionId() })).rejects.toThrow(
      /private or host address/,
    );
    expect(verbs(fake.calls)).not.toContain("create workload");
  });

  test("a failed nft install stops the pod and never starts the workload", async () => {
    const fake = fakePodman({ nftInstallFails: true });
    const provider = new PodmanProvider(deps(fake));
    const id = sessionId();
    const names = podmanNames(id);
    await expect(provider.ensure({ sessionId: id })).rejects.toThrow(
      /install egress rules/,
    );
    const seen = verbs(fake.calls);
    expect(seen).toContain("pod stop");
    expect(seen).not.toContain(`start ${names.workload}`);
    expect(seen).not.toContain("<prepare>");
  });

  test("a failed self-test names the target and stops the pod", async () => {
    const fake = fakePodman({
      selfTest: { "tcp:169.254.169.254:80": "open" },
    });
    const provider = new PodmanProvider(deps(fake));
    await expect(provider.ensure({ sessionId: sessionId() })).rejects.toThrow(
      /169\.254\.169\.254:80/,
    );
    const seen = verbs(fake.calls);
    expect(seen).toContain("pod stop");
    expect(seen).not.toContain("<prepare>");
  });

  test("cpu is applied only when the cpu controller is delegated", async () => {
    for (const delegated of [false, true]) {
      const fake = fakePodman();
      const provider = new PodmanProvider(
        deps(fake, {
          cpuDelegated: () => delegated,
          settings: () => podmanSettings({ cpu: 2 }),
        }),
      );
      await provider.ensure({ sessionId: sessionId() });
      const create = fake.calls.find(({ argv }) => argv[0] === "create")!;
      expect(create.argv.includes("--cpus")).toBe(delegated);
      expect(create.argv).toContain(IMAGE);
    }
  });

  test("a running pod is reverified, not restarted", async () => {
    const fake = fakePodman();
    const provider = new PodmanProvider(deps(fake));
    const id = sessionId();
    await provider.ensure({ sessionId: id });
    fake.calls.length = 0;
    const again = await provider.ensure({ sessionId: id });
    const seen = verbs(fake.calls);
    expect(seen).not.toContain("pod create");
    expect(seen.some((v) => v.startsWith("start "))).toBe(false);
    expect(seen).toContain("nft list");
    expect(seen).toContain("exec selftest");
    expect(again.wokeFromSleep).toBe(false);
  });
});

describe("podman workspace path", () => {
  test("the workspace lives on the volume, whatever the host layout", () => {
    expect(podmanWorkspaceCwd("/tmp/opensession/worktrees/acme-main")).toBe(
      "/home/ubuntu/worktrees/acme-main",
    );
    expect(podmanWorkspaceCwd("/Users/x/.opensession/wt/acme-feat")).toBe(
      "/home/ubuntu/worktrees/acme-feat",
    );
  });

  test("only paths under the sandbox home are accepted", () => {
    expect(podmanSandboxCwd("/home/ubuntu/worktrees/acme")).toBe(
      "/home/ubuntu/worktrees/acme",
    );
    expect(podmanSandboxCwd("/home/ubuntu/w/./x/../y/")).toBe(
      "/home/ubuntu/w/y",
    );
    for (const bad of [
      "/home/ubuntu",
      "/home/ubuntu/..",
      "/home/ubuntu/../root/x",
      "/home/ubuntuX/w",
      "/tmp/worktrees/acme",
      "worktrees/acme",
      "/home/ubuntu/a\0b",
      "",
    ])
      expect({ bad, cwd: podmanSandboxCwd(bad) }).toEqual({ bad, cwd: null });
  });

  test("a cwd outside the sandbox home is refused before anything is created", async () => {
    for (const cwd of ["/tmp/worktrees/acme-main", "/home/ubuntu/../etc"]) {
      const fake = fakePodman();
      const provider = new PodmanProvider(
        deps(fake, {
          workspacePlan: async () => ({
            repoId: "acme",
            branch: "main",
            defaultBranch: "main",
            cwd,
          }),
        }),
      );
      await expect(provider.ensure({ sessionId: sessionId() })).rejects.toThrow(
        /under \/home\/ubuntu/,
      );
      expect(verbs(fake.calls)).not.toContain("pod create");
    }
  });
});

describe("podman provider sleep and wake", () => {
  test("resume on a stopped pod reruns the firewall sequence and the resume hook", async () => {
    const fake = fakePodman();
    const provider = new PodmanProvider(deps(fake));
    const id = sessionId();
    const names = podmanNames(id);
    const sandbox = await provider.ensure({ sessionId: id });
    await provider.pause(sandbox.id);
    expect(
      fake.calls.some(
        ({ argv }) =>
          argv[0] === "pod" && argv[1] === "stop" && argv.at(-1) === names.pod,
      ),
    ).toBe(true);
    expect(await sandbox.status()).toBe("stopped");
    fake.calls.length = 0;
    const woken = await provider.resume(sandbox.id);
    expect(woken?.wokeFromSleep).toBe(true);
    const seen = verbs(fake.calls);
    const install = seen.indexOf("nft install");
    expect(seen.indexOf(`start ${names.infra}`)).toBeLessThan(install);
    expect(seen.indexOf(`start ${names.workload}`)).toBeGreaterThan(install);
    expect(seen.indexOf("exec selftest")).toBeGreaterThan(
      seen.indexOf(`start ${names.workload}`),
    );
    expect(seen.indexOf("<resume-hook>")).toBeGreaterThan(
      seen.indexOf("exec selftest"),
    );
    expect(seen).not.toContain("pod start");
    expect(await woken!.status()).toBe("running");
  });

  test("an exec on a sleeping sandbox wakes it through the firewall", async () => {
    const fake = fakePodman();
    const provider = new PodmanProvider(deps(fake));
    const id = sessionId();
    const names = podmanNames(id);
    const sandbox = await provider.ensure({ sessionId: id });
    await provider.pause(sandbox.id);
    fake.calls.length = 0;
    await sandbox.exec(["true"], { workloadIdentity: false });
    const seen = verbs(fake.calls);
    expect(seen.indexOf("nft install")).toBeGreaterThan(-1);
    expect(seen.indexOf(`start ${names.workload}`)).toBeGreaterThan(
      seen.indexOf("nft list"),
    );
    expect(seen.lastIndexOf("exec")).toBeGreaterThan(
      seen.indexOf("exec selftest"),
    );
  });

  test("a burst exec after an out-of-band stop wakes on the next call", async () => {
    const fake = fakePodman();
    const provider = new PodmanProvider(deps(fake));
    const id = sessionId();
    const names = podmanNames(id);
    const sandbox = await provider.ensure({ sessionId: id });
    const burst = { assumeStarted: true, workloadIdentity: false } as const;
    expect((await sandbox.exec(["true"], burst)).exitCode).toBe(0);
    await fake.run(["pod", "stop", names.pod]);
    const missed = await sandbox.exec(["true"], burst);
    expect(missed.exitCode).toBe(125);
    expect(missed.stderr).toContain("container state improper");
    expect((await sandbox.exec(["true"], burst)).exitCode).toBe(0);
    expect(fake.state.running).toBe(true);
  });

  test("status maps pod states", async () => {
    const id = sessionId();
    for (const [podState, expected] of [
      ["Running", "running"],
      ["Exited", "stopped"],
      ["Created", "stopped"],
    ] as const) {
      const fake = fakePodman({ podExists: true, running: true, podState });
      const provider = new PodmanProvider(deps(fake));
      expect(await provider.status(podmanNames(id).pod)).toBe(expected);
    }
    const gone = new PodmanProvider(deps(fakePodman()));
    expect(await gone.status(podmanNames(id).pod)).toBe("gone");
  });
});

/** A fake runner that calls `before` once, ahead of the first call that
 *  matches. */
function interceptOnce(
  fake: ReturnType<typeof fakePodman>,
  match: (argv: string[]) => boolean,
  before: () => void | Promise<void>,
) {
  let fired = false;
  return async (argv: string[], opts?: Parameters<typeof fake.run>[1]) => {
    if (!fired && match(argv)) {
      fired = true;
      await before();
    }
    return fake.run(argv, opts);
  };
}

/** The core invariant: no exec ran in an unfiltered namespace, and a running
 *  workload's namespace holds the rules. */
function expectNeverUnfiltered(fake: ReturnType<typeof fakePodman>) {
  expect(fake.state.execs.filter((e) => !e.filtered)).toEqual([]);
  if (fake.state.running)
    expect(fake.state.rules.has(fake.state.workloadNetns!)).toBe(true);
}

describe("podman firewall invariants", () => {
  test("a workload namespace with no rules stops the pod and fails", async () => {
    const fake = fakePodman();
    const id = sessionId();
    const names = podmanNames(id);
    // The infra stops out of band between its verify and the workload
    // start, so podman auto-starts it in a fresh, empty namespace.
    const run = interceptOnce(
      fake,
      (argv) => argv[0] === "start" && argv.at(-1) === names.workload,
      () => fake.stopInfra(),
    );
    const provider = new PodmanProvider(deps(fake, { run }));
    await expect(provider.ensure({ sessionId: id })).rejects.toThrow(
      /do not match the policy/,
    );
    expect(fake.state.running).toBe(false);
    expect(fake.state.infraRunning).toBe(false);
    const seen = verbs(fake.calls);
    expect(seen.lastIndexOf("pod stop")).toBeGreaterThan(
      seen.indexOf(`start ${names.workload}`),
    );
    expect(seen).not.toContain("exec selftest");
    expect(seen).not.toContain("<prepare>");
    expectNeverUnfiltered(fake);
  });

  test("a stop landing mid-start never leaves the workload unfiltered", async () => {
    const fake = fakePodman();
    const id = sessionId();
    const names = podmanNames(id);
    let pausing: Promise<void> | undefined;
    let provider!: PodmanProvider;
    const run = interceptOnce(
      fake,
      (argv) => argv[0] === "start" && argv.at(-1) === names.workload,
      async () => {
        // A pause (idle sweep, user stop) arrives between the infra's
        // verify and the workload start.
        pausing = provider.pause(names.pod);
        await new Promise((resolve) => setTimeout(resolve, 5));
      },
    );
    provider = new PodmanProvider(deps(fake, { run }));
    await Promise.allSettled([provider.ensure({ sessionId: id })]);
    await pausing;
    expectNeverUnfiltered(fake);
  });

  test("a pause waits for an in-flight start, then stops the pod", async () => {
    const fake = fakePodman();
    const id = sessionId();
    const names = podmanNames(id);
    let pausing: Promise<void> | undefined;
    let provider!: PodmanProvider;
    const run = interceptOnce(
      fake,
      (argv) => argv[0] === "start" && argv.at(-1) === names.workload,
      async () => {
        pausing = provider.pause(names.pod);
        await new Promise((resolve) => setTimeout(resolve, 5));
      },
    );
    provider = new PodmanProvider(deps(fake, { run }));
    await provider.ensure({ sessionId: id });
    await pausing;
    const seen = verbs(fake.calls);
    expect(seen.indexOf("pod stop")).toBeGreaterThan(
      seen.indexOf("exec selftest"),
    );
    expect(fake.state.running).toBe(false);
    expectNeverUnfiltered(fake);
  });

  test("the idle sweep rechecks activity once it holds the start lock", async () => {
    const fake = fakePodman();
    const id = sessionId();
    const names = podmanNames(id);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let armed = false;
    let entered!: () => void;
    const inLock = new Promise<void>((resolve) => (entered = resolve));
    const run = async (
      argv: string[],
      opts?: Parameters<typeof fake.run>[1],
    ) => {
      if (armed && argv[0] === "unshare" && argv.includes("-j")) {
        armed = false;
        entered();
        await gate;
      }
      return fake.run(argv, opts);
    };
    const provider = new PodmanProvider(deps(fake, { run }));
    await provider.ensure({ sessionId: id });
    const stale = readRemoteState("podman", names.pod)!;
    writeRemoteState({ ...stale, lastActivityAt: "2020-01-01T00:00:00.000Z" });
    // A wake re-verifies the running pod and holds the lock meanwhile.
    armed = true;
    const waking = provider.resume(names.pod);
    await inLock;
    const sweeping = sweepIdlePodmanSandboxes(Date.now(), provider);
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Activity lands while the sweep waits.
    writeRemoteState({ ...stale, lastActivityAt: new Date().toISOString() });
    release();
    await waking;
    expect(await sweeping).not.toContain(names.pod);
    expect(verbs(fake.calls)).not.toContain("pod stop");
    expect(fake.state.running).toBe(true);
  });

  test("a workload restarted out of band is re-verified before the next exec", async () => {
    const fake = fakePodman();
    const provider = new PodmanProvider(deps(fake));
    const id = sessionId();
    const names = podmanNames(id);
    const sandbox = await provider.ensure({ sessionId: id });
    // Same-uid `podman pod stop` then `podman start <ws>`: the infra comes
    // back in a fresh namespace with no rules.
    await fake.run(["pod", "stop", names.pod]);
    await fake.run(["start", names.workload]);
    fake.calls.length = 0;
    fake.state.execs.length = 0;
    await expect(
      sandbox.exec(["true"], { workloadIdentity: false }),
    ).rejects.toThrow(/do not match the policy/);
    expect(fake.state.execs).toEqual([]);
    expect(fake.state.running).toBe(false);
  });

  test("a running workload this gateway never verified is verified once", async () => {
    // As after a gateway restart: the pod is up, nothing recorded.
    const fake = fakePodman({ podExists: true, running: true });
    const id = sessionId();
    const names = podmanNames(id);
    const provider = new PodmanProvider(deps(fake));
    writeRemoteState({
      sandboxId: names.pod,
      provider: "podman",
      sessionId: id,
      cwd: "/home/ubuntu/worktrees/acme-main",
      repoId: "acme",
      branch: "main",
      trustProfile: "interactive",
      egressAllowlist: [],
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    });
    const sandbox = (await provider.get(names.pod))!;
    await sandbox.exec(["true"], { workloadIdentity: false });
    let seen = verbs(fake.calls);
    expect(seen.indexOf("nft list")).toBeGreaterThan(-1);
    expect(seen.lastIndexOf("exec")).toBeGreaterThan(
      seen.indexOf("exec selftest"),
    );
    fake.calls.length = 0;
    await sandbox.exec(["true"], { workloadIdentity: false });
    seen = verbs(fake.calls);
    expect(seen).not.toContain("nft list");
    expect(seen).not.toContain("exec selftest");
    expect(seen).toContain("exec");
  });

  test("a stop that fails escalates to kill, then removes the workload", async () => {
    const bad = { "tcp:169.254.169.254:80": "open" };
    const killed = fakePodman({ selfTest: bad, stopFails: true });
    await expect(
      new PodmanProvider(deps(killed)).ensure({ sessionId: sessionId() }),
    ).rejects.toThrow(/169\.254/);
    expect(verbs(killed.calls).slice(-2)).toEqual(["pod stop", "pod kill"]);
    expect(killed.state.running).toBe(false);

    const removed = fakePodman({
      selfTest: bad,
      stopFails: true,
      killFails: true,
    });
    await expect(
      new PodmanProvider(deps(removed)).ensure({ sessionId: sessionId() }),
    ).rejects.toThrow(/169\.254/);
    expect(removed.calls.at(-1)!.argv.slice(0, 2)).toEqual(["rm", "-f"]);
    expect(removed.state.running).toBe(false);
    expect(removed.state.workloadExists).toBe(false);
  });

  test("concurrent wakes serialize into one firewalled start", async () => {
    const fake = fakePodman();
    const provider = new PodmanProvider(deps(fake));
    const id = sessionId();
    const names = podmanNames(id);
    const sandbox = await provider.ensure({ sessionId: id });
    await provider.pause(sandbox.id);
    fake.calls.length = 0;
    const [a, b] = await Promise.all([
      provider.resume(sandbox.id),
      provider.resume(sandbox.id),
      sandbox.exec(["true"], { workloadIdentity: false }),
    ]);
    expect([a?.wokeFromSleep, b?.wokeFromSleep].sort()).toEqual([false, true]);
    const seen = verbs(fake.calls);
    expect(seen.filter((v) => v === `start ${names.workload}`)).toHaveLength(1);
    expect(seen.filter((v) => v === "nft install")).toHaveLength(1);
    // The callers queued behind that start reuse its verification.
    expect(seen.filter((v) => v === "exec selftest")).toHaveLength(1);
    expect(fake.state.workloadStarts).toBe(2);
    expectNeverUnfiltered(fake);
  });
});

describe("podman disk limits", () => {
  test("a start is refused below the free-space floor; a running pod is not", async () => {
    const fake = fakePodman();
    let free = 2 * GIB;
    const provider = new PodmanProvider(
      deps(fake, { storageFree: async () => free }),
    );
    const id = sessionId();
    const names = podmanNames(id);
    await expect(provider.ensure({ sessionId: id })).rejects.toThrow(
      /2\.0 GiB free .* needs 5\.0 GiB/,
    );
    expect(verbs(fake.calls).some((v) => v.startsWith("start "))).toBe(false);
    free = 50 * GIB;
    await provider.ensure({ sessionId: id });
    free = 1 * GIB;
    // Re-verifying a running pod starts nothing, so it is allowed.
    await provider.ensure({ sessionId: id });
    expect(fake.state.running).toBe(true);
    expect(verbs(fake.calls)).toContain(`start ${names.workload}`);
  });

  test("a volume over the quota stops its pod and refuses starts", async () => {
    const fake = fakePodman();
    const sizes = new Map<string, number>();
    const provider = new PodmanProvider(
      deps(fake, {
        volumeUsage: async () => sizes,
        storageFree: async () => 40 * GIB,
      }),
    );
    const id = sessionId();
    const names = podmanNames(id);
    await provider.ensure({ sessionId: id });
    sizes.set(names.volume, 12 * GIB);
    let report = await provider.checkDisk();
    expect(report.freeBytes).toBe(40 * GIB);
    expect(report.volumes).toEqual([
      { sandboxId: names.pod, sessionId: id, bytes: 12 * GIB },
    ]);
    expect(fake.state.running).toBe(true);
    sizes.set(names.volume, 21 * GIB);
    report = await provider.checkDisk();
    expect(report.volumes[0]!.bytes).toBe(21 * GIB);
    expect(fake.state.running).toBe(false);
    await expect(provider.resume(names.pod)).rejects.toThrow(
      /21\.0 GiB, over the 20\.0 GiB/,
    );
    expect(fake.state.running).toBe(false);
    // Once it is back under the quota, it starts again.
    sizes.set(names.volume, 3 * GIB);
    expect((await provider.checkDisk()).volumes).toEqual([]);
    expect((await provider.resume(names.pod))?.wokeFromSleep).toBe(true);
  });
});

describe("podman provider destroy", () => {
  test("removes the pod and the volume, and strict proves both gone", async () => {
    const fake = fakePodman();
    const provider = new PodmanProvider(deps(fake));
    const id = sessionId();
    const names = podmanNames(id);
    const sandbox = await provider.ensure({ sessionId: id });
    await provider.destroy(sandbox.id, { strict: true });
    const rm = fake.calls.filter(({ argv }) => argv.includes("rm"));
    expect(rm.map(({ argv }) => argv)).toEqual([
      ["pod", "rm", "-f", "-t", "5", names.pod],
      // No -f: a container of someone else's using the volume is not removed.
      ["volume", "rm", names.volume],
    ]);
    expect(await provider.get(sandbox.id)).toBeNull();
  });

  test("strict destroy rejects when the pod is still there", async () => {
    const fake = fakePodman({ podSurvivesRm: true });
    const provider = new PodmanProvider(deps(fake));
    const sandbox = await provider.ensure({ sessionId: sessionId() });
    await expect(
      provider.destroy(sandbox.id, { strict: true }),
    ).rejects.toThrow(/still exists/);
  });

  test("an inspect error keeps the pod, the volume and the record", async () => {
    const fake = fakePodman();
    let broken = false;
    const run = async (
      argv: string[],
      opts?: Parameters<typeof fake.run>[1],
    ) =>
      broken && argv[1] === "inspect"
        ? { exitCode: 125, stdout: "", stderr: "Error: database is locked" }
        : fake.run(argv, opts);
    const provider = new PodmanProvider(deps(fake, { run }));
    const sandbox = await provider.ensure({ sessionId: sessionId() });
    broken = true;
    await expect(provider.destroy(sandbox.id)).rejects.toThrow(
      /database is locked/,
    );
    expect(fake.calls.some(({ argv }) => argv.includes("rm"))).toBe(false);
    expect(readRemoteState("podman", sandbox.id)).not.toBeNull();
    broken = false;
    await provider.destroy(sandbox.id, { strict: true });
    expect(readRemoteState("podman", sandbox.id)).toBeNull();
  });

  test("refuses a name outside the provider's prefix", async () => {
    const fake = fakePodman({ podExists: true });
    const provider = new PodmanProvider(deps(fake));
    await expect(provider.destroy("habit-dev-db")).rejects.toThrow(
      /not an Open Session podman/,
    );
    expect(fake.calls.some(({ argv }) => argv.includes("rm"))).toBe(false);
  });
});

describe("podman driver", () => {
  test("exec passes env through a file, never in argv", async () => {
    const fake = fakePodman({ podExists: true, running: true });
    const names = podmanNames(sessionId());
    const driver = podmanDriver(fake.run, names, {
      ensureStarted: async () => {},
      runtimeDir: mkdtempSync(join(tmpdir(), "podman-rt-")),
    });
    await driver.exec("echo hi", {
      env: { GH_TOKEN: "t0ken-value" },
      cwd: "/home/ubuntu/w",
    });
    const call = fake.calls.find(({ argv }) => argv[0] === "exec")!;
    expect(call.argv.join(" ")).not.toContain("t0ken-value");
    expect(call.argv).toContain("--env-file");
    expect(call.argv).toContain("1000:1000");
    expect(call.argv.slice(-3)).toEqual(["/bin/bash", "-c", "echo hi"]);
  });

  test("writeFile sends content on stdin (no podman cp)", async () => {
    const fake = fakePodman({ podExists: true, running: true });
    const names = podmanNames(sessionId());
    const driver = podmanDriver(fake.run, names, {
      ensureStarted: async () => {},
    });
    await driver.writeFile("/home/ubuntu/.config/x y", "secret-content");
    const call = fake.calls.find(({ argv }) => argv[0] === "exec")!;
    expect(call.argv).toContain("-i");
    expect(call.argv.at(-1)).toBe("cat > '/home/ubuntu/.config/x y'");
    expect(call.opts?.stdin).toBe("secret-content");
    expect(fake.calls.some(({ argv }) => argv[0] === "cp")).toBe(false);
    await expect(driver.writeFile("relative", "x")).rejects.toThrow(/absolute/);
  });

  test("execBackground detaches", async () => {
    const fake = fakePodman({ podExists: true, running: true });
    const driver = podmanDriver(fake.run, podmanNames(sessionId()), {
      ensureStarted: async () => {},
    });
    await driver.execBackground("sleep 100");
    const call = fake.calls.find(({ argv }) => argv[0] === "exec")!;
    expect(call.argv).toContain("-d");
    expect(call.argv).not.toContain("/usr/bin/timeout");
  });
});
