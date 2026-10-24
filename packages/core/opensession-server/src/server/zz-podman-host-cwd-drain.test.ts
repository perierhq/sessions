/**
 * A session in a "This machine (container)" Sandbox whose working directory
 * is a host worktree path, driven through the real queue drain: enqueuePrompt
 * → drainQueue → runSessionPrompt → maybeLaunchSandboxedRun → the real
 * PodmanProvider (podman itself faked) → runAgentHosted with the fake engine.
 *
 * Every session records its host worktree path (`worktreeDir`), and the
 * launcher passes it to the provider as the workspace to reuse. The
 * container's only persistent place is its home volume, so the provider
 * maps the host path into the sandbox home; a host path must not reach the
 * container as is.
 *
 * zz- prefix and dynamic imports in beforeAll for the same reason as
 * zz-fake-run.test.ts: the run modules load only after the sessions dir is
 * redirected. Run this file directly.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import type { PodmanWorkspacePlan } from "./sandbox/adapters/podman";
import type { SandboxSessionSpec } from "./sandbox/provider";

// Resolved: worktree paths that are not on disk match the configured root
// by prefix (repoForPathOrNull), and macOS temp dirs sit behind a symlink.
const tmp = realpathSync(mkdtempSync(`${tmpdir()}/zz-podman-host-cwd-`));
const worktrees = `${tmp}/worktrees`;

const ensureCalls: SandboxSessionSpec[] = [];
const prepared: PodmanWorkspacePlan[] = [];
let provider: import("./sandbox/provider").SandboxProvider;

let runSession: typeof import("./run-session");
let agentRunner: typeof import("./agent-runner");
let sessionCache: typeof import("./session-cache");
let queueState: typeof import("./queue-state");
let fakeEngineMod: typeof import("./testing/fake-engine");
let memoryV2: typeof import("./memory-v2/runtime");
let podmanCli: typeof import("./sandbox/adapters/podman-cli");
let testSessionListStore:
  | import("./session-list-store").SessionListStore
  | null = null;
let restoreSessionListStore: (() => void) | null = null;
let restoreSessionsDir: (() => void) | null = null;
let restoreJournal: (() => void) | null = null;
let redirected = false;
const previousPiDetach = process.env.OPENSESSION_PI_DETACH;
const previousMemoryDb = process.env.OPENSESSION_MEMORY_DB;
const previousTestInProcessRuns = process.env.OPENSESSION_TEST_IN_PROCESS_RUNS;
const previousConfig = process.env.OPENSESSION_CONFIG;

/** A session on branch `incident/acme`: its host worktree path has the
 *  branch's slash in it, as `worktreePathFor` builds it. */
function writePodmanSession(
  id: string,
  extra: Record<string, unknown> = {},
): void {
  writeFileSync(
    `${tmp}/${id}.json`,
    JSON.stringify({
      id,
      claudeSessionId: "",
      branch: "incident/acme",
      worktreeDir: `${worktrees}/acme-incident/acme`,
      repo: "acme",
      agentStarted: true,
      title: "Container session",
      mode: "code",
      mcpServers: [],
      model: "pi/anthropic/claude-sonnet-5",
      sandbox: {
        provider: "podman",
        lifecycle: "preparing",
        workspace: "volume",
      },
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      ...extra,
    }),
  );
}

const sessionJson = (id: string) =>
  JSON.parse(readFileSync(`${tmp}/${id}.json`, "utf-8"));

async function waitForLastRunError(id: string): Promise<{ message: string }> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const error = sessionJson(id).lastRunError;
    if (error?.message) return error;
    await Bun.sleep(10);
  }
  throw new Error(`lastRunError was not persisted for ${id}`);
}

