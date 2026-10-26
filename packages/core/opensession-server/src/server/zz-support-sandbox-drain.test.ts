/**
 * A support session (a workspace `support` external ref) in a podman
 * Sandbox, driven through the real queue drain: enqueuePrompt → drainQueue →
 * runSessionPrompt → maybeLaunchSandboxedRun → runAgentHosted, with the
 * provider stubbed and the fake engine standing in for the model.
 *
 * A support session reads untrusted customer mail with no person at the
 * keyboard, so its Sandbox turn gets no repos/memory/personal note and no
 * ask-the-user handler; an ordinary session in the same Sandbox gets both.
 *
 * zz- prefix and dynamic imports in beforeAll for the same reason as
 * zz-fake-run.test.ts: the run modules load only after the sessions dir is
 * redirected. Run this file directly.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import type { SandboxSessionSpec } from "./sandbox/provider";

const tmp = mkdtempSync(`${tmpdir()}/zz-support-sandbox-drain-`);

const ensureCalls: SandboxSessionSpec[] = [];
const stubSandbox = {
  id: "sbx-support-stub",
  provider: "podman" as const,
  cwd: "/workspace/acme",
  workspace: "volume" as const,
  async exec() {
    return { exitCode: 0, stdout: "", stderr: "" };
  },
  async ports() {
    return {};
  },
  async status() {
    return "running" as const;
  },
};
const stubProvider = {
  id: "podman" as const,
  async ensure(spec: SandboxSessionSpec) {
    ensureCalls.push(spec);
    return stubSandbox;
  },
  async get() {
    return stubSandbox;
  },
  async destroy() {},
};

let runSession: typeof import("./run-session");
let agentRunner: typeof import("./agent-runner");
let sessionCache: typeof import("./session-cache");
let queueState: typeof import("./queue-state");
let fakeEngineMod: typeof import("./testing/fake-engine");
let memoryV2: typeof import("./memory-v2/runtime");
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

function writeSession(id: string, support: boolean) {
  writeFileSync(
    `${tmp}/${id}.json`,
    JSON.stringify({
      id,
      claudeSessionId: "",
      branch: "main",
      worktreeDir: `${tmp}/worktrees/${id}`,
      repo: "acme",
      agentStarted: true,
      createdBy: "Sessions",
      title: "Support",
      mode: "ask",
      mcpServers: [],
      model: "pi/anthropic/claude-sonnet-5",
      ...(support
        ? { externalRefs: [{ kind: "support", id: "sc_0190-acme" }] }
        : {}),
      sandbox: {
        provider: "podman",
        lifecycle: "preparing",
        workspace: "volume",
      },
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
    }),
  );
}

const sessionJson = (id: string) =>
  JSON.parse(readFileSync(`${tmp}/${id}.json`, "utf-8"));

beforeAll(async () => {
  process.env.OPENSESSION_PI_DETACH = "0";
  process.env.OPENSESSION_TEST_IN_PROCESS_RUNS = "1";
  process.env.OPENSESSION_MEMORY_DB = `${tmp}/memory-v2.sqlite`;
  (globalThis as any).__opensessionBooted = true;
  mkdirSync(`${tmp}/repo`, { recursive: true });
  writeFileSync(
    `${tmp}/config.json`,
    JSON.stringify({
      repos: {
        acme: { repo: `${tmp}/repo`, ghRepo: "acme/acme", label: "Acme" },
      },
    }),
  );
  process.env.OPENSESSION_CONFIG = `${tmp}/config.json`;

  // The provider is stubbed; the operator's connection settings are not
  // what this test is about.
  const sandboxConfig = await import("./sandbox/config");
  mock.module("./sandbox/config", () => ({
    ...sandboxConfig,
    sandboxesEnabled: () => true,
    sandboxProviderConfigured: () => true,
  }));
  const sandboxIndex = await import("./sandbox");
  mock.module("./sandbox", () => ({
    ...sandboxIndex,
    getSandboxProvider: () => stubProvider,
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
  memoryV2.closeMemoryRuntime();

  writeSession("bks-zz-support-probe", true);
  sessionCache.invalidateSessionsCache();
  redirected = !!sessionCache.findSession("bks-zz-support-probe");
  if (!redirected) {
    console.warn(
      "[zz-support-sandbox-drain] sessions-dir redirect didn't take (module " +
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

async function runOneTurn(sid: string, support: boolean) {
  writeSession(sid, support);
  sessionCache.invalidateSessionsCache();
  ensureCalls.length = 0;
  const fake = fakeEngineMod.makeFakeEngine([
    { kind: "clean", engineSessionId: `ses_${sid}`, text: ["on it"] },
  ]);
  agentRunner.__setEngineForTest(fake.engine);
  await runSession.enqueuePrompt(
    sid,
    queueState.queueItem({
      // A mention in mail must not resolve other sessions for the agent.
      content: "New customer email, see @session:bks-0190aaaa-0000",
      user: "Sessions",
    }),
  );
  await runSession.drainQueue(sid);
  expect(sessionJson(sid).lastRunError).toBeUndefined();
  expect(ensureCalls).toHaveLength(1);
  expect(fake.calls).toHaveLength(1);
  return { opts: fake.calls[0].opts, prompt: fake.calls[0].prompt };
}

describe("support session in a podman Sandbox (queue drain)", () => {
  test("the Sandbox turn carries no repos, memory, personal or mentions note and no ask handler", async () => {
    if (!redirected) return;
    const { opts, prompt } = await runOneTurn("bks-zz-support-sandbox", true);
    expect(opts.reposNote).toBeUndefined();
    expect(prompt).not.toContain("no session with this id");
    expect(opts.onAskUser).toBeUndefined();
    expect(opts.user).toBeUndefined();
  });

  test("an ordinary session in the same Sandbox still gets them", async () => {
    if (!redirected) return;
    const { opts, prompt } = await runOneTurn("bks-zz-plain-sandbox", false);
    expect(opts.reposNote).toBeTruthy();
    expect(prompt).toContain(
      "@session:bks-0190aaaa-0000 · no session with this id",
    );
    expect(opts.onAskUser).toBeDefined();
  });
});
