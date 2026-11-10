import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APPLICATION_CATALOG_NAMESPACES,
  catalogDocuments,
  importApplicationCatalog,
} from "./catalog-documents";
import {
  type Goal,
  appendLedger,
  createGoal,
  deleteGoal,
  getGoal,
  listGoals,
  mutateGoal,
  readLedger,
  resumeGoal,
  saveGoal,
  updateGoal,
} from "./goals";
import {
  SessionKernelStore,
  __setSessionKernelStoreForTest,
  sessionCatalogDocument,
} from "./session-kernel";

// The catalog mirrors every document to the legacy directory and imports
// legacy files from it, and ledgers live there too, so the state root is a
// scratch dir for the whole file.
const root = mkdtempSync(join(tmpdir(), "goals-test-"));
const previousRoot = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = root;
const goalsDir = join(root, ".opensession-goals");

afterAll(() => {
  if (previousRoot === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previousRoot;
  rmSync(root, { recursive: true, force: true });
});

let store: SessionKernelStore;
let previousStore: SessionKernelStore | undefined;
beforeEach(async () => {
  await rm(goalsDir, { recursive: true, force: true });
  store = new SessionKernelStore(":memory:");
  previousStore = __setSessionKernelStoreForTest(store);
});
afterEach(() => {
  __setSessionKernelStoreForTest(previousStore);
  store.close();
});

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function created(
  input: Partial<Parameters<typeof createGoal>[0]> = {},
): Promise<Goal> {
  const result = await createGoal({
    name: "Flake burndown",
    mission: "Fix the flakiest test each wake.",
    createdBy: "Ada",
    ...input,
  });
  if ("error" in result) throw new Error(result.error);
  return result;
}

describe("goals store", () => {
  test("creates a goal on the catalog with a seeded ledger file", async () => {
    const goal = await created({ mcpServers: [" ahrefs ", ""] });
    expect(goal).toMatchObject({
      name: "Flake burndown",
      status: "active",
      mode: "ask",
      minWakeMinutes: 30,
      wakeCount: 0,
      mcpServers: ["ahrefs"],
      createdBy: "Ada",
      stateFile: join(goalsDir, `${goal.id}.ledger.md`),
    });
    expect(await catalogDocuments("goals").get(goal.id)).toEqual(
      JSON.parse(JSON.stringify(goal)),
    );
    expect(await getGoal(goal.id)).toEqual(JSON.parse(JSON.stringify(goal)));
    const ledger = await readFile(goal.stateFile, "utf-8");
    expect(ledger).toStartWith("# Ledger — Flake burndown");
    expect(ledger).toContain("## Mission\n\nFix the flakiest test each wake.");
    // Every write is mirrored to the legacy JSON file next to the ledger.
    expect(await exists(join(goalsDir, `${goal.id}.json`))).toBe(true);
  });

  test("keeps the create validation", async () => {
    expect(
      await createGoal({ name: " ", mission: "m", createdBy: "Ada" }),
    ).toEqual({ error: "Name is required" });
    expect(
      await createGoal({ name: "n", mission: "", createdBy: "Ada" }),
    ).toEqual({ error: "Mission is required" });
    expect(
      await createGoal({
        name: "n",
        mission: "m",
        firstWakeAt: "not a time",
        createdBy: "Ada",
      }),
    ).toEqual({ error: 'Invalid firstWakeAt: "not a time"' });
    const goal = await created({
      minWakeMinutes: 1,
      maxWakes: 2.7,
      mode: "code",
      firstWakeAt: "2030-01-01T00:00:00Z",
    });
    expect(goal).toMatchObject({
      minWakeMinutes: 5,
      maxWakes: 2,
      mode: "code",
      nextWakeAt: "2030-01-01T00:00:00.000Z",
    });
    expect(await listGoals()).toHaveLength(1);
  });

  test("lists goals by name", async () => {
    await created({ name: "Zeta" });
    await created({ name: "alpha" });
    await created({ name: "Mid" });
    expect((await listGoals()).map((goal) => goal.name)).toEqual([
      "alpha",
      "Mid",
      "Zeta",
    ]);
  });

  test("updates, floors the cadence and resumes", async () => {
    const goal = await created();
    expect(await updateGoal("goal-missing", { name: "x" })).toEqual({
      error: "Goal not found",
    });
    const paused = await updateGoal(goal.id, {
      status: "paused",
      pauseReason: "Waiting on Bea",
      minWakeMinutes: 2,
      mcpServers: [" linear "],
    });
    expect(paused).toMatchObject({
      status: "paused",
      pauseReason: "Waiting on Bea",
      minWakeMinutes: 5,
      mcpServers: ["linear"],
    });
    expect(await getGoal(goal.id)).toMatchObject({ status: "paused" });

    expect(await resumeGoal(goal.id, "nope")).toEqual({
      error: 'Invalid time: "nope"',
    });
    const resumed = await resumeGoal(goal.id, "2031-05-01T09:00:00Z");
    expect(resumed).toMatchObject({
      status: "active",
      nextWakeAt: "2031-05-01T09:00:00.000Z",
    });
    expect((await getGoal(goal.id))?.pauseReason).toBeUndefined();
  });

  test("patches only the operator fields, whatever the caller sends", async () => {
    const goal = await created();
    // An API body is untrusted: `stateFile` is the path the ledger tools
    // read and write, and `id` would fork the record.
    const body = JSON.parse(
      JSON.stringify({
        name: "Renamed",
        id: "goal-other",
        stateFile: "/etc/passwd",
        wakeCount: 99,
        engineSessionId: "hijacked",
        createdBy: "Mallory",
      }),
    );
    const updated = await updateGoal(goal.id, body);
    expect(updated).toMatchObject({
      id: goal.id,
      name: "Renamed",
      stateFile: goal.stateFile,
      wakeCount: 0,
      createdBy: "Ada",
    });
    expect(updated).not.toHaveProperty("engineSessionId");
    expect(await getGoal(goal.id)).toEqual(updated as Goal);
    expect(await getGoal("goal-other")).toBeNull();
  });

  test("mutates the current record and creates nothing for an unknown id", async () => {
    const goal = await created();
    await updateGoal(goal.id, { status: "paused", pauseReason: "Hold" });
    const next = await mutateGoal(goal.id, (current) => ({
      ...current,
      wakeCount: current.wakeCount + 1,
    }));
    expect(next).toMatchObject({
      status: "paused",
      pauseReason: "Hold",
      wakeCount: 1,
    });
    expect(await mutateGoal("goal-missing", (current) => current)).toBeNull();
    expect(await mutateGoal("..", (current) => current)).toBeNull();
    // No tombstone either: the key was never written.
    expect(
      await sessionCatalogDocument({
        op: "get",
        namespace: "goals",
        key: "goal-missing",
      }),
    ).toBeNull();
  });

  test("a project lead's goal keeps what its settings decide", async () => {
    const lead = await createGoal(
      { name: "Lead: Acme", mission: "Lead acme.", createdBy: "Project lead" },
      { leadProject: "acme", pauseReason: "Starting" },
    );
    if ("error" in lead) throw new Error(lead.error);
    expect(lead).toMatchObject({
      status: "paused",
      pauseReason: "Starting",
      leadProject: "acme",
    });
    expect(
      await updateGoal(lead.id, { mission: "Anything.", mcpServers: [] }),
    ).toEqual({
      error:
        "This goal is a project lead's: its mission, mcpServers come from the project's lead settings",
    });
    expect((await getGoal(lead.id))?.mission).toBe("Lead acme.");
    // Other fields, and the values it already has, are fine.
    const renamed = await updateGoal(lead.id, {
      name: "Lead: Acme web",
      mission: "Lead acme.",
      status: "active",
    });
    expect(renamed).toMatchObject({ name: "Lead: Acme web", status: "active" });
    // An ordinary goal takes them all.
    const plain = await created();
    expect(await updateGoal(plain.id, { mission: "New." })).toMatchObject({
      mission: "New.",
    });
  });

  test("saves runner fields as given", async () => {
    const goal = await created();
    await saveGoal({ ...goal, wakeCount: 3, lastRunStatus: "ok" });
    expect(await getGoal(goal.id)).toMatchObject({
      wakeCount: 3,
      lastRunStatus: "ok",
    });
  });

  test("appends to the ledger, recreating its directory on demand", async () => {
    const goal = await created();
    await appendLedger(goal, "  Baseline: 14 flaky tests.  ");
    expect(await readLedger(goal)).toMatch(
      /\n\n## \d{4}-\d\d-\d\dT[^\n]+\n\nBaseline: 14 flaky tests\.\n$/,
    );
    await rm(goalsDir, { recursive: true, force: true });
    await appendLedger(goal, "After a wipe.");
    expect(await readLedger(goal)).toContain("After a wipe.");
  });

  test("reads a missing ledger as empty", async () => {
    const goal = await created();
    await rm(goal.stateFile);
    expect(await readLedger(goal)).toBe("");
  });

  test("deletes the record and its ledger", async () => {
    const goal = await created();
    expect(await deleteGoal(goal.id)).toBe(true);
    expect(await getGoal(goal.id)).toBeNull();
    expect(await exists(goal.stateFile)).toBe(false);
    expect(await exists(join(goalsDir, `${goal.id}.json`))).toBe(false);
    expect(await deleteGoal(goal.id)).toBe(false);
  });

  test("treats an id that can't be a key as a miss", async () => {
    expect(await getGoal("..")).toBeNull();
    expect(await getGoal("a/b")).toBeNull();
    expect(await deleteGoal("..")).toBe(false);
  });

  test("imports legacy goal files once at boot, skipping ledgers", async () => {
    const legacy: Goal = {
      id: "goal-legacy",
      name: "Legacy goal",
      mission: "Carry on.",
      status: "paused",
      mode: "ask",
      nextWakeAt: "2099-01-01T00:00:00.000Z",
      minWakeMinutes: 240,
      wakeCount: 2,
      stateFile: join(goalsDir, "goal-legacy.ledger.md"),
      createdBy: "Ada",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    await mkdir(goalsDir, { recursive: true });
    await writeFile(
      join(goalsDir, "goal-legacy.json"),
      JSON.stringify(legacy, null, 2),
    );
    await writeFile(legacy.stateFile, "# Ledger — Legacy goal\n");

    // Only the goals namespace imports here; the others read other stores.
    for (const namespace of APPLICATION_CATALOG_NAMESPACES)
      if (namespace !== "goals")
        await sessionCatalogDocument({ op: "mark_import_complete", namespace });

    // No file probe on reads: before the import the catalog is empty.
    expect(await listGoals()).toEqual([]);
    await importApplicationCatalog();
    expect(await listGoals()).toEqual([legacy]);
    expect(await readLedger(legacy)).toBe("# Ledger — Legacy goal\n");

    // The import is done once: a file that appears later stays out.
    await writeFile(
      join(goalsDir, "goal-late.json"),
      JSON.stringify({ ...legacy, id: "goal-late", name: "Late" }),
    );
    await importApplicationCatalog();
    expect((await listGoals()).map((goal) => goal.id)).toEqual(["goal-legacy"]);
  });
});
