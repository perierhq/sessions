// "What would this agent be allowed to do": the tools an incident agent
// would see and the warnings worth showing beside its access. Resolution
// runs without audit; a refusal is returned as the preview's error.
import type {
  AccessMode,
  AccessPreview,
  AgentAccess,
  IncidentAccessSettings,
  IncidentAgentRole,
} from "../../../shared/incident-access";
import { INCIDENT_ACCESS_SERVER } from "../../../shared/incident-access";
import type { Incident, Signal } from "../../../shared/incidents";
import type { LOCAL_WORKSPACE_TOOL_IDS } from "../../run-policy";
import { type AccessEnvironment, loadAccessEnvironment } from "./environment";
import { incidentAccessToolDefinitions } from "./mcp";
import { accessSpawnSnapshot, resolveAgentAccess } from "./resolve";

type LocalTool = (typeof LOCAL_WORKSPACE_TOOL_IDS)[number];
const READ_TOOLS: LocalTool[] = ["read", "grep", "glob", "bash"];
const WRITE_TOOLS: LocalTool[] = ["write", "edit", "patch"];

export function localToolsFor(mode: AccessMode): string[] {
  return mode === "code" ? [...READ_TOOLS, ...WRITE_TOOLS] : [...READ_TOOLS];
}

export function previewTools(access: AgentAccess): string[] {
  const denied = (name: string) => name in access.deniedTools;
  const local = localToolsFor(access.mode).filter((name) => !denied(name));
  const incident = incidentAccessToolDefinitions({
    sessionId: "preview",
    binding: {
      incidentId: access.incidentId,
      role: access.role,
      signalId: access.signalId,
      accessRevision: access.revision,
      spawn: accessSpawnSnapshot(access),
    },
    access,
  })
    .map((t) => `mcp__${INCIDENT_ACCESS_SERVER}__${t.name}`)
    .filter((name) => !denied(name));
  const connections = access.connections.map((c) => `mcp__${c}__*`);
  return [...local, ...incident, ...connections];
}

export function accessWarnings(
  access: AgentAccess,
  env: AccessEnvironment,
  other?: AgentAccess | null,
): string[] {
  const warnings: string[] = [];
  if (!access.repos.length) warnings.push("This agent has no repo to work in");
  const runnerIds = [
    ...access.runners,
    ...access.hosts.map((h) => h.runner),
    ...(access.egress?.route === "runner" && access.egress.runner
      ? [access.egress.runner]
      : []),
  ];
  const seen = new Set<string>();
  for (const id of runnerIds) {
    const info = env.runner(id);
    const key = info?.id ?? id;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!info || !info.connected)
      warnings.push(`Runner ${info?.name ?? id} is offline`);
  }
  if (
    access.role === "verifier" &&
    other &&
    access.model &&
    other.model &&
    access.model === other.model
  )
    warnings.push("The verifier uses the same model as the investigator");
  for (const n of access.narrowed) warnings.push(`${n.reason}: ${n.item}`);
  return warnings;
}

export async function previewAccess(
  role: IncidentAgentRole,
  incident: Incident,
  signal: Signal | null,
  opts: { settings?: IncidentAccessSettings; gates: boolean },
): Promise<AccessPreview> {
  const resolve = (r: IncidentAgentRole) =>
    resolveAgentAccess(r, incident, signal, {
      ...(opts.settings ? { settings: opts.settings } : {}),
      gates: opts.gates,
      audit: false,
    });
  let access: AgentAccess;
  try {
    access = await resolve(role);
  } catch (error) {
    return {
      access: null,
      error:
        error instanceof Error ? error.message : "Access could not be resolved",
      tools: [],
      warnings: [],
    };
  }
  // The investigator is resolved only to compare models.
  const other =
    role === "verifier"
      ? await resolve("investigator").catch(() => null)
      : null;
  const env = await loadAccessEnvironment();
  return {
    access,
    tools: previewTools(access),
    warnings: accessWarnings(access, env, other),
  };
}
