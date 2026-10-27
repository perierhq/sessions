import { describe, expect, test } from "bun:test";
import type { RunPlace } from "../../shared/project-settings";
import {
  ALL_READY,
  BLOCKED_NO_SANDBOX,
  READY_4_OF_6,
} from "../../shared/project-settings-fixtures";
import type { RoleModels } from "../incidents/response/models";
import {
  computeReadiness,
  type ConnectorState,
  type ReadinessInput,
} from "./readiness";

const MODELS: RoleModels = {
  investigator: {
    model: "pi/anthropic/claude-opus-5-5",
    provider: "anthropic",
    label: "Opus 5.5",
  },
  verifier: {
    model: "pi/openai/gpt-5.5",
    provider: "openai",
    label: "GPT-5.5",
    independence: "other-provider",
  },
};

const CONNECTORS: ConnectorState[] = [
  {
    server: "linear",
    label: "Linear",
    status: "ok",
    allowedUsers: 0,
    allowUnattended: false,
  },
  {
    server: "sentry",
    label: "Sentry",
    status: "ok",
    allowedUsers: 0,
    allowUnattended: false,
  },
  {
    server: "grafana",
    label: "Grafana",
    status: "ok",
    allowedUsers: 2,
    allowUnattended: false,
  },
];

function input(over: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    doc: READY_4_OF_6.document,
    models: MODELS,
    incidentWorkspace: READY_4_OF_6.effective.sandbox.incidentAgents,
    runnerProblems: { "rn-prod-eu-1": null },
    runners: { "rn-prod-eu-1": { name: "prod-eu-1" } },
    signalCount: 2,
    connectors: CONNECTORS,
    ...over,
  };
}

const allowed = CONNECTORS.map((c) =>
  c.server === "grafana" ? { ...c, allowUnattended: true } : c,
);

