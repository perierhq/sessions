import { afterEach, beforeEach, expect, test } from "bun:test";
import type {
  AgentRun,
  IncidentResponse,
} from "../../shared/incident-response";
import type { Incident } from "../../shared/incidents";
import { createIncident, updateIncident } from "../incidents/incident-store";
import { transitionIncident } from "../incidents/lifecycle";
import {
  __resetCoordinatorForTest,
  __setCoordinatorDepsForTest,
  __waitForCoordinatorForTest,
} from "../incidents/response/coordinator";
import { emptyResponse } from "../incidents/response/ledger";
import { __setProjectSettingsContextForTest } from "../incidents/response/project-settings";
import { useIncidentTestKernel } from "../incidents/testing/kernel-fixture";
import type { RouteContext } from "./context";
import {
  __setIncidentResponseRoutesForTest,
  handleIncidentResponseRoutes,
} from "./incident-response";
import { handleIncidentsRoutes } from "./incidents";
import { routeHandlers } from "./index";

const kit = useIncidentTestKernel();
const ADA = { login: "ada", name: "Ada Lovelace" };

beforeEach(() => {
  __setProjectSettingsContextForTest({
    projectExists: (id) => id === "acme",
    runnerProblem: () => null,
    modelProblem: () => null,
  });
  // The loop woken by a decision touches nothing real.
  __setCoordinatorDepsForTest({
    signal: async () => null,
    models: () => ({ error: "No models in this test" }),
    agents: () => {
      throw new Error("No agents in this test");
    },
  });
});
afterEach(async () => {
  await __waitForCoordinatorForTest();
  __resetCoordinatorForTest();
  __setCoordinatorDepsForTest(undefined);
  __setProjectSettingsContextForTest(undefined);
  __setIncidentResponseRoutesForTest(undefined);
});

const call = async (
  method: string,
  path: string,
  body?: unknown,
  opts: { authUser?: RouteContext["authUser"]; signInRequired?: boolean } = {},
) => {
  const url = new URL(`http://localhost${path}`);
  const res = await handleIncidentResponseRoutes(
    {
      req: new Request(url, {
        method,
        body:
          body === undefined
            ? undefined
            : typeof body === "string"
              ? body
              : JSON.stringify(body),
      }),
      url,
      path: url.pathname,
      publicPrefix: "/backstage",
      authUser: "authUser" in opts ? opts.authUser : ADA,
    },
    () => opts.signInRequired ?? false,
  );
  return res ? { status: res.status, json: await res.json() } : undefined;
};

async function seed(
  shape: (c: Incident, at: string) => Incident,
): Promise<Incident> {
  const created = await createIncident({
    project: "acme",
    title: "Search",
    state: "investigating",
    severity: "major",
    owner: "Ada",
    openedBy: { kind: "rule" },
    signalIds: ["sig-a"],
    primarySignalId: "sig-a",
    at: new Date().toISOString(),
    detail: "Search failing",
  });
  const out = await updateIncident(created.id, (c) =>
    shape(c, new Date().toISOString()),
  );
  if (!out || "error" in out) throw new Error("seed failed");
  return out;
}

function moved(c: Incident, to: Incident["state"], at: string): Incident {
  const next = transitionIncident(c, to, { by: "sessions", detail: to, at });
  if ("error" in next) throw new Error(next.error);
  return next;
}

function seedIncidentInVeto(): Promise<Incident> {
  return seed((c, at) => {
    const r: IncidentResponse = {
      ...emptyResponse({ now: at, maxRounds: 2, phase: "veto" }),
      veto: {
        startedAt: at,
        deadline: new Date(Date.now() + 600_000).toISOString(),
      },
    };
    return { ...moved(moved(c, "fix-ready", at), "veto", at), response: r };
  });
}

