import { afterEach, beforeEach, expect, test } from "bun:test";
import type { AgentAccess } from "../../../shared/incident-access";
import type {
  AgentRun,
  IncidentResponse,
} from "../../../shared/incident-response";
import type { Incident } from "../../../shared/incidents";
import type { TranscriptEntry } from "@tellahq/opensession-protocol/session";
import type { Automation } from "../../automations";
import type {
  CreateSessionOpts,
  SessionControl,
  SessionSummary,
} from "../../session-control";
import type { NativeSessionFile } from "../../types";
import { agentAccessFixture } from "../testing/access-fixture";
import { useIncidentTestKernel } from "../testing/kernel-fixture";
import { __resetIncidentAccessGateForTest } from "./access-gate";
import {
  type AgentDeps,
  type AutomationStore,
  agentToolCalls,
  createIncidentAgents,
  ensureCoordinatorSession,
  ensureIncidentAutomation,
  incidentAutomationName,
  incidentSessionPolicy,
} from "./agents";
import {
  __setProjectSettingsContextForTest,
  getProjectSettings,
} from "./project-settings";

useIncidentTestKernel();
beforeEach(() =>
  __setProjectSettingsContextForTest({
    projectExists: (id) => id === "acme",
    runnerProblem: () => null,
    modelProblem: () => null,
  }),
);
afterEach(() => {
  __setProjectSettingsContextForTest(undefined);
  __resetIncidentAccessGateForTest();
});

const KNOWN_MODELS = ["pi/anthropic/claude-opus-5-5", "pi/openai/gpt-6.1-sol"];

function memoryStore(): AutomationStore & { saved: Automation[] } {
  const rows = new Map<string, Automation>();
  let next = 0;
  const saved: Automation[] = [];
  return {
    saved,
    list: async () => [...rows.values()],
    create: async (input) => {
      const a = {
        ...input,
        id: `auto-${++next}`,
        createdAt: "2026-10-20T10:00:00Z",
        webhookSecret: "s",
      } as Automation;
      rows.set(a.id, a);
      return a;
    },
    save: async (a) => {
      saved.push(a);
      rows.set(a.id, a);
    },
  };
}

const incident: Incident = {
  id: "inc-1",
  project: "acme",
  title: "Search is down",
  state: "investigating",
  severity: "major",
  owner: "Ada",
  openedBy: { kind: "rule" },
  signalIds: ["sig-1"],
  primarySignalId: "sig-1",
  openedAt: "2026-10-20T10:00:00Z",
  updatedAt: "2026-10-20T10:00:00Z",
  lastProblemAt: "2026-10-20T10:00:00Z",
  findings: [],
  events: [],
  droppedEvents: 0,
};

const automation = {
  id: "auto-1",
  name: "Incidents · acme",
  prompt: "Incident response for acme.",
  schedule: "",
  mode: "code",
  repo: "acme",
  enabled: false,
  createdBy: "Sessions (incidents)",
  createdAt: "2026-10-20T10:00:00Z",
  webhookSecret: "s",
  mcpServers: [],
  workflows: true,
  workflowSessions: true,
  workflowSessionRepos: ["acme"],
  workflowSessionRunners: [],
  incidentResponse: { project: "acme" },
} as Automation;

const access = (
  role: "investigator" | "verifier",
  over: Partial<AgentAccess> = {},
): AgentAccess =>
  agentAccessFixture({
    role,
    mode: role === "verifier" ? "ask" : "code",
    revision: "r1",
    ...over,
  });

function responseWith(agents: Array<Partial<AgentRun>>): IncidentResponse {
  return {
    coordinatorSessionId: "coord",
    agents: agents as AgentRun[],
  } as IncidentResponse;
}

function summary(
  id: string,
  patch: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    id,
    local: true,
    claudeSessionId: "",
    source: "opensession",
    branch: "main",
    worktreeDir: "/repos/acme",
    createdBy: "Incidents · acme (automation)",
    startedBy: "Incidents · acme (automation)",
    title: id,
    lastActivity: new Date(0).toISOString(),
    createdAt: new Date(0).toISOString(),
    isRunning: false,
    transcriptPath: null,
    repo: "acme",
    mode: "ask",
    state: "idle",
    queuedCount: 0,
    controllable: true,
    automationId: "auto-1",
    ...patch,
  };
}

