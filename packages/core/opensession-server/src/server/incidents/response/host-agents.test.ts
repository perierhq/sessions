import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  __resetHostAgentCacheForTest,
  type HostAgentProbe,
  hostAgentUserProblem,
  hostBashArgv,
  incidentAgentUser,
  assertHostAgentReady,
  incidentHostAgentsEnabled,
  incidentWorkspaceFor,
} from "./host-agents";

const CGROUP = "0::/opensession-control.slice/opensession.service\n";

/** A host where every command exits 0 unless a key of `codes` is in its
 *  argv; `id -u` prints a system uid and the cgroup probe prints CGROUP. */
const probe = (
  codes: Record<string, number>,
  platform: NodeJS.Platform = "linux",
  over: Partial<HostAgentProbe> = {},
): Partial<HostAgentProbe> => ({
  platform,
  uid: 1000,
  stateDir: async () => "/home/svc/.opensession",
  worktreesDir: () => "/srv/opensession-worktrees",
  cgroup: async () => CGROUP,
  scopes: async () => true,
  run: async (argv) => {
    const key = argv.join(" ");
    const hit = Object.entries(codes).find(([k]) => key.includes(k));
    return {
      code: hit ? hit[1] : 0,
      stdout: key.startsWith("id -u")
        ? "998\n"
        : key.includes("/proc/self/cgroup")
          ? CGROUP
          : "",
      stderr: "",
    };
  },
  ...over,
});

const savedUser = process.env.OPENSESSION_INCIDENT_AGENT_USER;
beforeEach(() => {
  __resetHostAgentCacheForTest();
  delete process.env.OPENSESSION_INCIDENT_AGENT_USER;
});
afterEach(() => {
  if (savedUser === undefined)
    delete process.env.OPENSESSION_INCIDENT_AGENT_USER;
  else process.env.OPENSESSION_INCIDENT_AGENT_USER = savedUser;
});

test("a sandbox always wins", async () => {
  expect(
    await incidentWorkspaceFor("acme", "pi/anthropic/claude-opus-5-5", {
      sandbox: () => ({ ok: true, provider: "daytona" }),
      hostProblem: async () => null,
    }),
  ).toEqual({ kind: "sandbox", provider: "daytona" });
});

test("without a sandbox the host path is off unless the operator turns it on", async () => {
  const savedFlag = process.env.OPENSESSION_INCIDENT_HOST_AGENTS;
  try {
    delete process.env.OPENSESSION_INCIDENT_HOST_AGENTS;
    expect(incidentHostAgentsEnabled()).toBe(false);
    let probed = false;
    expect(
      await incidentWorkspaceFor("acme", "m", {
        sandbox: () => ({ ok: true, provider: null }),
        hostProblem: async () => {
          probed = true;
          return null;
        },
      }),
    ).toEqual({
      error: "Agents can't start: this project has no sandbox",
    });
    expect(probed).toBe(false);
    // A host agent is refused at its turns too.
    await expect(
      assertHostAgentReady("opensession-incident", "Isolation"),
    ).rejects.toThrow("Isolation");
    process.env.OPENSESSION_INCIDENT_HOST_AGENTS = "1";
    expect(incidentHostAgentsEnabled()).toBe(true);
    expect(
      await incidentWorkspaceFor("acme", "m", {
        sandbox: () => ({ ok: true, provider: null }),
        hostProblem: async () => null,
      }),
    ).toEqual({ kind: "host", user: "opensession-incident" });
  } finally {
    if (savedFlag === undefined)
      delete process.env.OPENSESSION_INCIDENT_HOST_AGENTS;
    else process.env.OPENSESSION_INCIDENT_HOST_AGENTS = savedFlag;
  }
});

