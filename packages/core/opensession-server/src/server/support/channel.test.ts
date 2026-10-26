import { afterEach, expect, test } from "bun:test";
import type { InboxHealth } from "../../shared/support";
import {
  SendError,
  type SupportChannelAdapter,
  __resetChannelAdaptersForTest,
  channelAdapterFor,
  listChannelAdapters,
  registerChannelAdapter,
  unregisterChannelAdapter,
} from "./channel";

function fakeAdapter(inboxId: string): SupportChannelAdapter {
  const health: InboxHealth = {
    state: "off",
    since: "2026-10-25T10:00:00.000Z",
    reason: null,
    retryAt: null,
    lastMessageAt: null,
  };
  return {
    channel: "email",
    inboxId,
    connect: async () => {},
    disconnect: async () => {},
    health: () => health,
    send: async () => ({
      messageId: `reply@${inboxId}.example.test`,
      providerId: null,
      sentAt: "2026-10-25T10:00:00.000Z",
    }),
  };
}

afterEach(() => __resetChannelAdaptersForTest());

test("finds each registered adapter by inbox", () => {
  const a = fakeAdapter("inb_a");
  const b = fakeAdapter("inb_b");
  registerChannelAdapter(a);
  registerChannelAdapter(b);
  expect(channelAdapterFor("inb_a")).toBe(a);
  expect(channelAdapterFor("inb_b")).toBe(b);
  expect(channelAdapterFor("inb_c")).toBeUndefined();
  expect(listChannelAdapters()).toHaveLength(2);
});

test("registering the same inbox again replaces the adapter", () => {
  const first = fakeAdapter("inb_a");
  const second = fakeAdapter("inb_a");
  registerChannelAdapter(first);
  registerChannelAdapter(second);
  expect(channelAdapterFor("inb_a")).toBe(second);
  expect(listChannelAdapters()).toEqual([second]);
});

test("unregistering returns the removed adapter", () => {
  const a = fakeAdapter("inb_a");
  registerChannelAdapter(a);
  expect(unregisterChannelAdapter("inb_a")).toBe(a);
  expect(unregisterChannelAdapter("inb_a")).toBeUndefined();
  expect(channelAdapterFor("inb_a")).toBeUndefined();
});

test("SendError carries permanence and a retry hint", () => {
  expect(new SendError("x", true).permanent).toBe(true);
  const transient = new SendError("busy", false, 60_000);
  expect(transient.permanent).toBe(false);
  expect(transient.retryAfterMs).toBe(60_000);
  expect(transient).toBeInstanceOf(Error);
  expect(transient.message).toBe("busy");
});