function fakeWorld(
  opts: { existing?: string[]; transcript?: TranscriptEntry[] } = {},
) {
  const sessions = new Map<string, SessionSummary>();
  sessions.set("coord", summary("coord"));
  for (const id of opts.existing ?? [])
    sessions.set(
      id,
      summary(id, {
        parentSessionId: "coord",
        state: "running",
        isRunning: true,
      }),
    );
  const creates: Array<CreateSessionOpts & { id: string }> = [];
  const sends: Array<{ id: string; message: string }> = [];
  const files: NativeSessionFile[] = [];
  let next = 0;
  const control: SessionControl = {
    listSessions: () => [...sessions.values()],
    getSession: (id) => sessions.get(id),
    transcriptTail: async () => opts.transcript ?? [],
    answerQuestion: () => false,
    async deliverToSession(id, message) {
      sends.push({ id, message });
      return { status: "steered", message: "sent" };
    },
    cancelSession: () => false,
    async reparentSession() {
      return { ok: false, error: "not used" };
    },
    async createSession(input) {
      const id = `child-${++next}`;
      creates.push({ ...input, id });
      sessions.set(
        id,
        summary(id, {
          parentSessionId: input.parentSessionId,
          repo: input.repo,
          mode: input.mode === "ask" ? "ask" : "code",
          state: "running",
          isRunning: true,
        }),
      );
      return { id, createdBy: "x", createdAt: new Date(0).toISOString() };
    },
  };
  const deps: Partial<AgentDeps> = {
    control,
    writeSessionFile: async (id, mutate) => {
      const file = mutate({} as NativeSessionFile) as NativeSessionFile;
      files.push(file);
      sessions.set(id, summary(id));
    },
    repo: () => ({ path: "/repos/acme", defaultBranch: "main" }),
    newSessionId: () => "coord-new",
    now: () => Date.parse("2026-10-20T10:00:00Z"),
    controllerDeps: {
      branchPushed: async () => true,
      hasUncommittedChanges: async () => false,
      defaultBranch: () => "main",
      publicationRepo: () => "acme/web",
      resolveModel: (id) => (KNOWN_MODELS.includes(id) ? { id } : null),
      baseUrl: "https://sessions.example.test",
      resolveRepo: (session, repo) =>
        repo === "acme"
          ? {
              repo: "acme",
              dir: session.worktreeDir || "/repos/acme",
              branch: session.branch || undefined,
              primary: true,
            }
          : null,
    },
  };
  return { control, deps, creates, sends, files, sessions };
}

test("the incident automation is disabled, scoped to its project, with an empty MCP list", async () => {
  const store = memoryStore();
  const a = await ensureIncidentAutomation("acme", store);
  expect(a).toMatchObject({
    name: "Incidents · acme",
    enabled: false,
    schedule: "",
    mcpServers: [],
    workflows: true,
    workflowSessions: true,
    workflowSessionRepos: ["acme"],
    workflowSessionRunners: [],
    webhookEnabled: false,
    incidentResponse: { project: "acme" },
  });
  expect(incidentAutomationName("acme")).toBe("Incidents · acme");
  expect((await ensureIncidentAutomation("acme", store)).id).toBe(a.id);
  expect((await getProjectSettings("acme")).automationId).toBe(a.id);
});

test("a person's edits to the incident automation are put back", async () => {
  const store = memoryStore();
  const a = await ensureIncidentAutomation("acme", store);
  await store.save({
    ...a,
    enabled: true,
    mcpServers: ["sentry"],
    workflowSessionRunners: ["rn-prod"],
  });
  const again = await ensureIncidentAutomation("acme", store);
  expect(again).toMatchObject({
    id: a.id,
    enabled: false,
    mcpServers: [],
    workflowSessionRunners: [],
  });
});

