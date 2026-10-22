import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPodmanRunner,
  execArgs,
  execEnvFileText,
  type PodmanRunner,
  podmanExec,
  PODMAN_MAX_OUTPUT_BYTES,
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

  test("exec passes env through a file and pins the user", () => {
    const argv = execArgs({
      workload: names.workload,
      cwd: "/home/ubuntu/work",
      envFile: "/run/user/1001/opensession/exec-env-x",
      timeoutSec: 30,
      cmd: "echo hi",
    });
    expect(argv[0]).toBe("exec");
    expect(
      hasPair(argv, "--env-file", "/run/user/1001/opensession/exec-env-x"),
    ).toBe(true);
    expect(argv).not.toContain("--env");
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
      timeoutSec: 5,
      stdin: true,
      cmd: "cat",
    });
    expect(piped).toContain("-i");
  });

  test("exec refuses relative env files, relative cwd and foreign containers", () => {
    const base = {
      workload: names.workload,
      timeoutSec: 5,
      cmd: "true",
    };
    expect(() => execArgs({ ...base, envFile: "env" })).toThrow();
    expect(() => execArgs({ ...base, cwd: "work" })).toThrow();
    expect(() => execArgs({ ...base, workload: "habit-dev-db" })).toThrow();
    expect(() => execArgs({ ...base, timeoutSec: 0 })).toThrow();
  });
});

