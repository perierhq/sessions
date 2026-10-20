// The context every incident access tool receives: the calling session, its
// binding and the access re-resolved for this call, plus the audit helper
// that stamps every line with the incident, the role and the session.
import type {
  AgentAccess,
  IncidentAgentBinding,
} from "../../../shared/incident-access";
import { incidentAudit } from "../audit-sink";

export interface IncidentToolContext {
  sessionId: string;
  binding: IncidentAgentBinding;
  access: AgentAccess;
}

/** Audit one tool event. Callers never pass secrets, header values, bodies
 *  or URL query strings. */
export function toolAudit(
  ctx: IncidentToolContext,
  kind: string,
  fields: Record<string, unknown>,
): void {
  incidentAudit({
    kind,
    incident_id: ctx.binding.incidentId,
    incident_role: ctx.binding.role,
    session_id: ctx.sessionId,
    ...fields,
  });
}