test("the controller's own policy allows only the project", () => {
  expect(incidentSessionPolicy(automation)).toEqual({
    automationId: "auto-1",
    automationName: "Incidents · acme",
    allowedRepos: ["acme"],
    allowedRunners: [],
  });
});

test("agents start under plan 3's policy, on their own model, never reporting into the coordinator", async () => {
  const h = fakeWorld();
  h.sessions.delete("coord");
  const coordinator = await ensureCoordinatorSession(
    incident,
    automation,
    h.deps,
  );
  expect(coordinator).toBe("coord-new");
  expect(h.files[0]).toMatchObject({
    id: coordinator,
    mode: "ask",
    repo: "acme",
    automationId: automation.id,
    spawnDepth: 0,
    title: "Incident · Search is down",
    createdBy: "Incidents · acme (automation)",
  });
  h.sessions.set(coordinator, summary(coordinator));
  const agents = createIncidentAgents(
    incident,
    { coordinatorSessionId: coordinator, automation },
    h.deps,
  );
  const { sessionId } = await agents.spawn({
    role: "investigator",
    round: 1,
    attempt: 1,
    prompt: "Investigate",
    model: "pi/anthropic/claude-opus-5-5",
    branch: "incident/2026-10-20-search",
    access: access("investigator", { connections: ["sentry"] }),
    workspace: { kind: "sandbox", provider: "daytona" },
  });
  expect(h.creates[0]).toMatchObject({
    requestId: "incident:inc-1:r1:investigator:a1",
    mode: "code",
    model: "pi/anthropic/claude-opus-5-5",
    reportBack: false,
    mcpServers: ["sentry"],
    isolatedWorktree: true,
    automationDescendantPolicy: {
      mcpServers: ["sentry"],
      repo: "acme",
      publication: "branch-pr-only",
      allowedRunners: [],
      incident: {
        incidentId: "inc-1",
        role: "investigator",
        accessRevision: "r1",
      },
    },
  });
  expect(h.creates[0]!.automationDescendantPolicy).not.toHaveProperty(
    "hostAgentUser",
  );
  // A default sandbox is left to the session's own resolution.
  expect(h.creates[0]).not.toHaveProperty("sandbox");
  await agents.spawn({
    role: "verifier",
    round: 1,
    attempt: 1,
    prompt: "Verify",
    model: "pi/openai/gpt-6.1-sol",
    branch: "incident/x-verify-r1",
    baseSessionId: sessionId,
    access: access("verifier"),
    workspace: { kind: "host", user: "opensession-incident" },
  });
  expect(h.creates[1]).toMatchObject({
    mode: "ask",
    model: "pi/openai/gpt-6.1-sol",
    automationDescendantPolicy: {
      hostAgentUser: "opensession-incident",
      incident: { role: "verifier" },
    },
  });
  expect(h.creates[1]!.isolatedWorktree).toBeFalsy();
  expect(h.creates[1]!.stackedOnBranch).toBeUndefined();
  expect(sessionId).not.toBe(h.creates[1]!.id);
});

test("an agent in This machine (container) asks for it by name", async () => {
  const h = fakeWorld();
  const agents = createIncidentAgents(
    incident,
    { coordinatorSessionId: "coord", automation },
    h.deps,
  );
  await agents.spawn({
    role: "investigator",
    round: 1,
    attempt: 1,
    prompt: "Investigate",
    model: "pi/anthropic/claude-opus-5-5",
    branch: "incident/x",
    access: access("investigator"),
    workspace: { kind: "sandbox", provider: "podman" },
  });
  expect(h.creates[0]).toMatchObject({
    sandbox: "podman",
    automationDescendantPolicy: { incident: { role: "investigator" } },
  });
  expect(h.creates[0]!.automationDescendantPolicy).not.toHaveProperty(
    "hostAgentUser",
  );
});

