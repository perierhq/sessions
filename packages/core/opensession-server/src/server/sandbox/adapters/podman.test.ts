import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult } from "../provider";
import { podmanNames, type PodmanRunOpts } from "./podman-cli";
import {
  EGRESS_FIXTURE_INPUT,
  EGRESS_FIXTURE_LISTING,
} from "./podman-egress-fixture";
import {
  PodmanProvider,
  podmanDriver,
  podmanSettings,
  type PodmanProviderDeps,
} from "./podman";

const IMAGE = "localhost/opensession-sandbox:0123456789abcdef";
const NETNS = "/run/user/1001/netns/netns-test";

function ok(stdout = ""): ExecResult {
  return { exitCode: 0, stdout, stderr: "" };
}
function fail(stderr: string, exitCode = 1): ExecResult {
  return { exitCode, stdout: "", stderr };
}

/** The answer a correctly isolated workload gives each probe. */
function goodProbe(name: string, probe: string): string {
  switch (probe) {
    case "probe_tcp":
      return "unreachable";
    case "probe_host_tcp":
      return "remote:unreachable";
    case "probe_http":
      return "http:200";
    case "probe_dns":
      return name === "dns:host.containers.internal"
        ? "unresolved"
        : "resolved";
    case "probe_file":
      return "absent";
    case "probe_proc":
      return name === "proc:CapEff"
        ? "0000000000000000"
        : name === "proc:NoNewPrivs"
          ? "1"
          : "1000";
  }
  return "?";
}

/** Rows for an isolation script (podman-selftest.ts isolationScript). */
function selfTestRows(script: string, override: Record<string, string>) {
  const inner = script.replaceAll("'\\''", "'");
  const rows: string[] = [];
  for (const match of inner.matchAll(
    /^printf '%s\\t%s\\n' '?([^' ]+)'? "\$\((probe_\w+)/gm,
  )) {
    const [, name, probe] = match;
    rows.push(`${name}\t${override[name!] ?? goodProbe(name!, probe!)}\n`);
  }
  return rows.join("");
}

interface FakeOptions {
  podExists?: boolean;
  running?: boolean;
  imageExists?: boolean;
  nftInstallFails?: boolean;
  selfTest?: Record<string, string>;
  podSurvivesRm?: boolean;
  podState?: string;
}

/** A stateful stand-in for rootless podman: one pod, its infra and its
 *  workload. Records every argv and the options it was run with. */
function fakePodman(o: FakeOptions = {}) {
  const calls: { argv: string[]; opts?: PodmanRunOpts }[] = [];
  const state = {
    podExists: o.podExists ?? false,
    volumeExists: o.podExists ?? false,
    infraRunning: o.running ?? false,
    running: o.running ?? false,
    packets: 0,
  };
  const listing = () => {
    state.packets += 100;
    return EGRESS_FIXTURE_LISTING.replace(
      /"packets": \d+/g,
      `"packets": ${state.packets}`,
    );
  };
  const run = async (
    argv: string[],
    opts?: PodmanRunOpts,
  ): Promise<ExecResult> => {
    calls.push({ argv, opts });
    const [a, b] = argv;
    const last = argv.at(-1)!;
    if (a === "pod" && b === "exists") return state.podExists ? ok() : fail("");
    if (a === "image" && b === "exists")
      return o.imageExists === false ? fail("") : ok();
    if (a === "volume" && b === "exists")
      return state.volumeExists ? ok() : fail("");
    if (a === "volume" && b === "create") {
      state.volumeExists = true;
      return ok();
    }
    if (a === "volume" && b === "inspect")
      return state.volumeExists ? ok("1\n") : fail("no such volume");
    if (a === "volume" && b === "rm") {
      state.volumeExists = false;
      return ok();
    }
    if (a === "pod" && b === "create") {
      state.podExists = true;
      return ok();
    }
    if (a === "create") return ok();
    if (a === "container" && b === "exists")
      return state.podExists ? ok() : fail("");
    if (a === "container" && b === "inspect") {
      const format = argv[3];
      if (format === "{{.State.Running}}")
        return ok(state.running ? "true\n" : "false\n");
      if (format === "{{.NetworkSettings.SandboxKey}}")
        return ok(state.infraRunning ? `${NETNS}\n` : "\n");
      if (format === "{{.State.Pid}}")
        return ok(state.running ? "4242\n" : "0\n");
    }
    if (a === "start") {
      if (last.endsWith("-infra")) state.infraRunning = true;
      else {
        // Real podman would auto-start the infra with no rules.
        state.infraRunning = true;
        state.running = true;
      }
      return ok();
    }
    if (a === "unshare" && argv.includes("-f"))
      return o.nftInstallFails ? fail("nft: Operation not permitted") : ok();
    if (a === "unshare" && argv.includes("-j")) return ok(listing());
    if (a === "exec") {
      const script = last;
      if (script.includes("probe_tcp"))
        return ok(selfTestRows(script, o.selfTest ?? {}));
      return ok("");
    }
    if (a === "pod" && b === "stop") {
      state.running = false;
      state.infraRunning = false;
      return ok();
    }
    if (a === "pod" && b === "inspect") {
      if (!state.podExists) return fail("no such pod", 125);
      if (argv[3]?.includes("Labels")) return ok("1\n");
      return ok(`${o.podState ?? (state.running ? "Running" : "Exited")}\n`);
    }
    if (a === "pod" && b === "rm") {
      state.podExists = o.podSurvivesRm ?? false;
      state.running = false;
      return ok();
    }
    return fail(`unexpected podman ${argv.join(" ")}`, 125);
  };
  return { run, calls, state };
}

let seq = 0;
function sessionId(): string {
  seq += 1;
  return `bks-podman-test-${Date.now().toString(36)}-${seq}`;
}

function deps(
  fake: ReturnType<typeof fakePodman>,
  extra: Partial<PodmanProviderDeps> = {},
): PodmanProviderDeps {
  const markers: string[][] = [];
  return {
    run: fake.run,
    lookup: async () => ["203.0.113.7"],
    hostAddresses: () => EGRESS_FIXTURE_INPUT.hostAddresses,
    extraHostAddresses: () => [],
    cpuDelegated: () => true,
    settings: () => podmanSettings({}),
    callbackBaseUrl: () => "wss://ingress.example.test",
    appPort: () => 3850,
    loopbackPorts: () => [3860],
    runtimeDir: mkdtempSync(join(tmpdir(), "podman-rt-")),
    imageTag: () => IMAGE,
    workspacePlan: async (spec) => ({
      repoId: "acme",
      branch: spec.branch || "main",
      defaultBranch: "main",
      cwd: "/home/ubuntu/worktrees/acme-main",
    }),
    prepare: async () => {
      markers.push(["<prepare>"]);
      fake.calls.push({ argv: ["<prepare>"] });
    },
    resumeHook: async () => {
      fake.calls.push({ argv: ["<resume-hook>"] });
    },
    ...extra,
  };
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
      ["volume", "rm", "-f", names.volume],
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
