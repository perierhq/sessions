import { describe, expect, test } from "bun:test";
import {
  KNOWLEDGE_SKIP,
  type KnowledgeImportJob,
} from "../../../shared/knowledge";
import { catalogDocuments } from "../../catalog-documents";
import { useSupportTestKernel } from "../../support/testing/kernel-fixture";
import {
  __setKnowledgeBroadcastForTest,
  type KnowledgeBroadcast,
} from "../broadcast";
import {
  __waitForJobForTest,
  JOB_WRITE_MS,
  CANCELLED_COPY,
  cancelJob,
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

  test("a running job can be cancelled; its run sees the signal", async () => {
    const g = gate();
    let seen: AbortSignal | undefined;
    const job = await startJob("acme", "mailbox", {}, async (handle) => {
      seen = handle.signal;
      await g.opened;
      handle.signal.throwIfAborted();
    });
    await Promise.resolve();
    const cancelled = await cancelJob("acme", job.id);
    expect(cancelled?.id).toBe(job.id);
    expect(seen?.aborted).toBe(true);
    g.open();
    await __waitForJobForTest(job.id);
    const [done] = await listJobs("acme");
    expect(done).toMatchObject({ state: "failed", error: CANCELLED_COPY });
    // Finished or unknown jobs can't be cancelled.
    expect(await cancelJob("acme", job.id)).toBeNull();
    expect(await cancelJob("acme", "kj_unknown")).toBeNull();
    expect(await cancelJob("acme-api", job.id)).toBeNull();
  });

  test("a cancelled run that fails for another reason records that reason", async () => {
    const g = gate();
    const job = await startJob("acme", "mailbox", {}, async () => {
      await g.opened;
      throw new Error("The disk is full");
    });
    await Promise.resolve();
    await cancelJob("acme", job.id);
    g.open();
    await __waitForJobForTest(job.id);
    const [done] = await listJobs("acme");
    expect(done).toMatchObject({ state: "failed", error: "The disk is full" });
  });

  test("a run stopped with the cancel copy (mailbox StopRun) is cancelled", async () => {
    const g = gate();
    const job = await startJob("acme", "mailbox", {}, async (handle) => {
      await g.opened;
      if (handle.signal.aborted) throw new Error(CANCELLED_COPY);
    });
    await Promise.resolve();
    await cancelJob("acme", job.id);
    g.open();
    await __waitForJobForTest(job.id);
    const [done] = await listJobs("acme");
    expect(done).toMatchObject({ state: "failed", error: CANCELLED_COPY });
  });

  test("a run can say it left part of the input out", async () => {
    const job = await startJob("acme", "mailbox", {}, async (handle) => {
      await handle.markTruncated();
    });
    await __waitForJobForTest(job.id);
    const [done] = await listJobs("acme");
    expect(done).toMatchObject({ state: "done", truncated: true });
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

  test("a run's phase shows from the start, is written at most every 500 ms, and the last one stays", async () => {
    const sent: KnowledgeBroadcast[] = [];
    __setKnowledgeBroadcastForTest((m) => sent.push(m));
    try {
      const g = gate();
      const job = await startJob("acme", "mailbox", {}, async (h) => {
        for (let i = 1; i <= 900; i++)
          h.phase("Reading INBOX", { done: i, total: 900 });
        await g.opened;
        h.phase("Committing");
      });
      expect(JOB_WRITE_MS).toBe(500);
      expect(job.phase).toEqual({ text: "Starting" });
      await Bun.sleep(5);
      // Read while it runs: the newest phase, before any write of it.
      const [running] = await listJobs("acme");
      expect(running!.phase).toEqual({
        text: "Reading INBOX 900 of 900",
        done: 900,
        total: 900,
      });
      // 900 updates, a handful of writes and messages.
      const jobMessages = () => sent.filter((m) => m.what === "jobs").length;
      expect(jobMessages()).toBeLessThanOrEqual(2);
      await Bun.sleep(JOB_WRITE_MS + 100);
      const stored = (await catalogDocuments("knowledge-jobs").get(
        `acme:${job.id}`,
      )) as KnowledgeImportJob;
      expect(stored.phase?.text).toBe("Reading INBOX 900 of 900");
      expect(jobMessages()).toBeLessThanOrEqual(3);
      g.open();
      await __waitForJobForTest(job.id);
      const [done] = await listJobs("acme");
      expect(done).toMatchObject({
        state: "done",
        phase: { text: "Committing" },
      });
    } finally {
      __setKnowledgeBroadcastForTest(undefined);
    }
  });

  test("a report after the run ended doesn't reopen its record", async () => {
    let late: ((label: string) => void) | undefined;
    const job = await startJob("acme", "repo", {}, async (h) => {
      late = h.phase;
      h.phase("Reading files");
    });
    await __waitForJobForTest(job.id);
    late!("Still here");
    await Bun.sleep(JOB_WRITE_MS + 50);
    const [done] = await listJobs("acme");
    expect(done).toMatchObject({
      state: "done",
      phase: { text: "Reading files" },
    });
  });

  test("a phase with only a count says so far", async () => {
    const job = await startJob("acme", "website", {}, async (h) => {
      h.phase("Reading pages", { done: 12 });
    });
    await __waitForJobForTest(job.id);
    const [done] = await listJobs("acme");
    expect(done!.phase).toEqual({ text: "Reading pages, 12 so far", done: 12 });
  });

  test("skipped inputs are counted by why", async () => {
    const job = await startJob("acme", "mailbox", {}, async (h) => {
      await h.progress({
        done: 3,
        skippedBy: {
          [KNOWLEDGE_SKIP.alreadyImported]: 2,
          [KNOWLEDGE_SKIP.notReusable]: 1,
        },
      });
      await h.progress({
        done: 1,
        skippedBy: { [KNOWLEDGE_SKIP.alreadyImported]: 1 },
      });
      await h.progress({ done: 1, trusted: 1 });
    });
    await __waitForJobForTest(job.id);
    const [done] = await listJobs("acme");
    expect(done).toMatchObject({
      done: 5,
      created: { trusted: 1, skipped: 4 },
      skippedReasons: {
        [KNOWLEDGE_SKIP.alreadyImported]: 3,
        [KNOWLEDGE_SKIP.notReusable]: 1,
      },
    });
  });

  test("every job change tells the project's clients", async () => {
    const sent: KnowledgeBroadcast[] = [];
    __setKnowledgeBroadcastForTest((m) => sent.push(m));
    try {
      const job = await startJob("acme", "repo", {}, async () => {});
      expect(sent).toEqual([
        { type: "knowledge_changed", project: "acme", what: "jobs" },
      ]);
      await __waitForJobForTest(job.id);
      // Started and finished.
      expect(sent).toHaveLength(2);
      expect(sent.every((m) => m.project === "acme" && m.what === "jobs")).toBe(
        true,
      );
    } finally {
      __setKnowledgeBroadcastForTest(undefined);
    }
  });
});