const run = (over: Partial<AgentRun>): AgentRun => ({
  role: "investigator",
  round: 1,
  attempt: 1,
  sessionId: "child-1",
  model: "pi/anthropic/claude-opus-5-5",
  provider: "anthropic",
  workspace: { kind: "sandbox", provider: "daytona" },
  accessSummary: "Investigator · no connections · can edit acme",
  accessRevision: "r1",
  status: "done",
  startedAt: "2026-10-20T12:00:00.000Z",
  turnSentAt: "2026-10-20T12:00:00.000Z",
  costUsd: 1.5,
  tokens: 1000,
  reminded: false,
  ...over,
});

function seedIncidentWithAgents(): Promise<Incident> {
  return seed((c, at) => {
    const base = emptyResponse({ now: at, maxRounds: 2, phase: "verifying" });
    return {
      ...c,
      response: {
        ...base,
        agents: [
          run({}),
          run({
            role: "verifier",
            sessionId: "child-2",
            model: "pi/openai/gpt-6.1-sol",
            provider: "openai",
            independence: "other-provider",
            accessSummary: "Verifier · no connections · read only",
            status: "running",
          }),
        ],
        ledger: [
          {
            id: "led-1",
            at,
            actor: "sessions",
            kind: "agent-started",
            detail: "Investigator started on Opus 5.5, round 1",
            sessionId: "child-1",
          },
        ],
      },
    };
  });
}

test("settings round trip, redacted, attributed", async () => {
  const put = await call("PUT", "/api/incident-projects/acme", {
    autonomy: "propose",
    vetoMs: 300_000,
  });
  expect(put?.status).toBe(200);
  expect(put?.json).toMatchObject({
    autonomy: "propose",
    vetoMs: 300_000,
    updatedBy: "Ada",
    releaseHookPath: expect.stringMatching(
      /^\/incident-releases\/acme\/[0-9a-f]{48}$/,
    ),
  });
  expect(put?.json).not.toHaveProperty("releaseHookSecret");
  expect(
    (await call("PUT", "/api/incident-projects/acme", { autonomy: "yolo" }))
      ?.status,
  ).toBe(400);
  expect((await call("GET", "/api/incident-projects/globex"))?.status).toBe(
    404,
  );
  const got = await call("GET", "/api/incident-projects/acme");
  expect(got?.json).toMatchObject({
    settings: { autonomy: "propose" },
    runners: expect.any(Array),
    models: expect.any(Object),
    spend: {
      month: expect.stringMatching(/^\d{4}-\d{2}$/),
      monthUsd: 0,
      perMonthUsd: 200,
    },
  });
  const list = await call("GET", "/api/incident-projects");
  expect(
    list?.json.projects.map((p: { project: string }) => p.project),
  ).toEqual(["acme"]);
  expect(kit.audits).toContainEqual(
    expect.objectContaining({ kind: "incident_settings_updated", by: "Ada" }),
  );
});

test("a claimed user is never taken, and only a person changes actions or sees the hook", async () => {
  const anonymous = { authUser: null };
  const put = await call(
    "PUT",
    "/api/incident-projects/acme",
    { autonomy: "propose", user: "Mallory" },
    anonymous,
  );
  expect(put?.json).toMatchObject({ updatedBy: "Anonymous" });
  expect(put?.json).not.toHaveProperty("releaseHookPath");
  expect(
    await call(
      "PUT",
      "/api/incident-projects/acme",
      { productionRunners: ["runner-prod"], user: "Ada" },
      anonymous,
    ),
  ).toEqual({
    status: 400,
    json: {
      error: "Only a signed-in person can change actions or production Runners",
    },
  });
  expect(
    await call(
      "POST",
      "/api/incident-projects/acme/runner-pairing",
      {},
      anonymous,
    ),
  ).toEqual({
    status: 403,
    json: { error: "Only a signed-in person can pair a production Runner" },
  });
  const pairing = await call(
    "POST",
    "/api/incident-projects/acme/runner-pairing",
    {},
  );
  expect(pairing?.json).toMatchObject({
    code: expect.any(String),
    expiresAt: expect.any(Number),
    command: expect.stringContaining("opensession runner connect"),
  });
});

