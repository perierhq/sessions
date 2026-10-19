import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readPortalRegistry, type PortalRecord } from "./portal-supervisor";
import {
  hostSessionResources,
  sessionResourceList,
  stopSessionWorkloads,
} from "./session-resource-inventory";
import {
  __setOwnershipRuntimeForTest,
  resourceInstanceId,
} from "./session-ownership";
import {
  listSessionResources,
  runSessionResource,
  type RunSessionResourceResult,
} from "./session-resources";
import { __setWorkloadScopingForTest } from "./workload-scope";

const previousStateDir = process.env.OPENSESSION_STATE_DIR;
let state = "";
let worktree = "";
const ID_A = "a".repeat(64);
const ID_B = "b".repeat(64);

type Fake = {
  kind: "container" | "unit";
  handle: string;
  session: string;
  memory?: number;
};
let fakes: Fake[] = [];
let stops: string[][] = [];

function install(): void {
  __setOwnershipRuntimeForTest({
    containerClis: () => ["podman"],
    systemdUser: () => true,
    uptimeMs: async () => 86_400_000,
    run: async (argv) => {
      if (argv[0] === "podman" && argv[1] === "ps")
        return {
          exitCode: 0,
          stdout: fakes
            .filter((f) => f.kind === "container")
            .map(
              (f) =>
                `${f.handle}\t${f.session}\t\t2026-05-01 12:00:00 +0000 UTC\tpg\tpostgres:16`,
            )
            .join("\n"),
        };
      if (argv[0] === "podman" && argv[1] === "stats")
        return {
          exitCode: 0,
          // podman and docker print the short id here.
          stdout: fakes
            .filter((f) => f.kind === "container" && argv.includes(f.handle))
            .map((f) => `${f.handle.slice(0, 12)}\t${f.memory}MiB / 7.6GiB`)
            .join("\n"),
        };
      if (argv[2] === "list-units")
        return {
          exitCode: 0,
          stdout: fakes
            .filter((f) => f.kind === "unit")
            .map(
              (f) =>
                `${f.handle} loaded active running opensession.session=${f.session} opensession.instance=${resourceInstanceId()} agent command`,
            )
            .join("\n"),
        };
      if (argv[2] === "show")
        return {
          exitCode: 0,
          stdout: argv
            .slice(4)
            .map((unit) => {
              const fake = fakes.find((f) => f.handle === unit);
              const memory =
                fake?.memory ?? (unit.includes("portal") ? 3 : undefined);
              return [
                `Id=${unit}`,
                `MemoryCurrent=${memory === undefined ? "[not set]" : memory * 1024 * 1024}`,
              ].join("\n");
            })
            .join("\n\n"),
        };
      if (argv[1] === "stop" || argv[2] === "stop") {
        stops.push(argv);
        const handle = argv[argv.length - 1];
        fakes = fakes.filter((f) => f.handle !== handle);
        return { exitCode: 0, stdout: "" };
      }
      return { exitCode: 1, stdout: "" };
    },
  });
}

function portals(records: Partial<PortalRecord>[]): void {
  writeFileSync(
    join(worktree, ".ports.conf"),
    records
      .map(
        (record, index) =>
          `# opensession-portal ${JSON.stringify({
            name: `web${index}`,
            key: `WEB${index}_PORT`,
            command: "serve",
            port: 18_100 + index,
            state: "awake",
            ...record,
          })}`,
      )
      .join("\n"),
  );
}

const runs: Promise<RunSessionResourceResult>[] = [];

/** A setup still running for os-a. */
async function runningSetup(): Promise<void> {
  runs.push(
    runSessionResource({
      kind: "setup",
      argv: ["sh", "-c", "sleep 30 & wait"],
      cwd: worktree,
      sessionId: "os-a",
      sessionOwned: true,
      timeoutMs: 30_000,
      label: "bun install",
    }),
  );
  const deadline = Date.now() + 5_000;
  while (!listSessionResources().length && Date.now() < deadline)
    await Bun.sleep(20);
  expect(listSessionResources()).toHaveLength(1);
}

beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "os-inventory-state-"));
  worktree = realpathSync(mkdtempSync(join(tmpdir(), "os-inventory-wt-")));
  process.env.OPENSESSION_STATE_DIR = state;
  __setWorkloadScopingForTest(false);
  fakes = [];
  stops = [];
  install();
});

