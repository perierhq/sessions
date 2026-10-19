/**
 * Which Open Session session declared an incident.io incident.
 *
 * A run that finds a production problem (a support-ticket triage, say) can
 * declare it with incident.io's `incident_create`. The incident responder that
 * starts next knows nothing about that run, so it redoes the investigation and
 * nobody in the incident channel sees the session that holds the evidence.
 * Three pieces close that gap:
 *
 * - {@link stampIncidentDeclaration}: every `incident_create` a run makes has
 *   the session's link appended to its summary, so people and the responder
 *   see where the incident came from (pi-runner.ts, via the MCP runtime).
 * - {@link createIncidentDeclarationScanner} + {@link recordIncidentDeclaration}:
 *   the server watches each run's tool stream for a successful
 *   `incident_create` and records incident → session in the catalog. That
 *   record, not the summary text, is what grants read access below, so an
 *   edited summary cannot point the responder at an arbitrary session.
 * - {@link declaringSessionFor}: the lookup behind the responder's
 *   `opensession-incident` tool (agents/slack/incident-tools.ts).
 *
 * Importing this module has no live effects.
 */

import { isMcpCallDispatcher } from "@tellahq/opensession-protocol/tool-presentation";

/** Line appended to a declared incident's summary. */
export const INCIDENT_DECLARED_FROM = "Declared from Open Session:";

const INCIDENT_CREATE = /(?:^|_)incident_create$/;
const INCIDENT_ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const INCIDENT_REFERENCE = /^#?INC-(\d+)$/i;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** True for an incident.io `incident_create` tool name, raw or server-prefixed. */
export function isIncidentCreateTool(name: string): boolean {
  return INCIDENT_CREATE.test(name);
}

/**
 * `incident_create` arguments with the declaring session's link appended to
 * the summary. Other tools, and a summary that already carries the link, pass
 * through unchanged.
 */
export function stampIncidentDeclaration(
  toolName: string,
  args: Record<string, unknown>,
  sessionLink: string | undefined,
): Record<string, unknown> {
  if (!sessionLink || !isIncidentCreateTool(toolName)) return args;
  const summary = typeof args.summary === "string" ? args.summary.trim() : "";
  if (summary.includes(sessionLink)) return args;
  const line = `${INCIDENT_DECLARED_FROM} ${sessionLink}`;
  return { ...args, summary: summary ? `${summary}\n\n${line}` : line };
}

/**
 * A catalog key for an incident: its ULID as-is, or `INC-<n>` for a
 * reference (with or without the leading `#`). Undefined for anything else.
 */
export function incidentKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  if (INCIDENT_ULID.test(v)) return v;
  const m = v.match(INCIDENT_REFERENCE);
  return m ? `INC-${m[1]}` : undefined;
}

export interface IncidentDeclaration {
  incidentId: string;
  reference?: string;
}

/**
 * Stateful scanner over one run's event stream. Returns the incident a
 * successful `incident_create` just declared, called directly or through the
 * `tool_call` dispatcher (`mcp_call` in older transcripts). A retry that
 * returned an existing incident (`already_existed`) and a failed call return
 * nothing.
 */
export function createIncidentDeclarationScanner(): (event: {
  type: string;
  toolUseId?: string;
  toolName?: string;
  toolInput?: unknown;
  content?: string;
  isError?: boolean;
}) => IncidentDeclaration | undefined {
  const pending = new Set<string>();
  return (event) => {
    if (event.type === "tool_use" && event.toolUseId) {
      const outer = event.toolName || "";
      const name = isMcpCallDispatcher(outer)
        ? String(record(event.toolInput).name ?? "")
        : outer;
      if (isIncidentCreateTool(name)) pending.add(event.toolUseId);
      return undefined;
    }
    if (event.type !== "tool_result" || !event.toolUseId) return undefined;
    if (!pending.delete(event.toolUseId) || event.isError) return undefined;
    const result = event.content || "";
    if (/"already_existed"\s*:\s*true/.test(result)) return undefined;
    // Lenient regexes rather than JSON.parse: the stream copy of a result can
    // be truncated, and the id sits near the head of incident.io's reply.
    const incidentId = result.match(
      /"id"\s*:\s*"([0-9A-HJKMNP-TV-Z]{26})"/,
    )?.[1];
    if (!incidentId) return undefined;
    const reference = incidentKey(
      result.match(/"reference"\s*:\s*"(#?INC-\d+)"/i)?.[1],
    );
    return { incidentId, ...(reference ? { reference } : {}) };
  };
}

interface StoredDeclaration {
  sessionId: string;
  incidentId: string;
  reference?: string;
  at: string;
}

async function store() {
  const { catalogDocuments } = await import("./catalog-documents");
  return catalogDocuments("incident-declarations");
}

/** Record that `sessionId` declared the incident. The first declarer wins. */
export async function recordIncidentDeclaration(
  sessionId: string,
  declaration: IncidentDeclaration,
): Promise<void> {
  const docs = await store();
  const value: StoredDeclaration = {
    sessionId,
    incidentId: declaration.incidentId,
    ...(declaration.reference ? { reference: declaration.reference } : {}),
    at: new Date().toISOString(),
  };
  for (const key of [declaration.incidentId, declaration.reference]) {
    if (key) await docs.update(key, (current) => current ?? value);
  }
}

/** The session that declared an incident (by ULID or INC reference), if any. */
export async function declaringSessionFor(
  incident: string,
): Promise<StoredDeclaration | null> {
  const key = incidentKey(incident);
  if (!key) return null;
  const value = record(await (await store()).get(key));
  return typeof value.sessionId === "string"
    ? (value as unknown as StoredDeclaration)
    : null;
}

/**
 * The incidents an automation run's triggering event names (`incident_id`,
 * `reference`), as catalog keys. This is the whole scope of the
 * responder's declaring-session tool: it answers only for these.
 */
export function incidentsInEvent(eventContext: string | undefined): string[] {
  if (!eventContext) return [];
  let payload: Record<string, unknown>;
  try {
    payload = record(JSON.parse(eventContext));
  } catch {
    return [];
  }
  const keys = [payload.incident_id, payload.reference]
    .map(incidentKey)
    .filter((k): k is string => !!k);
  return [...new Set(keys)];
}

/**
 * Scanner + recorder for one session's run: feed it every stream event and it
 * records each incident the session declares. Recording is fire-and-forget; a
 * failure is logged and never interrupts the run.
 */
export function createIncidentDeclarationRecorder(
  sessionId: string,
): (
  event: Parameters<ReturnType<typeof createIncidentDeclarationScanner>>[0],
) => void {
  const scan = createIncidentDeclarationScanner();
  return (event) => {
    const declared = scan(event);
    if (!declared) return;
    console.log(
      `[incidents] ${sessionId} declared ${declared.reference || declared.incidentId}`,
    );
    recordIncidentDeclaration(sessionId, declared).catch((error) =>
      console.error(
        `[incidents] recording ${declared.incidentId} for ${sessionId} failed:`,
        error,
      ),
    );
  };
}
