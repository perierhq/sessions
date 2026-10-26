import { expect, test } from "bun:test";
import type { Arguments } from "swr";
import { apiSWRKey } from "../api-swr";
import { createKnowledgeLive } from "./live";

type Filter = (key: Arguments) => boolean;

function recorder() {
  const calls: Filter[] = [];
  return { calls, revalidate: (filter: Filter) => calls.push(filter) };
}

const msg = (project: string, what: "jobs" | "items") =>
  ({ type: "knowledge_changed", project, what }) as const;

test("a job message revalidates that project's imports only", () => {
  const r = recorder();
  const live = createKnowledgeLive(r.revalidate, 20);
  live.onMessage(msg("acme", "jobs"));
  expect(r.calls).toHaveLength(1);
  const f = r.calls[0]!;
  expect(f(apiSWRKey.knowledgeJobs("acme"))).toBe(true);
  expect(f(apiSWRKey.knowledge("acme", "all"))).toBe(false);
  expect(f(apiSWRKey.knowledgeJobs("acme-api"))).toBe(false);
  live.cancel();
});

test("an items message revalidates every key of the project: lists, counts, needs check", () => {
  const r = recorder();
  const live = createKnowledgeLive(r.revalidate, 20);
  live.onMessage(msg("acme", "items"));
  const f = r.calls[0]!;
  expect(f(apiSWRKey.knowledge("acme", "all"))).toBe(true);
  expect(f(apiSWRKey.knowledge("acme", "suggestions", "", 50))).toBe(true);
  expect(f(apiSWRKey.knowledgeNeedsCheck("acme"))).toBe(true);
  expect(f(apiSWRKey.knowledgeHistory("acme"))).toBe(true);
  expect(f(apiSWRKey.knowledge("acme-api", "all"))).toBe(false);
  expect(f(apiSWRKey.incidents("open"))).toBe(false);
  live.cancel();
});

test("a burst revalidates once now and once after the window, per project and kind", async () => {
  const r = recorder();
  let clock = 1_000;
  const live = createKnowledgeLive(r.revalidate, 20, () => clock);
  for (let i = 0; i < 5; i++) live.onMessage(msg("acme", "jobs"));
  live.onMessage(msg("acme", "items"));
  live.onMessage(msg("acme-api", "jobs"));
  expect(r.calls).toHaveLength(3);
  clock += 25;
  await Bun.sleep(30);
  // The trailing call of the acme jobs burst.
  expect(r.calls).toHaveLength(4);
  expect(r.calls[3]!(apiSWRKey.knowledgeJobs("acme"))).toBe(true);
  live.cancel();
});

test("other messages are ignored", () => {
  const r = recorder();
  const live = createKnowledgeLive(r.revalidate, 20);
  live.onMessage({ type: "incidents_changed" });
  live.onMessage({ type: "knowledge_changed" });
  expect(r.calls).toHaveLength(0);
});

test("the channel's state is shared, and coming back revalidates every knowledge key", () => {
  const r = recorder();
  const live = createKnowledgeLive(r.revalidate, 20);
  let heard = 0;
  const off = live.subscribe(() => heard++);
  expect(live.connected()).toBe(false);
  live.setConnected(true);
  expect(live.connected()).toBe(true);
  expect(heard).toBe(1);
  // Messages missed while down: every project's knowledge is read again.
  expect(r.calls).toHaveLength(1);
  expect(r.calls[0]!(apiSWRKey.knowledge("acme", "all"))).toBe(true);
  expect(r.calls[0]!(apiSWRKey.knowledgeJobs("acme-api"))).toBe(true);
  expect(r.calls[0]!(apiSWRKey.incidents("open"))).toBe(false);
  live.setConnected(true);
  expect(heard).toBe(1);
  live.setConnected(false);
  expect(heard).toBe(2);
  expect(r.calls).toHaveLength(1);
  off();
  live.setConnected(true);
  expect(heard).toBe(2);
});
