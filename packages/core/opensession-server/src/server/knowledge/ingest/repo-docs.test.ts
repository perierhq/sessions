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
import { frontMatterOf } from "../freshness/revalidate";
import { releaseItemPath, repoItemPath } from "../layout";
import { KnowledgeService } from "../service";
import {
  __waitForJobForTest,
  CANCELLED_COPY,
  cancelJob,
  DEADLINE_COPY,
  listJobs,
} from "./jobs";
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

/** A person's edit of an item: its status set, text kept. */
async function personSets(path: string, status: "retired" | "active") {
  const current = (await read(path))!;
  const { check: _check, ...fm } = frontMatterOf(current.item);
  await knowledgeRepo.call(
    "write",
    "acme",
    [{ op: "put", path, fm: { ...fm, status }, body: current.body }],
    {
      message: "Ada's edit",
      author: { name: "Ada" },
      expected: { [path]: current.item.blob },
    },
  );
}

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

  test("a Git LFS pointer is skipped", async () => {
    await put(
      "docs/video.md",
      "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n",
    );
    await commit("lfs", "2026-10-21T09:00:00Z");
    try {
      const result = await mirrorRepoDocs("acme", deps());
      expect(result.skipped).toBe(3);
      expect(await read(repoItemPath("docs/video.md"))).toBeNull();
    } finally {
      await run(work, ["rm", "-q", "--", "docs/video.md"]);
      await commit("drop lfs", "2026-10-21T10:00:00Z");
    }
  });

  test("stops at maxFiles and says it was cut, retiring nothing it didn't read", async () => {
    await mirrorRepoDocs("acme", deps());
    const result = await mirrorRepoDocs("acme", deps({ maxFiles: 1 }));
    expect(result.truncated).toBe(true);
    expect(result.retired).toBe(0);
    const full = await mirrorRepoDocs("acme", deps());
    expect(full.truncated).toBe(false);
  });

  test("stops at maxBytes", async () => {
    const result = await mirrorRepoDocs("acme", deps({ maxBytes: 40 }));
    expect(result.truncated).toBe(true);
    expect(result.written).toBeLessThan(4);
  });

  test("a file now holding a credential flips its mirror to needs-check, text kept", async () => {
    await mirrorRepoDocs("acme", deps());
    const path = repoItemPath("docs/export.md");
    const before = (await read(path))!;
    await put(
      "docs/export.md",
      "# Exporting a project\n\nghp_0123456789abcdefghijklmnopqrstuvwxyzAB\n",
    );
    await commit("leak", "2026-10-22T09:00:00Z");
    try {
      const result = await mirrorRepoDocs("acme", deps());
      expect(result.skipped).toBe(3);
      const after = (await read(path))!;
      expect(after.item.status).toBe("needs-check");
      expect(after.item.check?.reason).toContain("credential");
      expect(after.item.check?.since).toBe(TODAY);
      expect(after.body).toBe(before.body);
      // Already waiting for a person: a rerun writes nothing more.
      const again = await commits();
      await mirrorRepoDocs("acme", deps());
      expect(await commits()).toBe(again);
    } finally {
      await put(
        "docs/export.md",
        "# Exporting a project\n\nOpen the project, press Export, pick CSV.\n",
      );
      await commit("restore export", "2026-10-23T09:00:00Z");
    }
  });

  test("a mirror a person edited last is left alone and counted", async () => {
    await mirrorRepoDocs("acme", deps());
    const path = repoItemPath("docs/export.md");
    await personSets(path, "retired");
    await put(
      "docs/export.md",
      "# Exporting a project\n\nOpen the project, press Export, pick JSON.\n",
    );
    await commit("json", "2026-10-22T09:00:00Z");
    try {
      const result = await mirrorRepoDocs("acme", deps());
      expect(result.written).toBe(0);
      expect(result.skipped).toBe(3);
      const after = (await read(path))!;
      expect(after.item.status).toBe("retired");
      expect(after.body).not.toContain("JSON");
    } finally {
      await put(
        "docs/export.md",
        "# Exporting a project\n\nOpen the project, press Export, pick CSV.\n",
      );
      await commit("restore export", "2026-10-23T09:00:00Z");
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

  test("a release gone from GitHub is retired; one past the newest 30 is not", async () => {
    await mirrorReleases("acme", deps());
    const listed = Array.from({ length: 31 }, (_, i) => release(i + 1));
    const result = await mirrorReleases(
      "acme",
      deps({ releases: async () => listed.filter((r) => r.tag !== "v1.31.0") }),
    );
    expect(result.retired).toBe(1);
    expect((await read(releaseItemPath("v1.31.0")))?.item.status).toBe(
      "retired",
    );
    // v1.1.0 is now among the newest 30; v1.2.0 stays.
    expect(result.written).toBe(1);
    expect((await read(releaseItemPath("v1.2.0")))?.item.status).toBe("active");
    // No GitHub repository any more: nothing is retired.
    const none = await mirrorReleases(
      "acme",
      deps({ releases: async () => null }),
    );
    expect(none.retired).toBe(0);
  });

  test("a release a person edited last is left alone", async () => {
    await mirrorReleases("acme", deps());
    const path = releaseItemPath("v1.31.0");
    await personSets(path, "retired");
    const result = await mirrorReleases("acme", deps());
    expect(result.written).toBe(0);
    expect(result.skipped).toBe(1);
    expect((await read(path))?.item.status).toBe("retired");
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

  test("a cancelled import ends Cancelled. and writes no releases", async () => {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    let asked!: () => void;
    const reading = new Promise<void>((resolve) => (asked = resolve));
    const job = await startRepoImport(
      { project: "acme", by: { name: "Ada" } },
      deps({
        releases: async () => {
          asked();
          await opened;
          return [release(1)];
        },
      }),
    );
    await reading;
    await cancelJob("acme", job.id);
    open();
    await __waitForJobForTest(job.id);
    const [done] = await listJobs("acme");
    expect(done).toMatchObject({ state: "failed", error: CANCELLED_COPY });
    expect(await read(releaseItemPath("v1.1.0"))).toBeNull();
  });

  test("an import past its deadline stops", async () => {
    const job = await startRepoImport(
      { project: "acme", by: { name: "Ada" } },
      deps({ deadlineMs: 0 }),
    );
    await __waitForJobForTest(job.id);
    const [done] = await listJobs("acme");
    expect(done).toMatchObject({ state: "failed", error: DEADLINE_COPY });
  });

  test("a job cut at maxFiles is marked truncated", async () => {
    const job = await startRepoImport(
      { project: "acme", by: { name: "Ada" } },
      deps({ maxFiles: 1 }),
    );
    await __waitForJobForTest(job.id);
    const [done] = await listJobs("acme");
    expect(done).toMatchObject({ state: "done", truncated: true });
  });
});
