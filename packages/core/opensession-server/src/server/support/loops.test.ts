import { expect, test } from "bun:test";
import type { MailAddress } from "../../shared/support";
import { isAutomatedMail } from "./loops";

const OWN = ["help@acme.example.test"];
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
  ["plain customer mail", customer, {}, null],
  [
    "customer whose name mentions noreply",
    from("noreplyfan@example.test"),
    {},
    null,
  ],
])("%s", (_label, sender, loopHeaders, why) => {
  expect(isAutomatedMail({ from: sender, loopHeaders }, OWN)).toEqual({
    automated: why !== null,
    why,
  });
});
