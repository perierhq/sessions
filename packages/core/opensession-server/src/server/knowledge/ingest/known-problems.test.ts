import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { useSupportTestKernel } from "../../support/testing/kernel-fixture";
import { __setKnowledgeServiceForTest, knowledgeRepo } from "../client";
import { __clearGithubSignalCacheForTest } from "../freshness/github";
import { frontMatterOf } from "../freshness/revalidate";
import { issueItemPath } from "../layout";
import { KnowledgeService } from "../service";
import { __waitForJobForTest, listJobs } from "./jobs";
import {
  type KnownProblemsDeps,
  startKnownProblemsImport,
  syncKnownProblems,
} from "./known-problems";

const kernel = useSupportTestKernel();
const TODAY = "2026-10-26";
const GH = "acme/app";
const LIST = `/repos/${GH}/issues?state=open&labels=bug&per_page=100&page=1`;

function issue(
  number: number,
  title: string,
  body = `Exporting a project as CSV fails for issue ${number}.`,
  extra: Record<string, unknown> = {},
) {
  return {
    number,
    title,
    body,
    state: "open",
    html_url: `https://github.com/${GH}/issues/${number}`,
    labels: [{ name: "bug" }],
    updated_at: "2026-10-20T08:00:00Z",
    ...extra,
  };
}

/** A fake GitHub: `answers` by request path; anything else is a 404. */
function fakeGithub(answers: Record<string, unknown>) {
  const requests: string[] = [];
  return {
    requests,
    answers,
    request: async (path: string) => {
      requests.push(path);
      if (!(path in answers)) return { ok: false, status: 404, data: null };
      const data = answers[path];
      if (data instanceof Error) throw data;
      return { ok: true, status: 200, data };
    },
  };
}

