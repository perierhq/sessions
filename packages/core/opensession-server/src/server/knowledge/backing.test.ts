import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KNOWLEDGE_COPY,
  type KnowledgeFrontMatter,
} from "../../shared/knowledge";
import type { DraftSource } from "../../shared/support";
import { git, isolatedGitEnv } from "../memory-repo/git";
import { MemoryRepoError } from "../memory-repo/git-store";
import {
  __resetSupportEvidenceForTest,
  recordKnowledgeSeen,
} from "../support/evidence";
import {
  type BackingDeps,
  type VerdictInput,
  __setKnowledgeVerdictForTest,
  knowledgeVerdict,
} from "./backing";
import { __setKnowledgeServiceForTest } from "./client";
import { KnowledgeService } from "./service";

const ADA = { name: "Ada", email: "ada@example.test" };
const NOW = Date.parse("2026-10-25T10:00:00.000Z");
const SESSION = "os-1";

let base: string;
let code: string;
let service: KnowledgeService;
let deps: Partial<BackingDeps>;
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

/** A commit on the code repository's default branch, as fetched. */
async function codeCommit(file: string, text: string, date: string) {
  await mkdir(join(code, file, ".."), { recursive: true });
  await writeFile(join(code, file), text);
  await run(code, ["add", "--", file]);
  await run(code, ["commit", "-q", "-m", `edit ${file}`], date);
  await run(code, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  return run(code, ["rev-parse", "HEAD"]);
}

function fm(over: Partial<KnowledgeFrontMatter> = {}): KnowledgeFrontMatter {
  return {
    title: "Export",
    kind: "answer",
    trust: "trusted",
    status: "active",
    origin: "article",
    topics: ["export"],
    sources: [],
    dependsOn: ["repo:docs/export.md"],
    validAsOf: "2026-10-20",
    validAsOfCommit: sha.c2,
    ...over,
  };
}

/** A project whose knowledge repo holds `items`; returns the new HEAD. The
 *  session read every item at it. */
async function project(
  name: string,
  items: Record<string, Partial<KnowledgeFrontMatter>>,
): Promise<string> {
  await service.ensureRepo(name);
  const head = (await service.write(
    name,
    Object.entries(items).map(([path, over]) => ({
      op: "put" as const,
      path,
      fm: fm(over),
      body: "Open the project, choose Export, then CSV.\n",
    })),
    { message: "Add articles", author: ADA },
  ))!;
  for (const path of Object.keys(items))
    recordKnowledgeSeen(SESSION, path, head);
  return head;
}

const cite = (
  path: string,
  commit: string,
): { kind: "knowledge"; ref: string } => ({
  kind: "knowledge",
  ref: `${path}@${commit}`,
});

function input(
  name: string,
  sources: DraftSource[],
  over: Partial<VerdictInput> = {},
): VerdictInput {
  return {
    project: name,
    sessionId: SESSION,
    sources,
    text: "Open the project, choose Export.",
    now: NOW,
    ...over,
  };
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "kn-backing-"));
  code = join(base, "code");
  await mkdir(code);
  await run(code, ["init", "-q", "-b", "main"]);
  sha.c1 = await codeCommit("docs/export.md", "v1\n", "2026-08-01T10:00:00Z");
  sha.c2 = await codeCommit("docs/export.md", "v2\n", "2026-10-06T10:00:00Z");
  service = new KnowledgeService({ base: join(base, "memory") });
  __setKnowledgeServiceForTest(service);
  deps = {
    repo: { repo: () => ({ dir: code, defaultBranch: "main" }) },
    refState: async () => ({ state: "open", at: null }),
  };
});

afterEach(() => {
  __setKnowledgeVerdictForTest(undefined);
});

afterAll(async () => {
  __setKnowledgeServiceForTest(null);
  __resetSupportEvidenceForTest();
  service.close();
  await rm(base, { recursive: true, force: true });
});

test("a fresh trusted article the session read backs the reply", async () => {
  const head = await project("acme-fresh", { "articles/export.md": {} });
  const v = await knowledgeVerdict(
    input("acme-fresh", [cite("articles/export.md", head)]),
    deps,
  );
  expect(v).toEqual({
    backing: [{ kind: "knowledge", ref: `articles/export.md@${head}` }],
    blocked: [],
    internalQuoted: null,
    failed: false,
    at: new Date(NOW).toISOString(),
  });
  // The seven hex search_knowledge prints name the same commit.
  const short = await knowledgeVerdict(
    input("acme-fresh", [cite("articles/export.md", head.slice(0, 7))]),
    deps,
  );
  expect(short?.backing).toHaveLength(1);
});