describe("podman env", () => {
  test("is exactly the user session variables", () => {
    const env = podmanEnv(1001);
    expect(Object.keys(env).sort()).toEqual([
      "DBUS_SESSION_BUS_ADDRESS",
      "HOME",
      "PATH",
      "XDG_RUNTIME_DIR",
    ]);
    expect(env.XDG_RUNTIME_DIR).toBe("/run/user/1001");
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/run/user/1001/bus");
    expect(env.PATH).toBe(
      "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    );
  });
});

describe("exec env file", () => {
  test("carries in-container names, PATH and HOME included", () => {
    expect(
      execEnvFileText({
        GH_TOKEN: "t",
        PATH: "/home/ubuntu/.bun/bin:/usr/bin",
        HOME: "/home/ubuntu",
        LD_PRELOAD: "/home/ubuntu/x.so",
        QUOTED: '"kept" $HOME \\ #x ',
      }),
    ).toBe(
      "GH_TOKEN=t\n" +
        "PATH=/home/ubuntu/.bun/bin:/usr/bin\n" +
        "HOME=/home/ubuntu\n" +
        "LD_PRELOAD=/home/ubuntu/x.so\n" +
        'QUOTED="kept" $HOME \\ #x \n',
    );
  });

  test("refuses values a line cannot carry", () => {
    expect(() => execEnvFileText({ KEY: "line one\nline two" })).toThrow(
      "KEY contains a line break",
    );
    expect(() => execEnvFileText({ KEY: "x\r" })).toThrow(
      "KEY contains a line break",
    );
  });

  test("refuses bad names, NUL and oversized values", () => {
    for (const name of ["BAD-NAME", "A=B", "1A", "", "LD*", " A"])
      expect(() => execEnvFileText({ [name]: "x" })).toThrow();
    expect(() => execEnvFileText({ A: "a\0b" })).toThrow();
    expect(() => execEnvFileText({ A: "x".repeat(70_000) })).toThrow();
  });
});

describe("podman exec", () => {
  const names = podmanNames("sess-1");
  const dirs: string[] = [];
  afterEach(async () => {
    for (const key of ["LD_PRELOAD", "CONTAINERS_CONF", "CONTAINER_HOST"])
      delete process.env[key];
    for (const dir of dirs.splice(0))
      await rm(dir, { recursive: true, force: true });
  });
  async function runtimeDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "podman-exec-test-"));
    dirs.push(dir);
    return dir;
  }

  test("writes a 0600 env file in a 0700 dir and removes it", async () => {
    const dir = await runtimeDir();
    const seen: {
      argv: string[];
      mode: number;
      dirMode: number;
      text: string;
    }[] = [];
    const run: PodmanRunner = async (argv) => {
      const file = argv[argv.indexOf("--env-file") + 1]!;
      seen.push({
        argv,
        mode: (await stat(file)).mode & 0o777,
        dirMode: (await stat(join(dir, "opensession"))).mode & 0o777,
        text: await readFile(file, "utf8"),
      });
      return { exitCode: 0, stdout: "ok", stderr: "" };
    };
    const result = await podmanExec(run, {
      workload: names.workload,
      cwd: "/home/ubuntu",
      env: { GH_TOKEN: "t", PATH: "/usr/bin" },
      timeoutSec: 30,
      cmd: "echo hi",
      runtimeDir: dir,
    });
    expect(result).toEqual({ exitCode: 0, stdout: "ok", stderr: "" });
    expect(seen).toHaveLength(1);
    const file = seen[0]!.argv[seen[0]!.argv.indexOf("--env-file") + 1]!;
    expect(file.startsWith(join(dir, "opensession") + "/")).toBe(true);
    expect(seen[0]!.mode).toBe(0o600);
    expect(seen[0]!.dirMode).toBe(0o700);
    expect(seen[0]!.text).toBe("GH_TOKEN=t\nPATH=/usr/bin\n");
    expect(seen[0]!.argv).toEqual([
      "exec",
      "--user",
      "1000:1000",
      "--workdir",
      "/home/ubuntu",
      "--env-file",
      file,
      names.workload,
      "/usr/bin/timeout",
      "-k",
      "5",
      "30",
      "/bin/bash",
      "-c",
      "echo hi",
    ]);
    expect(await readdir(join(dir, "opensession"))).toEqual([]);
  });

  test("removes the env file when the runner fails", async () => {
    const dir = await runtimeDir();
    const run: PodmanRunner = async () => {
      throw new Error("boom");
    };
    await expect(
      podmanExec(run, {
        workload: names.workload,
        env: { A: "b" },
        timeoutSec: 5,
        cmd: "true",
        runtimeDir: dir,
      }),
    ).rejects.toThrow("boom");
    expect(await readdir(join(dir, "opensession"))).toEqual([]);
  });

  test("removes the env file after a failed exec and refuses before writing", async () => {
    const dir = await runtimeDir();
    const calls: string[][] = [];
    const failed = await podmanExec(
      async (argv) => {
        calls.push(argv);
        return { exitCode: 125, stdout: "", stderr: "no such container" };
      },
      {
        workload: names.workload,
        env: { A: "b" },
        timeoutSec: 5,
        cmd: "true",
        runtimeDir: dir,
      },
    );
    expect(failed.exitCode).toBe(125);
    expect(await readdir(join(dir, "opensession"))).toEqual([]);
    await expect(
      podmanExec(
        async (argv) => {
          calls.push(argv);
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        {
          workload: names.workload,
          env: { A: "b", KEY: "two\nlines" },
          timeoutSec: 5,
          cmd: "true",
          runtimeDir: dir,
        },
      ),
    ).rejects.toThrow("KEY contains a line break");
    expect(calls).toHaveLength(1);
    expect(await readdir(join(dir, "opensession"))).toEqual([]);
  });

  test("passes no env file when there is no env", async () => {
    const dir = await runtimeDir();
    const calls: string[][] = [];
    await podmanExec(
      async (argv) => {
        calls.push(argv);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      { workload: names.workload, timeoutSec: 5, cmd: "true", runtimeDir: dir },
    );
    expect(calls[0]).not.toContain("--env-file");
  });

  test("tightens an existing dir and refuses a symlinked one", async () => {
    const dir = await runtimeDir();
    await mkdir(join(dir, "opensession"), { mode: 0o755 });
    await chmod(join(dir, "opensession"), 0o755);
    const ok = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    await podmanExec(ok, {
      workload: names.workload,
      env: { A: "b" },
      timeoutSec: 5,
      cmd: "true",
      runtimeDir: dir,
    });
    expect((await lstat(join(dir, "opensession"))).mode & 0o777).toBe(0o700);

    const other = await runtimeDir();
    const target = await runtimeDir();
    await symlink(target, join(other, "opensession"));
    await expect(
      podmanExec(ok, {
        workload: names.workload,
        env: { A: "b" },
        timeoutSec: 5,
        cmd: "true",
        runtimeDir: other,
      }),
    ).rejects.toThrow();
    expect(await readdir(target)).toEqual([]);
  });

  test("caller env never reaches the host podman process", async () => {
    const dir = await runtimeDir();
    const stub = join(dir, "podman-stub");
    await writeFile(
      stub,
      [
        "#!/bin/sh",
        "/usr/bin/env",
        'prev=""',
        'for a in "$@"; do',
        '  if [ "$prev" = "--env-file" ]; then echo "FILE<<"; cat "$a"; echo ">>FILE"; fi',
        '  prev="$a"',
        "done",
        "",
      ].join("\n"),
    );
    await chmod(stub, 0o755);
    process.env.LD_PRELOAD = "/nonexistent/host.so";
    process.env.CONTAINERS_CONF = "/tmp/evil.conf";
    process.env.CONTAINER_HOST = "unix:///tmp/evil.sock";
    const run = createPodmanRunner({ binary: stub, uid: 1001 });
    const result = await podmanExec(run, {
      workload: names.workload,
      env: {
        LD_PRELOAD: "/home/ubuntu/evil.so",
        CONTAINERS_CONF: "/home/ubuntu/containers.conf",
        CONTAINER_HOST: "unix:///home/ubuntu/podman.sock",
        PATH: "/home/ubuntu/bin",
        HOME: "/home/ubuntu",
      },
      timeoutSec: 5,
      cmd: "true",
      runtimeDir: dir,
    });
    expect(result.exitCode).toBe(0);
    const [hostEnv, rest] = result.stdout.split("FILE<<\n");
    const hostKeys = hostEnv!
      .trim()
      .split("\n")
      .map((line) => line.slice(0, line.indexOf("=")))
      .filter((key) => key !== "PWD" && key !== "SHLVL" && key !== "_")
      .sort();
    expect(hostKeys).toEqual([
      "DBUS_SESSION_BUS_ADDRESS",
      "HOME",
      "PATH",
      "XDG_RUNTIME_DIR",
    ]);
    expect(hostEnv).toContain(
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n",
    );
    expect(hostEnv).not.toContain("/home/ubuntu/bin");
    expect(rest).toBe(
      "LD_PRELOAD=/home/ubuntu/evil.so\n" +
        "CONTAINERS_CONF=/home/ubuntu/containers.conf\n" +
        "CONTAINER_HOST=unix:///home/ubuntu/podman.sock\n" +
        "PATH=/home/ubuntu/bin\n" +
        "HOME=/home/ubuntu\n" +
        ">>FILE\n",
    );
    expect(await readdir(join(dir, "opensession"))).toEqual([]);
  });
});

