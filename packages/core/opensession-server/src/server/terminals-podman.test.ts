// This machine (container) keeps work off the host, so its Terminal fails
// closed: when the sandbox cannot be reached it says why and exits, and it
// never opens a host shell in its place (every other provider still does).
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let enabled = true;
let configured = true;
let terminalError: Error | undefined;
const touches: string[] = [];
const podmanArgv = [
  "/usr/bin/env",
  "-i",
  "PATH=/usr/bin:/bin",
  "TERM=xterm-256color",
  "podman",
  "exec",
  "-it",
  "--user",
  "1000:1000",
  "opensession-sbx-acme-workload",
  "/bin/bash",
  "-l",
];

const realConfig = await import("./sandbox/config");
mock.module("./sandbox/config", () => ({
  ...realConfig,
  sandboxesEnabled: () => enabled,
  sandboxProviderConfigured: () => configured,
}));
mock.module("./sandbox/adapters/podman", () => ({
  podmanTerminalTarget: async (sandboxId: string) => {
    if (terminalError) throw terminalError;
    return {
      cwd: "/home/sandbox/workspace",
      touch: () => touches.push(sandboxId),
      argv: podmanArgv,
    };
  },
}));
mock.module("./workload-scope", () => ({
  workloadArgv: (argv: string[]) => argv,
}));

// A host shell would otherwise start a shared ssh-agent through Bun.spawn.
process.env.SSH_AUTH_SOCK = "/tmp/terminals-podman-test.sock";

const { startSessionTerminal, stopAllTerminals } = await import("./terminals");

interface Spawned {
  argv: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
}
const spawned: Spawned[] = [];
const realSpawn = Bun.spawn;

beforeEach(() => {
  enabled = true;
  configured = true;
  terminalError = undefined;
  touches.length = 0;
  spawned.length = 0;
  // Record what would run instead of starting a PTY.
  Object.assign(Bun, {
    spawn: (argv: string[], options: Omit<Spawned, "argv">) => {
      spawned.push({ argv, cwd: options.cwd, env: options.env });
      return {
        exited: new Promise<number>(() => {}),
        kill: () => {},
        terminal: { write: () => {}, resize: () => {} },
      };
    },
  });
});
afterEach(() => {
  Object.assign(Bun, { spawn: realSpawn });
});

const podmanSession = {
  id: "os-acme",
  worktreeDir: "/tmp",
  sandbox: { provider: "podman", sandboxId: "opensession-sbx-acme" },
};

async function open(session: object) {
  const ws = {};
  const sent: Array<{ type: string; message?: string; target?: string }> = [];
  await startSessionTerminal(ws, "t1", session, {
    send: (msg) => sent.push(msg as (typeof sent)[number]),
  });
  stopAllTerminals(ws);
  return sent;
}

describe("podman Terminal", () => {
  test("opens podman exec with its own argv and no added env", async () => {
    const sent = await open(podmanSession);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.argv).toEqual(podmanArgv);
    // No host cwd and nothing added to the env, which `env -i` clears.
    expect(spawned[0]?.cwd).toBeUndefined();
    expect(spawned[0]?.env).toEqual({
      ...process.env,
      TERM: "xterm-256color",
    });
    expect(sent[0]).toMatchObject({ type: "term_ready", target: "podman" });
    expect(touches).toEqual([]);
  });

  test("a failed wake refuses instead of opening a host shell", async () => {
    terminalError = new Error("firewall rules did not verify");
    const sent = await open(podmanSession);
    expect(spawned).toEqual([]);
    expect(sent).toEqual([
      {
        type: "term_notice",
        message:
          "This machine (container) terminal unavailable (firewall rules did not verify). No host shell was opened.",
      },
      { type: "term_exit", code: 1 } as (typeof sent)[number],
    ]);
  });

  test("a disabled connection, the kill switch or a missing sandbox refuse too", async () => {
    configured = false;
    expect((await open(podmanSession))[0]?.message).toContain(
      "its connection is not Ready",
    );
    configured = true;
    enabled = false;
    expect((await open(podmanSession))[0]?.message).toContain(
      "sandboxes are turned off",
    );
    enabled = true;
    const notStarted = await open({
      ...podmanSession,
      sandbox: { provider: "podman" },
    });
    expect(notStarted[0]?.message).toContain("has not started yet");
    expect(notStarted.at(-1)).toEqual({ type: "term_exit", code: 1 } as never);
    expect(spawned).toEqual([]);
  });

  test("another provider's failure still falls back to a host shell", async () => {
    configured = false;
    const sent = await open({
      ...podmanSession,
      sandbox: { provider: "box", sandboxId: "box-1" },
    });
    expect(spawned).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "term_ready", target: "host" });
  });
});
