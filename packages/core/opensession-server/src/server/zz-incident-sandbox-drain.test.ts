/**
 * An incident agent in a "This machine (container)" Sandbox, driven through
 * the real queue drain: enqueuePrompt → drainQueue → runSessionPrompt →
 * maybeLaunchSandboxedRun → runAgentHosted, with the provider stubbed and the
 * fake engine standing in for the model.
 *
 * The session file is shaped like a spawned investigator: an automation name
 * and id, the immutable descendant policy carrying the incident binding, and
 * a podman Sandbox that has not been materialized yet. The incident's
 * automation is not a Sandbox automation and has no stored record here, so
 * a turn that loses the descendant policy on the way to the launcher is
 * mistaken for a disposable automation resume and refused.
 *
 * zz- prefix and dynamic imports in beforeAll for the same reason as
 * zz-fake-run.test.ts: the run modules load only after the sessions dir is
 * redirected. Run this file directly.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import type { SandboxSessionSpec } from "./sandbox/provider";

const tmp = mkdtempSync(`${tmpdir()}/zz-incident-sandbox-drain-`);

const ensureCalls: SandboxSessionSpec[] = [];
let providerConfigured = true;
let configuredChecks = 0;
let ensureError: Error | null = null;
const stubSandbox = {
  id: "sbx-incident-stub",
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
    if (ensureError) throw ensureError;
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
let restoreResolver: (() => void) | null = null;
let restoreAudit: (() => void) | null = null;
let redirected = false;
const previousPiDetach = process.env.OPENSESSION_PI_DETACH;
const previousMemoryDb = process.env.OPENSESSION_MEMORY_DB;
const previousTestInProcessRuns = process.env.OPENSESSION_TEST_IN_PROCESS_RUNS;
const previousConfig = process.env.OPENSESSION_CONFIG;

const incidentPolicy = {
  automationId: "auto-incidents-acme",
  automationName: "Incidents · acme",
  repo: "acme",
  publicationRepo: "acme/acme",
  baseBranch: "main",
  mcpServers: [],
  allowedRunners: [],
  publication: "branch-pr-only",
  incident: {
    incidentId: "inc-acme",
    role: "investigator",
    signalId: "sig-acme",
    accessRevision: "r-acme",
    spawn: {
      hosts: [],
      credentials: [],
      egress: { route: "server", hosts: ["status.example.test"] },
    },
  },
};

function writeIncidentAgent(id: string) {
  writeFileSync(
    `${tmp}/${id}.json`,
    JSON.stringify({
      id,
      claudeSessionId: "",
      branch: "incident/acme",
      worktreeDir: `${tmp}/worktrees/${id}`,
      repo: "acme",
      parentSessionId: "os-incident-coordinator",
      spawnDepth: 1,
      agentStarted: true,
      automation: incidentPolicy.automationName,
      automationId: incidentPolicy.automationId,
      automationDescendantPolicy: incidentPolicy,
      createdBy: incidentPolicy.automationName,
      title: "Incident inc-acme",
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
    sandboxProviderConfigured: () => {
      configuredChecks += 1;
      return providerConfigured;
    },
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

  // The incident's access resolves to the agent's spawn snapshot.
  const { __setBindingResolverForTest } =
    await import("./incidents/access/resolve");
  __setBindingResolverForTest(async (binding) => ({
    incidentId: binding.incidentId,
    project: "acme",
    role: binding.role,
    signalId: binding.signalId,
    overrideApplied: false,
    defaults: false,
    connections: [],
    deniedTools: {},
    mode: "code",
    repos: ["acme"],
    runners: [],
    hosts: [],
    credentials: [],
    model: null,
    egress: { route: "server", hosts: ["status.example.test"] },
    narrowed: [],
    revision: "r-acme",
    summary: "Investigator · can edit acme",
  }));
  restoreResolver = () => __setBindingResolverForTest(undefined);
  const { __setIncidentAuditForTest } = await import("./incidents/audit-sink");
  __setIncidentAuditForTest(() => {});
  restoreAudit = () => __setIncidentAuditForTest(undefined);

  runSession = await import("./run-session");
  agentRunner = await import("./agent-runner");
  sessionCache = await import("./session-cache");
  queueState = await import("./queue-state");
  fakeEngineMod = await import("./testing/fake-engine");
  memoryV2 = await import("./memory-v2/runtime");
  memoryV2.closeMemoryRuntime();

  writeIncidentAgent("bks-zz-incident-probe");
  sessionCache.invalidateSessionsCache();
  redirected = !!sessionCache.findSession("bks-zz-incident-probe");
  if (!redirected) {
    console.warn(
      "[zz-incident-sandbox-drain] sessions-dir redirect didn't take (module " +
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
  restoreResolver?.();
  restoreAudit?.();
  restoreJournal?.();
  restoreSessionsDir?.();
  restoreSessionListStore?.();
  testSessionListStore?.close();
  sessionCache?.invalidateSessionsCache();
  mock.restore();
});

describe("incident agent in a podman Sandbox (queue drain)", () => {
  test("the queued turn starts in the Sandbox under the incident's own policy", async () => {
    if (!redirected) return;
    const sid = "bks-zz-incident-sandbox";
    writeIncidentAgent(sid);
    sessionCache.invalidateSessionsCache();
    ensureCalls.length = 0;
    ensureError = null;
    const fake = fakeEngineMod.makeFakeEngine([
      { kind: "clean", engineSessionId: "ses_zz_incident", text: ["looking"] },
    ]);
    agentRunner.__setEngineForTest(fake.engine);

    await runSession.enqueuePrompt(
      sid,
      queueState.queueItem({ content: "investigate", user: "Operator" }),
    );
    await runSession.drainQueue(sid);

    expect(sessionJson(sid).lastRunError).toBeUndefined();
    // The Sandbox is the session's own, not a disposable automation one, and
    // an incident agent gets no private seed files in it.
    expect(ensureCalls).toHaveLength(1);
    expect(ensureCalls[0]).toMatchObject({
      sessionId: sid,
      repo: "acme",
      seedPrivateFiles: false,
    });
    expect(ensureCalls[0].trustProfile).toBeUndefined();
    // The turn ran with its workspace in that Sandbox.
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].prompt).toContain("investigate");
    expect(sessionJson(sid).sandbox).toMatchObject({
      provider: "podman",
      sandboxId: stubSandbox.id,
      lifecycle: "awake",
    });
    expect(queueState.promptQueues.get(sid)?.length ?? 0).toBe(0);
  });

  test("a refused setup fails once, is reported, and waits for the next message", async () => {
    if (!redirected) return;
    const sid = "bks-zz-incident-refused";
    writeIncidentAgent(sid);
    sessionCache.invalidateSessionsCache();
    ensureCalls.length = 0;
    providerConfigured = false;
    const fake = fakeEngineMod.makeFakeEngine([
      { kind: "clean", engineSessionId: "ses_zz_refused", text: ["looking"] },
      { kind: "clean", text: ["still looking"] },
    ]);
    agentRunner.__setEngineForTest(fake.engine);
    try {
      // A send: the durable enqueue arms the drain watcher, and the sender
      // drains at once (ws-handlers).
      await runSession.enqueuePrompt(
        sid,
        queueState.queueItem({ content: "investigate", user: "Operator" }),
      );
      const checksBefore = configuredChecks;
      await expect(runSession.drainQueue(sid)).rejects.toThrow(
        'Sandbox provider "podman" is not configured and Ready',
      );
      const checksAfterFailure = configuredChecks;
      expect(checksAfterFailure).toBeGreaterThan(checksBefore);

      // Reported once on the session with the real reason, which is what an
      // incident watching this agent reads as its error.
      expect((await waitForLastRunError(sid)).message).toBe(
        'Session setup failed: Sandbox provider "podman" is not configured and Ready',
      );
      // The message is kept.
      expect(queueState.promptQueues.get(sid)?.length ?? 0).toBe(1);

      // The watcher the enqueue armed stops instead of retrying the same
      // refusal on its backoff.
      const deadline = Date.now() + 8_000;
      while (runSession.sessionQueueOwnerActive(sid) && Date.now() < deadline)
        await Bun.sleep(50);
      expect(runSession.sessionQueueOwnerActive(sid)).toBe(false);
      expect(configuredChecks).toBe(checksAfterFailure);
      expect(ensureCalls).toHaveLength(0);
      expect(fake.calls).toHaveLength(0);

      // Once the cause is fixed, the next message delivers the whole queue.
      providerConfigured = true;
      await runSession.enqueuePrompt(
        sid,
        queueState.queueItem({ content: "try again", user: "Operator" }),
      );
      await runSession.drainQueue(sid);
      const delivered = fake.calls.map((call) => call.prompt).join("\n");
      expect(delivered).toContain("investigate");
      expect(delivered).toContain("try again");
      expect(delivered.indexOf("investigate")).toBeLessThan(
        delivered.indexOf("try again"),
      );
      expect(queueState.promptQueues.get(sid)?.length ?? 0).toBe(0);
    } finally {
      providerConfigured = true;
    }
  }, 20_000);
});