beforeAll(async () => {
  process.env.OPENSESSION_PI_DETACH = "0";
  process.env.OPENSESSION_TEST_IN_PROCESS_RUNS = "1";
  process.env.OPENSESSION_MEMORY_DB = `${tmp}/memory-v2.sqlite`;
  (globalThis as any).__opensessionBooted = true;
  mkdirSync(`${tmp}/repo`, { recursive: true });
  mkdirSync(worktrees, { recursive: true });
  writeFileSync(
    `${tmp}/config.json`,
    JSON.stringify({
      paths: { worktreesDir: worktrees },
      repos: {
        acme: { repo: `${tmp}/repo`, ghRepo: "acme/acme", label: "Acme" },
      },
    }),
  );
  process.env.OPENSESSION_CONFIG = `${tmp}/config.json`;

  // The real provider over a fake podman; the operator's connection
  // settings are not what this test is about.
  const sandboxConfig = await import("./sandbox/config");
  mock.module("./sandbox/config", () => ({
    ...sandboxConfig,
    sandboxesEnabled: () => true,
    sandboxProviderConfigured: () => true,
  }));
  const { PodmanProvider } = await import("./sandbox/adapters/podman");
  const { fakePodman, fakeProviderDeps } =
    await import("./sandbox/adapters/podman-test-fixture");
  const fake = fakePodman();
  const real = new PodmanProvider(
    fakeProviderDeps(fake, {
      // The provider's own plan, from the spec it is given.
      workspacePlan: undefined,
      prepare: async (ctx) => {
        prepared.push(ctx.plan);
      },
    }),
  );
  provider = Object.assign(Object.create(real), {
    ensure(spec: SandboxSessionSpec) {
      ensureCalls.push(spec);
      return real.ensure(spec);
    },
  });
  const sandboxIndex = await import("./sandbox");
  mock.module("./sandbox", () => ({
    ...sandboxIndex,
    getSandboxProvider: () => provider,
  }));

  const paths = await import("./paths");
  const prevDir = paths.__setSessionsDirForTest(tmp);
  restoreSessionsDir = () => paths.__setSessionsDirForTest(prevDir);
  const sessionListStoreMod = await import("./session-list-store");
  testSessionListStore = new sessionListStoreMod.SessionListStore(
    `${tmp}/session-list.sqlite`,
  );
  const previousSessionListStore =
    sessionListStoreMod.__setSessionListStoreForTest(testSessionListStore);
  restoreSessionListStore = () =>
    sessionListStoreMod.__setSessionListStoreForTest(previousSessionListStore);
  await sessionListStoreMod.upsertIndexedSessions([], "include");
  const runJournal = await import("./run-journal");
  const prevJournal = runJournal.__setActiveRunsPathForTest(
    `${tmp}/active-runs.json`,
  );
  restoreJournal = () => runJournal.__setActiveRunsPathForTest(prevJournal);

  runSession = await import("./run-session");
  agentRunner = await import("./agent-runner");
  sessionCache = await import("./session-cache");
  queueState = await import("./queue-state");
  fakeEngineMod = await import("./testing/fake-engine");
  memoryV2 = await import("./memory-v2/runtime");
  podmanCli = await import("./sandbox/adapters/podman-cli");
  memoryV2.closeMemoryRuntime();

  writePodmanSession("bks-zz-podman-probe");
  sessionCache.invalidateSessionsCache();
  redirected = !!sessionCache.findSession("bks-zz-podman-probe");
  if (!redirected) {
    console.warn(
      "[zz-podman-host-cwd-drain] sessions-dir redirect didn't take (module " +
        "cache already warm from earlier test files) — skipping; run this file directly.",
    );
  }
});

