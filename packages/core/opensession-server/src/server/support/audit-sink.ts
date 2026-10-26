// The audit sink every support write that must be on record goes through
// (replies, failed sends, forget-customer), with a test seam. The incidents
// audit-sink pattern, durable: a reply's row is on disk before the caller
// reports the send. Events carry digests, never customer text or addresses.
import { auditDurable } from "../audit";

export type SupportAuditSink = (
  event: Record<string, unknown>,
) => void | Promise<void>;

let sink: SupportAuditSink | undefined;

export async function supportAudit(
  event: Record<string, unknown>,
): Promise<void> {
  await (sink ?? auditDurable)(event);
}

/** Replace the sink (undefined restores `auditDurable`); returns the previous one. */
export function __setSupportAuditForTest(
  next: SupportAuditSink | undefined,
): SupportAuditSink | undefined {
  const previous = sink;
  sink = next;
  return previous;
}
