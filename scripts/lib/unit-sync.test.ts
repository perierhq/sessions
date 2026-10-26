/**
 * `opensession update` keeps installed systemd units in step with the release
 * it switches to. Before this, only `service install` rendered units, so a
 * template change (a new slice, a new directive) never reached an install
 * that only ever updated.
 */

import { describe, expect, test } from "bun:test";
import { platform } from "os";
import {
  carryInstalledValues,
  planUnitSync,
  syncUnits,
  unitDrift,
  type UnitTarget,
} from "./unit-sync";

const onServiceHost = platform() !== "win32";

const INSTALLED = `# old comment
[Unit]
Description=Open Session - agent session dashboard
After=network.target opensession-session-kernel.service

[Service]
Environment="PATH=/opt/acme/bin:/usr/bin:/bin"
User=acme
WorkingDirectory=/opt/acme/src
EnvironmentFile=/etc/acme/opensession.env
LoadCredential=executor-token:/etc/acme/executor-token
LoadCredential=session-kernel-token:/etc/acme/session-kernel-token
Environment="OPENSESSION_STATE_DIR=/srv/acme/state"
Environment="NODE_ENV=production"
ExecStart=/opt/acme/bin/opensession server
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
`;

const RENDERED = `# new comment
[Unit]
Description=Open Session - agent session dashboard
After=network.target opensession-session-kernel.service opensession-executor.service

[Service]
Slice=opensession-control.slice
Environment="PATH=/home/acme/.opensession/bin:/usr/bin:/bin"
User=someone-else
WorkingDirectory=/home/acme/.opensession/src
EnvironmentFile=/home/acme/.opensession.env
LoadCredential=executor-token:/etc/opensession/executor-token
LoadCredential=session-kernel-token:/etc/opensession/session-kernel-token
Environment="NODE_ENV=production"
ExecStart=/home/acme/.opensession/bin/opensession server
TimeoutStopSec=80

[Install]
WantedBy=multi-user.target
`;

describe("carryInstalledValues", () => {
  test("keeps the install's own values and takes everything else from the template", () => {
    const out = carryInstalledValues(RENDERED, INSTALLED);
    // The install's identity, paths, credentials and binary stay.
    expect(out).toContain("User=acme\n");
    expect(out).toContain("WorkingDirectory=/opt/acme/src\n");
    expect(out).toContain("EnvironmentFile=/etc/acme/opensession.env\n");
    expect(out).toContain(
      "LoadCredential=executor-token:/etc/acme/executor-token\n",
    );
    expect(out).toContain(
      "LoadCredential=session-kernel-token:/etc/acme/session-kernel-token\n",
    );
    expect(out).toContain('Environment="PATH=/opt/acme/bin:/usr/bin:/bin"\n');
    expect(out).toContain("ExecStart=/opt/acme/bin/opensession server\n");
    // A state location the install carries is kept even though this shell
    // did not render one.
    expect(out).toContain(
      'Environment="OPENSESSION_STATE_DIR=/srv/acme/state"',
    );
    // Everything the template owns comes from the template.
    expect(out).toContain("# new comment");
    expect(out).not.toContain("# old comment");
    expect(out).toContain("Slice=opensession-control.slice\n");
    expect(out).toContain("TimeoutStopSec=80\n");
    expect(out).toContain("opensession-executor.service\n");
    expect(out).not.toContain("someone-else");
  });

  test("does not graft the old binary onto a different kind of ExecStart", () => {
    const installed = INSTALLED.replace(
      "ExecStart=/opt/acme/bin/opensession server",
      "ExecStart=/usr/local/bin/bun run packages/acme/old-entry.ts",
    );
    const out = carryInstalledValues(RENDERED, installed);
    expect(out).toContain(
      "ExecStart=/home/acme/.opensession/bin/opensession server\n",
    );
  });

  test("a unit the template already matches is unchanged", () => {
    const synced = carryInstalledValues(RENDERED, INSTALLED);
    expect(carryInstalledValues(RENDERED, synced)).toBe(synced);
  });
});

function fakeFs(files: Record<string, string>) {
  return {
    files,
    read: (path: string) => files[path],
  };
}

