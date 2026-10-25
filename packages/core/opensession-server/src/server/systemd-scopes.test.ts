import { describe, expect, test } from "bun:test";
import {
  ENGINE_SLICE,
  PREVIEW_SLICE,
  controlPlaneWorkloadCommand,
  engineScopeSystemdArgs,
  hostMemoryLimit,
  processRunsInControlPlane,
  previewScopeCommand,
  previewScopeSystemdArgs,
  previewScopeUnit,
  scopeVerbatimArgs,
} from "./systemd-scopes";

const GIB = 1024 ** 3;
const BIG_HOST = 64 * GIB;

describe("systemd scope resource controls", () => {
  test("detached engines get bounded memory, swap, tasks, and an aggregate slice", () => {
    expect(engineScopeSystemdArgs({}, BIG_HOST)).toEqual([
      `--slice=${ENGINE_SLICE}`,
      "--property=MemoryHigh=6G",
      "--property=MemoryMax=12G",
      "--property=MemorySwapMax=1G",
      "--property=TasksMax=1024",
      "--property=OOMPolicy=stop",
    ]);
  });

  test("previews get a separate budget and leave CPU headroom", () => {
    expect(previewScopeSystemdArgs({}, BIG_HOST)).toEqual([
      `--slice=${PREVIEW_SLICE}`,
      "--property=MemoryHigh=8G",
      "--property=MemoryMax=12G",
      "--property=MemorySwapMax=1G",
      "--property=TasksMax=768",
      "--property=CPUQuota=600%",
      "--property=OOMPolicy=stop",
    ]);
  });

  test("memory defaults stay below a small host's total memory", () => {
    // A 23 GB host keeps the fixed defaults.
    expect(previewScopeSystemdArgs({}, 23 * GIB)).toEqual(
      expect.arrayContaining([
        "--property=MemoryHigh=8G",
        "--property=MemoryMax=12G",
      ]),
    );
    // An 8 GB host caps MemoryHigh at half and MemoryMax at three quarters.
    expect(previewScopeSystemdArgs({}, 8 * GIB)).toEqual(
      expect.arrayContaining([
        "--property=MemoryHigh=4096M",
        "--property=MemoryMax=6144M",
      ]),
    );
    expect(engineScopeSystemdArgs({}, 8 * GIB)).toEqual(
      expect.arrayContaining([
        "--property=MemoryHigh=4096M",
        "--property=MemoryMax=6144M",
      ]),
    );
    // Overrides still win on small hosts.
    expect(
      previewScopeSystemdArgs(
        { OPENSESSION_PREVIEW_MEMORY_MAX: "7G" },
        8 * GIB,
      ),
    ).toContain("--property=MemoryMax=7G");
    // An unknown total keeps the fixed default.
    expect(hostMemoryLimit(12, 0.75, 0)).toBe("12G");
  });

  test("trusted env overrides tune limits while malformed values fall back", () => {
    expect(
      engineScopeSystemdArgs({
        OPENSESSION_ENGINE_MEMORY_HIGH: "4G",
        OPENSESSION_ENGINE_MEMORY_MAX: "nope",
        OPENSESSION_ENGINE_TASKS_MAX: "2048",
      }),
    ).toContain("--property=MemoryHigh=4G");
    expect(
      engineScopeSystemdArgs(
        { OPENSESSION_ENGINE_MEMORY_MAX: "nope" },
        BIG_HOST,
      ),
    ).toContain("--property=MemoryMax=12G");
    expect(
      engineScopeSystemdArgs({ OPENSESSION_ENGINE_TASKS_MAX: "2048" }),
    ).toContain("--property=TasksMax=2048");
  });

  test("gateway-owned shell commands escape into the low-priority agent slice", () => {
    expect(
      processRunsInControlPlane(
        "0::/opensession.slice/opensession-control.slice/opensession.service",
      ),
    ).toBe(true);
    const scoped = controlPlaneWorkloadCommand(
      ["setsid", "/bin/bash", "-c", "cargo test"],
      "opensession-agent-cmd-test",
      {
        env: { PATH: "/bin" },
        cgroup:
          "0::/opensession.slice/opensession-control.slice/opensession.service",
        scopesAvailable: true,
        systemdVersion: 259,
        totalMemoryBytes: BIG_HOST,
      },
    );
    expect(scoped.unit).toBe("opensession-agent-cmd-test");
    expect(scoped.command).toEqual([
      "systemd-run",
      "--user",
      "--scope",
      "--collect",
      "--quiet",
      "--unit=opensession-agent-cmd-test",
      "--slice=opensession-agents.slice",
      "--property=MemoryHigh=6G",
      "--property=MemoryMax=12G",
      "--property=MemorySwapMax=1G",
      "--property=TasksMax=1024",
      "--property=OOMPolicy=stop",
      "--property=TimeoutStopSec=2",
      "--expand-environment=no",
      "--",
      "setsid",
      "/bin/bash",
      "-c",
      "cargo test",
    ]);
  });

  test("a session-owned command scope carries its labels in the description", () => {
    const scoped = controlPlaneWorkloadCommand(
      ["/bin/bash", "-c", "bun run dev &"],
      "opensession-agent-cmd-test",
      {
        env: { PATH: "/bin" },
        cgroup:
          "0::/opensession.slice/opensession-control.slice/opensession.service",
        scopesAvailable: true,
        description:
          "opensession.session=os-1 opensession.instance=abc agent command",
      },
    );
    expect(scoped.command.slice(5, 7)).toEqual([
      "--unit=opensession-agent-cmd-test",
      "--description=opensession.session=os-1 opensession.instance=abc agent command",
    ]);
  });

  test("commands already owned by a run host stay in its system workload unit", () => {
    const command = ["/bin/bash", "-c", "cargo test"];
    expect(
      controlPlaneWorkloadCommand(command, "unused", {
        env: { PATH: "/bin" },
        cgroup:
          "0::/opensession.slice/opensession-workloads.slice/bks-run.service",
        scopesAvailable: true,
      }),
    ).toEqual({ command, env: { PATH: "/bin" } });
  });

  test("preview unit names are stable without exposing worktree paths", () => {
    const first = previewScopeUnit("/srv/worktrees/a");
    expect(first).toBe(previewScopeUnit("/srv/worktrees/a"));
    expect(first).not.toBe(previewScopeUnit("/srv/worktrees/b"));
    expect(first).toMatch(/^opensession-preview-[a-f0-9]{16}$/);
    expect(first).not.toContain("worktrees");
    expect(previewScopeUnit("/srv/worktrees/a", "web")).not.toBe(
      previewScopeUnit("/srv/worktrees/a", "api"),
    );
  });

  test("host Portals get a bounded user scope outside the gateway cgroup", () => {
    const direct = ["setsid", "bash", "-lc", "exec bun dev"];
    const scoped = previewScopeCommand(direct, "/srv/worktrees/a", "web", {
      env: { PATH: "/bin", HOME: "/tmp" },
      scopesAvailable: true,
      systemdVersion: 259,
      totalMemoryBytes: BIG_HOST,
    });
    expect(scoped.unit).toBe(previewScopeUnit("/srv/worktrees/a", "web"));
    expect(scoped.command).toEqual([
      "systemd-run",
      "--user",
      "--scope",
      "--collect",
      "--quiet",
      `--unit=${scoped.unit}`,
      "--slice=opensession-previews.slice",
      "--property=MemoryHigh=8G",
      "--property=MemoryMax=12G",
      "--property=MemorySwapMax=1G",
      "--property=TasksMax=768",
      "--property=CPUQuota=600%",
      "--property=OOMPolicy=stop",
      "--property=TimeoutStopSec=5",
      "--expand-environment=no",
      "--",
      ...direct,
    ]);
    expect(scoped.env).toMatchObject({
      PATH: "/bin",
      HOME: "/tmp",
      XDG_RUNTIME_DIR: expect.stringContaining("/run/user/"),
    });
  });

  test("scope commands reach their shell verbatim on every systemd", () => {
    // systemd 258 expands `$` in scope commands by default (`$$` -> `$`);
    // 254 added the switch that turns it off, and older systemd-run rejects
    // that switch but never expanded scope commands.
    expect(scopeVerbatimArgs(259)).toEqual(["--expand-environment=no"]);
    expect(scopeVerbatimArgs(254)).toEqual(["--expand-environment=no"]);
    expect(scopeVerbatimArgs(252)).toEqual([]);
    expect(scopeVerbatimArgs(null)).toEqual([]);
    const direct = ["setsid", "bash", "-lc", "exec bun dev"];
    expect(
      previewScopeCommand(direct, "/srv/worktrees/a", "web", {
        env: { PATH: "/bin" },
        scopesAvailable: true,
        systemdVersion: 249,
      }).command,
    ).not.toContain("--expand-environment=no");
  });
});