test("without a sandbox, host agents on: the host user, or a clear setup error", async () => {
  expect(
    await incidentWorkspaceFor("acme", "m", {
      sandbox: () => ({ ok: true, provider: null }),
      hostProblem: async () => null,
      hostEnabled: () => true,
    }),
  ).toEqual({ kind: "host", user: "opensession-incident" });
  expect(
    await incidentWorkspaceFor("acme", "m", {
      sandbox: () => ({ ok: true, provider: null }),
      hostProblem: async () => "create the system user opensession-incident",
      hostEnabled: () => true,
    }),
  ).toEqual({
    error:
      "Incident agents need a sandbox or the incident agent user. Set a default sandbox for acme, or create the system user opensession-incident (see docs/incident-host-agents.md), then retry.",
  });
  expect(
    await incidentWorkspaceFor("acme", "m", {
      sandbox: () => ({ ok: false, error: "Daytona is not qualified" }),
      hostProblem: async () => null,
    }),
  ).toEqual({ error: "Daytona is not qualified" });
});

test("without a default sandbox, a Ready container sandbox comes before the host", async () => {
  let probed = false;
  expect(
    await incidentWorkspaceFor("acme", "m", {
      sandbox: () => ({ ok: true, provider: null }),
      podmanReady: () => true,
      hostEnabled: () => true,
      hostProblem: async () => {
        probed = true;
        return null;
      },
    }),
  ).toEqual({ kind: "sandbox", provider: "podman" });
  expect(probed).toBe(false);
  // A configured default sandbox still wins.
  expect(
    await incidentWorkspaceFor("acme", "m", {
      sandbox: () => ({ ok: true, provider: "daytona" }),
      podmanReady: () => true,
      hostEnabled: () => true,
      hostProblem: async () => null,
    }),
  ).toEqual({ kind: "sandbox", provider: "daytona" });
  // So does a default that can't be used: its error is not papered over.
  expect(
    await incidentWorkspaceFor("acme", "m", {
      sandbox: () => ({ ok: false, error: "Daytona is not qualified" }),
      podmanReady: () => true,
    }),
  ).toEqual({ error: "Daytona is not qualified" });
});

test("the container sandbox is checked for the project and model", async () => {
  const seen: unknown[] = [];
  await incidentWorkspaceFor("acme", "pi/openai/gpt-6.1-sol", {
    sandbox: () => ({ ok: true, provider: null }),
    podmanReady: (...args) => {
      seen.push(args);
      return false;
    },
    hostEnabled: () => false,
  });
  expect(seen).toEqual([["acme", "pi/openai/gpt-6.1-sol"]]);
});

test("without the container sandbox the host path is unchanged", async () => {
  expect(
    await incidentWorkspaceFor("acme", "m", {
      sandbox: () => ({ ok: true, provider: null }),
      podmanReady: () => false,
      hostEnabled: () => false,
    }),
  ).toEqual({ error: "Agents can't start: this project has no sandbox" });
  expect(
    await incidentWorkspaceFor("acme", "m", {
      sandbox: () => ({ ok: true, provider: null }),
      podmanReady: () => false,
      hostEnabled: () => true,
      hostProblem: async () => null,
    }),
  ).toEqual({ kind: "host", user: "opensession-incident" });
});

test("the sandbox is resolved for the project and model", async () => {
  const seen: unknown[] = [];
  await incidentWorkspaceFor("acme", "pi/openai/gpt-6.1-sol", {
    sandbox: (...args) => {
      seen.push(args);
      return { ok: true, provider: "box" };
    },
    hostProblem: async () => null,
    automationUser: "Incidents · acme",
  });
  expect(seen).toEqual([
    [undefined, "Incidents · acme", "acme", "pi/openai/gpt-6.1-sol"],
  ]);
});

test("the probe refuses a user that can read the state directory", async () => {
  expect(await hostAgentUserProblem(probe({}, "darwin"))).toBe(
    "run Sessions on Linux to use the incident agent user",
  );
  expect(await hostAgentUserProblem(probe({ "id -u": 1 }))).toBe(
    "create the system user opensession-incident",
  );
  expect(await hostAgentUserProblem(probe({ "-c true": 1 }))).toBe(
    "allow this server to run commands as opensession-incident without a password",
  );
  expect(await hostAgentUserProblem(probe({ "test ! -r": 1 }))).toBe(
    "make the Sessions state directory unreadable to opensession-incident",
  );
  expect(await hostAgentUserProblem(probe({ "test -w": 1 }))).toBe(
    "let opensession-incident write the worktrees directory",
  );
  expect(await hostAgentUserProblem(probe({}))).toBeNull();
});

