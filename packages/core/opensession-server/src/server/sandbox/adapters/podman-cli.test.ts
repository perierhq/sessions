import { afterEach, describe, expect, test } from "bun:test";
import {
  createPodmanRunner,
  execArgs,
  PODMAN_PASTA_NETWORK,
  podCreateArgs,
  podmanEnv,
  podmanNames,
  volumeCreateArgs,
  workloadCreateArgs,
} from "./podman-cli";

/** Every value that follows a flag in argv, e.g. all `-v` operands. */
function operands(argv: string[], flag: string): string[] {
  const out: string[] = [];
  argv.forEach((word, i) => {
    if (word === flag && i + 1 < argv.length) out.push(argv[i + 1]!);
  });
  return out;
}

/** `flag value` appears as two adjacent words. */
function hasPair(argv: string[], flag: string, value: string): boolean {
  return argv.some((word, i) => word === flag && argv[i + 1] === value);
}

describe("podman names", () => {
  test("a hostile session id stays inside the prefix", () => {
    const names = podmanNames("bks-AB/../x");
    for (const name of [names.pod, names.volume, names.workload, names.infra]) {
      expect(name.startsWith("opensession-sbx-")).toBe(true);
      expect(name).not.toContain("/");
      expect(name).not.toContain("..");
      expect(name).toMatch(/^[a-z0-9][a-z0-9_.-]*$/);
    }
    expect(names.key.length).toBeLessThanOrEqual(48);
  });

  test("derives every resource from the pod name", () => {
    const names = podmanNames("sess-1");
    expect(names).toEqual({
      key: "sess-1",
      pod: "opensession-sbx-sess-1",
      infra: "opensession-sbx-sess-1-infra",
      volume: "opensession-sbx-sess-1-home",
      workload: "opensession-sbx-sess-1-ws",
    });
  });

  test("ids that sanitize or truncate to the same text get different keys", () => {
    expect(podmanNames("a/b").key).not.toBe(podmanNames("a-b").key);
    expect(podmanNames("AB").key).not.toBe(podmanNames("ab").key);
    const long = "x".repeat(80);
    expect(podmanNames(long).key.length).toBeLessThanOrEqual(48);
    expect(podmanNames(long).key).not.toBe(podmanNames(`${long}y`).key);
    expect(podmanNames("a-b").key).toBe(podmanNames("a-b").key);
  });

  test("an empty session id is refused", () => {
    expect(() => podmanNames("")).toThrow();
  });
});

