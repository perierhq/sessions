import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Real workspace store on a fresh in-memory kernel per test, with the state
// root (scratch dirs included) pointed at a temp dir.
const scratch = mkdtempSync(join(tmpdir(), "opensession-ws-cleanup-"));
const previous = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = scratch;

const { SessionKernelStore, __setSessionKernelStoreForTest } =
  await import("./session-kernel");
const {
  __resetWorkspaceProjectionForTest,
  createWorkspace,
  deleteWorkspace,
  getWorkspace,
} = await import("./workspaces");
const { stateDir } = await import("./paths");
const { removeWorkspaceAfterSessionDelete, workspaceGoesWithLastSession } =
  await import("./session-workspace-cleanup");

let store: InstanceType<typeof SessionKernelStore>;
let previousStore: InstanceType<typeof SessionKernelStore> | undefined;

beforeEach(() => {
  process.env.OPENSESSION_STATE_DIR = scratch;
  store = new SessionKernelStore(":memory:");
  previousStore = __setSessionKernelStoreForTest(store);
  __resetWorkspaceProjectionForTest();
});

afterEach(() => {
  __setSessionKernelStoreForTest(previousStore);
  store.close();
  __resetWorkspaceProjectionForTest();
});

afterAll(() => {
  if (previous === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previous;
  rmSync(scratch, { recursive: true, force: true });
});

async function workspaceWithScratchDir(key?: string) {
  const ws = await createWorkspace({
    name: "Cleanup",
    createdBy: "Kent",
    ...(key ? { key } : {}),
  });
  const dir = `${stateDir("scratch")}/${ws.id}`;
  mkdirSync(dir, { recursive: true });
  return { ws, dir };
}

const deps = (sessions: Array<{ id: string; workspaceId?: string }>) => ({
  getWorkspace,
  listSessions: async () => sessions,
  deleteWorkspace,
});

test("only keyless and session-create workspaces go with their last session", () => {
  expect(workspaceGoesWithLastSession(undefined)).toBe(true);
  expect(workspaceGoesWithLastSession("")).toBe(true);
  expect(workspaceGoesWithLastSession("session-create:abc123")).toBe(true);
  expect(workspaceGoesWithLastSession("ghpr-1234")).toBe(false);
  expect(workspaceGoesWithLastSession("device-1:folder-1")).toBe(false);
  expect(workspaceGoesWithLastSession("x-session-create:abc")).toBe(false);
});

test("deleting the last session of a session-create workspace removes it and its scratch dir", async () => {
  const { ws, dir } = await workspaceWithScratchDir("session-create:abc123");
  // The deleted session may still be in the list snapshot; it must not count.
  const removed = await removeWorkspaceAfterSessionDelete(
    "bks-gone",
    ws.id,
    deps([{ id: "bks-gone", workspaceId: ws.id }, { id: "bks-other" }]),
  );
  expect(removed).toBe(true);
  expect(await getWorkspace(ws.id)).toBeNull();
  expect(existsSync(dir)).toBe(false);
});

test("a keyless workspace still goes with its last session", async () => {
  const { ws, dir } = await workspaceWithScratchDir();
  expect(
    await removeWorkspaceAfterSessionDelete("bks-gone", ws.id, deps([])),
  ).toBe(true);
  expect(await getWorkspace(ws.id)).toBeNull();
  expect(existsSync(dir)).toBe(false);
});

test("a session-create workspace with sessions left stays", async () => {
  const { ws, dir } = await workspaceWithScratchDir("session-create:abc123");
  const removed = await removeWorkspaceAfterSessionDelete(
    "bks-gone",
    ws.id,
    deps([
      { id: "bks-gone", workspaceId: ws.id },
      { id: "bks-sibling", workspaceId: ws.id },
    ]),
  );
  expect(removed).toBe(false);
  expect((await getWorkspace(ws.id))?.id).toBe(ws.id);
  expect(existsSync(dir)).toBe(true);
});

test("workspaces with other key kinds stay even when empty", async () => {
  for (const key of ["ghpr-1234", "device-1:folder-1"]) {
    const { ws, dir } = await workspaceWithScratchDir(key);
    expect(
      await removeWorkspaceAfterSessionDelete("bks-gone", ws.id, deps([])),
    ).toBe(false);
    expect((await getWorkspace(ws.id))?.key).toBe(key);
    expect(existsSync(dir)).toBe(true);
  }
});

test("a workspace already gone is a no-op", async () => {
  expect(
    await removeWorkspaceAfterSessionDelete("bks-gone", "ws-missing", deps([])),
  ).toBe(false);
});