test("root, the gateway's own user and a uid that is not a number are refused", async () => {
  const uid = (stdout: string, gateway = 1000) =>
    probe({}, "linux", {
      uid: gateway,
      run: async (argv) => ({
        code: 0,
        stdout: argv[0] === "id" ? stdout : CGROUP,
        stderr: "",
      }),
    });
  expect(await hostAgentUserProblem(uid("0\n"))).toBe(
    "create the system user opensession-incident",
  );
  expect(await hostAgentUserProblem(uid("1000\n"))).toBe(
    "create the system user opensession-incident",
  );
  expect(await hostAgentUserProblem(uid("nobody\n"))).toBe(
    "create the system user opensession-incident",
  );
});

test("commands as the user must stay in a scope Sessions can kill", async () => {
  expect(
    await hostAgentUserProblem(
      probe({}, "linux", { scopes: async () => false }),
    ),
  ).toBe(
    "run Sessions as its systemd service on Linux 5.14 or newer, so each agent command runs in a scope Sessions can stop",
  );
  // sudo opened a login session (pam_systemd) and moved the command out.
  expect(
    await hostAgentUserProblem(
      probe({}, "linux", {
        cgroup: async () => "0::/user.slice/user-1000.slice/session-4.scope\n",
      }),
    ),
  ).toBe(
    "stop sudo from opening a login session for opensession-incident (Defaults>opensession-incident !pam_session)",
  );
});

test("the probe runs every check as the configured user with sudo -n", async () => {
  process.env.OPENSESSION_INCIDENT_AGENT_USER = "acme-incident";
  const argvs: string[][] = [];
  const p = probe({});
  await hostAgentUserProblem({
    ...p,
    run: async (argv) => {
      argvs.push(argv);
      return p.run!(argv);
    },
  });
  expect(argvs[0]).toEqual(["id", "-u", "acme-incident"]);
  for (const argv of argvs.slice(1)) {
    expect(argv.slice(0, 5)).toEqual([
      "sudo",
      "-n",
      "-E",
      "-u",
      "acme-incident",
    ]);
    expect(argv[5]).toBe("--");
    expect(argv[6]).toBe("/bin/bash");
  }
  expect(argvs.some((a) => a.includes("/home/svc/.opensession"))).toBe(true);
  expect(argvs.some((a) => a.includes("/srv/opensession-worktrees"))).toBe(
    true,
  );
});

test("the default probe result is cached, failures included", async () => {
  let runs = 0;
  const p = probe({ "id -u": 1 });
  const counted: Partial<HostAgentProbe> = {
    ...p,
    run: async (argv) => {
      runs++;
      return p.run!(argv);
    },
  };
  const { __setHostAgentProbeForTest } = await import("./host-agents");
  __setHostAgentProbeForTest(counted);
  try {
    expect(await hostAgentUserProblem()).toBe(
      "create the system user opensession-incident",
    );
    expect(await hostAgentUserProblem()).toBe(
      "create the system user opensession-incident",
    );
    expect(runs).toBe(1);
  } finally {
    __setHostAgentProbeForTest(undefined);
  }
});

test("the user name falls back to the default when it is not a plain name", () => {
  expect(incidentAgentUser()).toBe("opensession-incident");
  process.env.OPENSESSION_INCIDENT_AGENT_USER = "acme_incident";
  expect(incidentAgentUser()).toBe("acme_incident");
  for (const bad of ["root;id", "-u", "Acme", "a".repeat(33), ""]) {
    process.env.OPENSESSION_INCIDENT_AGENT_USER = bad;
    expect(incidentAgentUser()).toBe("opensession-incident");
  }
});

test("the wrapper keeps the command one argument", () => {
  expect(hostBashArgv("opensession-incident", "echo $HOME; ls")).toEqual([
    "sudo",
    "-n",
    "-E",
    "-u",
    "opensession-incident",
    "--",
    "/bin/bash",
    "-c",
    "echo $HOME; ls",
  ]);
});
