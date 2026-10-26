import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, isolatedGitEnv } from "../../memory-repo/git";
import { useSupportTestKernel } from "../../support/testing/kernel-fixture";
import { __setKnowledgeServiceForTest, knowledgeRepo } from "../client";
import type { ReleaseInfo } from "../freshness/github";
import type { RepoChangeDeps } from "../freshness/repo-changes";
import { releaseItemPath, repoItemPath } from "../layout";
import { KnowledgeService } from "../service";
import { __waitForJobForTest, listJobs } from "./jobs";
import {
  mirrorReleases,
  mirrorRepoDocs,
  type RepoDocsDeps,
  startRepoImport,
} from "./repo-docs";

const kernel = useSupportTestKernel();
const TODAY = "2026-10-26";

let repoBase: string;
let work: string;
let checkout: string;
let head: string;

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

async function put(file: string, text: string) {
  await mkdir(join(work, file, ".."), { recursive: true });
  await writeFile(join(work, file), text);
  await run(work, ["add", "--", file]);
}

async function commit(message: string, date: string) {
  await run(work, ["commit", "-q", "-m", message], date);
  await run(work, ["push", "-q", "origin", "main"]);
  return run(work, ["rev-parse", "HEAD"]);
}

beforeAll(async () => {
  repoBase = await mkdtemp(join(tmpdir(), "kn-repo-docs-"));
  const origin = join(repoBase, "origin.git");
  work = join(repoBase, "work");
  checkout = join(repoBase, "checkout");
  await run(repoBase, ["init", "-q", "--bare", "-b", "main", origin]);
  await run(repoBase, ["clone", "-q", origin, work]);
  await run(work, ["checkout", "-q", "-b", "main"]);
  await put("README.md", "# Acme\n\nAcme exports projects.\n");
  await put(
    "docs/export.md",
    "# Exporting a project\n\nOpen the project, press Export, pick CSV.\n",
  );
  await put("docs/old.md", "# Old export\n\nUse the old menu.\n");
  await put(
    "docs/incidents/db.md",
    "# Database failover\n\nPromote the replica first.\n",
  );
  await put("docs/notes.txt", "Not Markdown.\n");
  await put("src/a.ts", "export const a = 1;\n");
  await put(
    "docs/token.md",
    "# Token\n\nghp_0123456789abcdefghijklmnopqrstuvwxyzAB\n",
  );
  await put("docs/big.md", `# Big\n\n${"x".repeat(300 * 1024)}\n`);
  head = await commit("docs", "2026-10-20T09:00:00Z");
  await run(repoBase, ["clone", "-q", origin, checkout]);
});

afterAll(async () => {
  await rm(repoBase, { recursive: true, force: true });
});

let service: KnowledgeService;

beforeEach(async () => {
  service = new KnowledgeService({ base: join(kernel.root(), "memory") });
  __setKnowledgeServiceForTest(service);
  await knowledgeRepo.call("ensureRepo", "acme");
});

afterEach(() => {
  __setKnowledgeServiceForTest(null);
  service.close();
});

function release(n: number): ReleaseInfo {
  const day = String(n).padStart(2, "0");
  return {
    tag: `v1.${n}.0`,
    name: `Acme 1.${n}`,
    at: `2026-08-${day}T12:00:00Z`,
    body: `Changes in 1.${n}.`,
  };
}

function deps(over: Partial<RepoDocsDeps> = {}): Partial<RepoDocsDeps> {
  const repoChanges: Partial<RepoChangeDeps> = {
    repo: (project) =>
      project === "acme" ? { dir: checkout, defaultBranch: "main" } : null,
    serialize: (fn) => fn(),
  };
  return {
    today: () => TODAY,
    repoChanges,
    // 31 releases, oldest first: only the newest 30 are mirrored.
    releases: async () => Array.from({ length: 31 }, (_, i) => release(i + 1)),
    ...over,
  };
}

const read = (path: string) => knowledgeRepo.call("read", "acme", path, TODAY);
const commits = async () =>
  (await knowledgeRepo.call("history", "acme", undefined, 100)).length;