afterAll(() => {
  if (previousPiDetach === undefined) delete process.env.OPENSESSION_PI_DETACH;
  else process.env.OPENSESSION_PI_DETACH = previousPiDetach;
  if (previousTestInProcessRuns === undefined)
    delete process.env.OPENSESSION_TEST_IN_PROCESS_RUNS;
  else process.env.OPENSESSION_TEST_IN_PROCESS_RUNS = previousTestInProcessRuns;
  memoryV2?.closeMemoryRuntime();
  if (previousConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else process.env.OPENSESSION_CONFIG = previousConfig;
  if (previousMemoryDb === undefined) delete process.env.OPENSESSION_MEMORY_DB;
  else process.env.OPENSESSION_MEMORY_DB = previousMemoryDb;
  agentRunner?.__setEngineForTest(null);
  restoreJournal?.();
  restoreSessionsDir?.();
  restoreSessionListStore?.();
  testSessionListStore?.close();
  sessionCache?.invalidateSessionsCache();
  mock.restore();
});

describe("podman Sandbox with a host worktree path (queue drain)", () => {
  test("the queued turn runs in the sandbox home's copy of the worktree", async () => {
    if (!redirected) return;
    const sid = "bks-zz-podman-host-cwd";
    writePodmanSession(sid);
    sessionCache.invalidateSessionsCache();
    ensureCalls.length = 0;
    prepared.length = 0;
    const fake = fakeEngineMod.makeFakeEngine([
      { kind: "clean", engineSessionId: "ses_zz_podman", text: ["here"] },
    ]);
    agentRunner.__setEngineForTest(fake.engine);

    await runSession.enqueuePrompt(
      sid,
      queueState.queueItem({ content: "where are you", user: "Operator" }),
    );
    await runSession.drainQueue(sid);

    expect(sessionJson(sid).lastRunError).toBeUndefined();
    // The launcher hands the provider the host worktree path…
    expect(ensureCalls).toHaveLength(1);
    expect(ensureCalls[0]?.cwd).toBe(`${worktrees}/acme-incident/acme`);
    // …and the workspace is set up at the same place under the sandbox home.
    expect(prepared).toHaveLength(1);
    expect(prepared[0]).toMatchObject({
      repoId: "acme",
      branch: "incident/acme",
      cwd: "/home/ubuntu/worktrees/acme-incident/acme",
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.prompt).toContain("where are you");
    expect(sessionJson(sid).sandbox).toMatchObject({
      provider: "podman",
      sandboxId: podmanCli.podmanNames(sid).pod,
      lifecycle: "awake",
    });
    expect(queueState.promptQueues.get(sid)?.length ?? 0).toBe(0);
  });

  test("a workspace the sandbox refuses fails once, is reported, and is not retried", async () => {
    if (!redirected) return;
    const sid = "bks-zz-podman-refused";
    // Attached repos are host worktrees; a container has none of them.
    writePodmanSession(sid, {
      attachedRepos: [{ repo: "acme", dir: `${worktrees}/acme-other` }],
    });
    sessionCache.invalidateSessionsCache();
    ensureCalls.length = 0;
    prepared.length = 0;
    const fake = fakeEngineMod.makeFakeEngine([
      { kind: "clean", engineSessionId: "ses_zz_refused", text: ["no"] },
    ]);
    agentRunner.__setEngineForTest(fake.engine);

    await runSession.enqueuePrompt(
      sid,
      queueState.queueItem({ content: "investigate", user: "Operator" }),
    );
    await expect(runSession.drainQueue(sid)).rejects.toThrow(
      /attached repos are not supported/,
    );
    // Reported once on the session with the provider's reason.
    expect((await waitForLastRunError(sid)).message).toMatch(
      /^Session setup failed: Sandbox unavailable: attached repos are not supported/,
    );
    expect(queueState.promptQueues.get(sid)?.length ?? 0).toBe(1);

    // The watcher the enqueue armed stops instead of retrying on its backoff.
    const deadline = Date.now() + 8_000;
    while (runSession.sessionQueueOwnerActive(sid) && Date.now() < deadline)
      await Bun.sleep(50);
    expect(runSession.sessionQueueOwnerActive(sid)).toBe(false);
    expect(ensureCalls).toHaveLength(1);
    expect(prepared).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
  }, 20_000);
});
