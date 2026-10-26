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
  type RevalidateState,
} from "./revalidate";
import type { ReleaseInfo } from "./github";
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
    saved: 0,
    conflictMarks: {
      load: async () => marks.mark,
      save: async (mark: ConflictMark) => {
        marks.saved++;
        marks.mark = mark;
      },
      resolve: async (key: string) => {
        marks.mark = {
          commit: marks.mark?.commit ?? null,
          pending: marks.mark?.pending ?? [],
          resolved: [...(marks.mark?.resolved ?? []), key],
        };
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
    state: memoryRunState(),
    ...over,
  };
}

/** A run-state store kept in memory (never the catalog). */
function memoryRunState(): RevalidateDeps["state"] {
  let value: RevalidateState | null = null;
  return {
    load: async () => value,
    save: async (next) => {
      value = structuredClone(next);
    },
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
  const A = "articles/plans.md";
  const B = "articles/plans-old.md";
  let n = 0;

  /** A project of its own per test: two trusted answers that disagree. */
  async function seed(
    over: Partial<KnowledgeFrontMatter> = {},
  ): Promise<string> {
    const project = `acme-c${++n}`;
    await knowledgeRepo.call("ensureRepo", project);
    await knowledgeRepo.call(
      "write",
      project,
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
          fm: fm({
            title: "Which plans export CSV",
            topics: ["plans"],
            ...over,
          }),
          body: "Only the Pro plan can export CSV.\n",
        },
      ],
      { message: "Seed", author: ADA },
    );
    return project;
  }

  test("nothing written since the last run: no model call", async () => {
    const P = await seed();
    const marks = memoryMarks({
      commit: await knowledgeRepo.call("head", P),
      pending: [],
      resolved: [],
    });
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
    const P = await seed();
    const marks = memoryMarks();
    const result = await revalidateProject(P, {
      deps: deps({
        conflictMarks: marks.conflictMarks,
        classifyConflict: async () => null,
      }),
    });
    expect(result.conflicts).toEqual([]);
    expect(marks.mark!.pending.sort()).toEqual([A, B].sort());
    expect(marks.mark!.commit).toBe(await knowledgeRepo.call("head", P));
    const a = await knowledgeRepo.call("read", P, A, TODAY);
    expect(a!.item.status).toBe("active");
  });

  test("scope repo leaves the conflict check to the daily run", async () => {
    const P = await seed();
    const marks = memoryMarks();
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
    expect(marks.saved).toBe(0);
  });

  test("items that disagree both need a check", async () => {
    const P = await seed();
    const marks = memoryMarks();
    const result = await revalidateProject(P, {
      deps: deps({
        conflictMarks: marks.conflictMarks,
        classifyConflict: async () => "disagree",
      }),
    });
    expect(result.errors).toEqual([]);
    expect(result.conflicts).toEqual([{ a: B, b: A }]);
    expect(result.flipped).toEqual([
      { path: B, reason: "Disagrees with Plans with CSV export" },
      { path: A, reason: "Disagrees with Which plans export CSV" },
    ]);
    expect(marks.mark!.pending).toEqual([]);
    const a = await knowledgeRepo.call("read", P, A, TODAY);
    expect(a!.item.status).toBe("needs-check");
    expect(a!.item.check?.conflictWith).toBe(B);
    const b = await knowledgeRepo.call("read", P, B, TODAY);
    expect(b!.item.check?.conflictWith).toBe(A);
  });

  test("flipped lists only the items the conflict check wrote", async () => {
    const note = { reason: "Checked by hand", since: "2026-10-01" };
    const P = await seed({ status: "needs-check", check: note });
    const result = await revalidateProject(P, {
      deps: deps({
        conflictMarks: memoryMarks().conflictMarks,
        classifyConflict: async () => "disagree",
      }),
    });
    expect(result.flipped).toEqual([
      { path: A, reason: "Disagrees with Which plans export CSV" },
    ]);
    const b = await knowledgeRepo.call("read", P, B, TODAY);
    expect(b!.item.check).toEqual(note);
  });
});

