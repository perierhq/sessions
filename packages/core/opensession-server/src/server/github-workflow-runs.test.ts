import { expect, test } from "bun:test";
import { actionsNotRunning, type WorkflowRunJob } from "./github-workflow-runs";

const job = (id: number, steps: number): WorkflowRunJob => ({
  id,
  name: `job-${id}`,
  status: "completed",
  conclusion: "failure",
  failedSteps: [],
  steps,
});

const checks = [
  { name: "test", url: "https://github.com/acme/web/actions/runs/7/job/70" },
  { name: "lint", url: "https://github.com/acme/web/actions/runs/7/job/71" },
];

test("GitHub Actions that refused every job: the annotation says why", async () => {
  const runs: number[] = [];
  const reason = await actionsNotRunning("acme/web", checks, {
    jobs: async (_repo, run) => {
      runs.push(run);
      return [job(70, 0), job(71, 0)];
    },
    annotations: async () => [
      "The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings",
    ],
  });
  expect(reason).toBe(
    "the job was not started because recent account payments have failed or your spending limit needs to be increased",
  );
  expect(runs).toEqual([7]);
});

test("every job stopped before its first step, with no annotation", async () => {
  expect(
    await actionsNotRunning("acme/web", checks, {
      jobs: async () => [job(70, 0), job(71, 0)],
      annotations: async () => [],
    }),
  ).toBe("every job stopped before its first step");
});

test("a job that ran a step, or a check that is not an Actions job, is the code's", async () => {
  const deps = {
    jobs: async () => [job(70, 0), job(71, 3)],
    annotations: async () => ["The job was not started because of billing"],
  };
  expect(await actionsNotRunning("acme/web", checks, deps)).toBeUndefined();
  expect(
    await actionsNotRunning(
      "acme/web",
      [...checks, { name: "preview", url: "https://ci.example.test/1" }],
      { ...deps, jobs: async () => [job(70, 0), job(71, 0)] },
    ),
  ).toBeUndefined();
  expect(await actionsNotRunning("acme/web", [], deps)).toBeUndefined();
});
