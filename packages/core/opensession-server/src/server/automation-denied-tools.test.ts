import { describe, expect, test } from "bun:test";
import {
  AUTOMATION_DENIED_TOOLS,
  SUPPORT_DENIED_TOOLS,
} from "./automation-denied-tools";
import { STRIPE_CONFIRM_TOOLS } from "./runner-shared";
import { REACH_TOOLS } from "./turn-outcome";

describe("the support deny-set", () => {
  test("keeps everything an automation run is denied", () => {
    for (const name of Object.keys(AUTOMATION_DENIED_TOOLS))
      expect(SUPPORT_DENIED_TOOLS[name]).toBeDefined();
  });

  test("denies every tool that reaches someone outside the run", () => {
    expect(REACH_TOOLS.length).toBeGreaterThan(0);
    for (const name of REACH_TOOLS)
      expect(SUPPORT_DENIED_TOOLS[name]).toBeDefined();
    // Spelled out, so a shrinking reach list can't quietly reopen them.
    for (const name of [
      "mcp__slack__slack_post_message",
      "mcp__slack__slack_reply_to_thread",
      "mcp__linear__save_issue",
      "mcp__linear__save_comment",
      "mcp__plain__create_note",
      "mcp__plain__reply_to_thread",
      "mcp__gmail__send_email",
    ])
      expect(SUPPORT_DENIED_TOOLS[name]).toBeDefined();
  });

  test("denies every Stripe tool that moves money or writes to the account", () => {
    for (const name of Object.keys(STRIPE_CONFIRM_TOOLS))
      expect(SUPPORT_DENIED_TOOLS[name]).toBeDefined();
    for (const name of [
      "mcp__stripe__create_payment_link",
      "mcp__stripe__create_coupon",
      "mcp__stripe__create_invoice",
      "mcp__stripe__create_invoice_item",
      "mcp__stripe__finalize_invoice",
      "mcp__stripe__create_customer",
      "mcp__stripe__create_product",
      "mcp__stripe__create_price",
      "mcp__stripe__update_dispute",
    ])
      expect(SUPPORT_DENIED_TOOLS[name]).toBeDefined();
  });

  test("leaves Stripe reads open", () => {
    for (const name of [
      "mcp__stripe__list_customers",
      "mcp__stripe__list_subscriptions",
      "mcp__stripe__list_invoices",
      "mcp__stripe__retrieve_balance",
    ])
      expect(SUPPORT_DENIED_TOOLS[name]).toBeUndefined();
  });

  test("every denial explains itself", () => {
    for (const reason of Object.values(SUPPORT_DENIED_TOOLS))
      expect(reason.length).toBeGreaterThan(20);
  });
});
