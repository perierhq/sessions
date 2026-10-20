import { afterEach, beforeEach, expect, test } from "bun:test";
import type { AgentAccess } from "../../../shared/incident-access";
import { useIncidentTestKernel } from "../testing/kernel-fixture";
import { AgentAccessError, __setBindingResolverForTest } from "./resolve";
import {
  auditIncidentSpawned,
  enforceIncidentSpawn,
  incidentDescendantPolicy,
  incidentTurnScope,
} from "./session-policy";

const kit = useIncidentTestKernel();
const access = (over: Partial<AgentAccess> = {}): AgentAccess => ({
  incidentId: "inc-1",
  project: "acme",
  role: "investigator",
  signalId: "sig-search",
  overrideApplied: false,
  defaults: false,
  connections: ["sentry"],
  deniedTools: {},
  mode: "code",
  repos: ["acme"],
  runners: ["rn-prod"],
  hosts: [],
  credentials: [],
  model: null,
  egress: null,
  narrowed: [],
  revision: "r2",
  summary: "",
  ...over,
});
const base = {
  automationId: "incidents-acme",
  automationName: "Incidents",
  repo: "acme",
  publicationRepo: "example/acme",
  baseBranch: "main",
};
let current = access();
beforeEach(() => {
  current = access();
  __setBindingResolverForTest(async () => current);
});
afterEach(() => __setBindingResolverForTest(undefined));

test("descendant policy carries the binding and the access", () => {
  expect(incidentDescendantPolicy(access(), base)).toEqual({
    ...base,
    mcpServers: ["sentry"],
    allowedRunners: ["rn-prod"],
    publication: "branch-pr-only",
    incident: {
      incidentId: "inc-1",
      role: "investigator",
      signalId: "sig-search",
      accessRevision: "r2",
    },
  });
  expect(() =>
    incidentDescendantPolicy(access(), { ...base, repo: "acme-api" }),
  ).toThrow("Repo acme-api is not in this agent's access");
});
test("spawn re-resolves and narrows to the fresh access", async () => {
  const policy = {
    ...incidentDescendantPolicy(access(), base),
    mcpServers: ["sentry", "logs"],
  };
  current = access({ connections: ["logs"], revision: "r3" });
  expect(
    await enforceIncidentSpawn(policy, {
      repo: "acme",
      mode: "code",
      runner: "rn-prod",
    }),
  ).toMatchObject({ mcpServers: ["logs"], incident: { accessRevision: "r3" } });
  // The session does not exist yet: the allowed decision is recorded, the
  // spawn itself only once the create succeeds.
  expect(kit.audits).toContainEqual(
    expect.objectContaining({
      kind: "incident_access_spawn_allowed",
      incident_id: "inc-1",
      revision: "r3",
    }),
  );
  expect(kit.audits.filter((e) => e.kind === "incident_access_spawn")).toEqual(
    [],
  );
});
test("the spawn is audited with the created session", () => {
  const policy = incidentDescendantPolicy(access({ revision: "r3" }), base);
  auditIncidentSpawned(policy, "os-9", {
    repo: "acme",
    mode: "code",
    runner: "rn-prod",
  });
  auditIncidentSpawned(undefined, "os-10", { repo: "acme", mode: "code" });
  expect(kit.audits.filter((e) => e.kind === "incident_access_spawn")).toEqual([
    {
      kind: "incident_access_spawn",
      incident_id: "inc-1",
      incident_role: "investigator",
      session_id: "os-9",
      revision: "r3",
      repo: "acme",
      runner: "rn-prod",
      mode: "code",
    },
  ]);
});
test.each([
  [{ repo: "acme-api", mode: "code" as const }, "does not match"],
  [{ repo: "acme", mode: "scratch" as const }, "work in a repository"],
  [
    { repo: "acme", mode: "code" as const, runner: "rn-other" },
    "Runner rn-other is not in this agent's access",
  ],
])("refuses %j", async (request, message) => {
  await expect(
    enforceIncidentSpawn(incidentDescendantPolicy(access(), base), request),
  ).rejects.toThrow(message);
});
test("a repo the fresh access no longer lists is refused", async () => {
  const policy = incidentDescendantPolicy(access(), base);
  current = access({ repos: [] });
  await expect(
    enforceIncidentSpawn(policy, { repo: "acme", mode: "code" }),
  ).rejects.toThrow("Repo acme is not in this agent's access");
});
test("access for another incident or role is refused", async () => {
  const policy = incidentDescendantPolicy(access(), base);
  current = access({ incidentId: "inc-2" });
  await expect(
    enforceIncidentSpawn(policy, { repo: "acme", mode: "code" }),
  ).rejects.toMatchObject({ code: "spawn" });
});
test("mode and model locks", async () => {
  current = access({ mode: "ask", model: "pi/openai/gpt-6.1" });
  const policy = incidentDescendantPolicy(access(), base);
  await expect(
    enforceIncidentSpawn(policy, { repo: "acme", mode: "code" }),
  ).rejects.toThrow("This agent may only read (mode ask)");
  await expect(
    enforceIncidentSpawn(policy, {
      repo: "acme",
      mode: "ask",
      model: "pi/anthropic/claude-opus-5-5",
    }),
  ).rejects.toThrow("This agent must use pi/openai/gpt-6.1");
  expect(
    await enforceIncidentSpawn(policy, {
      repo: "acme",
      mode: "ask",
      model: "pi/openai/gpt-6.1",
    }),
  ).toBeDefined();
});
test("a refused resolution refuses the spawn and is audited", async () => {
  __setBindingResolverForTest(async () => {
    throw new AgentAccessError(
      "Incident inc-1 is resolved; its agents have no access",
      "incident",
    );
  });
  await expect(
    enforceIncidentSpawn(incidentDescendantPolicy(access(), base), {
      repo: "acme",
      mode: "code",
    }),
  ).rejects.toThrow("is resolved");
  expect(kit.audits).toContainEqual(
    expect.objectContaining({
      kind: "incident_access_refused",
      phase: "spawn",
      incident_id: "inc-1",
    }),
  );
});
test("a policy without a binding passes through untouched", async () => {
  const plain = {
    ...base,
    mcpServers: [],
    allowedRunners: [],
    publication: "branch-pr-only" as const,
  };
  expect(
    await enforceIncidentSpawn(plain, { repo: "acme", mode: "scratch" }),
  ).toBe(plain);
});
test("createSession enforces before the descendant isolation check", async () => {
  const src = await Bun.file(
    new URL("../../session-control-wiring.ts", import.meta.url),
  ).text();
  const enforce = src.indexOf("enforceIncidentSpawn(");
  expect(enforce).toBeGreaterThan(-1);
  expect(enforce).toBeLessThan(
    src.indexOf("Automation descendants require an explicit sandbox"),
  );
});

