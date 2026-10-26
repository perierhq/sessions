import { describe, expect, test } from "bun:test";
import type { KnowledgeImportJob } from "../../../shared/knowledge";
import { catalogDocuments } from "../../catalog-documents";
import { useSupportTestKernel } from "../../support/testing/kernel-fixture";
import {
  __waitForJobForTest,
  failInterruptedJobs,
  INTERRUPTED_COPY,
  JOB_RUNNING_COPY,
  listJobs,
  MAX_LISTED_JOBS,
  startJob,
} from "./jobs";

useSupportTestKernel();

/** A run that waits until the test lets it finish. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

describe("knowledge import jobs", () => {
  test("a second running import of one kind per project is refused", async () => {
    const g = gate();
    const first = await startJob(
      "acme",
      "mailbox",
      { months: 12 },
      () => g.opened,
    );
    expect(first.state).toBe("running");
    expect(first.project).toBe("acme");
    expect(first.options).toEqual({ months: 12 });

    const second = startJob("acme", "mailbox", {}, async () => {});
    await expect(second).rejects.toMatchObject({
      status: 409,
      message: JOB_RUNNING_COPY,
    });
    // Another kind, or another project, may run meanwhile.
    const other = await startJob("acme", "website", {}, async () => {});
    const elsewhere = await startJob("acme-api", "mailbox", {}, async () => {});
    await __waitForJobForTest(other.id);
    await __waitForJobForTest(elsewhere.id);

    g.open();
    await __waitForJobForTest(first.id);
    // Once it finished another may start.
    const again = await startJob("acme", "mailbox", {}, async () => {});
    await __waitForJobForTest(again.id);
    expect(
      (await listJobs("acme")).filter((j) => j.kind === "mailbox"),
    ).toHaveLength(2);
  });

  test("two starts at the same moment run once", async () => {
    const g = gate();
    const results = await Promise.allSettled([
      startJob("acme", "repo", {}, () => g.opened),
      startJob("acme", "repo", {}, () => g.opened),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    g.open();
    for (const r of results)
      if (r.status === "fulfilled") await __waitForJobForTest(r.value.id);
  });

  test("progress adds up and the job ends done", async () => {
    const job = await startJob("acme", "mailbox", {}, async (h) => {
      await h.setTotal(5);
      await h.progress({ trusted: 1, done: 1 });
      await h.progress({ reference: 2, done: 2 });
      await h.progress({ skipped: 1, done: 1 });
      await h.progress({ trusted: 1, done: 1 });
    });
    expect(job.total).toBeNull();
    await __waitForJobForTest(job.id);
    const [done] = await listJobs("acme");
    expect(done).toMatchObject({
      id: job.id,
      state: "done",
      total: 5,
      done: 5,
      created: { trusted: 2, reference: 2, suggestions: 0, skipped: 1 },
    });
    expect(done!.finishedAt).toBeString();
  });

  test("a run that throws ends failed with its error", async () => {
    const job = await startJob("acme", "website", {}, async () => {
      throw new Error("The site didn't answer");
    });
    await __waitForJobForTest(job.id);
    const [failed] = await listJobs("acme");
    expect(failed).toMatchObject({
      state: "failed",
      error: "The site didn't answer",
    });
  });

  test("listJobs is newest first, one project, at most 20", async () => {
    for (let i = 0; i < MAX_LISTED_JOBS + 3; i++) {
      const job = await startJob("acme", "files", { i }, async () => {});
      await __waitForJobForTest(job.id);
    }
    const other = await startJob("acme-api", "files", {}, async () => {});
    await __waitForJobForTest(other.id);
    const jobs = await listJobs("acme");
    expect(jobs).toHaveLength(MAX_LISTED_JOBS);
    expect(jobs.every((j) => j.project === "acme")).toBe(true);
    expect(jobs[0]!.options).toEqual({ i: MAX_LISTED_JOBS + 2 });
    expect(jobs.at(-1)!.options).toEqual({ i: 3 });
  });

  test("failInterruptedJobs fails what a restart left running", async () => {
    const stale: KnowledgeImportJob = {
      id: "kj_stale",
      project: "acme",
      kind: "mailbox",
      state: "running",
      startedAt: "2026-10-25T08:00:00.000Z",
      done: 3,
      total: 10,
      created: { trusted: 1, reference: 2, suggestions: 0, skipped: 0 },
      options: {},
    };
    await catalogDocuments("knowledge-jobs").set("acme:kj_stale", stale);
    // A restart left it "running": a new one is refused until boot fails it.
    await expect(
      startJob("acme", "mailbox", {}, async () => {}),
    ).rejects.toMatchObject({ status: 409 });

    await failInterruptedJobs();
    const [job] = await listJobs("acme");
    expect(job).toMatchObject({
      id: "kj_stale",
      state: "failed",
      error: INTERRUPTED_COPY,
      done: 3,
    });
    expect(INTERRUPTED_COPY).toBe("Interrupted by a restart. Start it again.");
    const next = await startJob("acme", "mailbox", {}, async () => {});
    await __waitForJobForTest(next.id);
  });

  test("failInterruptedJobs leaves a job this process runs alone", async () => {
    const g = gate();
    const job = await startJob("acme", "mailbox", {}, () => g.opened);
    await failInterruptedJobs();
    expect((await listJobs("acme"))[0]!.state).toBe("running");
    g.open();
    await __waitForJobForTest(job.id);
    expect((await listJobs("acme"))[0]!.state).toBe("done");
  });
});
