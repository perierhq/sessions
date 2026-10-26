import { expect, test } from "bun:test";
import type { MailAddress } from "../../shared/support";
import { isAutomatedMail } from "./loops";

const INBOX = "help@acme.example.test";
const OWN = [INBOX, "sales@acme.example.test"];
/** What Google Groups adds to a collaborative inbox's mail. */
const OWN_GROUP = {
  "list-id": "Help desk <help.acme.example.test>",
  "list-unsubscribe": "<mailto:googlegroups-manage+1+unsubscribe@example.test>",
  precedence: "list",
};
const customer: MailAddress = { name: "Ada", address: "ada@example.test" };

function from(address: string): MailAddress {
  return { name: null, address };
}

test.each<[string, MailAddress, Record<string, string>, string | null]>([
  [
    "auto-replied",
    customer,
    { "auto-submitted": "auto-replied" },
    "Auto-Submitted",
  ],
  [
    "auto-generated",
    customer,
    { "auto-submitted": "auto-generated" },
    "Auto-Submitted",
  ],
  ["auto-submitted: no", customer, { "auto-submitted": "no" }, null],
  ["auto-submitted: No (case)", customer, { "auto-submitted": " No " }, null],
  [
    "auto-submitted: no; params",
    customer,
    { "auto-submitted": "no; x=y" },
    null,
  ],
  [
    "auto-submitted: no (comment)",
    customer,
    { "auto-submitted": "no (sent by a person)" },
    null,
  ],
  [
    "auto-submitted: auto-replied; params",
    customer,
    { "auto-submitted": "auto-replied; owner-email=x@example.test" },
    "Auto-Submitted",
  ],
  [
    "x-auto-response-suppress: All",
    customer,
    { "x-auto-response-suppress": "All" },
    "X-Auto-Response-Suppress",
  ],
  [
    "x-auto-response-suppress: list with OOF",
    customer,
    { "x-auto-response-suppress": "DR, oof, RN" },
    "X-Auto-Response-Suppress",
  ],
  [
    "x-auto-response-suppress: AutoReply",
    customer,
    { "x-auto-response-suppress": "AUTOREPLY" },
    "X-Auto-Response-Suppress",
  ],
  [
    "x-auto-response-suppress: receipts only",
    customer,
    { "x-auto-response-suppress": "DR, RN, NRN" },
    null,
  ],
  ["precedence bulk", customer, { precedence: "bulk" }, "Precedence"],
  ["precedence list", customer, { precedence: "list" }, "Precedence"],
  ["precedence junk", customer, { precedence: "junk" }, "Precedence"],
  [
    "precedence auto_reply",
    customer,
    { precedence: "auto_reply" },
    "Precedence",
  ],
  ["precedence normal", customer, { precedence: "normal" }, null],
  ["list-id", customer, { "list-id": "<news.acme.example.test>" }, "List-Id"],
  [
    "list-unsubscribe",
    customer,
    { "list-unsubscribe": "<mailto:u@example.test>" },
    "List-Unsubscribe",
  ],
  ["x-autoreply", customer, { "x-autoreply": "yes" }, "X-Autoreply"],
  ["null return-path", customer, { "return-path": "<>" }, "Return-Path"],
  [
    "return-path with address",
    customer,
    { "return-path": "<ada@example.test>" },
    null,
  ],
  ["mailer-daemon", from("MAILER-DAEMON@example.test"), {}, "Bounce sender"],
  [
    "mailer-daemon without a domain",
    from("mailer-daemon"),
    {},
    "Bounce sender",
  ],
  ["postmaster without a domain", from("Postmaster"), {}, "Bounce sender"],
  ["postmaster", from("postmaster@mx.example.test"), {}, "Bounce sender"],
  ["noreply", from("noreply@shop.example.test"), {}, "No-reply sender"],
  ["no-reply", from("no-reply@shop.example.test"), {}, "No-reply sender"],
  [
    "do-not-reply",
    from("do-not-reply@shop.example.test"),
    {},
    "No-reply sender",
  ],
  ["own address, any case", from("Help@Acme.Example.Test"), {}, "Own address"],
  ["another own address", from("sales@acme.example.test"), {}, "Own address"],
  ["the inbox's own group (Google Groups)", customer, OWN_GROUP, null],
  [
    "a list named by the inbox's domain",
    customer,
    { "list-id": "<acme.example.test>", precedence: "list" },
    null,
  ],
  [
    "the inbox's own group, but bulk",
    customer,
    { ...OWN_GROUP, precedence: "bulk" },
    "Precedence",
  ],
  [
    "the inbox's own group, but an auto-reply",
    customer,
    { ...OWN_GROUP, "auto-submitted": "auto-replied" },
    "Auto-Submitted",
  ],
  [
    "a list whose id only ends like the inbox",
    customer,
    { "list-id": "<xhelp.acme.example.test>" },
    "List-Id",
  ],
  [
    "list-unsubscribe without the inbox's list id",
    customer,
    { "list-unsubscribe": "<mailto:u@example.test>", precedence: "list" },
    "Precedence",
  ],
  ["plain customer mail", customer, {}, null],
  [
    "customer whose name mentions noreply",
    from("noreplyfan@example.test"),
    {},
    null,
  ],
])("%s", (_label, sender, loopHeaders, why) => {
  expect(isAutomatedMail({ from: sender, loopHeaders }, OWN, INBOX)).toEqual({
    automated: why !== null,
    why,
  });
});