describe("syncKnownProblems", () => {
  let service: KnowledgeService;

  beforeEach(async () => {
    __clearGithubSignalCacheForTest();
    service = new KnowledgeService({ base: join(kernel.root(), "memory") });
    __setKnowledgeServiceForTest(service);
    await knowledgeRepo.call("ensureRepo", "acme");
  });

  afterEach(() => {
    __setKnowledgeServiceForTest(null);
    service.close();
    __clearGithubSignalCacheForTest();
  });

  const commits = async () =>
    (await knowledgeRepo.call("history", "acme", undefined, 100)).length;
  const read = (n: number) =>
    knowledgeRepo.call("read", "acme", issueItemPath(n), TODAY);

  /** A person's edit of issue item `n`: its status set, a line added. */
  async function personSets(n: number, status: "retired" | "active") {
    const current = (await read(n))!;
    const { check: _check, ...fm } = frontMatterOf(current.item);
    await knowledgeRepo.call(
      "write",
      "acme",
      [
        {
          op: "put",
          path: issueItemPath(n),
          fm: { ...fm, status },
          body: `${current.body}\n\nWorkaround: export as JSON.`,
        },
      ],
      {
        message: "Ada's edit",
        author: { name: "Ada" },
        expected: { [issueItemPath(n)]: current.item.blob },
      },
    );
  }

  function deps(
    gh: ReturnType<typeof fakeGithub>,
    over: Partial<KnownProblemsDeps> = {},
  ): Partial<KnownProblemsDeps> {
    return {
      today: () => TODAY,
      hosts: async () => ["help.acme.example.test"],
      github: { ghRepo: () => GH, request: gh.request },
      ...over,
    };
  }

  test("open bug issues become reference items; a pull request is skipped; a closed one is retired", async () => {
    const gh = fakeGithub({
      [LIST]: [
        issue(1, "CSV export fails"),
        issue(2, "Login loops on Safari"),
        { ...issue(3, "Fix CSV export"), pull_request: { url: "x" } },
      ],
    });
    const first = await syncKnownProblems("acme", deps(gh));
    expect(first).toEqual({ written: 2, retired: 0, skipped: 0 });

    const one = await read(1);
    expect(one!.item).toMatchObject({
      title: "CSV export fails",
      kind: "answer",
      trust: "reference",
      status: "active",
      origin: "issue",
      sources: ["issue:1"],
      dependsOn: ["issue:1"],
      validAsOf: TODAY,
    });
    expect(one!.body).toStartWith(
      `Known problem, open: https://github.com/${GH}/issues/1`,
    );
    expect(one!.body).toContain(
      "Exporting a project as CSV fails for issue 1.",
    );
    expect(await read(3)).toBeNull();
    const two = await read(2);
    const after = await commits();

    // Issue 1 closed: gone from the list, and GitHub says closed.
    gh.answers[LIST] = [issue(2, "Login loops on Safari")];
    gh.answers[`/repos/${GH}/issues/1`] = {
      ...issue(1, "CSV export fails"),
      state: "closed",
      closed_at: "2026-10-25T10:00:00Z",
    };
    const second = await syncKnownProblems("acme", deps(gh));
    expect(second).toEqual({ written: 0, retired: 1, skipped: 0 });
    expect((await read(1))!.item.status).toBe("retired");
    expect((await read(1))!.body).toBe(one!.body);
    // The open one is not rewritten.
    expect((await read(2))!.item.blob).toBe(two!.item.blob);
    expect(await commits()).toBe(after + 1);

    // Nothing changed: no commit.
    expect(await syncKnownProblems("acme", deps(gh))).toEqual({
      written: 0,
      retired: 0,
      skipped: 0,
    });
    expect(await commits()).toBe(after + 1);
  });

  test("a project without a GitHub repository: nothing, no request", async () => {
    const gh = fakeGithub({});
    const result = await syncKnownProblems(
      "acme",
      deps(gh, { github: { ghRepo: () => null, request: gh.request } }),
    );
    expect(result).toEqual({ written: 0, retired: 0, skipped: 0 });
    expect(gh.requests).toEqual([]);
  });

  test("customer data is stripped from the issue text, which is cut at 2000 characters", async () => {
    const body = [
      "A customer wrote in, mail them at jane.doe@example.test or +44 20 7946 0958.",
      "",
      "> Hi, I'm Jane Doe and my export is empty",
      "",
      "See https://tracker.example.test/private/77 for the log.",
      "",
      "x ".repeat(2000),
    ].join("\n");
    const gh = fakeGithub({ [LIST]: [issue(5, "Export empty", body)] });
    await syncKnownProblems("acme", deps(gh));
    const item = await read(5);
    expect(item!.body).not.toContain("jane.doe@example.test");
    expect(item!.body).not.toContain("7946");
    expect(item!.body).not.toContain("Jane Doe");
    expect(item!.body).not.toContain("tracker.example.test");
    const text = item!.body.slice(item!.body.indexOf("\n\n") + 2);
    expect(text.length).toBeLessThanOrEqual(2001);
  });

  test("an issue holding a credential is skipped, never stored", async () => {
    const gh = fakeGithub({
      [LIST]: [
        issue(
          6,
          "Token leak",
          "Our key is ghp_abcdefghijklmnopqrstuvwxyz0123456789AB",
        ),
        issue(7, "Slow search"),
      ],
    });
    expect(await syncKnownProblems("acme", deps(gh))).toEqual({
      written: 1,
      retired: 0,
      skipped: 1,
    });
    expect(await read(6)).toBeNull();
    expect(await read(7)).not.toBeNull();
  });

  test("an unreadable list throws and retires nothing", async () => {
    const gh = fakeGithub({ [LIST]: [issue(1, "CSV export fails")] });
    await syncKnownProblems("acme", deps(gh));
    delete gh.answers[LIST];
    await expect(syncKnownProblems("acme", deps(gh))).rejects.toThrow();
    expect((await read(1))!.item.status).toBe("active");
  });

  test("absence alone is no proof: an unreadable or truncated state keeps the item", async () => {
    const gh = fakeGithub({ [LIST]: [issue(1, "CSV export fails")] });
    await syncKnownProblems("acme", deps(gh));
    gh.answers[LIST] = [];
    // /repos/acme/app/issues/1 unanswered: state unknown.
    expect(await syncKnownProblems("acme", deps(gh))).toEqual({
      written: 0,
      retired: 0,
      skipped: 0,
    });
    expect((await read(1))!.item.status).toBe("active");
  });

  test("an open issue that lost its bug label is retired, and comes back when relabelled", async () => {
    const gh = fakeGithub({ [LIST]: [issue(1, "CSV export fails")] });
    await syncKnownProblems("acme", deps(gh));
    gh.answers[LIST] = [];
    gh.answers[`/repos/${GH}/issues/1`] = issue(1, "CSV export fails");
    expect(await syncKnownProblems("acme", deps(gh))).toEqual({
      written: 0,
      retired: 1,
      skipped: 0,
    });
    expect((await read(1))!.item.status).toBe("retired");
    gh.answers[LIST] = [issue(1, "CSV export fails")];
    expect(await syncKnownProblems("acme", deps(gh))).toEqual({
      written: 1,
      retired: 0,
      skipped: 0,
    });
    expect((await read(1))!.item.status).toBe("active");
  });

  test("an item a person edited last is left alone and counted; only Pat's retires reopen", async () => {
    const gh = fakeGithub({
      [LIST]: [issue(1, "CSV export fails"), issue(2, "Slow search")],
    });
    await syncKnownProblems("acme", deps(gh));
    // Ada retires 1 while it is open, and edits 2.
    await personSets(1, "retired");
    await personSets(2, "active");
    const one = await read(1);
    const two = await read(2);
    const after = await commits();

    // 1 still listed (no reopen); 2 retitled (no rewrite).
    gh.answers[LIST] = [
      issue(1, "CSV export fails"),
      issue(2, "Slow search everywhere"),
    ];
    expect(await syncKnownProblems("acme", deps(gh))).toEqual({
      written: 0,
      retired: 0,
      skipped: 2,
    });
    expect((await read(1))!.item.blob).toBe(one!.item.blob);
    expect((await read(2))!.item.blob).toBe(two!.item.blob);

    // 2 closes: Ada's edit stays active.
    gh.answers[LIST] = [issue(1, "CSV export fails")];
    gh.answers[`/repos/${GH}/issues/2`] = {
      ...issue(2, "Slow search"),
      state: "closed",
    };
    expect(await syncKnownProblems("acme", deps(gh))).toEqual({
      written: 0,
      retired: 0,
      skipped: 2,
    });
    expect((await read(2))!.item.status).toBe("active");
    expect(await commits()).toBe(after);
  });

  test("a changed title rewrites the item", async () => {
    const gh = fakeGithub({ [LIST]: [issue(1, "CSV export fails")] });
    await syncKnownProblems("acme", deps(gh));
    gh.answers[LIST] = [issue(1, "CSV export fails for large projects")];
    expect(await syncKnownProblems("acme", deps(gh))).toEqual({
      written: 1,
      retired: 0,
      skipped: 0,
    });
    expect((await read(1))!.item.title).toBe(
      "CSV export fails for large projects",
    );
  });

  test("the import job records what it wrote", async () => {
    const gh = fakeGithub({
      [LIST]: [issue(1, "CSV export fails"), issue(2, "Slow search")],
    });
    const job = await startKnownProblemsImport(
      { project: "acme", by: { name: "Ada" } },
      deps(gh),
    );
    expect(job.kind).toBe("known-problems");
    await __waitForJobForTest(job.id);
    const [done] = await listJobs("acme");
    expect(done).toMatchObject({
      kind: "known-problems",
      state: "done",
      created: { trusted: 0, reference: 2, suggestions: 0, skipped: 0 },
    });
  });
});