const targets = (desired: Record<string, string>): UnitTarget[] =>
  Object.entries(desired).map(([path, text]) => ({
    name: path.split("/").pop()!,
    path,
    render: async () => text,
    carry: path.endsWith(".service"),
  }));

describe("planUnitSync", () => {
  test("reports which installed units differ from the release's templates", async () => {
    const fs = fakeFs({
      "/etc/systemd/system/opensession.service": INSTALLED,
      "/etc/systemd/system/opensession-workloads.slice":
        "[Slice]\nCPUWeight=100\n",
    });
    const plan = await planUnitSync({
      targets: targets({
        "/etc/systemd/system/opensession.service": RENDERED,
        "/etc/systemd/system/opensession-workloads.slice":
          "[Slice]\nCPUWeight=100\nMemoryMax=75%\n",
        "/etc/systemd/system/opensession-control.slice": "[Slice]\n",
      }),
      read: fs.read,
    });
    const byName = Object.fromEntries(plan.map((u) => [u.name, u]));
    expect(byName["opensession.service"].status).toBe("changed");
    expect(byName["opensession.service"].desired).toContain("User=acme");
    expect(byName["opensession-workloads.slice"].status).toBe("changed");
    expect(byName["opensession-workloads.slice"].added).toEqual([
      "MemoryMax=75%",
    ]);
    // A unit this install never had is not created behind its back.
    expect(byName["opensession-control.slice"].status).toBe("missing");
  });

  test("an install already in step plans nothing", async () => {
    const synced = carryInstalledValues(RENDERED, INSTALLED);
    const plan = await planUnitSync({
      targets: targets({ "/etc/systemd/system/opensession.service": RENDERED }),
      read: fakeFs({ "/etc/systemd/system/opensession.service": synced }).read,
    });
    expect(plan.map((u) => u.status)).toEqual(["unchanged"]);
  });
});

describe("unitDrift (doctor)", () => {
  test("names each out-of-date unit with what differs", async () => {
    const plan = await planUnitSync({
      targets: targets({
        "/etc/systemd/system/opensession.service": RENDERED,
        "/etc/systemd/system/opensession-workloads.slice": "[Slice]\nB=2\n",
      }),
      read: fakeFs({
        "/etc/systemd/system/opensession.service": INSTALLED,
        "/etc/systemd/system/opensession-workloads.slice": "[Slice]\nB=2\n",
      }).read,
    });
    const drift = unitDrift(plan)!;
    expect(drift.summary).toBe("1 systemd unit(s) differ from this release");
    expect(drift.fix).toContain("opensession service sync");
    expect(drift.details[0]).toBe("/etc/systemd/system/opensession.service");
    expect(drift.details).toContain("  + Slice=opensession-control.slice");
    expect(drift.details).toContain("  - TimeoutStopSec=60");
  });

  test("no drift, no finding", async () => {
    expect(unitDrift([])).toBeNull();
  });
});