test("decisions need a verified sign-in when sign-in is on", async () => {
  const inc = await seedIncidentInVeto();
  expect(
    (
      await call(
        "POST",
        `/api/incidents/${inc.id}/decisions`,
        { decision: "stop" },
        { authUser: null, signInRequired: true },
      )
    )?.status,
  ).toBe(401);
  const stop = await call("POST", `/api/incidents/${inc.id}/decisions`, {
    decision: "stop",
  });
  expect(stop?.json).toMatchObject({
    state: "needs-you",
    response: { needsYou: { reason: "Stopped by Ada" } },
  });
  expect(
    (
      await call("POST", `/api/incidents/${inc.id}/decisions`, {
        decision: "dance",
      })
    )?.json,
  ).toEqual({ error: "Unknown decision" });
  expect(await call("POST", `/api/incidents/${inc.id}/decisions`, "{")).toEqual(
    { status: 400, json: { error: "Invalid JSON" } },
  );
  expect(
    (
      await call("POST", "/api/incidents/inc-missing/decisions", {
        decision: "close",
      })
    )?.status,
  ).toBe(404);
});

test("production decisions need a signed-in person, never a claimed name", async () => {
  const inc = await seedIncidentInVeto();
  expect(
    await call(
      "POST",
      `/api/incidents/${inc.id}/decisions`,
      { decision: "deploy-now", user: "Ada" },
      { authUser: null },
    ),
  ).toEqual({
    status: 403,
    json: { error: "Only a signed-in person can deploy, approve or roll back" },
  });
  expect(
    (
      await call(
        "POST",
        `/api/incidents/${inc.id}/decisions`,
        { decision: "deploy-now" },
        { authUser: { login: "bot", name: "Bot", automation: true } as never },
      )
    )?.status,
  ).toBe(403);
  // Stop is safe for anyone the API lets in, attributed without the claim.
  const stop = await call(
    "POST",
    `/api/incidents/${inc.id}/decisions`,
    { decision: "stop", user: "Mallory" },
    { authUser: null },
  );
  expect(stop?.json).toMatchObject({
    response: { needsYou: { reason: "Stopped by Anonymous" } },
  });
});

test("agent audit lists the ledger, each agent's access and its tool calls", async () => {
  __setIncidentResponseRoutesForTest({
    toolCalls: async (sessionId) =>
      sessionId === "child-1"
        ? [
            {
              at: "2026-10-20T12:01:00.000Z",
              tool: "bash",
              summary: "curl -sI https://acme.example.test/search",
            },
          ]
        : [],
  });
  const inc = await seedIncidentWithAgents();
  const audit = await call("GET", `/api/incidents/${inc.id}/agent-audit`);
  expect(audit?.json.agents).toEqual([
    expect.objectContaining({
      role: "investigator",
      access: "Investigator · no connections · can edit acme",
      workspaceLabel: "Runs in the daytona sandbox",
      toolCalls: [
        {
          at: expect.any(String),
          tool: "bash",
          summary: "curl -sI https://acme.example.test/search",
        },
      ],
    }),
    expect.objectContaining({
      role: "verifier",
      independenceLabel: "Verifier · different provider",
    }),
  ]);
  expect(audit?.json.ledger.length).toBeGreaterThan(0);
  const bare = await seed((c) => c);
  expect(
    (await call("GET", `/api/incidents/${bare.id}/agent-audit`))?.json,
  ).toEqual({ ledger: [], droppedLedger: 0, agents: [] });
});

test("other paths fall through", async () => {
  expect(await call("GET", "/api/incidents")).toBeUndefined();
  expect(await call("DELETE", "/api/incident-projects/acme")).toBeUndefined();
});

test("registered in the route chain after the incidents routes", () => {
  const at = routeHandlers.indexOf(handleIncidentsRoutes);
  expect(at).toBeGreaterThanOrEqual(0);
  expect(routeHandlers[at + 1]).toBe(handleIncidentResponseRoutes);
});
