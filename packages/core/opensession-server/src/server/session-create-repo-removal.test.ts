import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getConfigAsync } from "./config";
import {
  RepoBeingRemovedError,
  markRepoRemoving,
  unmarkRepoRemoving,
} from "./repo-removal-guard";
import { promptDispatches } from "./queue-state";
import { getSessionControl } from "./session-control";
import "./session-control-wiring";
import { openCreatedSession, type ResolvedCreate } from "./session-create";
import { snapshotOpeningCreate } from "./session-create-plan";
import {
  SessionKernelStore,
  __setSessionKernelStoreForTest,
  type CreationOpeningEffectItem,
} from "./session-kernel";
import {
  SessionListStore,
  __setSessionListStoreForTest,
} from "./session-list-store";
import { planCreateAttachRepos } from "./session-repos";
import { createWorkspace, deleteWorkspace } from "./workspaces";
import { ensureAskCheckout } from "./worktree";
import { OPENSESSION_SESSIONS_DIR } from "./paths";

const savedConfig = process.env.OPENSESSION_CONFIG;
const dirs: string[] = [];
const workspaces: string[] = [];
let store: SessionKernelStore;
let previous: SessionKernelStore | undefined;
let index: SessionListStore;
let previousIndex: SessionListStore | undefined;

beforeEach(async () => {
  store = new SessionKernelStore(":memory:");
  previous = __setSessionKernelStoreForTest(store);
  index = new SessionListStore(":memory:");
  previousIndex = __setSessionListStoreForTest(index);
  const dir = mkdtempSync(join(tmpdir(), "os-create-removal-"));
  dirs.push(dir);
  const configPath = join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      repos: {
        widget: { repo: join(dir, "widget"), defaultBranch: "main" },
        gadget: { repo: join(dir, "gadget"), defaultBranch: "main" },
      },
    }),
  );
  process.env.OPENSESSION_CONFIG = configPath;
  await getConfigAsync();
  markRepoRemoving("widget");
});

afterEach(async () => {
  unmarkRepoRemoving("widget");
  for (const id of workspaces.splice(0))
    await deleteWorkspace(id).catch(() => {});
  __setSessionKernelStoreForTest(previous);
  __setSessionListStoreForTest(previousIndex);
  store.close();
  index.close();
  if (savedConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else process.env.OPENSESSION_CONFIG = savedConfig;
  await getConfigAsync();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** A resolved create with an opening turn, prepared up to the point the
 *  opening effect runs, as session-create-empty.test.ts does. */
async function preparedCreate(
  overrides: Partial<ResolvedCreate>,
): Promise<{ spec: ResolvedCreate; effectKey: string }> {
  const id = `os-${crypto.randomUUID()}`;
  const spec: ResolvedCreate = {
    id,
    title: "Question",
    titlePrompt: "What does this do?",
    displayPrompt: "What does this do?",
    openingPrompt: "What does this do?",
    createdBy: "Alice",
    createdAt: new Date().toISOString(),
    mode: "ask",
    wtPath: OPENSESSION_SESSIONS_DIR,
    persistBranch: "",
    branch: "",
    memoryRepoIds: [],
    sandboxProvider: null,
    volumeWorkspace: false,
    remoteSandbox: false,
    needsWorktree: false,
    openingPromptEntryId: `create-${id}`,
    finish: "drain",
    ...overrides,
  };
  const effectKey = `opening:${spec.openingPromptEntryId}`;
  const payload: CreationOpeningEffectItem["payload"] = {
    creationIdentity: id,
    creationGeneration: 1,
    openingPromptEntryId: spec.openingPromptEntryId,
    runId: `opening:${id}:${spec.openingPromptEntryId}`,
    runGeneration: 1,
    mode: "adopt_or_launch",
  };
  await promptDispatches.set(id, {
    promptEntryId: spec.openingPromptEntryId,
    items: [{ content: spec.openingPrompt }],
    kind: "create",
  });
  for (const event of ["plan", "preparation_started"] as const)
    store.applyCreationEvent({ sessionId: id, identity: id, event });
  store.applyCreationEvent({
    sessionId: id,
    identity: id,
    event: "opening_dispatched",
    openingPlan: snapshotOpeningCreate(spec),
    nextEffectId: effectKey,
    effect: { kind: "creation_opening_turn", effectKey, payload },
  });
  return { spec, effectKey };
}

async function openAndCollectFailure(
  spec: ResolvedCreate,
  effectKey: string,
): Promise<string[]> {
  const failures: string[] = [];
  await openCreatedSession(
    spec,
    {
      announce: () => {},
      emit: () => {},
      fail: (message) => {
        failures.push(message);
      },
    },
    spec.id,
    effectKey,
  );
  return failures;
}

describe("creating a session in a repository being removed", () => {
  test("the shared create path refuses the opening run", async () => {
    const { spec, effectKey } = await preparedCreate({
      repoId: "widget",
      memoryRepoIds: ["widget"],
    });
    const failures = await openAndCollectFailure(spec, effectKey);
    expect(failures).toEqual([
      expect.stringContaining('"widget" is being removed'),
    ]);
    expect(store.creationState(spec.id)?.state).toBe("failed");
    expect(store.runState(spec.id).currentRunId).toBeFalsy();
  });

  test("so does one that attaches it", async () => {
    const { spec, effectKey } = await preparedCreate({
      mode: "code",
      repoId: "gadget",
      memoryRepoIds: ["gadget"],
      attachRepos: { repos: ["widget"], branch: "feature" },
    });
    const failures = await openAndCollectFailure(spec, effectKey);
    expect(failures).toEqual([
      expect.stringContaining('"widget" is being removed'),
    ]);
    expect(store.creationState(spec.id)?.state).toBe("failed");
  });

  test("an ask-mode create is refused", async () => {
    await expect(
      getSessionControl().createSession({
        prompt: "What does this repository do?",
        mode: "ask",
        repo: "widget",
        user: "Alice",
      }),
    ).rejects.toBeInstanceOf(RepoBeingRemovedError);
  });

  test("a create that joins the repository's workspace is refused", async () => {
    const workspace = await createWorkspace({
      name: "Widget work",
      repo: "widget",
      createdBy: "Alice",
    });
    workspaces.push(workspace.id);
    await expect(
      getSessionControl().createSession({
        prompt: "Pick up where we left off",
        mode: "ask",
        workspaceId: workspace.id,
        user: "Alice",
      }),
    ).rejects.toBeInstanceOf(RepoBeingRemovedError);
  });

  test("the ask checkout is not prepared", async () => {
    await expect(ensureAskCheckout("widget")).rejects.toBeInstanceOf(
      RepoBeingRemovedError,
    );
  });

  test("it can't be attached to a new session", () => {
    expect(() =>
      planCreateAttachRepos(["widget"], "gadget", "feature", (id) => ({
        id,
        sharedCheckout: false,
        defaultBranch: "main",
      })),
    ).toThrow(RepoBeingRemovedError);
  });
});