describe("syncUnits", () => {
  type Call = string[];
  const runner =
    (calls: Call[], code = 0) =>
    async (cmd: string[]) => {
      calls.push(cmd);
      return code;
    };

  test("system scope installs changed units through sudo -n, then reloads once", async () => {
    const calls: Call[] = [];
    const written: Record<string, string> = {};
    const result = await syncUnits({
      scope: "system",
      targets: targets({
        "/etc/systemd/system/opensession.service": RENDERED,
        "/etc/systemd/system/opensession-workloads.slice": "[Slice]\nA=1\n",
      }),
      read: fakeFs({
        "/etc/systemd/system/opensession.service": INSTALLED,
        "/etc/systemd/system/opensession-workloads.slice": "[Slice]\nA=1\n",
      }).read,
      stage: async (content) => {
        const path = `/tmp/staged-${Object.keys(written).length}`;
        written[path] = content;
        return path;
      },
      runCommand: runner(calls),
    });
    expect(result.code).toBe(0);
    expect(result.changed).toEqual(["opensession.service"]);
    expect(calls).toEqual([
      [
        "sudo",
        "-n",
        "install",
        "-o",
        "root",
        "-g",
        "root",
        "-m",
        "0644",
        "/tmp/staged-0",
        "/etc/systemd/system/opensession.service",
      ],
      ["sudo", "-n", "systemctl", "daemon-reload"],
    ]);
    expect(written["/tmp/staged-0"]).toContain("User=acme");
  });

  test("user scope writes the unit itself and reloads the user manager", async () => {
    const calls: Call[] = [];
    const files: Record<string, string> = {
      "/home/acme/.config/systemd/user/opensession.service": INSTALLED,
    };
    const result = await syncUnits({
      scope: "user",
      targets: targets({
        "/home/acme/.config/systemd/user/opensession.service": RENDERED,
      }),
      read: (path) => files[path],
      write: async (path, content) => {
        files[path] = content;
      },
      runCommand: runner(calls),
    });
    expect(result.code).toBe(0);
    expect(
      files["/home/acme/.config/systemd/user/opensession.service"],
    ).toContain("Slice=opensession-control.slice");
    expect(calls).toEqual([["systemctl", "--user", "daemon-reload"]]);
  });

  test("check mode changes nothing", async () => {
    const calls: Call[] = [];
    const result = await syncUnits({
      scope: "system",
      check: true,
      targets: targets({ "/etc/systemd/system/opensession.service": RENDERED }),
      read: fakeFs({ "/etc/systemd/system/opensession.service": INSTALLED })
        .read,
      runCommand: runner(calls),
    });
    expect(result.changed).toEqual(["opensession.service"]);
    expect(calls).toEqual([]);
  });

  test("nothing to do runs nothing", async () => {
    const calls: Call[] = [];
    const synced = carryInstalledValues(RENDERED, INSTALLED);
    const result = await syncUnits({
      scope: "system",
      targets: targets({ "/etc/systemd/system/opensession.service": RENDERED }),
      read: fakeFs({ "/etc/systemd/system/opensession.service": synced }).read,
      runCommand: runner(calls),
    });
    expect(result).toMatchObject({ code: 0, changed: [] });
    expect(calls).toEqual([]);
  });

  test("a refused sudo fails the sync and says how to finish it", async () => {
    const calls: Call[] = [];
    const result = await syncUnits({
      scope: "system",
      targets: targets({ "/etc/systemd/system/opensession.service": RENDERED }),
      read: fakeFs({ "/etc/systemd/system/opensession.service": INSTALLED })
        .read,
      stage: async () => "/tmp/staged",
      runCommand: runner(calls, 1),
    });
    expect(result.code).not.toBe(0);
    expect(result.hint).toContain("opensession service sync");
    // No reload after a failed install.
    expect(calls.some((c) => c.includes("daemon-reload"))).toBe(false);
  });
});

describe.skipIf(!onServiceHost)("the release's own templates", () => {
  test("a stale system gateway unit is re-rendered with its install's values", async () => {
    const { defaultUnitTargets } = await import("./unit-sync");
    const gateway = defaultUnitTargets("system").find(
      (t) => t.name === "opensession.service",
    )!;
    const rendered = await gateway.render();
    // The install runs the same kind of program from its own location.
    const exec = rendered.match(/^ExecStart=(\S+)(.*)$/m)!;
    const program = exec[1].split("/").pop();
    const installed = INSTALLED.replace(
      "ExecStart=/opt/acme/bin/opensession server",
      `ExecStart=/opt/acme/bin/${program}${exec[2]}`,
    );
    const desired = carryInstalledValues(rendered, installed);
    expect(desired).toContain("User=acme\n");
    expect(desired).toContain("WorkingDirectory=/opt/acme/src\n");
    expect(desired).toContain(`ExecStart=/opt/acme/bin/${program}${exec[2]}\n`);
    expect(desired).toContain("KillMode=mixed");
    expect(desired).toContain("Slice=opensession-control.slice");
    const names = defaultUnitTargets("system").map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "opensession.service",
        "opensession-session-kernel.service",
        "opensession-executor.service",
        "opensession-control.slice",
        "opensession-workloads.slice",
      ]),
    );
    expect(defaultUnitTargets("user").map((t) => t.name)).not.toContain(
      "opensession-executor.service",
    );
  });
});