describe("repo docs mirror", () => {
  test("mirrors README.md and docs/**/*.md, runbooks as internal", async () => {
    const result = await mirrorRepoDocs("acme", deps());
    expect(result.written).toBe(4);
    expect(result.skipped).toBe(2);

    const exported = await read(repoItemPath("docs/export.md"));
    expect(exported?.item).toMatchObject({
      title: "Exporting a project",
      kind: "answer",
      trust: "trusted",
      status: "active",
      origin: "repo",
      sources: [`repo:docs/export.md@${head}`],
      dependsOn: ["repo:docs/export.md"],
      validAsOf: "2026-10-20",
      validAsOfCommit: head,
    });
    expect(exported?.body).toContain("Open the project, press Export");
    expect((await read(repoItemPath("README.md")))?.item.title).toBe("Acme");
    expect((await read(repoItemPath("docs/incidents/db.md")))?.item.kind).toBe(
      "internal",
    );
    // Code, non-Markdown docs, a credential and an oversize file stay out.
    expect(await read(repoItemPath("src/a.ts"))).toBeNull();
    expect(await read(repoItemPath("docs/notes.txt"))).toBeNull();
    expect(await read(repoItemPath("docs/token.md"))).toBeNull();
    expect(await read(repoItemPath("docs/big.md"))).toBeNull();

    const history = await knowledgeRepo.call("history", "acme", undefined, 5);
    expect(history[0]!.author).toBe("Pat");
  });

  test("re-running at the same head makes no commit", async () => {
    await mirrorRepoDocs("acme", deps());
    const before = await commits();
    const again = await mirrorRepoDocs("acme", deps());
    expect(again.written).toBe(0);
    expect(await commits()).toBe(before);
  });

  test("a doc deleted upstream retires its item, text kept", async () => {
    await mirrorRepoDocs("acme", deps());
    const path = repoItemPath("docs/old.md");
    const before = await read(path);
    await run(work, ["rm", "-q", "--", "docs/old.md"]);
    await commit("drop old", "2026-10-22T09:00:00Z");
    try {
      const result = await mirrorRepoDocs("acme", deps());
      expect(result.retired).toBe(1);
      const after = await read(path);
      expect(after?.item.status).toBe("retired");
      expect(after?.item.check).toBeUndefined();
      expect(after?.body).toBe(before!.body);
      expect((await read(repoItemPath("docs/export.md")))?.item.status).toBe(
        "active",
      );
    } finally {
      await put("docs/old.md", "# Old export\n\nUse the old menu.\n");
      await commit("restore old", "2026-10-23T09:00:00Z");
    }
  });

  test("an unconfigured project fails, nothing written", async () => {
    await expect(
      mirrorRepoDocs("acme", deps({ repoChanges: { repo: () => null } })),
    ).rejects.toThrow("can't be read");
  });
});

describe("releases mirror", () => {
  test("writes the newest 30 releases at their tag paths", async () => {
    const result = await mirrorReleases("acme", deps());
    expect(result.written).toBe(30);
    const newest = await read(releaseItemPath("v1.31.0"));
    expect(newest?.item).toMatchObject({
      title: "Acme 1.31",
      kind: "answer",
      trust: "trusted",
      status: "active",
      origin: "release",
      sources: ["release:v1.31.0"],
      validAsOf: "2026-08-31",
    });
    expect(newest?.body).toContain("Changes in 1.31.");
    expect(await read(releaseItemPath("v1.2.0"))).not.toBeNull();
    expect(await read(releaseItemPath("v1.1.0"))).toBeNull();

    const before = await commits();
    expect((await mirrorReleases("acme", deps())).written).toBe(0);
    expect(await commits()).toBe(before);
  });

  test("no GitHub repository: nothing to mirror", async () => {
    expect(
      (await mirrorReleases("acme", deps({ releases: async () => null })))
        .written,
    ).toBe(0);
  });
});

describe("repo import job", () => {
  test("runs docs and releases as one job", async () => {
    const job = await startRepoImport(
      { project: "acme", by: { name: "Ada" } },
      deps(),
    );
    expect(job.kind).toBe("repo");
    await __waitForJobForTest(job.id);
    const [done] = await listJobs("acme");
    expect(done).toMatchObject({
      kind: "repo",
      state: "done",
      created: { trusted: 34, reference: 0, suggestions: 0, skipped: 2 },
    });
  });
});
