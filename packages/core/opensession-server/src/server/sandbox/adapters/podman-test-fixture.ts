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
  /** For a pod that starts out running: whether its namespace already holds
   *  the egress rules (default true). */
  rulesInstalled?: boolean;
  imageExists?: boolean;
  nftInstallFails?: boolean;
  selfTest?: Record<string, string>;
  podSurvivesRm?: boolean;
  /** `pod stop` fails (and leaves everything running). */
  stopFails?: boolean;
  /** `pod kill` fails too. */
  killFails?: boolean;
  podState?: string;
  /** `podman info --format json` output. */
  info?: string;
  /** The workload's `{{.State.CgroupPath}}`. */
  cgroup?: string;
}

/** An nft listing of a namespace with no ruleset loaded. */
const EMPTY_LISTING =
  '{"nftables": [{"metainfo": {"version": "1.0.9", "release_name": "Old Doc Yak #3", "json_schema_version": 1}}]}';

/**
 * A stateful stand-in for rootless podman: one pod, its infra and its
 * workload. Records every argv and the options it was run with.
 *
 * Network namespaces are modelled: every infra start (explicit, or the
 * auto-start podman does when the workload starts with the infra stopped)
 * makes a fresh namespace with no rules; nft installs into one namespace and
 * lists only that namespace's rules; a namespace and its rules go away when
 * nothing runs in it. Each exec records whether the workload's namespace held
 * the rules at that moment.
 */
