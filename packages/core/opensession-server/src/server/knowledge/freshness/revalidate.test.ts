import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KnowledgeFrontMatter } from "../../../shared/knowledge";
import { git, isolatedGitEnv } from "../../memory-repo/git";
import { __setKnowledgeServiceForTest, knowledgeRepo } from "../client";
import { repoItemPath, webItemPath } from "../layout";
import { KnowledgeService } from "../service";
import {
  revalidateProject,
  type ConflictMark,
  type RevalidateDeps,
} from "./revalidate";
import type { RepoChangeDeps } from "./repo-changes";

const TODAY = "2026-10-26";
const ADA = { name: "Ada", email: "ada@example.test" };
const PAGE = "https://help.acme.example.test/export";
const MIRROR = repoItemPath("docs/export.md");
const WEB = webItemPath(PAGE);
const ARTICLE_BODY = "Open the project, choose **Export**, then CSV.\n";

let base: string;
let work: string;
let checkout: string;
let service: KnowledgeService;
let repoDeps: Partial<RepoChangeDeps>;
const sha: Record<string, string> = {};

async function run(dir: string, args: string[], date?: string) {
  return (
    await git(args, {
      cwd: dir,
      env: isolatedGitEnv(
        date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {},
      ),
    })
  ).stdout.trim();
}

async function commit(file: string, text: string, date: string) {
  await mkdir(join(work, file, ".."), { recursive: true });
  await writeFile(join(work, file), text);
  await run(work, ["add", "--", file]);
  await run(work, ["commit", "-q", "-m", `edit ${file}`], date);
  await run(work, ["push", "-q", "origin", "main"]);
  return run(work, ["rev-parse", "HEAD"]);
}

function fm(over: Partial<KnowledgeFrontMatter>): KnowledgeFrontMatter {
  return {
    title: "Exporting a project as CSV",
    kind: "answer",
    trust: "trusted",
    status: "active",
    origin: "article",
    topics: [],
    sources: [],
    dependsOn: [],
    validAsOf: "2026-10-20",
    ...over,
  };
}

function memoryMarks(start: ConflictMark | null = null) {
  const marks = {
    mark: start,
    conflictMarks: {
      load: async () => marks.mark,
      save: async (mark: ConflictMark) => {
        marks.mark = mark;
      },
    },
  };
  return marks;
}

function deps(over: Partial<RevalidateDeps> = {}): Partial<RevalidateDeps> {
  return {
    today: TODAY,
    repoChanges: repoDeps,
    releasesSince: async () => [],
    refState: async () => null,
    pageHash: async () => null,
    classifyConflict: async () => "unrelated",
    conflictMarks: memoryMarks().conflictMarks,
    ...over,
  };
}

async function body(path: string) {
  return (await knowledgeRepo.call("read", "acme", path))!;
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "kn-revalidate-"));
  const origin = join(base, "origin.git");
  work = join(base, "work");
  checkout = join(base, "checkout");
  await run(base, ["init", "-q", "--bare", "-b", "main", origin]);
  await run(base, ["clone", "-q", origin, work]);
  await run(work, ["checkout", "-q", "-b", "main"]);
  sha.c1 = await commit("docs/export.md", "v1\n", "2026-08-01T10:00:00Z");
  sha.c2 = await commit("README.md", "hello\n", "2026-09-01T10:00:00Z");
  await run(base, ["clone", "-q", origin, checkout]);
  repoDeps = {
    repo: (project) =>
      project === "acme" ? { dir: checkout, defaultBranch: "main" } : null,
  };

  service = new KnowledgeService({ base: join(base, "memory") });
  __setKnowledgeServiceForTest(service);
  await knowledgeRepo.call("ensureRepo", "acme");
  await knowledgeRepo.call(
    "write",
    "acme",
    [
      {
        op: "put",
        path: "articles/export.md",
        fm: fm({ dependsOn: ["repo:docs/export.md"], validAsOfCommit: sha.c2 }),
        body: ARTICLE_BODY,
      },
      {
        op: "put",
        path: "articles/billing.md",
        fm: fm({ title: "Changing the billing email" }),
        body: "Go to Settings, then Billing.\n",
      },
      {
        op: "put",
        path: "sources/mail/2026-10/m1@example.test.md",
        fm: fm({
          title: "Export misses archived rows",
          trust: "reference",
          origin: "mail",
          dependsOn: ["repo:docs/export.md"],
          validAsOfCommit: sha.c2,
          answeredAt: "2026-10-19T08:12:00Z",
        }),
        body: "Archived rows are left out of exports.\n",
      },
      {
        op: "put",
        path: MIRROR,
        fm: fm({
          title: "docs/export.md",
          origin: "repo",
          sources: [`repo:docs/export.md@${sha.c2}`],
          dependsOn: ["repo:docs/export.md"],
          validAsOf: "2026-09-01",
          validAsOfCommit: sha.c2,
        }),
        body: "v1\n",
      },
      {
        op: "put",
        path: "articles/old.md",
        fm: fm({
          title: "The old export",
          status: "retired",
          dependsOn: ["repo:docs/export.md"],
          validAsOfCommit: sha.c1,
        }),
        body: "Retired.\n",
      },
    ],
    { message: "Seed", author: ADA },
  );
});