describe("computeReadiness", () => {
  test("4 of 6 ready: rollback and Grafana to do first, then the ready steps", () => {
    const r = computeReadiness(input());
    expect(r.readyCount).toBe(4);
    expect(r.steps.map((s) => s.id)).toEqual([
      "deploy",
      "access",
      "models",
      "where",
      "production",
      "signals",
    ]);
    expect(r.steps[0]?.title).toBe("Rollback");
    expect(r.steps[1]?.title).toBe("Logs for agents");
    expect(r).toEqual(READY_4_OF_6.readiness);
  });

  test("no sandbox for incident agents blocks the project", () => {
    const r = computeReadiness(
      input({
        doc: BLOCKED_NO_SANDBOX.document,
        incidentWorkspace: BLOCKED_NO_SANDBOX.effective.sandbox.incidentAgents,
      }),
    );
    expect(r.blocking?.id).toBe("where");
    expect(r.status.kind).toBe("blocked");
    expect(r).toEqual(BLOCKED_NO_SANDBOX.readiness);
  });

  test("every step ready", () => {
    const r = computeReadiness(
      input({
        doc: ALL_READY.document,
        incidentWorkspace: ALL_READY.effective.sandbox.incidentAgents,
        connectors: allowed,
      }),
    );
    expect(r).toEqual(ALL_READY.readiness);
  });

  test("paused agents block an otherwise ready project", () => {
    const doc = {
      ...ALL_READY.document,
      incidents: { ...ALL_READY.document.incidents, agentsPaused: true },
    };
    const r = computeReadiness(
      input({
        doc,
        incidentWorkspace: ALL_READY.effective.sandbox.incidentAgents,
        connectors: allowed,
      }),
    );
    expect(r.readyCount).toBe(6);
    expect(r.blocking).toEqual({
      id: "paused",
      state: "blocked",
      title: "Agents are paused",
      detail:
        "Every incident run for acme-web is stopped. Signals keep checking",
      fix: { kind: "unpause" },
    });
    expect(r.status).toEqual({ kind: "blocked", label: "Can't start" });
    expect(r.steps.some((s) => s.id === "paused")).toBe(false);
  });

  test("no signals is incidents off", () => {
    const r = computeReadiness(input({ signalCount: 0 }));
    expect(r.status).toEqual({ kind: "off", label: "Incidents off" });
    expect(r.steps.find((s) => s.id === "signals")).toMatchObject({
      state: "todo",
      fix: { kind: "add-signal" },
    });
  });

  test("a model error blocks with the providers fix", () => {
    const r = computeReadiness(input({ models: { error: "none" } }));
    expect(r.blocking).toEqual({
      id: "models",
      state: "blocked",
      title: "Models",
      detail: "No model provider is configured for incident agents",
      fix: { kind: "providers" },
    });
  });

  test("production: no runner, or every runner with a problem, is to do", () => {
    const none = computeReadiness(
      input({
        doc: {
          ...READY_4_OF_6.document,
          production: { runners: [], actions: [], releases: [] },
        },
      }),
    );
    expect(none.steps.find((s) => s.id === "production")).toMatchObject({
      state: "todo",
      title: "Production",
      fix: { kind: "pair-runner" },
    });
    const offline = computeReadiness(
      input({ runnerProblems: { "rn-prod-eu-1": "prod-eu-1 is offline" } }),
    );
    expect(offline.steps.find((s) => s.id === "production")).toEqual({
      id: "production",
      state: "todo",
      title: "Production",
      detail: "prod-eu-1 is offline",
      fix: { kind: "pair-runner" },
    });
  });

  test("deploy: both missing, or only deploy missing", () => {
    const both = computeReadiness(
      input({
        doc: {
          ...READY_4_OF_6.document,
          production: { ...READY_4_OF_6.document.production, actions: [] },
        },
      }),
    );
    expect(both.steps.find((s) => s.id === "deploy")).toMatchObject({
      state: "todo",
      title: "Deploy and rollback",
      fix: { kind: "add-action", action: "deploy" },
    });
    const rollbackOnly = ALL_READY.document.production.actions.filter(
      (a) => a.kind === "rollback",
    );
    const deployMissing = computeReadiness(
      input({
        doc: {
          ...READY_4_OF_6.document,
          production: {
            ...READY_4_OF_6.document.production,
            actions: rollbackOnly,
          },
        },
      }),
    );
    expect(deployMissing.steps.find((s) => s.id === "deploy")).toMatchObject({
      state: "todo",
      title: "Deploy",
      fix: { kind: "add-action", action: "deploy" },
    });
  });

  test("a broken connector ticked for agents is to do; one only You use is not", () => {
    const broken = computeReadiness(
      input({
        connectors: allowed.map((c) =>
          c.server === "sentry" ? { ...c, status: "error" as const } : c,
        ),
      }),
    );
    expect(broken.steps.find((s) => s.id === "access")).toMatchObject({
      state: "todo",
      title: "Errors for agents",
    });
    const unticked = computeReadiness(
      input({
        doc: {
          ...READY_4_OF_6.document,
          access: {
            ...READY_4_OF_6.document.access,
            connections: [{ server: "grafana", roles: [] }],
          },
        },
      }),
    );
    expect(unticked.steps.find((s) => s.id === "access")?.state).toBe("ready");
  });

  test("a ticked connector whose sign-in expired asks for a reconnect", () => {
    const expired = computeReadiness(
      input({
        connectors: allowed.map((c) =>
          c.server === "sentry" ? { ...c, signInExpired: true } : c,
        ),
      }),
    );
    expect(expired.steps.find((s) => s.id === "access")).toMatchObject({
      state: "todo",
      title: "Errors for agents",
      detail:
        "Sentry's sign-in expired, so agents can't open it. A person needs to reconnect it",
      fix: { kind: "reconnect", server: "sentry" },
    });
  });

  test("a sandbox provider that isn't set up blocks the project, with the reason", () => {
    const place: RunPlace = {
      state: "not-ready",
      provider: "modal",
      label: "Modal",
      source: "project",
      reason: "Modal isn't connected",
    };
    const r = computeReadiness(input({ incidentWorkspace: place }));
    expect(r.blocking?.id).toBe("where");
    expect(r.steps.find((s) => s.id === "where")).toEqual({
      id: "where",
      state: "blocked",
      title: "Where agents run",
      detail: "Modal isn't connected, so incident agents can't start",
      fix: { kind: "connect-sandbox" },
    });
  });

  test("an ok workspace on this machine without a sandbox reads plainly", () => {
    const place: RunPlace = {
      state: "ok",
      provider: null,
      label: "This machine",
      source: "fallback",
    };
    const r = computeReadiness(input({ incidentWorkspace: place }));
    expect(r.steps.find((s) => s.id === "where")?.detail).toBe(
      "Incident agents run on this machine",
    );
  });
});