test("an existing coordinator session is reused", async () => {
  const h = fakeWorld();
  expect(
    await ensureCoordinatorSession(
      { ...incident, response: responseWith([]) },
      automation,
      h.deps,
    ),
  ).toBe("coord");
  expect(h.files).toEqual([]);
});

test("an access for another incident or role never spawns", async () => {
  const h = fakeWorld();
  const agents = createIncidentAgents(
    incident,
    { coordinatorSessionId: "coord", automation },
    h.deps,
  );
  const base = {
    round: 1,
    attempt: 1,
    prompt: "Investigate",
    model: "pi/anthropic/claude-opus-5-5",
    branch: "incident/x",
    workspace: { kind: "sandbox" as const, provider: "daytona" },
  };
  await expect(
    agents.spawn({
      ...base,
      role: "investigator",
      access: access("investigator", { incidentId: "inc-2" }),
    }),
  ).rejects.toThrow("The access is not for this incident and role");
  await expect(
    agents.spawn({
      ...base,
      role: "investigator",
      access: access("verifier"),
    }),
  ).rejects.toThrow("The access is not for this incident and role");
  expect(h.creates).toEqual([]);
});

test("after a restart, recorded agents are adopted", async () => {
  const h = fakeWorld({ existing: ["child-7"] });
  const agents = createIncidentAgents(
    { ...incident, response: responseWith([{ sessionId: "child-7" }]) },
    { coordinatorSessionId: "coord", automation },
    h.deps,
  );
  await expect(
    agents.send("child-7", "Round 2", "req-1"),
  ).resolves.toBeUndefined();
  expect(h.sends).toEqual([{ id: "child-7", message: "Round 2" }]);
  expect(await agents.status("child-7")).toMatchObject({
    status: "running",
    costUsd: 0,
    tokens: 0,
  });
  await expect(agents.cancel("child-7", "req-2")).resolves.toBeUndefined();
});

test("final text is the newest assistant message after the turn was sent", async () => {
  const h = fakeWorld({
    transcript: [
      {
        id: "1",
        type: "assistant",
        content: "old",
        timestamp: "2026-10-20T10:00:00Z",
      },
      {
        id: "2",
        type: "assistant",
        content: "thinking",
        isReasoning: true,
        timestamp: "2026-10-20T10:06:00Z",
      },
      {
        id: "3",
        type: "assistant",
        content: "new",
        timestamp: "2026-10-20T10:05:00Z",
      },
    ],
  });
  const agents = createIncidentAgents(
    incident,
    { coordinatorSessionId: "coord", automation },
    h.deps,
  );
  expect(await agents.finalText("child-1", "2026-10-20T10:01:00Z")).toBe("new");
  expect(
    await agents.finalText("child-1", "2026-10-20T10:07:00Z"),
  ).toBeUndefined();
});

test("tool calls are summarised without their full input", async () => {
  const h = fakeWorld({
    transcript: [
      {
        id: "1",
        type: "tool_use",
        content: "",
        toolName: "bash",
        toolInput: { command: `grep -rn error /var/log/${"x".repeat(200)}` },
        timestamp: "2026-10-20T10:00:00Z",
      },
      {
        id: "2",
        type: "tool_use",
        content: "",
        toolName: "read",
        toolInput: { path: "src/search.ts" },
        timestamp: "2026-10-20T10:01:00Z",
      },
      {
        id: "3",
        type: "assistant",
        content: "done",
        timestamp: "2026-10-20T10:02:00Z",
      },
      {
        id: "4",
        type: "tool_use",
        content: "",
        toolName: "describe_access",
        toolInput: {},
        timestamp: "2026-10-20T10:03:00Z",
      },
    ],
  });
  const calls = await agentToolCalls("child-1", 50, h.control);
  expect(calls).toHaveLength(3);
  expect(calls[0]).toEqual({
    at: "2026-10-20T10:00:00Z",
    tool: "bash",
    summary: `grep -rn error /var/log/${"x".repeat(200)}`.slice(0, 120),
  });
  expect(calls[1]!.summary).toBe("src/search.ts");
  expect(calls[2]!.summary).toBe("describe_access");
});