const bound = (over: Record<string, unknown> = {}) => ({
  id: "os-1",
  mode: "code" as const,
  repo: "acme",
  runner: { id: "rn-prod" },
  automationDescendantPolicy: {
    ...incidentDescendantPolicy(access(), base),
    mcpServers: ["sentry", "logs"],
  },
  ...over,
});

test("a turn never widens past the spawn snapshot and narrows to the fresh access", async () => {
  current = access({ connections: ["sentry", "logs", "metrics"] });
  expect((await incidentTurnScope(bound()))?.mcpServers).toEqual([
    "sentry",
    "logs",
  ]);
  current = access({ connections: ["logs"], deniedTools: { bash: "off" } });
  expect(await incidentTurnScope(bound())).toMatchObject({
    mcpServers: ["logs"],
    deniedTools: { bash: "off" },
  });
});
test.each([
  [access({ mode: "ask" }), {}, "may now only read"],
  [access({ repos: [] }), {}, "Repo acme was removed"],
  [access({ runners: [] }), {}, "Runner rn-prod was removed"],
])(
  "refuses a turn when access shrank under the session",
  async (next, over, message) => {
    current = next;
    await expect(incidentTurnScope(bound(over))).rejects.toThrow(message);
    expect(kit.audits).toContainEqual(
      expect.objectContaining({
        kind: "incident_access_refused",
        phase: "turn",
        session_id: "os-1",
        incident_id: "inc-1",
      }),
    );
  },
);
test("a refused resolution refuses the turn", async () => {
  __setBindingResolverForTest(async () => {
    throw new AgentAccessError(
      "Incident inc-1 is paused; its agents have no access",
      "incident",
    );
  });
  await expect(incidentTurnScope(bound())).rejects.toThrow("is paused");
  expect(kit.audits).toContainEqual(
    expect.objectContaining({ kind: "incident_access_refused", phase: "turn" }),
  );
});
test("access for another incident or role refuses the turn", async () => {
  current = access({ role: "verifier" });
  await expect(incidentTurnScope(bound())).rejects.toMatchObject({
    code: "turn",
  });
});
test("a revision change is audited once", async () => {
  current = access({ revision: "r9" });
  await incidentTurnScope(bound());
  await incidentTurnScope(bound());
  expect(
    kit.audits.filter((e) => e.kind === "incident_access_changed"),
  ).toEqual([
    {
      kind: "incident_access_changed",
      incident_id: "inc-1",
      incident_role: "investigator",
      session_id: "os-1",
      from: "r2",
      to: "r9",
    },
  ]);
});
test("no binding, no scope", async () => {
  expect(await incidentTurnScope({ id: "os-2" })).toBeNull();
});
