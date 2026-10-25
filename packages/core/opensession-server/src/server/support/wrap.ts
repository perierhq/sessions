// The data wrapper: how a support message reaches a model. Customer text
// only ever appears inside <customer_email>, our sent mail inside
// <our_reply>, and no text inside either can open or close one, or a
// context fence. Shared by routing (the opening prompt, deliveries) and the
// support MCP server (get_conversation). Nothing runs at import.

import type { SupportMessage } from "../../shared/support";
import { neutralizeContextSentinels } from "../prompt-context";

/** Compatibility forms folded (full-width `＜` is `<`) and invisible format
 *  characters (zero-width space, joiners, bidi marks) dropped, so what the
 *  escaping below sees is what a model reads. */
function fold(text: string): string {
  return text.normalize("NFKC").replace(/\p{Cf}/gu, "");
}

/** An attribute value: one line, quotes and angle brackets as entities. */
export function wrapAttribute(value: string): string {
  return neutralizeContextSentinels(fold(value))
    .replace(/\s+/g, " ")
    .trim()
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .slice(0, 500);
}

/** Body text: context fences made inert, and every spelling of a wrapper
 *  tag (any case, spaces, attributes) loses its `<`, so text can neither
 *  open nor close one. */
function body(text: string | null): string {
  if (text === null) return "(Removed by retention)";
  return neutralizeContextSentinels(fold(text)).replace(
    /<(\s*\/?\s*(?:customer_email|our_reply)\b)/gi,
    "&lt;$1",
  );
}

/** A customer's message as untrusted data for a model. */
export function wrapCustomerMessage(m: SupportMessage): string {
  const name = m.from.name ? ` name="${wrapAttribute(m.from.name)}"` : "";
  return (
    `<customer_email from="${wrapAttribute(m.from.address)}"${name} subject="${wrapAttribute(m.subject)}" at="${wrapAttribute(m.at)}">\n` +
    `${body(m.text)}\n</customer_email>`
  );
}

/** A message we sent. It may quote the customer, so it is wrapped too. */
function wrapOurMessage(m: SupportMessage): string {
  return (
    `<our_reply from="${wrapAttribute(m.from.address)}" subject="${wrapAttribute(m.subject)}" at="${wrapAttribute(m.at)}">\n` +
    `${body(m.text)}\n</our_reply>`
  );
}

/** Any stored message, wrapped by direction. */
export function wrapSupportMessage(m: SupportMessage): string {
  return m.direction === "in" ? wrapCustomerMessage(m) : wrapOurMessage(m);
}
