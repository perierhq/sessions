import { describe, expect, test } from "bun:test";
import type { StreamEvent } from "./run-events";
import {
  foldRunUsageInto,
  foldSessionUsage,
  withRunUsageRecorded,
} from "./session-usage";

const turn = {
  costUsd: 0.5,
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 1_000,
  cacheCreationTokens: 50,
  contextTokens: 1_150,
};

async function drain(events: AsyncIterable<StreamEvent>) {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function* source(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const event of events) yield event;
}

describe("run usage recording for headless runs", () => {
  test("a terminal event's usage is saved before the event reaches the caller", async () => {
    const order: string[] = [];
    const saved: Array<{ id: string; runId?: string; cost?: number }> = [];
    const events = withRunUsageRecorded(
      "bks-acme-1",
      source([
        { type: "init", sessionId: "pi-1", provider: "pi" },
        { type: "usage_snapshot", usage: { ...turn, costUsd: 0.1 } },
        { type: "done", usage: turn, model: "pi/xai/grok" },
      ] as StreamEvent[]),
      {
        runId: "rh-1",
        persist: async (id, event, runId) => {
          order.push(`persist:${event.type}`);
          saved.push({ id, runId, cost: event.usage?.costUsd });
        },
      },
    );
    for await (const event of events) order.push(`yield:${event.type}`);

    expect(saved).toEqual([{ id: "bks-acme-1", runId: "rh-1", cost: 0.5 }]);
    expect(order).toEqual([
      "yield:init",
      "yield:usage_snapshot",
      "persist:done",
      "yield:done",
    ]);
  });

  test("a failed run still records the work it paid for", async () => {
    const saved: number[] = [];
    await drain(
      withRunUsageRecorded(
        "bks-acme-2",
        source([
          { type: "error", content: "pi: boom", usage: turn },
        ] as StreamEvent[]),
        {
          persist: async (_id, event) => {
            saved.push(event.usage!.inputTokens);
          },
        },
      ),
    );
    expect(saved).toEqual([100]);
  });

  test("a run without usage writes nothing, and a failed write does not end the run", async () => {
    let calls = 0;
    const out = await drain(
      withRunUsageRecorded(
        "bks-acme-3",
        source([
          { type: "done" },
          { type: "error", content: "x", usage: turn },
        ] as StreamEvent[]),
        {
          persist: async () => {
            calls++;
            throw new Error("disk full");
          },
          log: () => {},
        },
      ),
    );
    expect(calls).toBe(1);
    expect(out.map((e) => e.type)).toEqual(["done", "error"]);
  });

  test("folding is idempotent per run id", () => {
    const first = foldRunUsageInto({}, { usage: turn }, "rh-9");
    expect(first.usage?.costUsd).toBe(0.5);
    expect(first.data.usageRunId).toBe("rh-9");
    const again = foldRunUsageInto(first.data, { usage: turn }, "rh-9");
    expect(again.usage?.costUsd).toBe(0.5);
    expect(again.usage?.turns).toBe(1);
    const next = foldRunUsageInto(first.data, { usage: turn }, "rh-10");
    expect(next.usage?.costUsd).toBe(1);
    expect(next.usage?.turns).toBe(2);
  });

  test("foldSessionUsage sums cost and keeps the latest context", () => {
    const one = foldSessionUsage(undefined, turn);
    const two = foldSessionUsage(one, { ...turn, contextTokens: 9 });
    expect(two.costUsd).toBe(1);
    expect(two.inputTokens).toBe(200);
    expect(two.contextTokens).toBe(9);
    expect(two.turns).toBe(2);
  });

  test("GitHub and automation runs record their usage", async () => {
    for (const path of ["../agents/github/run.ts", "./automations.ts"]) {
      const source = await Bun.file(new URL(path, import.meta.url)).text();
      expect(source).toContain("withRunUsageRecorded(");
    }
  });
});
