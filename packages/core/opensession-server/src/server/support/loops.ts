// Mail that must never start an agent or get a reply: auto-replies and
// other machine mail (RFC 3834 `Auto-Submitted`, `Precedence`, Exchange's
// `X-Auto-Response-Suppress`), mailing-list posts (RFC 2369 / RFC 2919 list
// headers), bounces (null return path, mailer-daemon and postmaster
// senders), no-reply senders and our own mail. A list that is the inbox
// itself (a Google Group or collaborative inbox, whose List-Id names the
// inbox's address or domain) is not a mailing list for this purpose.
// Pure; ingest records the verdict on the message.

import type { InboundMessage } from "../../shared/support";

const AUTOMATED_PRECEDENCE = new Set(["bulk", "list", "junk", "auto_reply"]);
/** Values that ask other systems not to auto-reply: the sender is one. */
const SUPPRESSING_RESPONSES = new Set(["all", "oof", "autoreply"]);
const BOUNCE_SENDERS = new Set(["mailer-daemon", "postmaster"]);
const NO_REPLY_SENDERS = new Set([
  "noreply",
  "no-reply",
  "no_reply",
  "donotreply",
  "do-not-reply",
  "do_not_reply",
]);

/** The List-Id ids (RFC 2919 `phrase <id>`) that name the inbox itself:
 *  Google Groups uses `<local.domain>` for the group `local@domain`. */
function ownListIds(inboxAddress: string): Set<string> {
  const address = inboxAddress.trim().toLowerCase();
  const at = address.lastIndexOf("@");
  if (at < 0) return new Set([address]);
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  return new Set([`${local}.${domain}`, address, domain]);
}

function listIdOf(value: string): string {
  const bracketed = /<([^>]*)>/.exec(value);
  return (bracketed ? bracketed[1]! : value).trim().toLowerCase();
}

export function isAutomatedMail(
  m: Pick<InboundMessage, "from" | "loopHeaders">,
  ownAddresses: string[],
  inboxAddress: string,
): { automated: boolean; why: string | null } {
  const header = (name: string) => m.loopHeaders[name]?.trim().toLowerCase();
  const automated = (why: string) => ({ automated: true, why });

  // RFC 3834: only the keyword counts, not its parameters or comments.
  const autoSubmitted = header("auto-submitted")?.split(/[\s;(]/, 1)[0];
  if (autoSubmitted && autoSubmitted !== "no")
    return automated("Auto-Submitted");
  const suppress = header("x-auto-response-suppress");
  if (suppress?.split(",").some((v) => SUPPRESSING_RESPONSES.has(v.trim())))
    return automated("X-Auto-Response-Suppress");

  const listId = header("list-id");
  const ownList =
    listId !== undefined && ownListIds(inboxAddress).has(listIdOf(listId));
  const precedence = header("precedence");
  if (
    precedence &&
    AUTOMATED_PRECEDENCE.has(precedence) &&
    !(ownList && precedence === "list")
  )
    return automated("Precedence");
  if (listId && !ownList) return automated("List-Id");
  if (header("list-unsubscribe") && !ownList)
    return automated("List-Unsubscribe");
  if (header("x-autoreply")) return automated("X-Autoreply");
  if (header("return-path")?.replace(/\s+/g, "") === "<>")
    return automated("Return-Path");

  const address = m.from.address.trim().toLowerCase();
  if (
    [inboxAddress, ...ownAddresses].some(
      (own) => own.trim().toLowerCase() === address,
    )
  )
    return automated("Own address");
  const at = address.lastIndexOf("@");
  const local = at < 0 ? address : address.slice(0, at);
  if (BOUNCE_SENDERS.has(local)) return automated("Bounce sender");
  if (NO_REPLY_SENDERS.has(local)) return automated("No-reply sender");
  return { automated: false, why: null };
}
