import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  __setOwnershipRuntimeForTest,
  CONTAINER_PS_FORMAT,
  containerShimDir,
  listLabelledResources,
  parseContainerCreatedAt,
  parseContainerJson,
  parseContainerRows,
  parseUnitLabels,
  parseUnitRows,
  parseUnitShow,
  resourceInstanceId,
  sessionOwnershipEnv,
  sessionUnitDescription,
  stopLabelledResource,
} from "./session-ownership";

const previousStateDir = process.env.OPENSESSION_STATE_DIR;
let state = "";
let bin = "";

beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "os-ownership-state-"));
  bin = mkdtempSync(join(tmpdir(), "os-ownership-bin-"));
  process.env.OPENSESSION_STATE_DIR = state;
});

afterEach(() => {
  __setOwnershipRuntimeForTest(null);
  rmSync(state, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

afterAll(() => {
  if (previousStateDir == null) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previousStateDir;
});

/** A stand-in container CLI that prints the arguments it was given. */
function fakeCli(name: string): void {
  const file = join(bin, name);
  writeFileSync(file, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
  chmodSync(file, 0o755);
}

const ID_A = "a".repeat(64);
const ID_B = "b".repeat(64);

describe("labels", () => {
  test("unit descriptions carry the session and this instance", () => {
    const description = sessionUnitDescription("os-123", "agent command");
    expect(description).toBe(
      `opensession.session=os-123 opensession.instance=${resourceInstanceId()} agent command`,
    );
    expect(parseUnitLabels(description!)).toEqual({
      sessionId: "os-123",
      instance: resourceInstanceId(),
    });
    expect(parseUnitLabels("Open Session agent command")).toBeNull();
    // An id that cannot be a label never becomes one.
    expect(sessionUnitDescription("bad id; rm -rf", "x")).toBeUndefined();
    expect(sessionUnitDescription(undefined, "x")).toBeUndefined();
  });

  test("the instance follows the state root", () => {
    const first = resourceInstanceId();
    process.env.OPENSESSION_STATE_DIR = join(state, "other");
    expect(resourceInstanceId()).not.toBe(first);
    process.env.OPENSESSION_STATE_DIR = state;
    expect(resourceInstanceId()).toBe(first);
  });
});

describe("parsing", () => {
  test("container CreatedAt from docker and podman", () => {
    expect(parseContainerCreatedAt("2026-05-01 12:00:00 +0200 CEST")).toBe(
      Date.parse("2026-05-01T10:00:00Z"),
    );
    expect(
      parseContainerCreatedAt("2026-05-01 12:00:00.123456789 -0000 UTC"),
    ).toBe(Date.parse("2026-05-01T12:00:00Z"));
    expect(parseContainerCreatedAt("3 days ago")).toBeUndefined();
  });

  test("container rows keep only usable session labels", () => {
    const out = [
      `${ID_A}\tos-1\tabc123\t2026-05-01 12:00:00 +0000 UTC\tpg\tpostgres:16`,
      `${ID_B}\t\t\t2026-05-01 12:00:00 +0000 UTC\tmine\tredis`,
      `not-an-id\tos-2\t\t\tx\ty`,
      `${"c".repeat(12)}\tbad id\t\t\tx\ty`,
      "",
    ].join("\n");
    expect(parseContainerRows(out, "podman")).toEqual([
      {
        kind: "container",
        handle: ID_A,
        runtime: "podman",
        sessionId: "os-1",
        instance: "abc123",
        startedAtMs: Date.parse("2026-05-01T12:00:00Z"),
        label: "pg · postgres:16",
      },
    ]);
  });

  test("the JSON form from podman and docker", () => {
    const podman = JSON.stringify([
      {
        Id: ID_A,
        Labels: {
          "opensession.session": "os-1",
          "opensession.instance": "abc",
        },
        Created: 1_780_000_000,
        Names: ["pg"],
        Image: "postgres:16",
      },
      { Id: ID_B, Labels: { other: "x" }, Created: 1, Names: ["mine"] },
    ]);
    expect(parseContainerJson(podman, "podman")).toEqual([
      {
        kind: "container",
        handle: ID_A,
        runtime: "podman",
        sessionId: "os-1",
        instance: "abc",
        startedAtMs: 1_780_000_000_000,
        label: "pg · postgres:16",
      },
    ]);
    const docker = [
      JSON.stringify({
        ID: ID_B,
        Labels: "a=b,opensession.session=os-2",
        CreatedAt: "2026-05-01 12:00:00 +0000 UTC",
        Names: "redis",
        Image: "redis",
      }),
      "not json",
    ].join("\n");
    expect(parseContainerJson(docker, "docker")).toEqual([
      {
        kind: "container",
        handle: ID_B,
        runtime: "docker",
        sessionId: "os-2",
        startedAtMs: Date.parse("2026-05-01T12:00:00Z"),
        label: "redis · redis",
      },
    ]);
  });

  test("unit rows keep active labelled scopes and services", () => {
    const out = [
      "opensession-agent-cmd-1.scope loaded active running opensession.session=os-1 opensession.instance=abc agent command",
      "run-u7.service loaded active running opensession.session=os-2 dev server",
      "opensession-agent-cmd-2.scope loaded active running Open Session agent command",
      "foo.timer loaded active waiting opensession.session=os-3",
    ].join("\n");
    expect(parseUnitRows(out)).toEqual([
      {
        kind: "unit",
        handle: "opensession-agent-cmd-1.scope",
        sessionId: "os-1",
        instance: "abc",
        label:
          "opensession.session=os-1 opensession.instance=abc agent command",
      },
      {
        kind: "unit",
        handle: "run-u7.service",
        sessionId: "os-2",
        label: "opensession.session=os-2 dev server",
      },
    ]);
  });

  test("unit show blocks give start time and memory", () => {
    const now = 1_000_000_000;
    const shown = parseUnitShow(
      [
        "Id=a.scope",
        "ActiveEnterTimestampMonotonic=5000000",
        "MemoryCurrent=1048576",
        "",
        "MemoryCurrent=18446744073709551615",
        "Id=b.scope",
        "ActiveEnterTimestampMonotonic=0",
      ].join("\n"),
      65_000,
      now,
    );
    // Up 65 s, active since 5 s after boot: started 60 s ago.
    expect(shown.get("a.scope")).toEqual({
      startedAtMs: now - 60_000,
      memoryBytes: 1_048_576,
    });
    expect(shown.get("b.scope")).toEqual({});
  });
});

describe("listing and stopping", () => {
  test("lists labelled containers from each CLI once, and units with details", async () => {
    const calls: string[][] = [];
    __setOwnershipRuntimeForTest({
      containerClis: () => ["podman", "docker"],
      systemdUser: () => true,
      uptimeMs: async () => 100_000,
      run: async (argv) => {
        calls.push(argv);
        if (argv[0] === "podman")
          return {
            exitCode: 0,
            stdout: `${ID_A}\tos-1\t\t2026-05-01 12:00:00 +0000 UTC\tpg\tpostgres\n`,
          };
        // podman-docker: the same container under the docker name.
        if (argv[0] === "docker")
          return {
            exitCode: 0,
            stdout: `${ID_A}\tos-1\t\t2026-05-01 12:00:00 +0000 UTC\tpg\tpostgres\n`,
          };
        if (argv[2] === "list-units")
          return {
            exitCode: 0,
            stdout:
              "x.scope loaded active running opensession.session=os-2 agent command\n",
          };
        return {
          exitCode: 0,
          stdout:
            "Id=x.scope\nActiveEnterTimestampMonotonic=40000000\nMemoryCurrent=2048\n",
        };
      },
    });
    const rows = await listLabelledResources();
    expect(rows.map((row) => [row.kind, row.handle, row.sessionId])).toEqual([
      ["container", ID_A, "os-1"],
      ["unit", "x.scope", "os-2"],
    ]);
    expect(rows[1]!.memoryBytes).toBe(2048);
    expect(calls[0]).toEqual([
      "podman",
      "ps",
      "--no-trunc",
      "--filter",
      "label=opensession.session",
      "--format",
      CONTAINER_PS_FORMAT,
    ]);
    expect(calls).toContainEqual([
      "systemctl",
      "--user",
      "show",
      "--property=Id,ActiveEnterTimestampMonotonic,MemoryCurrent",
      "x.scope",
    ]);
  });

  test("falls back to the JSON form when the template fails", async () => {
    const calls: string[][] = [];
    __setOwnershipRuntimeForTest({
      containerClis: () => ["podman"],
      systemdUser: () => false,
      run: async (argv) => {
        calls.push(argv);
        return argv.at(-1) === "json"
          ? {
              exitCode: 0,
              stdout: JSON.stringify([
                { Id: ID_A, Labels: { "opensession.session": "os-1" } },
              ]),
            }
          : { exitCode: 125, stdout: "" };
      },
    });
    expect((await listLabelledResources()).map((row) => row.handle)).toEqual([
      ID_A,
    ]);
    expect(calls.map((argv) => argv.at(-1))).toEqual([
      CONTAINER_PS_FORMAT,
      "json",
    ]);
  });

  test("a CLI that fails and a host without a user manager list nothing", async () => {
    const calls: string[][] = [];
    __setOwnershipRuntimeForTest({
      containerClis: () => ["docker"],
      systemdUser: () => false,
      run: async (argv) => {
        calls.push(argv);
        return { exitCode: 1, stdout: "" };
      },
    });
    expect(await listLabelledResources()).toEqual([]);
    expect(calls.map((argv) => argv[0])).toEqual(["docker", "docker"]);
  });

  test("a host without podman, docker or systemd runs nothing", async () => {
    const calls: string[][] = [];
    __setOwnershipRuntimeForTest({
      containerClis: () => [],
      systemdUser: () => false,
      run: async (argv) => {
        calls.push(argv);
        return { exitCode: 0, stdout: "" };
      },
    });
    expect(await listLabelledResources()).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("stops a container through its own CLI and a unit through systemctl", async () => {
    const calls: string[][] = [];
    __setOwnershipRuntimeForTest({
      run: async (argv) => {
        calls.push(argv);
        return { exitCode: argv[0] === "docker" ? 0 : 5, stdout: "" };
      },
    });
    expect(
      await stopLabelledResource({
        kind: "container",
        handle: ID_A,
        runtime: "docker",
        sessionId: "os-1",
        label: "pg",
      }),
    ).toBe(true);
    expect(
      await stopLabelledResource({
        kind: "unit",
        handle: "x.scope",
        sessionId: "os-1",
        label: "x",
      }),
    ).toBe(false);
    expect(calls).toEqual([
      ["docker", "stop", "--time", "10", ID_A],
      ["systemctl", "--user", "stop", "x.scope"],
    ]);
  });
});

describe("session environment and container shims", () => {
  test("no session, or an id that cannot be a label, adds nothing", () => {
    fakeCli("podman");
    expect(sessionOwnershipEnv(undefined, bin)).toEqual({});
    expect(sessionOwnershipEnv("a b", bin)).toEqual({});
    expect(existsSync(containerShimDir())).toBe(false);
  });

  test("without podman or docker on PATH, only the variables are set", () => {
    const env = sessionOwnershipEnv("os-1", bin);
    expect(env.OPENSESSION_SESSION_ID).toBe("os-1");
    expect(env.OPENSESSION_UNIT_LABEL).toBe(
      `opensession.session=os-1 opensession.instance=${resourceInstanceId()}`,
    );
    expect(env.PATH).toBeUndefined();
  });

  test("a remote command gets the id but not this host's shims", () => {
    fakeCli("podman");
    const env = sessionOwnershipEnv("os-1", bin, { shims: false });
    expect(env.OPENSESSION_SESSION_ID).toBe("os-1");
    expect(env.PATH).toBeUndefined();
  });

  test("puts shims for the installed CLIs first on PATH, once", () => {
    fakeCli("podman");
    const shims = containerShimDir();
    const env = sessionOwnershipEnv("os-1", `${shims}:${bin}`);
    expect(env.PATH).toBe(`${shims}:${bin}`);
    expect(statSync(join(shims, "podman")).mode & 0o111).toBeTruthy();
    expect(existsSync(join(shims, "docker"))).toBe(false);
  });

  async function runShim(
    args: string[],
    env: Record<string, string>,
  ): Promise<string> {
    const proc = Bun.spawn([join(containerShimDir(), "podman"), ...args], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    return out.trim();
  }

  test("the shim labels run and create, and passes everything else through", async () => {
    fakeCli("podman");
    const env = sessionOwnershipEnv("os-1", `${bin}:/usr/bin:/bin`);
    const label = [
      "--label",
      "opensession.session=os-1",
      "--label",
      `opensession.instance=${resourceInstanceId()}`,
    ];
    expect((await runShim(["run", "-d", "postgres"], env)).split("\n")).toEqual(
      ["run", ...label, "-d", "postgres"],
    );
    expect((await runShim(["create", "redis"], env)).split("\n")).toEqual([
      "create",
      ...label,
      "redis",
    ]);
    expect(
      (await runShim(["container", "run", "--rm", "x"], env)).split("\n"),
    ).toEqual(["container", "run", ...label, "--rm", "x"]);
    expect((await runShim(["ps", "-a"], env)).split("\n")).toEqual([
      "ps",
      "-a",
    ]);
    expect((await runShim(["container", "ls"], env)).split("\n")).toEqual([
      "container",
      "ls",
    ]);
    // A shell outside a session reaches the real CLI unchanged.
    const { OPENSESSION_SESSION_ID: _id, ...outside } = env;
    expect((await runShim(["run", "x"], outside)).split("\n")).toEqual([
      "run",
      "x",
    ]);
  });

  test("the shim never runs itself, even through a second PATH spelling", async () => {
    fakeCli("podman");
    const shims = containerShimDir();
    sessionOwnershipEnv("os-1", bin);
    mkdirSync(join(state, "link-parent"), { recursive: true });
    const proc = Bun.spawn([
      "ln",
      "-s",
      shims,
      join(state, "link-parent", "shims"),
    ]);
    await proc.exited;
    const out = await runShim(["version"], {
      PATH: `${shims}/:${join(state, "link-parent", "shims")}:${bin}:/usr/bin:/bin`,
      OPENSESSION_SESSION_ID: "os-1",
    });
    expect(out).toBe("version");
  });

  test("the shim reports a missing CLI instead of looping", async () => {
    fakeCli("podman");
    sessionOwnershipEnv("os-1", bin);
    const proc = Bun.spawn([join(containerShimDir(), "podman"), "ps"], {
      env: { PATH: `${containerShimDir()}:/nonexistent` },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(127);
    expect(await new Response(proc.stderr).text()).toContain(
      "podman: command not found",
    );
    expect(readFileSync(join(containerShimDir(), "podman"), "utf8")).toContain(
      "Generated by Open Session",
    );
  });
});