afterEach(async () => {
  for (const record of listSessionResources())
    try {
      process.kill(-record.pid!, "SIGKILL");
    } catch {}
  await Promise.allSettled(runs.splice(0));
  __setOwnershipRuntimeForTest(null);
  rmSync(state, { recursive: true, force: true });
  rmSync(worktree, { recursive: true, force: true });
});

afterAll(() => {
  __setWorkloadScopingForTest(null);
  if (previousStateDir == null) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previousStateDir;
});

describe("a session's resource list", () => {
  test("lists its Portals, setup, containers and units with memory", async () => {
    portals([
      { sessionId: "os-a", scopeUnit: "opensession-preview-portal1" },
      { sessionId: "os-a", state: "sleeping" },
      { sessionId: "os-b" },
      { sessionId: "os-a", state: "stopped" },
    ]);
    await runningSetup();
    fakes = [
      { kind: "container", handle: ID_A, session: "os-a", memory: 64 },
      { kind: "container", handle: ID_B, session: "os-b", memory: 32 },
      { kind: "unit", handle: "u1.scope", session: "os-a", memory: 10 },
    ];
    install();
    const session = { id: "os-a", worktreeDir: worktree };
    const list = await sessionResourceList(session, [session]);
    expect(
      list.items.map((item) => [item.kind, item.label, item.memoryBytes]),
    ).toEqual([
      ["portal", "web0", 3 * 1024 * 1024],
      ["setup", "bun install", undefined],
      ["container", "pg · postgres:16", 64 * 1024 * 1024],
      ["unit", "agent command · u1.scope", 10 * 1024 * 1024],
    ]);
    expect(list.memoryBytes).toBe(77 * 1024 * 1024);
  });

  test("a setup tagged with another session is not on the list", async () => {
    const session = { id: "os-c", worktreeDir: worktree };
    await runningSetup();
    // The setup is tagged os-a: not os-c's.
    expect((await sessionResourceList(session, [session])).items).toEqual([]);
  });

  test("Runner and Sandbox sessions list no host Portals", async () => {
    portals([{ sessionId: "os-a" }]);
    const session = {
      id: "os-a",
      worktreeDir: worktree,
      sandbox: { sandboxId: "sbx-1" } as never,
    };
    expect((await sessionResourceList(session, [session])).items).toEqual([]);
  });

  test("stop everything stops its Portals, setup and labelled resources only", async () => {
    portals([{ sessionId: "os-a" }, { sessionId: "os-b" }]);
    await runningSetup();
    fakes = [
      { kind: "container", handle: ID_A, session: "os-a" },
      { kind: "container", handle: ID_B, session: "os-b" },
      { kind: "unit", handle: "u1.scope", session: "os-a" },
    ];
    install();
    const session = { id: "os-a", worktreeDir: worktree };
    expect(await stopSessionWorkloads(session, [session])).toBe(4);
    expect(readPortalRegistry(worktree).map((p) => p.state)).toEqual([
      "stopped",
      "awake",
    ]);
    expect(listSessionResources()).toEqual([]);
    expect(stops).toEqual([
      ["podman", "stop", "--time", "10", ID_A],
      ["systemctl", "--user", "stop", "u1.scope"],
    ]);
    expect(fakes.map((f) => f.session)).toEqual(["os-b"]);
    expect((await runs[0])!.stopped).toBe("stopped");
  });
});

describe("host session workloads", () => {
  test("counts by owner state and lists archived and missing leftovers", async () => {
    await runningSetup();
    fakes = [
      { kind: "container", handle: ID_A, session: "os-a", memory: 64 },
      { kind: "container", handle: ID_B, session: "os-archived", memory: 32 },
      { kind: "unit", handle: "u1.scope", session: "os-gone", memory: 8 },
    ];
    install();
    const host = await hostSessionResources([
      { id: "os-a" },
      { id: "os-archived", archived: true },
    ]);
    expect(host.counts).toEqual({
      live: 2,
      archived: 1,
      missing: 1,
      unknown: 0,
    });
    expect(host.byKind).toEqual({ setup: 1, container: 2, unit: 1 });
    expect(host.memoryBytes).toBe(104 * 1024 * 1024);
    expect(host.leftoverMemoryBytes).toBe(40 * 1024 * 1024);
    expect(
      host.leftovers.map((item) => [item.kind, item.sessionId, item.owner]),
    ).toEqual([
      ["container", "os-archived", "archived"],
      ["unit", "os-gone", "missing"],
    ]);
  });
});
