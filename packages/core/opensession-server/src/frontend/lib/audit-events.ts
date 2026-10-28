/**
 * Audit log events as the web UI reads them (Settings → Audit log, and a
 * credential's history in the Keychain): the loose schema they are parsed
 * with and the one-line summary a row shows.
 */
import { z } from "zod";

export const auditEventSchema = z.looseObject({
  tool_name: z.json().optional(),
  action: z.json().optional(),
  context: z.json().optional(),
  decision: z.json().optional(),
  account: z.json().optional(),
  model: z.json().optional(),
  ok: z.boolean().optional().catch(undefined),
  error: z.json().optional(),
  text_snippet: z.json().optional(),
  time: z.json().optional(),
  kind: z.json().optional(),
  msg: z.json().optional(),
  bks_session_id: z.string().optional().catch(undefined),
  session_id: z.string().optional().catch(undefined),
  run_kind: z.json().optional(),
  method: z.json().optional(),
  path: z.json().optional(),
  status: z.json().optional(),
  reason: z.json().optional(),
  requested_by: z.json().optional(),
});
export const auditEventsSchema = z.array(auditEventSchema);
export type AuditEvent = z.infer<typeof auditEventSchema>;

/** Summarize one audit event for its row (the details live in the expand). */
export function auditSummary(e: AuditEvent): string {
  const parts: string[] = [];
  if (e.tool_name) parts.push(String(e.tool_name));
  if (e.action) parts.push(`${e.context ? `${e.context}.` : ""}${e.action}`);
  if (e.method && e.path) parts.push(`${e.method} ${e.path}`);
  if (e.status !== undefined) parts.push(String(e.status));
  if (e.requested_by) parts.push(`by ${e.requested_by}`);
  if (e.decision) parts.push(`decision: ${e.decision}`);
  if (e.account) parts.push(`account: ${e.account}`);
  if (e.model) parts.push(String(e.model));
  if (e.ok !== undefined) parts.push(e.ok ? "ok" : "failed");
  if (e.error) parts.push(`error: ${String(e.error).slice(0, 80)}`);
  if (e.reason) parts.push(`refused: ${String(e.reason).slice(0, 80)}`);
  if (e.text_snippet) parts.push(`“${String(e.text_snippet).slice(0, 100)}”`);
  return parts.join(" · ");
}

/** The session an event belongs to, under either of its field names. */
export function auditSessionId(e: AuditEvent): string {
  return e.session_id ?? e.bks_session_id ?? "";
}
