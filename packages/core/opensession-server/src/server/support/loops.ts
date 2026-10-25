// Mail that must never start an agent or get a reply: auto-replies and
// other machine mail (RFC 3834 `Auto-Submitted`, `Precedence`), mailing-list
// posts (RFC 2369 / RFC 2919 list headers), bounces (null return path,
// mailer-daemon and postmaster senders), no-reply senders and our own mail.
// Pure; ingest records the verdict on the message.

import type { InboundMessage } from "../../shared/support";

const AUTOMATED_PRECEDENCE = new Set(["bulk", "list", "junk", "auto_reply"]);
const BOUNCE_SENDERS = new Set(["mailer-daemon", "postmaster"]);
const NO_REPLY_SENDERS = new Set([
  "noreply",
  "no-reply",
  "no_reply",
  "donotreply",
  "do-not-reply",
  "do_not_reply",
]);

export function isAutomatedMail(
  m: Pick<InboundMessage, "from" | "loopHeaders">,
  ownAddresses: string[],
): { automated: boolean; why: string | null } {
  const header = (name: string) => m.loopHeaders[name]?.trim().toLowerCase();
  const automated = (why: string) => ({ automated: true, why });

  const autoSubmitted = header("auto-submitted");
  if (autoSubmitted && autoSubmitted !== "no")
    return automated("Auto-Submitted");
  const precedence = header("precedence");
  if (precedence && AUTOMATED_PRECEDENCE.has(precedence))
    return automated("Precedence");
  if (header("list-id")) return automated("List-Id");
  if (header("list-unsubscribe")) return automated("List-Unsubscribe");
  if (header("x-autoreply")) return automated("X-Autoreply");
  if (header("return-path")?.replace(/\s+/g, "") === "<>")
    return automated("Return-Path");

  const address = m.from.address.trim().toLowerCase();
  if (ownAddresses.some((own) => own.trim().toLowerCase() === address))
    return automated("Own address");
  const local = address.slice(0, address.lastIndexOf("@"));
  if (BOUNCE_SENDERS.has(local)) return automated("Bounce sender");
  if (NO_REPLY_SENDERS.has(local)) return automated("No-reply sender");
  return { automated: false, why: null };
}
