// A detached run host keeps a private view of its run's state; the server
// records the authoritative transitions. The host must not audit its own
// copy, or every run is logged twice (once per process).
import { afterAll, expect, test } from "bun:test";
import { getRunState, transitionRunState } from "./run-state";

const prior = process.env.OPENSESSION_RUN_JOURNAL;
process.env.OPENSESSION_RUN_JOURNAL = "/tmp/acme-run-journal.json";
afterAll(() => {
  if (prior === undefined) delete process.env.OPENSESSION_RUN_JOURNAL;
  else process.env.OPENSESSION_RUN_JOURNAL = prior;
});

test("a run host's transitions move its view without auditing them", async () => {
  const events: Record<string, unknown>[] = [];
  const emit = (event: Record<string, unknown>) => void events.push(event);
  expect(
    await transitionRunState("acme-1", "prompt", { run_key: "r1" }, emit),
  ).toBe("starting");
  expect(
    await transitionRunState(
      "acme-1",
      "run_failed",
      { run_key: "r1", source: "runner_terminal" },
      emit,
    ),
  ).toBe("failed");
  expect(getRunState("acme-1")).toBe("failed");
  expect(events).toEqual([]);
});

test("a transition the host's view refuses is still reported", async () => {
  const events: Record<string, unknown>[] = [];
  await transitionRunState(
    "acme-2",
    "turn_end",
    { run_key: "r2" },
    (event) => void events.push(event),
  );
  expect(events).toMatchObject([
    { msg: "run_state_rejected", session_id: "acme-2", event: "turn_end" },
  ]);
});