describe("podman argv", () => {
  const names = podmanNames("sess-1");

  test("pod create isolates the network namespace", () => {
    const argv = podCreateArgs({
      names,
      sessionId: "sess-1",
      dns: ["1.1.1.1", "9.9.9.9"],
    });
    expect(argv.slice(0, 2)).toEqual(["pod", "create"]);
    expect(hasPair(argv, "--name", names.pod)).toBe(true);
    expect(hasPair(argv, "--infra-name", names.infra)).toBe(true);
    expect(hasPair(argv, "--network", PODMAN_PASTA_NETWORK)).toBe(true);
    expect(PODMAN_PASTA_NETWORK).toBe(
      "pasta:--no-map-gw,-T,none,-U,none,-t,none,-u,none,-4,--map-guest-addr,none",
    );
    expect(argv).toContain("--no-hosts");
    expect(hasPair(argv, "--share", "net,uts,ipc")).toBe(true);
    expect(operands(argv, "--dns")).toEqual(["1.1.1.1", "9.9.9.9"]);
    expect(hasPair(argv, "--dns-search", ".")).toBe(true);
    expect(hasPair(argv, "--hostname", "sandbox")).toBe(true);
    expect(operands(argv, "--label").sort()).toEqual([
      "opensession.sandbox=1",
      "opensession.session=sess-1",
    ]);
    for (const word of ["-p", "--publish", "host", "--network=host"])
      expect(argv).not.toContain(word);
  });

  test("pod create refuses resolvers that are not IPv4 addresses", () => {
    expect(() =>
      podCreateArgs({ names, sessionId: "s", dns: ["dns.example.test"] }),
    ).toThrow();
    expect(() => podCreateArgs({ names, sessionId: "s", dns: [] })).toThrow();
  });

  test("volume create labels the volume", () => {
    const argv = volumeCreateArgs({ names, sessionId: "sess-1" });
    expect(argv.slice(0, 2)).toEqual(["volume", "create"]);
    expect(argv.at(-1)).toBe(names.volume);
    expect(operands(argv, "--label")).toContain("opensession.sandbox=1");
  });

  test("workload create drops every privilege and mounts only the volume", () => {
    const argv = workloadCreateArgs({
      names,
      image: "localhost/opensession-sandbox:0123456789abcdef",
      memoryMb: 4096,
      pidsLimit: 4096,
    });
    expect(argv[0]).toBe("create");
    expect(hasPair(argv, "--pod", names.pod)).toBe(true);
    expect(hasPair(argv, "--name", names.workload)).toBe(true);
    expect(hasPair(argv, "--user", "1000:1000")).toBe(true);
    expect(hasPair(argv, "--cap-drop", "ALL")).toBe(true);
    expect(hasPair(argv, "--security-opt", "no-new-privileges")).toBe(true);
    expect(hasPair(argv, "--security-opt", "label=type:container_t")).toBe(
      true,
    );
    expect(argv).toContain("--read-only");
    expect(argv).toContain("--read-only-tmpfs=true");
    expect(argv).toContain("--init");
    expect(hasPair(argv, "--pids-limit", "4096")).toBe(true);
    expect(hasPair(argv, "--memory", "4096m")).toBe(true);
    expect(hasPair(argv, "--memory-swap", "4096m")).toBe(true);
    expect(hasPair(argv, "--ulimit", "nofile=65536:65536")).toBe(true);
    expect(operands(argv, "-v")).toEqual([`${names.volume}:/home/ubuntu:Z`]);
    for (const flag of ["--volume", "--mount", "--cap-add", "--cpus"])
      expect(argv).not.toContain(flag);
    expect(argv.filter((w) => w === "-v")).toHaveLength(1);
    for (const word of argv) {
      expect(word.startsWith("--privileged")).toBe(false);
      expect(word.startsWith("--restart")).toBe(false);
      expect(word.startsWith("--network")).toBe(false);
      expect(word.startsWith("-p")).toBe(false);
      expect(word).not.toContain("seccomp=unconfined");
      expect(word).not.toContain("label=disable");
    }
    expect(argv.slice(-3)).toEqual([
      "localhost/opensession-sandbox:0123456789abcdef",
      "sleep",
      "infinity",
    ]);
  });

  test("workload create adds --cpus only when a CPU limit is given", () => {
    const argv = workloadCreateArgs({
      names,
      image: "localhost/opensession-sandbox:0123456789abcdef",
      memoryMb: 2048,
      pidsLimit: 512,
      cpu: 2,
    });
    expect(hasPair(argv, "--cpus", "2")).toBe(true);
    expect(hasPair(argv, "--memory", "2048m")).toBe(true);
  });

  test("workload create refuses bad limits and option-like images", () => {
    const base = {
      names,
      image: "localhost/opensession-sandbox:0123456789abcdef",
      memoryMb: 4096,
      pidsLimit: 4096,
    };
    expect(() => workloadCreateArgs({ ...base, memoryMb: 0 })).toThrow();
    expect(() => workloadCreateArgs({ ...base, pidsLimit: 1.5 })).toThrow();
    expect(() => workloadCreateArgs({ ...base, cpu: -1 })).toThrow();
    expect(() =>
      workloadCreateArgs({ ...base, image: "--privileged" }),
    ).toThrow();
  });

  test("exec passes secrets by name and pins the user", () => {
    const argv = execArgs({
      workload: names.workload,
      cwd: "/home/ubuntu/work",
      envNames: ["GH_TOKEN"],
      timeoutSec: 30,
      cmd: "echo hi",
    });
    expect(argv[0]).toBe("exec");
    expect(hasPair(argv, "--env", "GH_TOKEN")).toBe(true);
    expect(argv.some((w) => w.includes("="))).toBe(false);
    expect(hasPair(argv, "--user", "1000:1000")).toBe(true);
    expect(hasPair(argv, "--workdir", "/home/ubuntu/work")).toBe(true);
    expect(argv).not.toContain("-d");
    expect(argv).not.toContain("-t");
    expect(argv.slice(-8)).toEqual([
      names.workload,
      "/usr/bin/timeout",
      "-k",
      "5",
      "30",
      "/bin/bash",
      "-c",
      "echo hi",
    ]);
  });

  test("exec -d detaches, -i keeps stdin open", () => {
    const detached = execArgs({
      workload: names.workload,
      envNames: [],
      timeoutSec: 0,
      detached: true,
      cmd: "sleep 1",
    });
    expect(detached).toContain("-d");
    expect(detached.slice(-4)).toEqual([
      names.workload,
      "/bin/bash",
      "-c",
      "sleep 1",
    ]);
    const piped = execArgs({
      workload: names.workload,
      envNames: [],
      timeoutSec: 5,
      stdin: true,
      cmd: "cat",
    });
    expect(piped).toContain("-i");
  });

  test("exec refuses unsafe env names, relative cwd and foreign containers", () => {
    const envNames: string[] = [];
    const base = {
      workload: names.workload,
      envNames,
      timeoutSec: 5,
      cmd: "true",
    };
    expect(() => execArgs({ ...base, envNames: ["GH_TOKEN=x"] })).toThrow();
    expect(() => execArgs({ ...base, envNames: ["PATH"] })).toThrow();
    expect(() => execArgs({ ...base, cwd: "work" })).toThrow();
    expect(() => execArgs({ ...base, workload: "habit-dev-db" })).toThrow();
    expect(() => execArgs({ ...base, timeoutSec: 0 })).toThrow();
  });
});

