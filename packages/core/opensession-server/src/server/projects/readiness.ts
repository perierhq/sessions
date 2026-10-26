// The project page's readiness checklist: six steps in a fixed order
// (models, where agents run, production, signals, deploy and rollback,
// what agents may use), computed from plain data so the routes can build it
// from whatever stores they read. Pure: no I/O, no imports with side
// effects. Paused agents are a blocking problem, never a seventh step.

import {
  READINESS_STEP_IDS,
  READINESS_TOTAL,
  UNATTENDED_ROLES,
  projectStatusLabel,
  type ProjectReadiness,
  type ProjectSettingsDocument,
  type ReadinessStep,
  type ReadinessStepId,
  type RunPlace,
} from "../../shared/project-settings";
import type { RoleModels } from "../incidents/response/models";

/** What the server knows about one MCP connector, for the checklist and
 *  the access table. */
export interface ConnectorState {
  server: string;
  label: string;
  status: "ok" | "error";
  /** How many people the connector is limited to; 0 is everyone. */
  allowedUsers: number;
  /** Runs without a person may use it despite `allowedUsers`. */
  allowUnattended: boolean;
  /** Its workspace sign-in expired and can't be refreshed: a person has to
   *  reconnect it. */
  signInExpired?: boolean;
}

export type ReadinessDocument = Pick<
  ProjectSettingsDocument,
  "project" | "sandbox" | "incidents" | "production" | "access"
>;

export interface ReadinessInput {
  doc: ReadinessDocument;
  models: RoleModels | { error: string };
  /** Where incident agents run, or why they can't start. */
  incidentWorkspace: RunPlace;
  /** Each production Runner's problem, `null` when it is usable. */
  runnerProblems: Record<string, string | null>;
  /** Runner names by id, for the step details. */
  runners?: Record<string, { name: string }>;
  signalCount: number;
  connectors: ConnectorState[];
  /** How the project's own sandbox choice reads mid-sentence, when it is a
   *  provider id ("Daytona eu"). */
  sandboxLabel?: string;
}

/** The kind of data a connector gives agents, for the step title. */
const CONNECTOR_CATEGORY: Record<string, string> = {
  grafana: "Logs",
  loki: "Logs",
  datadog: "Logs",
  sentry: "Errors",
};

export type ConnectorProblem =
  | { kind: "limited"; people: number }
  | { kind: "signin-expired" }
  | { kind: "error" };

/** Why agents can't open a connector ticked for them, or `null`. A
 *  connector the server doesn't know counts as not connected. */
export function connectorProblem(
  state: ConnectorState | undefined,
): ConnectorProblem | null {
  if (!state || state.status !== "ok") return { kind: "error" };
  if (state.allowedUsers > 0 && !state.allowUnattended) {
    return { kind: "limited", people: state.allowedUsers };
  }
  if (state.signInExpired) return { kind: "signin-expired" };
  return null;
}

export function peopleCount(n: number): string {
  return n === 1 ? "1 person" : `${n} people`;
}

function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function runnerName(input: ReadinessInput, id: string): string {
  return input.runners?.[id]?.name ?? id;
}

/** How a project's sandbox choice reads mid-sentence. */
function sandboxPhrase(input: ReadinessInput): string {
  const choice = input.doc.sandbox;
  if (choice === "local") return "this machine";
  if (choice === "podman") return "this machine in a container";
  if (choice === "default") return "the global default";
  return input.sandboxLabel ?? choice;
}

function wherePhrase(place: Extract<RunPlace, { state: "ok" }>): string {
  if (place.provider === "podman") return "on this machine in a container";
  if (place.provider === null) return "on this machine";
  return `in ${place.label}`;
}

function modelsStep(input: ReadinessInput): ReadinessStep {
  if ("error" in input.models) {
    return {
      id: "models",
      state: "blocked",
      title: "Models",
      detail: "No model provider is configured for incident agents",
      fix: { kind: "providers" },
    };
  }
  const { investigator, verifier } = input.models;
  return {
    id: "models",
    state: "ready",
    title: "Models",
    detail: `${investigator.label} investigates, ${verifier.label} verifies`,
  };
}

function whereStep(input: ReadinessInput): ReadinessStep {
  const place = input.incidentWorkspace;
  if (place.state === "cant-start") {
    return {
      id: "where",
      state: "blocked",
      title: "Where agents run",
      detail: `${input.doc.project} uses ${sandboxPhrase(input)}, which can't run incident agents, and no sandbox provider is connected for them to fall back to`,
      fix: { kind: "connect-sandbox" },
    };
  }
  return {
    id: "where",
    state: "ready",
    title: "Where agents run",
    detail: `Incident agents run ${wherePhrase(place)}`,
  };
}