test("citation of an older blob is blocked", async () => {
  const read = await project("acme-edited", { "articles/export.md": {} });
  await service.write(
    "acme-edited",
    [
      {
        op: "put",
        path: "articles/export.md",
        fm: fm(),
        body: "Export moved to Settings.\n",
      },
    ],
    { message: "Edit export", author: ADA },
  );
  const v = await knowledgeVerdict(
    input("acme-edited", [cite("articles/export.md", read)]),
    deps,
  );
  expect(v?.backing).toEqual([]);
  expect(v?.blocked).toEqual([
    {
      ref: `articles/export.md@${read}`,
      path: "articles/export.md",
      title: "Export",
      reason: KNOWLEDGE_COPY.changedSinceRead,
    },
  ]);
});

test("an unrelated later commit leaves an unchanged article backing", async () => {
  const read = await project("acme-later", { "articles/export.md": {} });
  await service.write(
    "acme-later",
    [{ op: "put", path: "articles/other.md", fm: fm(), body: "Other.\n" }],
    { message: "Add other", author: ADA },
  );
  const v = await knowledgeVerdict(
    input("acme-later", [cite("articles/export.md", read)]),
    deps,
  );
  expect(v?.backing).toHaveLength(1);
});

test("each article that may not back says why, in order", async () => {
  const head = await project("acme-reasons", {
    "articles/reference.md": { title: "Reference", trust: "reference" },
    "articles/overdue.md": { title: "Overdue", reviewBy: "2026-10-01" },
    "articles/checked.md": {
      title: "Checked",
      status: "needs-check",
      check: {
        reason: "docs/export.md changed in 9c1d2e0",
        since: "2026-10-24",
      },
    },
    "articles/retired.md": { title: "Retired one", status: "retired" },
    "articles/stale.md": { title: "Stale", validAsOfCommit: sha.c1 },
    "articles/today.md": { title: "Today", reviewBy: "2026-10-25" },
  });
  const paths = [
    "articles/reference.md",
    "articles/overdue.md",
    "articles/checked.md",
    "articles/retired.md",
    "articles/stale.md",
    "articles/today.md",
  ];
  const v = await knowledgeVerdict(
    input(
      "acme-reasons",
      paths.map((p) => cite(p, head)),
    ),
    deps,
  );
  expect(v?.failed).toBe(false);
  expect(v?.backing).toEqual([cite("articles/today.md", head)]);
  expect(v?.blocked.map((b) => [b.title, b.reason])).toEqual([
    ["Reference", KNOWLEDGE_COPY.notTrusted],
    ["Overdue", KNOWLEDGE_COPY.reviewPassed("2026-10-01")],
    ["Checked", "docs/export.md changed in 9c1d2e0"],
    ["Retired one", "Retired"],
    ["Stale", `docs/export.md changed in ${sha.c2!.slice(0, 7)}`],
  ]);
});

test("an article without validAsOfCommit counts changes from its day on", async () => {
  const head = await project("acme-day", {
    "articles/old.md": { validAsOfCommit: undefined, validAsOf: "2026-09-01" },
    "articles/new.md": { validAsOfCommit: undefined, validAsOf: "2026-10-07" },
  });
  const v = await knowledgeVerdict(
    input("acme-day", [
      cite("articles/old.md", head),
      cite("articles/new.md", head),
    ]),
    deps,
  );
  expect(v?.backing).toEqual([cite("articles/new.md", head)]);
  expect(v?.blocked[0]?.reason).toBe(
    `docs/export.md changed in ${sha.c2!.slice(0, 7)}`,
  );
});

