import { describe, expect, test } from "bun:test";
import {
  type PiBashTestHooks,
  incidentUserHomeEnv,
  makePiBashTool,
} from "./pi-bash-tool";

type Spawned = { argv: string[]; env: Record<string, string> };

function fakeProc(code: number, out: string) {
  return {
    pid: 4242,
    stdout: new Response(out).body,
    stderr: new Response("").body,
    exited: Promise.resolve(code),
    kill() {},
  };
}

function hooks(over: Partial<PiBashTestHooks> & { codes?: number[] } = {}): {
  hooks: PiBashTestHooks;
  spawned: Spawned[];
  killed: string[];
} {
  const spawned: Spawned[] = [];
  const killed: string[] = [];
  const codes = [...(over.codes ?? [])];
  return {
    spawned,
    killed,
    hooks: {
      spawn: (argv, opts) => {
        spawned.push({ argv, env: opts.env });
        return fakeProc(codes.shift() ?? 0, "ok");
      },
      inControlPlane: false,
      scope: (argv, env) => ({ command: argv, env }),
      killScope: async (unit) => {
        killed.push(unit);
      },
      ...over,
    },
  };
}

const run = (tool: ReturnType<typeof makePiBashTool>, command: string) =>
  tool.execute(
    "t1",
    { command },
    undefined,
    undefined,
    undefined as never,
  ) as Promise<{ content: { text: string }[] }>;

const home = incidentUserHomeEnv("os-1");

describe("bash as the incident agent user", () => {
  test("runAs wraps the command in sudo as one argument", async () => {
    const h = hooks();
    const tool = makePiBashTool({
      cwd: "/tmp",
      env: { ...home, PATH: "/usr/bin:/bin" },
      gated: false,
      unattended: true,
      runAs: "opensession-incident",
      __testHooks: h.hooks,
    });
    await run(tool, "id -un; cat ~/.ssh/id_rsa");
    expect(h.spawned.at(-1)!.argv.slice(-9)).toEqual([
      "sudo",
      "-n",
      "-E",
      "-u",
      "opensession-incident",
      "--",
      "/bin/bash",
      "-c",
      "id -un; cat ~/.ssh/id_rsa",
    ]);
    expect(h.spawned.at(-1)!.env.HOME).toBe("/tmp/opensession-incident-os-1");
  });

  test("the user prepares its own home first, once per tool", async () => {
    const h = hooks();
    const tool = makePiBashTool({
      cwd: "/tmp",
      env: home,
      gated: false,
      unattended: true,
      runAs: "opensession-incident",
      __testHooks: h.hooks,
    });
    await run(tool, "true");
    await run(tool, "true");
    expect(h.spawned).toHaveLength(3);
    const prep = h.spawned[0]!.argv;
    expect(prep.slice(0, 7)).toEqual([
      "sudo",
      "-n",
      "-E",
      "-u",
      "opensession-incident",
      "--",
      "/bin/bash",
    ]);
    expect(prep[8]).toContain('mkdir -p -- "$HOME" "$TMPDIR"');
    expect(prep[8]).toContain('test -O "$d"');
  });

  test("a home the user cannot own stops the command before it runs", async () => {
    const h = hooks({ codes: [1] });
    const tool = makePiBashTool({
      cwd: "/tmp",
      env: home,
      gated: false,
      unattended: true,
      runAs: "opensession-incident",
      __testHooks: h.hooks,
    });
    await expect(run(tool, "echo hi")).rejects.toThrow(
      "The incident agent user could not prepare its home",
    );
    expect(h.spawned).toHaveLength(1);
  });

  test("in the gateway, every command's scope is killed whole when it ends", async () => {
    const h = hooks({
      inControlPlane: true,
      scope: (argv, env) => ({
        command: ["systemd-run", "--user", "--scope", "--", ...argv],
        env,
        unit: "opensession-agent-cmd-1",
      }),
    });
    const tool = makePiBashTool({
      cwd: "/tmp",
      env: home,
      gated: false,
      unattended: true,
      runAs: "opensession-incident",
      __testHooks: h.hooks,
    });
    await run(tool, "sleep 600 &");
    expect(h.spawned.at(-1)!.argv.slice(0, 4)).toEqual([
      "systemd-run",
      "--user",
      "--scope",
      "--",
    ]);
    expect(h.killed).toEqual(["opensession-agent-cmd-1"]);
  });

  test("in the gateway without a scope, commands as the user are refused", async () => {
    const h = hooks({ inControlPlane: true });
    const tool = makePiBashTool({
      cwd: "/tmp",
      env: home,
      gated: false,
      unattended: true,
      runAs: "opensession-incident",
      __testHooks: h.hooks,
    });
    await expect(run(tool, "ls")).rejects.toThrow(
      "Commands as the incident agent user need a systemd scope",
    );
    expect(h.spawned).toHaveLength(0);
  });

  test("without runAs the command runs as before", async () => {
    const h = hooks();
    const tool = makePiBashTool({
      cwd: "/tmp",
      env: {},
      gated: false,
      unattended: true,
      __testHooks: h.hooks,
    });
    await run(tool, "ls");
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]!.argv.slice(-3)).toEqual(["/bin/bash", "-c", "ls"]);
    expect(h.spawned[0]!.argv).not.toContain("sudo");
    expect(h.killed).toEqual([]);
  });

  test("the home is under /tmp, one per session, with TMPDIR inside it", () => {
    expect(incidentUserHomeEnv("os/../1")).toEqual({
      HOME: "/tmp/opensession-incident-os____1",
      XDG_CONFIG_HOME: "/tmp/opensession-incident-os____1/.config",
      AWS_CONFIG_FILE: "/tmp/opensession-incident-os____1/.aws/config",
      AWS_SHARED_CREDENTIALS_FILE:
        "/tmp/opensession-incident-os____1/.aws/credentials",
      GH_CONFIG_DIR: "/tmp/opensession-incident-os____1/.config/gh",
      TMPDIR: "/tmp/opensession-incident-os____1/tmp",
      OPENSESSION_SCRATCH: "/tmp/opensession-incident-os____1/tmp",
    });
  });
});

describe("read-only ask mode", () => {
  const cwd = "/srv/acme/worktrees/acme-review";
  const scratch = "/srv/acme/scratch/s1";
  const askTool = (h: ReturnType<typeof hooks>) =>
    makePiBashTool({
      cwd,
      env: { PATH: "/usr/bin:/bin", OPENSESSION_SCRATCH: scratch },
      gated: false,
      askReadOnly: true,
      unattended: true,
      __testHooks: h.hooks,
    });

  test("cd into the session's own worktree or scratch runs", async () => {
    const h = hooks();
    const tool = askTool(h);
    await run(tool, `cd ${cwd} && git diff origin/main...HEAD | head`);
    await run(tool, `cd ${scratch} && ls`);
    expect(h.spawned).toHaveLength(2);
  });

  test("cd elsewhere and writes are refused before anything runs", async () => {
    const h = hooks();
    const tool = askTool(h);
    await expect(run(tool, "cd /etc && ls")).rejects.toThrow(
      `Commands already run in ${cwd}`,
    );
    await expect(run(tool, `cd ${cwd} && rm -f a.txt`)).rejects.toThrow(
      "read-only allowlist",
    );
    expect(h.spawned).toHaveLength(0);
  });
});