describe("podman env", () => {
  afterEach(() => {
    delete process.env.OPENSESSION_TEST_SECRET;
  });

  test("carries only the user session variables and the caller's extras", () => {
    process.env.OPENSESSION_TEST_SECRET = "leak";
    const env = podmanEnv(1001, { GH_TOKEN: "t" });
    expect(Object.keys(env).sort()).toEqual([
      "DBUS_SESSION_BUS_ADDRESS",
      "GH_TOKEN",
      "HOME",
      "PATH",
      "XDG_RUNTIME_DIR",
    ]);
    expect(env.XDG_RUNTIME_DIR).toBe("/run/user/1001");
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/run/user/1001/bus");
    expect(Object.values(env)).not.toContain("leak");
    expect(Object.keys(podmanEnv(1001)).sort()).toEqual([
      "DBUS_SESSION_BUS_ADDRESS",
      "HOME",
      "PATH",
      "XDG_RUNTIME_DIR",
    ]);
  });

  test("extras cannot replace the session variables", () => {
    expect(() => podmanEnv(1001, { PATH: "/tmp" })).toThrow();
    expect(() => podmanEnv(1001, { XDG_RUNTIME_DIR: "/tmp" })).toThrow();
    expect(() => podmanEnv(1001, { "BAD-NAME": "x" })).toThrow();
  });
});

describe("podman runner", () => {
  afterEach(() => {
    delete process.env.OPENSESSION_TEST_SECRET;
  });

  test("spawns with the minimal env and the caller's stdin", async () => {
    process.env.OPENSESSION_TEST_SECRET = "leak";
    const run = createPodmanRunner({ binary: "/usr/bin/env", uid: 1001 });
    const result = await run([], { env: { GH_TOKEN: "t" } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("GH_TOKEN=t");
    expect(result.stdout).toContain("XDG_RUNTIME_DIR=/run/user/1001");
    expect(result.stdout).not.toContain("OPENSESSION_TEST_SECRET");

    const cat = createPodmanRunner({ binary: "/bin/cat", uid: 1001 });
    expect((await cat([], { stdin: "rules\n" })).stdout).toBe("rules\n");
  });

  test("never throws: non-zero exits, timeouts and a missing binary are results", async () => {
    const fail = createPodmanRunner({ binary: "/usr/bin/false", uid: 1001 });
    expect((await fail([])).exitCode).not.toBe(0);

    const slow = createPodmanRunner({ binary: "/bin/sleep", uid: 1001 });
    const started = Date.now();
    const timedOut = await slow(["5"], { timeoutMs: 100 });
    expect(timedOut.exitCode).toBe(124);
    expect(timedOut.stderr).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(3000);

    const missing = createPodmanRunner({
      binary: "/nonexistent/podman",
      uid: 1001,
    });
    expect((await missing(["info"])).exitCode).toBe(127);
  });
});