test("a closed issue it depends on blocks it; GitHub is read fresh", async () => {
  const head = await project("acme-issue", {
    "articles/known.md": {
      title: "Known",
      dependsOn: ["repo:docs/export.md", "issue:42"],
    },
  });
  const asked: unknown[] = [];
  const v = await knowledgeVerdict(
    input("acme-issue", [cite("articles/known.md", head)]),
    {
      ...deps,
      refState: async (project, ref, opts) => {
        asked.push([project, ref, opts]);
        return { state: "closed", at: "2026-10-22T08:00:00Z" };
      },
    },
  );
  expect(v?.blocked.map((b) => b.reason)).toEqual(["Issue #42 was closed"]);
  expect(asked).toEqual([
    ["acme-issue", { type: "issue", number: 42 }, { fresh: true }],
  ]);
  // Unreadable: can't tell, so the check fails closed.
  const unread = await knowledgeVerdict(
    input("acme-issue", [cite("articles/known.md", head)]),
    { ...deps, refState: async () => null },
  );
  expect(unread?.failed).toBe(true);
});

test("an item this session didn't read is blocked", async () => {
  const head = await project("acme-unread", { "articles/export.md": {} });
  const other = await knowledgeVerdict(
    input("acme-unread", [cite("articles/export.md", head)], {
      sessionId: "os-2",
    }),
    deps,
  );
  expect(other?.blocked.map((b) => b.reason)).toEqual([KNOWLEDGE_COPY.notRead]);
  const none = await knowledgeVerdict(
    input("acme-unread", [cite("articles/export.md", head)], {
      sessionId: null,
    }),
    deps,
  );
  expect(none?.blocked.map((b) => b.reason)).toEqual([KNOWLEDGE_COPY.notRead]);
});

test("a citation that names nothing in knowledge is not found", async () => {
  const head = await project("acme-missing", { "articles/export.md": {} });
  const v = await knowledgeVerdict(
    input("acme-missing", [
      { kind: "knowledge", ref: "../x@abc1234" },
      cite("articles/nope.md", head),
      cite("articles/export.md", "deadbeef00"),
      cite("articles/export.md", "abc1234"),
    ]),
    deps,
  );
  expect(v?.failed).toBe(false);
  expect(v?.blocked.map((b) => b.reason)).toEqual([
    "Not found in knowledge",
    "Not found in knowledge",
    "Not found in knowledge",
    "Not found in knowledge",
  ]);
  expect(v?.blocked[0]?.ref).toBe("../x@abc1234");
});

test("service error fails closed", async () => {
  const head = await project("acme-down", { "articles/export.md": {} });
  const down: Partial<BackingDeps> = {
    ...deps,
    call: (async () => {
      throw new MemoryRepoError("The memory worker is unavailable.", 503);
    }) as unknown as BackingDeps["call"],
  };
  expect(
    await knowledgeVerdict(
      input("acme-down", [cite("articles/export.md", head)]),
      down,
    ),
  ).toEqual({
    backing: [],
    blocked: [],
    internalQuoted: null,
    failed: true,
    at: new Date(NOW).toISOString(),
  });
  // Nothing cited, but the project may have knowledge: still unchecked.
  expect((await knowledgeVerdict(input("acme-down", []), down))?.failed).toBe(
    true,
  );
  // The code repository can't be read: fails closed too.
  const gone = await knowledgeVerdict(
    input("acme-down", [cite("articles/export.md", head)]),
    { ...deps, repo: { repo: () => null } },
  );
  expect(gone?.failed).toBe(true);
});

test("no knowledge repo and no knowledge cited: no verdict", async () => {
  expect(
    await knowledgeVerdict(
      input("acme-none", [{ kind: "repo", ref: "docs/export.md" }]),
      deps,
    ),
  ).toBeNull();
  // A project with knowledge always gets a verdict.
  await project("acme-has", { "articles/export.md": {} });
  expect(await knowledgeVerdict(input("acme-has", []), deps)).toEqual({
    backing: [],
    blocked: [],
    internalQuoted: null,
    failed: false,
    at: new Date(NOW).toISOString(),
  });
  // Cited without a repository: not found.
  const v = await knowledgeVerdict(
    input("acme-none", [cite("articles/export.md", "abc1234")]),
    deps,
  );
  expect(v?.blocked.map((b) => b.reason)).toEqual(["Not found in knowledge"]);
});

test("a test override replaces the verdict", async () => {
  __setKnowledgeVerdictForTest(async () => null);
  expect(
    await knowledgeVerdict(
      input("acme-fresh", [cite("articles/x.md", "abc1234")]),
    ),
  ).toBeNull();
});
