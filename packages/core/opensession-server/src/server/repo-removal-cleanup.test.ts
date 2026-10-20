import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { UnifiedSession } from "./types";

// What repository removal cleans up outside the registry: the workspaces
// that name it and the automations that target it.
const scratch = mkdtempSync(join(tmpdir(), "opensession-repo-removal-"));
const previous = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = scratch;

const { SessionKernelStore, __setSessionKernelStoreForTest } =
  await import("./session-kernel");
const { __resetWorkspaceProjectionForTest, createWorkspace, getWorkspace } =
  await import("./workspaces");
const { releaseRepoWorkspaces } = await import("./repo-removal");
const {
  disableAutomationsForRepo,
  enabledAutomationsForRepo,
  getAutomation,
  saveAutomation,
} = await import("./automations");
type Automation = Parameters<typeof saveAutomation>[0];

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

const draft = { text: "Pick this back up", updatedAt: "2026-01-01" };

test("workspaces that default to a removed repository are cleaned", async () => {
  const idle = await createWorkspace({
    name: "Widget work",
    createdBy: "acme",
    repo: "widget",
    draft,
  });
  const busy = await createWorkspace({
    name: "Still busy",
    createdBy: "acme",
    repo: "widget",
    draft,
  });
  const other = await createWorkspace({
    name: "Gadget work",
    createdBy: "acme",
    repo: "gadget",
    draft,
    attachedRepos: [
      { repo: "widget", branch: "feature", dir: "/tmp/acme/widget-feature" },
      { repo: "tools", branch: "feature", dir: "/tmp/acme/tools-feature" },
    ],
  });
  const live = [
    { id: "s1", workspaceId: busy.id, archived: false } as UnifiedSession,
  ];

  await releaseRepoWorkspaces("widget", live);

  // Its sessions are archived, and without a draft it leaves the sidebar.
  expect((await getWorkspace(idle.id))?.draft).toBeUndefined();
  // A live session still keeps the other one, draft and all.
  expect((await getWorkspace(busy.id))?.draft?.text).toBe(draft.text);
  // Others keep their draft, and stop attaching the removed repository.
  const after = await getWorkspace(other.id);
  expect(after?.draft?.text).toBe(draft.text);
  expect(after?.attachedRepos?.map((a) => a.repo)).toEqual(["tools"]);
});

test("automations that target a removed repository are turned off", async () => {
  const base = {
    name: "Nightly",
    prompt: "Check the build",
    mode: "code",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  for (const [id, repo, enabled] of [
    ["auto-widget", "widget", true],
    ["auto-widget-off", "widget", false],
    ["auto-gadget", "gadget", true],
    ["auto-default", undefined, true],
  ] as const) {
    // SAFETY: the store keeps whole records; these carry every field the
    // removal reads (id, name, repo, enabled).
    await saveAutomation({
      ...base,
      id,
      enabled,
      ...(repo ? { repo } : {}),
    } as unknown as Automation);
  }

  expect((await enabledAutomationsForRepo("widget")).map((a) => a.id)).toEqual([
    "auto-widget",
  ]);
  expect(await disableAutomationsForRepo("widget")).toBe(1);

  expect((await getAutomation("auto-widget"))?.enabled).toBe(false);
  expect((await getAutomation("auto-widget"))?.repo).toBe("widget");
  expect((await getAutomation("auto-gadget"))?.enabled).toBe(true);
  expect((await getAutomation("auto-default"))?.enabled).toBe(true);
  expect(await enabledAutomationsForRepo("widget")).toEqual([]);
});
