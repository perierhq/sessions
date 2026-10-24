import { describe, expect, test } from "bun:test";
import type { ExecResult } from "../provider";
import { podmanVolumeUsage } from "./podman";
import {
  execArgs,
  podCreateArgs,
  podmanNames,
  volumeCreateArgs,
  workloadCreateArgs,
  type PodmanRunOpts,
} from "./podman-cli";
import {
  HOST_DU_DENIED_STDERR,
  HOST_DU_OUTPUT,
  HOST_DU_VANISHED_STDERR,
  HOST_MOUNTPOINT,
  HOST_VOLUME_LS_EMPTY,
  HOST_VOLUME_LS_JSON,
} from "./podman-host-fixture";
import { isVerifiedPodmanArgv } from "./podman-verified-argv";

function hostRunner(du: ExecResult, volumes = HOST_VOLUME_LS_JSON) {
  const calls: { argv: string[]; opts?: PodmanRunOpts }[] = [];
  const run = async (argv: string[], opts?: PodmanRunOpts) => {
    calls.push({ argv, opts });
    if (argv[0] === "volume" && argv[1] === "ls")
      return { exitCode: 0, stdout: volumes, stderr: "" };
    if (argv[0] === "unshare" && argv[1] === "du") return du;
    return { exitCode: 125, stdout: "", stderr: "unexpected" };
  };
  return { run, calls };
}

describe("podman volume usage", () => {
  test("lists labelled volumes, then sums them with du in podman's user namespace", async () => {
    const host = hostRunner({
      exitCode: 0,
      stdout: HOST_DU_OUTPUT,
      stderr: "",
    });
    const usage = await podmanVolumeUsage(host.run);
    expect([...usage]).toEqual([["opensession-sbx-sess-1-home", 3002368]]);
    expect(host.calls.map(({ argv }) => argv)).toEqual([
      [
        "volume",
        "ls",
        "--filter",
        "label=opensession.sandbox=1",
        "--format",
        "json",
      ],
      ["unshare", "du", "-s", "-x", "-B1", "--", HOST_MOUNTPOINT],
    ]);
    for (const { argv, opts } of host.calls) {
      expect(isVerifiedPodmanArgv(argv)).toBe(true);
      expect(opts?.timeoutMs).toBeGreaterThan(0);
    }
  });

  test("no sandbox volumes: nothing to measure, and du is not run", async () => {
    const host = hostRunner(
      { exitCode: 1, stdout: "", stderr: "unused" },
      HOST_VOLUME_LS_EMPTY,
    );
    expect((await podmanVolumeUsage(host.run)).size).toBe(0);
    expect(host.calls).toHaveLength(1);
  });

  test("files vanishing mid-walk keep the totals; any other du error fails the check", async () => {
    const busy = hostRunner({
      exitCode: 1,
      stdout: HOST_DU_OUTPUT,
      stderr: HOST_DU_VANISHED_STDERR,
    });
    expect(
      (await podmanVolumeUsage(busy.run)).get("opensession-sbx-sess-1-home"),
    ).toBe(3002368);
    const denied = hostRunner({
      exitCode: 1,
      stdout: `0\t${HOST_MOUNTPOINT}\n`,
      stderr: HOST_DU_DENIED_STDERR,
    });
    await expect(podmanVolumeUsage(denied.run)).rejects.toThrow(
      /podman unshare du: .*Permission denied/,
    );
  });

  test("a volume du did not report is left out (its session is unknown)", async () => {
    const host = hostRunner({
      exitCode: 1,
      stdout: "",
      stderr: `du: cannot access '${HOST_MOUNTPOINT}': No such file or directory\n`,
    });
    expect((await podmanVolumeUsage(host.run)).size).toBe(0);
  });

  test("a failed volume listing fails the check", async () => {
    const run = async () => ({
      exitCode: 125,
      stdout: "",
      stderr: "Error: database is locked",
    });
    await expect(podmanVolumeUsage(run)).rejects.toThrow(
      /podman volume ls: Error: database is locked/,
    );
  });
});

describe("podman argv checked on a host", () => {
  const names = podmanNames("sess-1");

  test("the builders' argv are all verified shapes", () => {
    const argvs = [
      volumeCreateArgs({ names, sessionId: "sess-1" }),
      podCreateArgs({
        names,
        sessionId: "sess-1",
        dns: ["1.1.1.1", "9.9.9.9"],
      }),
      workloadCreateArgs({
        names,
        image: "localhost/opensession-sandbox:0123456789abcdef",
        memoryMb: 4096,
        pidsLimit: 4096,
      }),
      workloadCreateArgs({
        names,
        image: "localhost/opensession-sandbox:0123456789abcdef",
        memoryMb: 512,
        pidsLimit: 256,
        cpu: 1.5,
      }),
      // The default CPU limit on a host that delegates `cpu`.
      workloadCreateArgs({
        names,
        image: "localhost/opensession-sandbox:0123456789abcdef",
        memoryMb: 4096,
        pidsLimit: 4096,
        cpu: 2,
      }),
      execArgs({ workload: names.workload, timeoutSec: 30, cmd: "echo a b" }),
      execArgs({
        workload: names.workload,
        timeoutSec: 30,
        stdin: true,
        cwd: "/home/ubuntu/worktrees/acme",
        envFile: "/run/user/1001/opensession/exec-env-0123",
        cmd: "cat\nexit 0",
      }),
      execArgs({
        workload: names.workload,
        timeoutSec: 0,
        detached: true,
        cmd: "sleep 1",
      }),
    ];
    for (const argv of argvs) expect(isVerifiedPodmanArgv(argv)).toBe(true);
  });

  test("a workload with swap beyond its memory is not a verified shape", () => {
    const argv = workloadCreateArgs({
      names,
      image: "localhost/opensession-sandbox:0123456789abcdef",
      memoryMb: 4096,
      pidsLimit: 4096,
    });
    expect(isVerifiedPodmanArgv(argv)).toBe(true);
    const more = [...argv];
    more[more.indexOf("--memory-swap") + 1] = "8192m";
    expect(isVerifiedPodmanArgv(more)).toBe(false);
  });

  test("argv podman 5.8 rejects are not verified shapes", () => {
    // podman: "cannot combine --format and --verbose flags".
    expect(
      isVerifiedPodmanArgv(["system", "df", "-v", "--format", "json"]),
    ).toBe(false);
    // podman: "unknown shorthand flag: 'a' in -a".
    expect(
      isVerifiedPodmanArgv([
        "pod",
        "ps",
        "-a",
        "--filter",
        "label=opensession.sandbox=1",
        "--format",
        "{{.Name}}",
      ]),
    ).toBe(false);
    expect(
      isVerifiedPodmanArgv([
        "pod",
        "ps",
        "--filter",
        "label=opensession.sandbox=1",
        "--format",
        "{{.Name}}",
      ]),
    ).toBe(true);
  });
});