describe("podman runner", () => {
  test("spawns with the minimal env and the caller's stdin", async () => {
    process.env.OPENSESSION_TEST_SECRET = "leak";
    try {
      const run = createPodmanRunner({ binary: "/usr/bin/env", uid: 1001 });
      const result = await run([]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("XDG_RUNTIME_DIR=/run/user/1001");
      expect(result.stdout).not.toContain("OPENSESSION_TEST_SECRET");
    } finally {
      delete process.env.OPENSESSION_TEST_SECRET;
    }
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

  async function stub(
    body: (dir: string) => string,
  ): Promise<{ binary: string; dir: string }> {
    const dir = await mkdtemp(join(tmpdir(), "podman-runner-test-"));
    const binary = join(dir, "podman-stub");
    await writeFile(binary, `#!/bin/sh\n${body(dir)}\n`);
    await chmod(binary, 0o755);
    return { binary, dir };
  }

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  test("a timeout kills the whole process group", async () => {
    const { binary, dir } = await stub(
      (dir) => `/bin/sleep 30 &\necho $! > ${dir}/child.pid\nwait`,
    );
    try {
      const run = createPodmanRunner({ binary, uid: 1001 });
      const started = Date.now();
      // Long enough for a loaded machine to start the shell and its child.
      const result = await run([], { timeoutMs: 1000 });
      expect(result.exitCode).toBe(124);
      expect(Date.now() - started).toBeLessThan(4000);
      const pid = Number(
        (await readFile(join(dir, "child.pid"), "utf8")).trim(),
      );
      for (let i = 0; i < 20 && alive(pid); i++) await Bun.sleep(50);
      expect(alive(pid)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a timeout returns even when an escaped child holds the pipes", async () => {
    const { binary, dir } = await stub(
      (dir) =>
        `/usr/bin/perl -e 'use POSIX; POSIX::setsid(); sleep 30' &\n` +
        `echo $! > ${dir}/escaped.pid\nwait`,
    );
    try {
      const run = createPodmanRunner({ binary, uid: 1001 });
      const started = Date.now();
      const result = await run([], { timeoutMs: 300 });
      expect(result.exitCode).toBe(124);
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      const pid = Number(
        await readFile(join(dir, "escaped.pid"), "utf8").catch(() => "0"),
      );
      if (pid > 0 && alive(pid)) process.kill(pid, "SIGKILL");
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("caps stdout and stderr at 8 MiB and says so", async () => {
    const { binary, dir } = await stub(
      () =>
        "/usr/bin/head -c 9000000 /dev/zero\n/usr/bin/head -c 10 /dev/zero >&2",
    );
    try {
      const run = createPodmanRunner({ binary, uid: 1001 });
      const result = await run([]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.length).toBe(PODMAN_MAX_OUTPUT_BYTES);
      expect(result.stderr.length).toBe(10);
      expect(result.truncated).toBe(true);
      const small = await createPodmanRunner({
        binary: "/bin/echo",
        uid: 1001,
      })(["hi"]);
      expect(small).toEqual({ exitCode: 0, stdout: "hi\n", stderr: "" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
