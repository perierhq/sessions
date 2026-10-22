/**
 * A stateful stand-in for rootless podman, shared by the podman provider
 * tests (podman.test.ts, podman-qualify.test.ts). Nothing here spawns podman.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult } from "../provider";
import { podmanSettings, type PodmanProviderDeps } from "./podman";
import type { PodmanRunOpts } from "./podman-cli";
import {
  EGRESS_FIXTURE_INPUT,
  EGRESS_FIXTURE_LISTING,
} from "./podman-egress-fixture";

export const IMAGE = "localhost/opensession-sandbox:0123456789abcdef";
export const NETNS = "/run/user/1001/netns/netns-test";

export function ok(stdout = ""): ExecResult {
  return { exitCode: 0, stdout, stderr: "" };
}
export function fail(stderr: string, exitCode = 1): ExecResult {
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

export interface FakeOptions {
  podExists?: boolean;
  running?: boolean;
  imageExists?: boolean;
  nftInstallFails?: boolean;
  selfTest?: Record<string, string>;
  podSurvivesRm?: boolean;
  podState?: string;
  /** `podman info --format json` output. */
  info?: string;
  /** The workload's `{{.State.CgroupPath}}`. */
  cgroup?: string;
}

/** A stateful stand-in for rootless podman: one pod, its infra and its
 *  workload. Records every argv and the options it was run with. */
export function fakePodman(o: FakeOptions = {}) {
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
    if (a === "info")
      return o.info === undefined ? fail("no info") : ok(o.info);
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
      if (format === "{{.State.CgroupPath}}")
        return ok(
          `${o.cgroup ?? "/user.slice/user-1001.slice/user@1001.service/user.slice/libpod-x.scope"}\n`,
        );
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

/** Provider deps wired to a fake podman and this fixture's addresses. */
export function fakeProviderDeps(
  fake: ReturnType<typeof fakePodman>,
  extra: Partial<PodmanProviderDeps> = {},
): PodmanProviderDeps {
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
      fake.calls.push({ argv: ["<prepare>"] });
    },
    resumeHook: async () => {
      fake.calls.push({ argv: ["<resume-hook>"] });
    },
    ...extra,
  };
}