function productionStep(input: ReadinessInput): ReadinessStep {
  const runners = input.doc.production.runners;
  const usable = runners.filter((id) => !input.runnerProblems[id]);
  if (usable.length > 0) {
    const names = usable.map((id) => runnerName(input, id));
    return {
      id: "production",
      state: "ready",
      title: "Production",
      detail: `${listNames(names)} ${names.length === 1 ? "is" : "are"} online`,
    };
  }
  const problem = runners
    .map((id) => input.runnerProblems[id])
    .find((p): p is string => !!p);
  return {
    id: "production",
    state: "todo",
    title: "Production",
    detail:
      problem ??
      "Pair a production Runner so agents can check production and ship a fix",
    fix: { kind: "pair-runner" },
  };
}

function signalsStep(input: ReadinessInput): ReadinessStep {
  const n = input.signalCount;
  const project = input.doc.project;
  if (n === 0) {
    return {
      id: "signals",
      state: "todo",
      title: "Signals",
      detail: `No signal checks ${project}, so incidents never open`,
      fix: { kind: "add-signal" },
    };
  }
  return {
    id: "signals",
    state: "ready",
    title: "Signals",
    detail:
      n === 1 ? `1 signal checks ${project}` : `${n} signals check ${project}`,
  };
}

function deployStep(input: ReadinessInput): ReadinessStep {
  const actions = input.doc.production.actions;
  const deploy = actions.find((a) => a.kind === "deploy");
  const rollback = actions.find((a) => a.kind === "rollback");
  if (!deploy && !rollback) {
    return {
      id: "deploy",
      state: "todo",
      title: "Deploy and rollback",
      detail: "Agents can't ship a fix or undo one until both are set",
      fix: { kind: "add-action", action: "deploy" },
    };
  }
  if (!rollback) {
    return {
      id: "deploy",
      state: "todo",
      title: "Rollback",
      detail: "Deploy is set. Without a rollback, a bad fix stays live",
      fix: { kind: "add-action", action: "rollback" },
    };
  }
  if (!deploy) {
    return {
      id: "deploy",
      state: "todo",
      title: "Deploy",
      detail: "Rollback is set. Without a deploy, agents can't ship a fix",
      fix: { kind: "add-action", action: "deploy" },
    };
  }
  const detail =
    deploy.runner === rollback.runner
      ? `Both run on ${runnerName(input, deploy.runner)}`
      : `Deploy runs on ${runnerName(input, deploy.runner)}, rollback on ${runnerName(input, rollback.runner)}`;
  return { id: "deploy", state: "ready", title: "Deploy and rollback", detail };
}

function accessStep(input: ReadinessInput): ReadinessStep {
  const byServer = new Map(input.connectors.map((c) => [c.server, c]));
  for (const row of input.doc.access.connections) {
    const ticked = row.roles.some((r) =>
      (UNATTENDED_ROLES as readonly string[]).includes(r),
    );
    if (!ticked) continue;
    const state = byServer.get(row.server);
    const problem = connectorProblem(state);
    if (!problem) continue;
    const label = state?.label ?? row.server;
    const title = `${CONNECTOR_CATEGORY[row.server] ?? label} for agents`;
    if (problem.kind === "limited") {
      return {
        id: "access",
        state: "todo",
        title,
        detail: `${label} is limited to ${peopleCount(problem.people)}, so agents can't open it`,
        fix: { kind: "allow-agents", server: row.server },
      };
    }
    if (problem.kind === "signin-expired") {
      return {
        id: "access",
        state: "todo",
        title,
        detail: `${label}'s sign-in expired, so agents can't open it. A person needs to reconnect it`,
        fix: { kind: "reconnect", server: row.server },
      };
    }
    return {
      id: "access",
      state: "todo",
      title,
      detail: `${label} isn't connected, so agents can't open it`,
    };
  }
  return {
    id: "access",
    state: "ready",
    title: "What agents may use",
    detail: "Every connector ticked for agents can be opened",
  };
}

const STEP_BUILDERS: Record<
  ReadinessStepId,
  (input: ReadinessInput) => ReadinessStep
> = {
  models: modelsStep,
  where: whereStep,
  production: productionStep,
  signals: signalsStep,
  deploy: deployStep,
  access: accessStep,
};

const STATE_ORDER: Record<ReadinessStep["state"], number> = {
  blocked: 0,
  todo: 1,
  ready: 2,
};

export function computeReadiness(input: ReadinessInput): ProjectReadiness {
  const inOrder = READINESS_STEP_IDS.map((id) => STEP_BUILDERS[id](input));
  // Problems first, then the ready steps; each group keeps the fixed order
  // (Array.prototype.sort is stable).
  const steps = [...inOrder].sort(
    (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state],
  );
  const readyCount = steps.filter((s) => s.state === "ready").length;
  const blocking =
    steps.find((s) => s.state === "blocked") ??
    (input.doc.incidents.agentsPaused
      ? ({
          id: "paused",
          state: "blocked",
          title: "Agents are paused",
          detail: `Every incident run for ${input.doc.project} is stopped. Signals keep checking`,
          fix: { kind: "unpause" },
        } satisfies ReadinessStep)
      : null);
  return {
    steps,
    readyCount,
    total: READINESS_TOTAL,
    blocking,
    status: projectStatusLabel({ readyCount, blocking }, input.signalCount > 0),
  };
}
