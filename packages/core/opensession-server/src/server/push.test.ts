import { afterAll, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const root = mkdtempSync(`${tmpdir()}/push-test-`);
const previousRoot = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = root;
afterAll(() => {
  if (previousRoot === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previousRoot;
  rmSync(root, { recursive: true, force: true });
});

const sent: Array<{
  endpoint: string;
  body: string;
  options: Record<string, unknown>;
}> = [];
mock.module("web-push", () => ({
  default: {
    generateVAPIDKeys: () => ({ publicKey: "pub", privateKey: "priv" }),
    setVapidDetails: () => {},
    sendNotification: async (
      sub: { endpoint: string },
      body: string,
      options: Record<string, unknown>,
    ) => {
      sent.push({ endpoint: sub.endpoint, body, options });
    },
  },
}));
const { addPushSubscription, pushTopic, sendPushToUser } =
  await import("./push");

test("send options carry TTL, urgency and topic", async () => {
  await addPushSubscription({
    user: "Ada",
    subscription: {
      endpoint: "https://push.example.test/1",
      keys: { p256dh: "k", auth: "a" },
    },
  });
  await sendPushToUser(
    "ada",
    { title: "Search is down", url: "/incidents/inc-1" },
    { ttlSeconds: 360, urgency: "high", topic: "t1" },
  );
  await sendPushToUser("Ada", { title: "x" });
  expect(sent.map((s) => s.options)).toEqual([
    { TTL: 360, urgency: "high", topic: "t1" },
    { TTL: 3600 },
  ]);
  expect(JSON.parse(sent[0].body)).toEqual({
    title: "Search is down",
    url: "/incidents/inc-1",
  });
});

test("topics are short, URL-safe and stable", () => {
  const t = pushTopic("incident:inc-1");
  expect(t).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
  expect(pushTopic("incident:inc-1")).toBe(t);
  expect(pushTopic("incident:inc-2")).not.toBe(t);
});
