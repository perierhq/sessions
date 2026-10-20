// The audit sink every incident write and state change goes through, with a
// test seam. Events never carry header values, hook secrets or URL userinfo.
import { auditAsync } from "../audit";

export type AuditSink = (event: Record<string, unknown>) => void;

let sink: AuditSink | undefined;

export function incidentAudit(event: Record<string, unknown>): void {
  (sink ?? auditAsync)(event);
}

/** Replace the sink (undefined restores `auditAsync`); returns the previous one. */
export function __setIncidentAuditForTest(
  next: AuditSink | undefined,
): AuditSink | undefined {
  const previous = sink;
  sink = next;
  return previous;
}