afterAll(async () => {
  __setKnowledgeServiceForTest(null);
  service.close();
  await rm(base, { recursive: true, force: true });
});

describe("revalidateProject", () => {
  test("a docs change flips dependents and refreshes the mirror in one commit", async () => {
    sha.c3 = await commit("docs/export.md", "v2\n", "2026-10-25T10:00:00Z");
    const before = await knowledgeRepo.call("history", "acme");
    const articleBefore = await body("articles/export.md");

    const result = await revalidateProject("acme", { deps: deps() });

    const reason = `docs/export.md changed in ${sha.c3!.slice(0, 7)}`;
    expect(result.errors).toEqual([]);
    expect(result.refreshed).toBe(1);
    expect(result.checked).toBe(4);
    expect(result.flipped).toEqual([
      { path: "articles/export.md", reason },
      { path: "sources/mail/2026-10/m1@example.test.md", reason },
    ]);

    const article = await body("articles/export.md");
    expect(article.item.status).toBe("needs-check");
    expect(article.item.check).toEqual({
      reason,
      since: TODAY,
      source: `repo:docs/export.md@${sha.c3}`,
    });
    expect(article.item.validAsOfCommit).toBe(sha.c2);
    expect(article.body).toBe(articleBefore.body);

    const mail = await body("sources/mail/2026-10/m1@example.test.md");
    expect(mail.item.status).toBe("needs-check");
    expect(mail.item.trust).toBe("reference");

    const mirror = await body(MIRROR);
    expect(mirror.item.status).toBe("active");
    expect(mirror.item.validAsOfCommit).toBe(sha.c3);
    expect(mirror.item.validAsOf).toBe(TODAY);
    expect(mirror.item.sources).toEqual([`repo:docs/export.md@${sha.c3}`]);
    expect(mirror.body.trim()).toBe("v2");

    expect((await body("articles/billing.md")).item.status).toBe("active");
    expect((await body("articles/old.md")).item.status).toBe("retired");

    const after = await knowledgeRepo.call("history", "acme");
    expect(after.length).toBe(before.length + 1);
    expect(after[0]!.author).toBe("Pat");
    expect(after[0]!.subject).toBe(
      "Knowledge check: 2 need a check, 1 refreshed",
    );
    expect(after[0]!.body).toContain("Suggested-by: Pat");
  });

  test("a second run changes nothing and makes no commit", async () => {
    const before = await knowledgeRepo.call("history", "acme");
    const result = await revalidateProject("acme", { deps: deps() });
    expect(result.flipped).toEqual([]);
    expect(result.refreshed).toBe(0);
    expect(result.errors).toEqual([]);
    expect((await knowledgeRepo.call("history", "acme")).length).toBe(
      before.length,
    );
  });

  test("an overdue review date is written to needs-check", async () => {
    await knowledgeRepo.call(
      "write",
      "acme",
      [
        {
          op: "put",
          path: "articles/refunds.md",
          fm: fm({ title: "Refunds", reviewBy: "2026-10-01" }),
          body: "Refunds take five days.\n",
        },
      ],
      { message: "Add refunds", author: ADA },
    );
    const result = await revalidateProject("acme", { deps: deps() });
    expect(result.flipped).toEqual([
      {
        path: "articles/refunds.md",
        reason: "Review date passed (2026-10-01)",
      },
    ]);
    const refunds = await body("articles/refunds.md");
    expect(refunds.item.status).toBe("needs-check");
    expect(refunds.item.check).toEqual({
      reason: "Review date passed (2026-10-01)",
      since: TODAY,
    });
  });

  test("a changed page refreshes its mirror and flips what depends on it", async () => {
    await knowledgeRepo.call(
      "write",
      "acme",
      [
        {
          op: "put",
          path: WEB,
          fm: fm({
            title: "Export",
            origin: "web",
            sources: [`url:${PAGE}#sha256=${"a".repeat(64)}`],
            dependsOn: [`url:${PAGE}`],
          }),
          body: "Old page text.\n",
        },
        {
          op: "put",
          path: "articles/export-web.md",
          fm: fm({
            title: "Export from the help center",
            sources: [`url:${PAGE}#sha256=${"a".repeat(64)}`],
            dependsOn: [`url:${PAGE}`],
          }),
          body: "See the help center.\n",
        },
      ],
      { message: "Add web", author: ADA },
    );
    const hash = "b".repeat(64);
    const result = await revalidateProject("acme", {
      deps: deps({
        pageHash: async () => hash,
        fetchPage: async (url) => ({ url, text: "New page text.", hash }),
      }),
    });
    expect(result.errors).toEqual([]);
    expect(result.refreshed).toBe(1);
    expect(result.flipped).toEqual([
      {
        path: "articles/export-web.md",
        reason: `${PAGE} changed on ${TODAY}`,
      },
    ]);
    const mirror = await body(WEB);
    expect(mirror.body.trim()).toBe("New page text.");
    expect(mirror.item.sources).toEqual([`url:${PAGE}#sha256=${hash}`]);
    expect(mirror.item.validAsOf).toBe(TODAY);
    expect(mirror.item.status).toBe("active");
  });

  test("a throwing signal sends the item to a person", async () => {
    await knowledgeRepo.call(
      "write",
      "acme",
      [
        {
          op: "put",
          path: "articles/issue.md",
          fm: fm({ title: "Known issue", dependsOn: ["issue:42"] }),
          body: "We're on it.\n",
        },
      ],
      { message: "Add issue", author: ADA },
    );
    const result = await revalidateProject("acme", {
      deps: deps({
        refState: async () => {
          throw new Error("GitHub is down");
        },
      }),
    });
    expect(result.errors).toEqual(["articles/issue.md: GitHub is down"]);
    expect(result.flipped).toEqual([
      { path: "articles/issue.md", reason: "Knowledge couldn't be checked" },
    ]);
    const issue = await body("articles/issue.md");
    expect(issue.item.status).toBe("needs-check");
    expect(issue.item.check).toEqual({
      reason: "Knowledge couldn't be checked",
      since: TODAY,
    });
    expect(issue.body.trim()).toBe("We're on it.");
  });

  test("releases GitHub can't list send release-sensitive items to a person", async () => {
    await knowledgeRepo.call(
      "write",
      "acme",
      [
        {
          op: "put",
          path: "articles/sso.md",
          fm: fm({ title: "Single sign-on", topics: ["sso"] }),
          body: "Turn on SSO in Settings.\n",
        },
      ],
      { message: "Add sso", author: ADA },
    );
    const result = await revalidateProject("acme", {
      deps: deps({
        releasesSince: undefined,
        github: {
          ghRepo: () => "acme/app",
          request: async () => ({ ok: false, status: 503, data: null }),
        },
      }),
    });
    expect(result.flipped).toEqual([
      { path: "articles/sso.md", reason: "Knowledge couldn't be checked" },
    ]);
    expect(result.errors).toEqual([
      "articles/sso.md: acme/app's releases couldn't be read (503)",
    ]);
  });

  test("a code checkout that is gone is never read as unchanged", async () => {
    await knowledgeRepo.call(
      "write",
      "acme",
      [
        {
          op: "put",
          path: "articles/import.md",
          fm: fm({
            title: "Importing",
            dependsOn: ["repo:docs/import.md"],
            validAsOfCommit: sha.c3,
          }),
          body: "Upload a CSV.\n",
        },
      ],
      { message: "Add import", author: ADA },
    );
    const result = await revalidateProject("acme", {
      // The project's checkout is gone: repo-changes throws
      // RepoUnavailableError.
      deps: deps({ repoChanges: { repo: () => null } }),
    });
    // Every active item with a repo dependency, the mirror included.
    expect(result.flipped).toEqual([
      { path: "articles/import.md", reason: "Knowledge couldn't be checked" },
      { path: MIRROR, reason: "Knowledge couldn't be checked" },
    ]);
    expect(result.errors).toContain(
      "articles/import.md: acme's repository can't be read: not configured",
    );
  });

  test("scope repo only looks at the code repository", async () => {
    const result = await revalidateProject("acme", {
      scope: "repo",
      deps: deps({
        refState: async () => {
          throw new Error("must not be asked");
        },
      }),
    });
    expect(result.errors).toEqual([]);
    expect(result.flipped).toEqual([]);
  });

  test("a mirror whose file was deleted is retired with its text kept", async () => {
    await run(work, ["rm", "-q", "--", "docs/export.md"]);
    await run(
      work,
      ["commit", "-q", "-m", "drop export"],
      "2026-10-25T12:00:00Z",
    );
    await run(work, ["push", "-q", "origin", "main"]);
    const result = await revalidateProject("acme", { deps: deps() });
    expect(result.errors).toEqual([]);
    expect(result.refreshed).toBe(1);
    const mirror = await body(MIRROR);
    expect(mirror.item.status).toBe("retired");
    expect(mirror.body.trim()).toBe("v2");
  });

  test("a project without knowledge is a no-op", async () => {
    expect(await revalidateProject("other", { deps: deps() })).toEqual({
      checked: 0,
      flipped: [],
      refreshed: 0,
      conflicts: [],
      errors: [],
    });
  });
});