export function fakePodman(o: FakeOptions = {}) {
  const calls: { argv: string[]; opts?: PodmanRunOpts }[] = [];
  const state = {
    podExists: o.podExists ?? false,
    workloadExists: o.podExists ?? false,
    volumeExists: o.podExists ?? false,
    infraRunning: false,
    running: false,
    packets: 0,
    netnsSeq: 0,
    infraNetns: null as string | null,
    workloadNetns: null as string | null,
    workloadPid: 0,
    workloadStarts: 0,
    startedAt: "",
    /** Namespaces holding the egress ruleset. */
    rules: new Set<string>(),
    /** Every exec into the workload, with whether its namespace was
     *  filtered when it ran. */
    execs: [] as { script: string; filtered: boolean }[],
  };
  const forget = (netns: string | null) => {
    if (!netns) return;
    const held =
      (state.infraRunning && state.infraNetns === netns) ||
      (state.running && state.workloadNetns === netns);
    if (!held) state.rules.delete(netns);
  };
  const startInfra = () => {
    if (state.infraRunning) return;
    state.netnsSeq += 1;
    state.infraNetns =
      state.netnsSeq === 1 ? NETNS : `${NETNS}-${state.netnsSeq}`;
    state.infraRunning = true;
  };
  const startWorkload = () => {
    if (state.running) return;
    // Real podman auto-starts a stopped infra, in a fresh namespace with no
    // rules.
    startInfra();
    state.workloadStarts += 1;
    state.workloadPid = 4241 + state.workloadStarts;
    state.workloadNetns = state.infraNetns;
    state.startedAt = new Date(
      Date.UTC(2026, 0, 1, 0, 0, state.workloadStarts),
    ).toISOString();
    state.running = true;
  };
  /** Stop the infra only (out of band). The namespace survives while the
   *  workload still runs in it. */
  const stopInfra = () => {
    const netns = state.infraNetns;
    state.infraRunning = false;
    state.infraNetns = null;
    forget(netns);
  };
  /** Stop the workload only (out of band). */
  const stopWorkload = () => {
    const netns = state.workloadNetns;
    state.running = false;
    state.workloadPid = 0;
    state.workloadNetns = null;
    forget(netns);
  };
  const stopAll = () => {
    stopWorkload();
    stopInfra();
  };
  /** The namespace an `nsenter --net=<path>` lands in, if any. */
  const resolveNetns = (argv: string[]): string | null => {
    const path = argv.find((a) => a.startsWith("--net="))?.slice(6);
    if (!path) return null;
    const proc = /^\/proc\/(\d+)\/ns\/net$/.exec(path);
    if (proc)
      return state.running && Number(proc[1]) === state.workloadPid
        ? state.workloadNetns
        : null;
    return state.infraRunning && path === state.infraNetns ? path : null;
  };
  if (o.running) {
    startInfra();
    if (o.rulesInstalled !== false) state.rules.add(state.infraNetns!);
    startWorkload();
  }
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
    if ((a === "pod" && b === "ps") || (a === "volume" && b === "ls"))
      return ok("");
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
    if (a === "create") {
      state.workloadExists = true;
      return ok();
    }
    if (a === "container" && b === "exists")
      return state.podExists && state.workloadExists ? ok() : fail("");
    if (a === "container" && b === "inspect") {
      const target = last;
      if (target.endsWith("-ws") && !state.workloadExists)
        return fail(`Error: no such container ${target}`, 125);
      const fields: Record<string, string> = {
        ".State.Running": String(state.running),
        ".NetworkSettings.SandboxKey": state.infraRunning
          ? state.infraNetns!
          : "",
        ".State.Pid": String(state.workloadPid),
        ".State.StartedAt": state.running ? state.startedAt : "",
        ".State.CgroupPath":
          o.cgroup ??
          "/user.slice/user-1001.slice/user@1001.service/user.slice/libpod-x.scope",
      };
      return ok(
        `${argv[3]!.replace(/\{\{(\.[\w.]+)\}\}/g, (_, key: string) => fields[key] ?? "?")}\n`,
      );
    }
    if (a === "start") {
      if (last.endsWith("-infra")) startInfra();
      else {
        if (!state.workloadExists)
          return fail(`Error: no such container ${last}`, 125);
        startWorkload();
      }
      return ok();
    }
    if (a === "rm" && argv.includes("-f")) {
      stopWorkload();
      state.workloadExists = false;
      return ok();
    }
    if (a === "unshare") {
      const netns = resolveNetns(argv);
      if (!netns)
        return fail(
          "nsenter: cannot open namespace: No such file or directory",
        );
      if (argv.includes("-f")) {
        if (o.nftInstallFails) return fail("nft: Operation not permitted");
        state.rules.add(netns);
        return ok();
      }
      if (argv.includes("-j")) {
        if (state.rules.has(netns)) return ok(listing());
        return argv.includes("table")
          ? fail("Error: No such file or directory")
          : ok(EMPTY_LISTING);
      }
    }
    if (a === "exec") {
      if (!state.running)
        return fail(
          "Error: can only create exec sessions on running containers: container state improper",
          125,
        );
      const script = last;
      state.execs.push({
        script,
        filtered: state.rules.has(state.workloadNetns!),
      });
      if (script.includes("probe_tcp"))
        return ok(selfTestRows(script, o.selfTest ?? {}));
      return ok("");
    }
    if (a === "pod" && b === "stop") {
      if (o.stopFails) return fail("Error: timed out stopping the pod");
      stopAll();
      return ok();
    }
    if (a === "pod" && b === "kill") {
      if (o.killFails) return fail("Error: could not kill the pod");
      stopAll();
      return ok();
    }
    if (a === "pod" && b === "inspect") {
      if (!state.podExists) return fail("no such pod", 125);
      if (argv[3]?.includes("Labels")) return ok("1\n");
      return ok(`${o.podState ?? (state.running ? "Running" : "Exited")}\n`);
    }
    if (a === "pod" && b === "rm") {
      stopAll();
      state.podExists = o.podSurvivesRm ?? false;
      if (!state.podExists) state.workloadExists = false;
      return ok();
    }
    return fail(`unexpected podman ${argv.join(" ")}`, 125);
  };
  return { run, calls, state, stopInfra, stopWorkload };
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
    storageFree: async () => 100 * 1024 ** 3,
    volumeUsage: async () => new Map(),
    ...extra,
  };
}