describe("revalidateProject hardening", () => {
  let n = 0;
  const hRepo = (): Partial<RepoChangeDeps> => ({
    repo: (project) =>
      project.startsWith("acme-h")
        ? { dir: checkout, defaultBranch: "main" }
        : null,
  });

  /** A fresh project holding `files`. */
  async function seed(
    files: Array<{ path: string; fm: KnowledgeFrontMatter; body?: string }>,
  ): Promise<string> {
    const project = `acme-h${++n}`;
    await knowledgeRepo.call("ensureRepo", project);
    await knowledgeRepo.call(
      "write",
      project,
      files.map((f) => ({
        op: "put" as const,
        path: f.path,
        fm: f.fm,
        body: f.body ?? "Some text.\n",
      })),
      { message: "Seed", author: ADA },
    );
    return project;
  }

  function memoryState(start: RevalidateState | null = null) {
    const box = {
      value: start,
      state: {
        load: async () => box.value,
        save: async (value: RevalidateState) => {
          box.value = structuredClone(value);
        },
      },
    };
    return box;
  }

  function hdeps(over: Partial<RevalidateDeps> = {}) {
    return deps({
      repoChanges: hRepo(),
      fetchRepo: async () => true,
      state: memoryState().state,
      ...over,
    });
  }

  const NOW = Date.parse(`${TODAY}T09:00:00Z`);
  const V2: ReleaseInfo = {
    tag: "v2.0.0",
    name: "v2.0.0",
    at: "2026-10-24T09:00:00Z",
    body: "SSO now needs an admin.",
  };

  test("a failed fetch is an error; three days without one can't be checked", async () => {
    const project = await seed([
      {
        path: "articles/a.md",
        fm: fm({ dependsOn: ["repo:README.md"], validAsOfCommit: sha.c2 }),
      },
    ]);
    const box = memoryState({
      fetchedAt: "2026-10-25T09:00:00.000Z",
      unreadable: {},
      releaseClears: [],
    });
    const first = await revalidateProject(project, {
      deps: hdeps({
        now: () => NOW,
        state: box.state,
        fetchRepo: async () => false,
      }),
    });
    expect(first.errors).toEqual([
      "The code repository couldn't be fetched; checked against what was fetched on 2026-10-25",
    ]);
    expect(first.flipped).toEqual([]);
    expect(box.value!.fetchedAt).toBe("2026-10-25T09:00:00.000Z");

    const later = await revalidateProject(project, {
      deps: hdeps({
        now: () => NOW + 3 * 86_400_000,
        state: box.state,
        fetchRepo: async () => {
          throw new Error("network down");
        },
      }),
    });
    expect(later.flipped).toEqual([
      { path: "articles/a.md", reason: "Knowledge couldn't be checked" },
    ]);
    expect(later.errors).toContain(
      "articles/a.md: The code repository hasn't been fetched since 2026-10-25",
    );

    await revalidateProject(project, {
      deps: hdeps({ now: () => NOW + 4 * 86_400_000, state: box.state }),
    });
    expect(box.value!.fetchedAt).toBe(
      new Date(NOW + 4 * 86_400_000).toISOString(),
    );
  });

  test("without validAsOfCommit, commits from two days before validAsOf count", async () => {
    // docs/export.md changed on 2026-10-25; the item says it is valid as of
    // the 26th, but that day may not have seen the change land.
    const project = await seed([
      {
        path: "articles/a.md",
        fm: fm({ dependsOn: ["repo:docs/export.md"], validAsOf: TODAY }),
      },
    ]);
    const result = await revalidateProject(project, { deps: hdeps() });
    expect(result.flipped.map((f) => f.path)).toEqual(["articles/a.md"]);
  });

  test("a gone page flips at once; other unreadable pages after three runs", async () => {
    const GONE = "https://help.acme.example.test/gone";
    const FLAKY = "https://help.acme.example.test/flaky";
    const hash = "a".repeat(64);
    const project = await seed([
      {
        path: "articles/gone.md",
        fm: fm({
          sources: [`url:${GONE}#sha256=${hash}`],
          dependsOn: [`url:${GONE}`],
        }),
      },
      {
        path: "articles/flaky.md",
        fm: fm({
          sources: [`url:${FLAKY}#sha256=${hash}`],
          dependsOn: [`url:${FLAKY}`],
        }),
      },
    ]);
    const box = memoryState();
    const fetchPage = async (url: string) =>
      url === GONE
        ? { error: "The page answered 404" }
        : { error: "The page answered 503" };
    const runOnce = () =>
      revalidateProject(project, {
        deps: hdeps({ state: box.state, fetchPage, pageHash: undefined }),
      });
    const first = await runOnce();
    expect(first.flipped).toEqual([
      {
        path: "articles/gone.md",
        reason: `${GONE} can't be read any more: The page answered 404`,
      },
    ]);
    expect(box.value!.unreadable).toEqual({ [FLAKY]: 1 });
    expect((await runOnce()).flipped).toEqual([]);
    const third = await runOnce();
    expect(third.flipped).toEqual([
      { path: "articles/flaky.md", reason: "Knowledge couldn't be checked" },
    ]);
    expect(third.errors).toEqual([
      `articles/flaky.md: ${FLAKY} couldn't be read for 3 runs: The page answered 503`,
    ]);
  });

  test("a readable page resets its unreadable count", async () => {
    const PAGE2 = "https://help.acme.example.test/ok";
    const hash = "a".repeat(64);
    const project = await seed([
      {
        path: "articles/ok.md",
        fm: fm({
          sources: [`url:${PAGE2}#sha256=${hash}`],
          dependsOn: [`url:${PAGE2}`],
        }),
      },
    ]);
    const box = memoryState({
      unreadable: { [PAGE2]: 2 },
      releaseClears: [],
    });
    await revalidateProject(project, {
      deps: hdeps({
        state: box.state,
        pageHash: undefined,
        fetchPage: async (url) => ({ url, text: "Same.", hash }),
      }),
    });
    expect(box.value!.unreadable).toEqual({});
  });

  test("the release check sees the notes around each match and the matching section", async () => {
    const filler = "Faster sync. ".repeat(600);
    const project = await seed([
      {
        path: "articles/sso.md",
        fm: fm({ title: "Single sign-on", topics: ["sso"] }),
        body: `${"Intro text. ".repeat(400)}\n\n## Turning on SSO\n\nAsk an owner to open Settings.\n`,
      },
    ]);
    const asked: string[] = [];
    await revalidateProject(project, {
      deps: hdeps({
        releasesSince: async () => [
          { ...V2, body: `${filler}\nSSO now needs an admin.\n${filler}` },
        ],
        releaseMentions: undefined,
        askRelease: async (content) => {
          asked.push(content);
          return { route: "unrelated", confidence: "high" };
        },
      }),
    });
    expect(asked.length).toBe(1);
    expect(asked[0]).toContain("SSO now needs an admin.");
    expect(asked[0]).toContain("## Turning on SSO");
    expect(asked[0]).not.toContain("Intro text. Intro text.");
    expect(asked[0]!.length).toBeLessThan(8000);
  });

  test("matches past what can be sent are 'affects' without a model call", async () => {
    const many = Array.from(
      { length: 40 },
      (_, i) => `${"x".repeat(400)} sso change ${i}`,
    ).join("\n");
    const project = await seed([
      {
        path: "articles/sso.md",
        fm: fm({ title: "Single sign-on", topics: ["sso"] }),
      },
    ]);
    let calls = 0;
    const result = await revalidateProject(project, {
      deps: hdeps({
        releasesSince: async () => [{ ...V2, body: many }],
        releaseMentions: undefined,
        askRelease: async () => {
          calls++;
          return { route: "unrelated", confidence: "high" };
        },
      }),
    });
    expect(calls).toBe(0);
    expect(result.flipped).toEqual([
      { path: "articles/sso.md", reason: "Release v2.0.0 mentions sso" },
    ]);
  });

  test("a trusted item named by topic clears only on a high-confidence 'unrelated', once per release", async () => {
    const project = await seed([
      {
        path: "articles/low.md",
        fm: fm({ title: "Single sign-on", topics: ["sso"] }),
      },
      {
        path: "articles/high.md",
        fm: fm({ title: "Signing in with SSO", topics: ["sso"] }),
      },
      {
        path: "articles/ref.md",
        fm: fm({
          title: "Admin roles",
          trust: "reference",
          topics: ["roles"],
        }),
      },
    ]);
    const box = memoryState();
    let calls = 0;
    const run = () =>
      revalidateProject(project, {
        deps: hdeps({
          state: box.state,
          releasesSince: async () => [
            { ...V2, body: "SSO now needs an admin." },
          ],
          releaseMentions: undefined,
          askRelease: async (content) => {
            calls++;
            return content.includes("Signing in with SSO")
              ? { route: "unrelated", confidence: "high" }
              : { route: "unrelated", confidence: "low" };
          },
        }),
      });
    const first = await run();
    // "admin" is a title word of the reference item: a low-confidence
    // "unrelated" is enough there.
    expect(first.flipped).toEqual([
      { path: "articles/low.md", reason: "Release v2.0.0 mentions sso" },
    ]);
    expect(calls).toBe(3);
    await run();
    // high.md and ref.md were cleared for v2.0.0 at their blobs.
    expect(calls).toBe(3);
  });

  test("at most 20 model calls a run; past that items can't be checked", async () => {
    const project = await seed(
      Array.from({ length: 21 }, (_, i) => ({
        path: `articles/sso-${String(i).padStart(2, "0")}.md`,
        fm: fm({ title: `SSO ${i}`, topics: ["sso"] }),
      })),
    );
    let calls = 0;
    const result = await revalidateProject(project, {
      deps: hdeps({
        releasesSince: async () => [V2],
        releaseMentions: undefined,
        askRelease: async () => {
          calls++;
          return { route: "unrelated", confidence: "high" };
        },
      }),
    });
    expect(calls).toBe(20);
    expect(result.flipped).toEqual([
      { path: "articles/sso-20.md", reason: "Knowledge couldn't be checked" },
    ]);
    expect(result.errors).toEqual([
      "articles/sso-20.md: Too many release checks in one run",
    ]);
  });

  test("an item already waiting for a check is not evaluated again", async () => {
    const project = await seed([
      {
        path: "articles/waiting.md",
        fm: fm({
          status: "needs-check",
          check: { reason: "Earlier", since: "2026-10-01" },
          dependsOn: ["issue:9"],
        }),
      },
    ]);
    const result = await revalidateProject(project, {
      deps: hdeps({
        refState: async () => {
          throw new Error("must not be asked");
        },
      }),
    });
    expect(result.errors).toEqual([]);
    expect(result.flipped).toEqual([]);
  });

  test("a mirror whose own file didn't change flips instead of refreshing", async () => {
    const project = await seed([
      {
        path: repoItemPath("docs/guide.md"),
        fm: fm({
          title: "docs/guide.md",
          origin: "repo",
          sources: [`repo:docs/guide.md@${sha.c2}`],
          dependsOn: ["repo:docs/"],
          validAsOfCommit: sha.c2,
        }),
        body: "Guide.\n",
      },
    ]);
    const seeded = (await knowledgeRepo.call(
      "index.get",
      project,
      repoItemPath("docs/guide.md"),
      TODAY,
    ))!;
    const before = await knowledgeRepo.call(
      "readAt",
      project,
      seeded.path,
      seeded.commit,
    );
    const result = await revalidateProject(project, { deps: hdeps() });
    expect(result.refreshed).toBe(0);
    expect(result.flipped.map((f) => f.path)).toEqual([
      repoItemPath("docs/guide.md"),
    ]);
    const mirror = await knowledgeRepo.call(
      "read",
      project,
      repoItemPath("docs/guide.md"),
    );
    expect(mirror!.item.status).toBe("needs-check");
    expect(mirror!.body.trim()).toBe("Guide.");
    // Written from the git blob: the file keeps its exact text.
    const atGit = await knowledgeRepo.call(
      "readAt",
      project,
      repoItemPath("docs/guide.md"),
      mirror!.item.commit,
    );
    expect(atGit!.body).toBe(before!.body);
  });

  test("a write that fails for another reason is retried with only the flips", async () => {
    const hash = "a".repeat(64);
    const project = await seed([
      {
        path: WEB,
        fm: fm({
          title: "Export",
          origin: "web",
          sources: [`url:${PAGE}#sha256=${hash}`],
          dependsOn: [`url:${PAGE}`],
        }),
      },
      {
        path: "articles/b.md",
        fm: fm({ reviewBy: "2026-10-01" }),
      },
    ]);
    const writes: string[][] = [];
    const result = await revalidateProject(project, {
      deps: hdeps({
        pageHash: async () => "b".repeat(64),
        fetchPage: async (url) => ({ url, text: "New.", hash: "b".repeat(64) }),
        write: async (p, changes, opts) => {
          writes.push(changes.map((c) => ("path" in c ? c.path : "")));
          if (writes.length === 1) throw new Error("disk full");
          return knowledgeRepo.call("write", p, changes, opts);
        },
      }),
    });
    expect(writes).toEqual([["articles/b.md", WEB], ["articles/b.md"]]);
    expect(result.refreshed).toBe(0);
    expect(result.flipped).toEqual([
      { path: "articles/b.md", reason: "Review date passed (2026-10-01)" },
    ]);
    expect(result.errors).toEqual([
      "Writing the refreshed mirrors failed: disk full",
    ]);
  });
});