describe("revalidateProject conflict check", () => {
  const P = "acme-c";
  const A = "articles/plans.md";
  const B = "articles/plans-old.md";

  beforeAll(async () => {
    await knowledgeRepo.call("ensureRepo", P);
    await knowledgeRepo.call(
      "write",
      P,
      [
        {
          op: "put",
          path: A,
          fm: fm({ title: "Plans with CSV export", topics: ["plans"] }),
          body: "Every plan can export CSV.\n",
        },
        {
          op: "put",
          path: B,
          fm: fm({ title: "Which plans export CSV", topics: ["plans"] }),
          body: "Only the Pro plan can export CSV.\n",
        },
      ],
      { message: "Seed", author: ADA },
    );
  });

  test("nothing written since the last run: no model call", async () => {
    const marks = memoryMarks({ at: "2999-01-01T00:00:00Z", pending: [] });
    let calls = 0;
    const result = await revalidateProject(P, {
      deps: deps({
        conflictMarks: marks.conflictMarks,
        classifyConflict: async () => {
          calls++;
          return "disagree";
        },
      }),
    });
    expect(calls).toBe(0);
    expect(result.conflicts).toEqual([]);
  });

  test("a model that fails keeps the items for the next run", async () => {
    const marks = memoryMarks({ at: "2000-01-01T00:00:00Z", pending: [] });
    const result = await revalidateProject(P, {
      deps: deps({
        conflictMarks: marks.conflictMarks,
        classifyConflict: async () => null,
      }),
    });
    expect(result.conflicts).toEqual([]);
    expect(marks.mark!.pending.sort()).toEqual([A, B].sort());
    expect(marks.mark!.at > "2000-01-01T00:00:00Z").toBe(true);
    const a = await knowledgeRepo.call("read", P, A, TODAY);
    expect(a!.item.status).toBe("active");
  });

  test("scope repo leaves the conflict check to the daily run", async () => {
    const marks = memoryMarks({ at: "2000-01-01T00:00:00Z", pending: [] });
    let calls = 0;
    await revalidateProject(P, {
      scope: "repo",
      deps: deps({
        conflictMarks: marks.conflictMarks,
        classifyConflict: async () => {
          calls++;
          return "disagree";
        },
      }),
    });
    expect(calls).toBe(0);
    expect(marks.mark!.at).toBe("2000-01-01T00:00:00Z");
  });

  test("items written since the last run that disagree both need a check", async () => {
    const marks = memoryMarks({ at: "2999-01-01T00:00:00Z", pending: [A] });
    const result = await revalidateProject(P, {
      deps: deps({
        conflictMarks: marks.conflictMarks,
        classifyConflict: async () => "disagree",
      }),
    });
    expect(result.errors).toEqual([]);
    expect(result.conflicts).toEqual([{ a: A, b: B }]);
    expect(marks.mark!.pending).toEqual([]);
    const a = await knowledgeRepo.call("read", P, A, TODAY);
    expect(a!.item.status).toBe("needs-check");
    expect(a!.item.check?.conflictWith).toBe(B);
    const b = await knowledgeRepo.call("read", P, B, TODAY);
    expect(b!.item.check?.conflictWith).toBe(A);
  });
});
