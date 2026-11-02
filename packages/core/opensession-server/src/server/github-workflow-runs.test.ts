import { expect, test } from "bun:test";
import {
  actionsNotRunning,
  actionsRunIds,
  actionsRunsAgain,
  type WorkflowRun,
  type WorkflowRunJob,
} from "./github-workflow-runs";

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

test("the refused checks' workflow runs, once each, from their job URLs", () => {
  expect(
    actionsRunIds([
      ...checks,
      { url: "https://github.com/acme/web/actions/runs/9/job/90" },
      { url: "https://ci.example.test/1" },
      {},
    ]),
  ).toEqual([7, 9]);
});

const wfRun = (id: number, status: string, createdAt: number): WorkflowRun => ({
  id,
  name: "ci",
  status,
  conclusion: status === "completed" ? "success" : "",
  url: `https://github.com/acme/web/actions/runs/${id}`,
  headBranch: "main",
  headSha: "abc1234",
  event: "push",
  runNumber: id,
  runAttempt: 1,
  createdAt,
});

test("Actions runs again when its newest finished run has a job that got to a step", async () => {
  const asked: number[] = [];
  const runs = async () => [
    wfRun(1, "completed", 100),
    wfRun(2, "completed", 300),
    wfRun(3, "in_progress", 400),
  ];
  expect(
    await actionsRunsAgain("acme/web", {
      runs,
      jobs: async (_repo, id) => {
        asked.push(id);
        return [job(20, 0), job(21, 2)];
      },
    }),
  ).toBe(true);
  // The newest finished run, never one still running.
  expect(asked).toEqual([2]);
  // Still refused: every job of the newest run stopped before a step.
  expect(
    await actionsRunsAgain("acme/web", {
      runs,
      jobs: async () => [job(20, 0)],
    }),
  ).toBe(false);
  // No finished run yet: nothing shows Actions works again.
  expect(
    await actionsRunsAgain("acme/web", {
      runs: async () => [wfRun(3, "queued", 400)],
      jobs: async () => {
        throw new Error("not asked");
      },
    }),
  ).toBe(false);
});
