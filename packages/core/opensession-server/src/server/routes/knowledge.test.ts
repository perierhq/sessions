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
import { dirname, join } from "node:path";
import type {
  KnowledgeFrontMatter,
  KnowledgeImportJob,
  KnowledgeItem,
} from "../../shared/knowledge";
import { git } from "../memory-repo/git";
import { __setKnowledgeServiceForTest } from "../knowledge/client";
import { __waitForJobForTest } from "../knowledge/ingest/jobs";
import { MemoryRepoError } from "../memory-repo/git-store";
import { KnowledgeService } from "../knowledge/service";
import { __setInboxProjectCheckForTest } from "../support/inboxes";
import { __setEmailSupportEnabledForTest } from "../support/enabled";
import { useSupportTestKernel } from "../support/testing/kernel-fixture";
import type { RouteContext } from "./context";
import { routeHandlers } from "./index";
import {
  __setKnowledgeRouteDepsForTest,
  handleKnowledgeRoutes,
} from "./knowledge";

useSupportTestKernel();

const ADA = { login: "ada", name: "Ada Lovelace" };
const AUTOMATION = {
  login: "automation",
  name: "Automation",
  automation: true,
};
const TODAY = "2026-10-26";

function fm(over: Partial<KnowledgeFrontMatter> = {}): KnowledgeFrontMatter {
  return {
    title: "Exporting a project as CSV",
    kind: "answer",
    trust: "trusted",
    status: "active",
    origin: "article",
    topics: ["export", "csv"],
    sources: [],
    dependsOn: ["repo:docs/export.md"],
    validAsOf: "2026-10-20",
    ...over,
  };
}

let base: string;
let code: string;
let service: KnowledgeService;
/** The code repository's commits: the old export doc, then the new one. */
let oldSha: string;
let newSha: string;

async function commitCode(path: string, text: string): Promise<string> {
  await mkdir(dirname(join(code, path)), { recursive: true });
  await writeFile(join(code, path), text);
  await git(["add", "-A"], { cwd: code });
  await git(
    [
      "-c",
      "user.name=Dev",
      "-c",
      "user.email=dev@example.test",
      "commit",
      "--quiet",
      "-m",
      `Change ${path}`,
    ],
    { cwd: code },
  );
  return (await git(["rev-parse", "HEAD"], { cwd: code })).stdout.trim();
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "knowledge-routes-"));
  code = join(base, "code");
  await mkdir(code, { recursive: true });
  await git(["init", "--quiet", "-b", "main"], { cwd: code });
  oldSha = await commitCode("docs/export.md", "Export from the menu.\n");
  newSha = await commitCode("docs/export.md", "Export from Settings.\n");
  // The fetched default branch the freshness reads look at.
  await git(["update-ref", "refs/remotes/origin/main", newSha], { cwd: code });
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

let jobs: Array<Record<string, unknown>>;

beforeEach(async () => {
  service = new KnowledgeService({
    base: await mkdtemp(join(base, "state-")),
  });
  __setKnowledgeServiceForTest(service);
  __setEmailSupportEnabledForTest(true);
  __setInboxProjectCheckForTest((id) => id === "acme" || id === "acme-api");
  jobs = [];
  __setKnowledgeRouteDepsForTest({
    today: () => TODAY,
    repoChanges: {
      repo: (project) =>
        project === "acme" ? { dir: code, defaultBranch: "main" } : null,
    },
    inboxProject: async (id) =>
      id === "inb_acme" ? "acme" : id === "inb_api" ? "acme-api" : null,
    startImport: async (request) => {
      jobs.push(request as unknown as Record<string, unknown>);
      return {
        id: `job_${jobs.length}`,
        project: request.project,
        kind: request.kind,
        state: "queued",
        startedAt: `${TODAY}T00:00:00.000Z`,
        done: 0,
        total: null,
        created: { trusted: 0, reference: 0, suggestions: 0, skipped: 0 },
        options: request.options,
      } satisfies KnowledgeImportJob;
    },
  });
});

afterEach(() => {
  __setKnowledgeRouteDepsForTest(undefined);
  __setInboxProjectCheckForTest(undefined);
  __setEmailSupportEnabledForTest(undefined);
  __setKnowledgeServiceForTest(null);
  service.close();
});

async function call(
  method: string,
  path: string,
  opts: {
    body?: unknown;
    form?: FormData;
    auth?: RouteContext["authUser"];
  } = {},
): Promise<Response> {
  const url = new URL(`http://localhost${path}`);
  const init: RequestInit = { method };
  if (opts.form) init.body = opts.form;
  else if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    init.headers = { "content-type": "application/json" };
  }
  const response = await handleKnowledgeRoutes({
    req: new Request(url, init),
    url,
    path: url.pathname,
    publicPrefix: "/backstage",
    authUser: opts.auth === undefined ? ADA : opts.auth,
  });
  if (!response) throw new Error(`${method} ${path} wasn't handled`);
  return response;
}

const PAT = { name: "Pat" };
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1,
]);

function frontMatter(item: KnowledgeItem): KnowledgeFrontMatter {
  const {
    project: _project,
    path: _path,
    blob: _blob,
    commit: _commit,
    updatedAt: _updatedAt,
    effective: _effective,
    excerpt: _excerpt,
    ...rest
  } = item;
  return rest;
}

/** Commit items as ingestion would, straight through the service. */
async function seed(
  files: Array<{ path: string; fm: KnowledgeFrontMatter; body: string }>,
): Promise<void> {
  await service.ensureRepo("acme");
  await service.write(
    "acme",
    files.map((f) => ({ op: "put" as const, ...f })),
    { message: "Seed", author: PAT, trailers: ["Suggested-by: Pat"] },
  );
}

async function lastCommit(): Promise<{ author: string; message: string }> {
  const { stdout } = await git([
    "--git-dir",
    join(service.opts.base, "repos", "knowledge-acme.git"),
    "log",
    "-1",
    "--format=%an%x00%B",
    "main",
  ]);
  const [author, message] = stdout.split("\0");
  return { author: author!, message: message!.trim() };
}

async function commitCount(): Promise<number> {
  const { stdout } = await git([
    "--git-dir",
    join(service.opts.base, "repos", "knowledge-acme.git"),
    "rev-list",
    "--count",
    "main",
  ]);
  return Number(stdout.trim());
}

describe("/api/knowledge access", () => {
  test("is registered in the route chain", () => {
    expect(routeHandlers).toContain(handleKnowledgeRoutes);
  });

  test("a signed-out request answers 401", async () => {
    const response = await call("GET", "/api/knowledge/acme", { auth: null });
    expect(response.status).toBe(401);
  });

  test("an automation principal answers 401", async () => {
    const response = await call("GET", "/api/knowledge/acme", {
      auth: AUTOMATION,
    });
    expect(response.status).toBe(401);
  });

  test("email support off answers 404", async () => {
    __setEmailSupportEnabledForTest(false);
    const response = await call("GET", "/api/knowledge/acme");
    expect(response.status).toBe(404);
  });

  test("an unknown project answers 404", async () => {
    const response = await call("GET", "/api/knowledge/nope");
    expect(response.status).toBe(404);
  });

  test("a project without knowledge lists nothing", async () => {
    const response = await call("GET", "/api/knowledge/acme");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: unknown[];
      total: number;
      head: string | null;
    };
    expect(body).toMatchObject({ items: [], total: 0, head: null });
  });
});

describe("articles", () => {
  test("PUT a new article, then GET it back", async () => {
    const put = await call("PUT", "/api/knowledge/acme/item", {
      body: {
        fm: fm(),
        body: "Open the project, choose Export, then CSV.\n",
        expectedBlob: null,
      },
    });
    expect(put.status).toBe(200);
    const saved = (await put.json()) as { item: KnowledgeItem; commit: string };
    expect(saved.item.path).toBe("articles/exporting-a-project-as-csv.md");
    expect(saved.commit).toMatch(/^[0-9a-f]{40}$/);
    expect((await lastCommit()).author).toBe("Ada Lovelace");

    const got = await call(
      "GET",
      `/api/knowledge/acme/item?path=${encodeURIComponent(saved.item.path)}`,
    );
    expect(got.status).toBe(200);
    const read = (await got.json()) as {
      item: KnowledgeItem;
      body: string;
      commit: string;
    };
    expect(read.item.title).toBe("Exporting a project as CSV");
    expect(read.body).toContain("choose Export, then CSV");
    expect(read.commit).toBe(saved.commit);

    const list = (await (
      await call("GET", "/api/knowledge/acme?filter=answer")
    ).json()) as { items: KnowledgeItem[]; total: number; head: string };
    expect(list.total).toBe(1);
    expect(list.head).toBe(saved.commit);
  });

  test("PUT with a stale expectedBlob answers 409", async () => {
    const put = await call("PUT", "/api/knowledge/acme/item", {
      body: { fm: fm(), body: "First.\n", expectedBlob: null },
    });
    const { item } = (await put.json()) as { item: KnowledgeItem };
    await call("PUT", "/api/knowledge/acme/item", {
      body: {
        path: item.path,
        fm: fm(),
        body: "Second.\n",
        expectedBlob: item.blob,
      },
    });
    const stale = await call("PUT", "/api/knowledge/acme/item", {
      body: {
        path: item.path,
        fm: fm(),
        body: "Third.\n",
        expectedBlob: item.blob,
      },
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: string }).error).toBe(
      "Someone changed this article. Reload and try again.",
    );
  });

  test("confirm clears the check and sets today's validAsOf", async () => {
    await seed([
      {
        path: "articles/export.md",
        fm: fm({
          status: "needs-check",
          validAsOfCommit: oldSha,
          check: {
            reason: `docs/export.md changed in ${newSha.slice(0, 7)}`,
            since: "2026-10-25",
            source: `repo:docs/export.md@${newSha}`,
          },
        }),
        body: "Export from the menu.\n",
      },
    ]);
    const response = await call("POST", "/api/knowledge/acme/confirm", {
      body: { paths: ["articles/export.md"] },
    });
    expect(response.status).toBe(200);
    const read = await service.read("acme", "articles/export.md", TODAY);
    expect(read?.item.status).toBe("active");
    expect(read?.item.check).toBeUndefined();
    expect(read?.item.validAsOf).toBe(TODAY);
    expect(read?.item.validAsOfCommit).toBe(newSha);
  });

  test("retire sets status retired", async () => {
    await seed([
      { path: "articles/export.md", fm: fm(), body: "Export it.\n" },
    ]);
    const response = await call("POST", "/api/knowledge/acme/retire", {
      body: { paths: ["articles/export.md"] },
    });
    expect(response.status).toBe(200);
    const read = await service.read("acme", "articles/export.md", TODAY);
    expect(read?.item.status).toBe("retired");
  });
});

describe("suggestions", () => {
  test("approving two makes one commit by the person, suggested by Pat", async () => {
    await seed([
      {
        path: "suggestions/export.md",
        fm: fm({
          origin: "suggestion",
          trust: "reference",
          suggestedBy: "Pat",
        }),
        body: "Export it.\n",
      },
      {
        path: "suggestions/import.md",
        fm: fm({
          title: "Importing a CSV",
          origin: "suggestion",
          trust: "reference",
          suggestedBy: "Pat",
        }),
        body: "Import it.\n",
      },
    ]);
    const before = await commitCount();
    const response = await call(
      "POST",
      "/api/knowledge/acme/suggestions/approve",
      { body: { paths: ["suggestions/export.md", "suggestions/import.md"] } },
    );
    expect(response.status).toBe(200);
    const result = (await response.json()) as { approved: string[] };
    expect(result.approved.sort()).toEqual([
      "articles/export.md",
      "articles/import.md",
    ]);
    expect(await commitCount()).toBe(before + 1);
    const last = await lastCommit();
    expect(last.author).toBe("Ada Lovelace");
    expect(last.message).toStartWith("Approve 2 suggestions");
    expect(last.message).toContain("Suggested-by: Pat");
    const approved = await service.read("acme", "articles/export.md", TODAY);
    expect(approved?.item).toMatchObject({
      origin: "article",
      trust: "trusted",
      status: "active",
      approvedBy: "Ada Lovelace",
      validAsOf: TODAY,
    });
    expect(await service.read("acme", "suggestions/export.md", TODAY)).toBe(
      null,
    );
  });
});

describe("server-set front matter", () => {
  test("PUT ignores approvedBy, suggestedBy and origin from the client", async () => {
    const put = await call("PUT", "/api/knowledge/acme/item", {
      body: {
        fm: fm({
          origin: "suggestion",
          approvedBy: "Mallory",
          suggestedBy: "Mallory",
        }),
        body: "Export it.\n",
        expectedBlob: null,
      },
    });
    expect(put.status).toBe(200);
    const { item } = (await put.json()) as { item: KnowledgeItem };
    expect(item.path).toStartWith("articles/");
    expect(item.origin).toBe("article");
    expect(item.approvedBy).toBe("Ada Lovelace");
    expect(item.suggestedBy).toBeUndefined();
  });

  test("PUT and approve work without origin or approvedBy", async () => {
    const { origin: _origin, ...input } = fm();
    const put = await call("PUT", "/api/knowledge/acme/item", {
      body: { fm: input, body: "Export it.\n", expectedBlob: null },
    });
    expect(put.status).toBe(200);
    const { item } = (await put.json()) as { item: KnowledgeItem };
    expect(item).toMatchObject({
      origin: "article",
      approvedBy: "Ada Lovelace",
    });

    await seed([
      {
        path: "suggestions/import.md",
        fm: fm({
          title: "Importing a CSV",
          origin: "suggestion",
          trust: "reference",
          suggestedBy: "Pat",
        }),
        body: "Import it.\n",
      },
    ]);
    const approved = await call(
      "POST",
      "/api/knowledge/acme/suggestions/approve",
      {
        body: {
          paths: ["suggestions/import.md"],
          edits: {
            "suggestions/import.md": {
              fm: { ...input, title: "Importing a CSV" },
              body: "Import it, edited.\n",
            },
          },
        },
      },
    );
    expect(approved.status).toBe(200);
    const read = await service.read("acme", "articles/import.md", TODAY);
    expect(read?.item).toMatchObject({
      origin: "article",
      approvedBy: "Ada Lovelace",
      suggestedBy: "Pat",
    });
  });

  test("PUT on a suggestion keeps who suggested it", async () => {
    await seed([
      {
        path: "suggestions/export.md",
        fm: fm({
          origin: "suggestion",
          trust: "reference",
          suggestedBy: "Pat",
        }),
        body: "Export it.\n",
      },
    ]);
    const stored = await service.read("acme", "suggestions/export.md", TODAY);
    const put = await call("PUT", "/api/knowledge/acme/item", {
      body: {
        path: "suggestions/export.md",
        fm: fm({
          origin: "article",
          trust: "reference",
          approvedBy: "Mallory",
          suggestedBy: "Mallory",
        }),
        body: "Export it from Settings.\n",
        expectedBlob: stored!.item.blob,
      },
    });
    expect(put.status).toBe(200);
    const { item } = (await put.json()) as { item: KnowledgeItem };
    expect(item).toMatchObject({ origin: "suggestion", suggestedBy: "Pat" });
    expect(item.approvedBy).toBeUndefined();
  });

  test("approve edits can't set approvedBy, suggestedBy or origin", async () => {
    await seed([
      {
        path: "suggestions/export.md",
        fm: fm({
          origin: "suggestion",
          trust: "reference",
          suggestedBy: "Pat",
        }),
        body: "Export it.\n",
      },
    ]);
    const response = await call(
      "POST",
      "/api/knowledge/acme/suggestions/approve",
      {
        body: {
          paths: ["suggestions/export.md"],
          edits: {
            "suggestions/export.md": {
              fm: fm({
                origin: "mail",
                approvedBy: "Mallory",
                suggestedBy: "Mallory",
              }),
              body: "Export it, edited.\n",
            },
          },
        },
      },
    );
    expect(response.status).toBe(200);
    const read = await service.read("acme", "articles/export.md", TODAY);
    expect(read?.item).toMatchObject({
      origin: "article",
      approvedBy: "Ada Lovelace",
      suggestedBy: "Pat",
    });
    expect(read?.body).toContain("edited");
  });
});

describe("suggestion paths", () => {
  test("approve refuses anything but suggestions/<name>.md", async () => {
    await seed([
      {
        path: "suggestions/nested/export.md",
        fm: fm({ origin: "suggestion", trust: "reference" }),
        body: "Export it.\n",
      },
    ]);
    for (const path of [
      "suggestions/nested/export.md",
      "suggestions/../articles/export.md",
      "suggestions/notes.txt",
      "articles/export.md",
    ]) {
      const response = await call(
        "POST",
        "/api/knowledge/acme/suggestions/approve",
        { body: { paths: [path] } },
      );
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe(
        `"${path}" isn't a suggestion`,
      );
    }
  });
});

describe("discard and revert", () => {
  test("discard removes a suggestion and revert brings it back", async () => {
    await seed([
      {
        path: "suggestions/export.md",
        fm: fm({ origin: "suggestion", trust: "reference" }),
        body: "Export it.\n",
      },
    ]);
    const shot = "attachments/suggestion+export/shot.png";
    await service.write("acme", [{ op: "attach", path: shot, bytes: PNG }], {
      message: "Attach",
      author: PAT,
    });
    const discarded = await call(
      "POST",
      "/api/knowledge/acme/suggestions/discard",
      { body: { paths: ["suggestions/export.md"] } },
    );
    expect(discarded.status).toBe(200);
    const { commit } = (await discarded.json()) as { commit: string };
    expect(await service.read("acme", "suggestions/export.md", TODAY)).toBe(
      null,
    );
    expect(await service.readAttachment("acme", shot)).toBe(null);
    const reverted = await call("POST", "/api/knowledge/acme/revert", {
      body: { sha: commit },
    });
    expect(reverted.status).toBe(200);
    expect(
      (await service.read("acme", "suggestions/export.md", TODAY))?.item.title,
    ).toBe("Exporting a project as CSV");
    expect(await service.readAttachment("acme", shot)).toEqual(PNG);
  });

  test("discard refuses an article", async () => {
    await seed([
      { path: "articles/export.md", fm: fm(), body: "Export it.\n" },
    ]);
    const response = await call(
      "POST",
      "/api/knowledge/acme/suggestions/discard",
      { body: { paths: ["articles/export.md"] } },
    );
    expect(response.status).toBe(400);
  });
});

describe("needs-check", () => {
  const repoCheck = () =>
    fm({
      status: "needs-check",
      validAsOfCommit: oldSha,
      check: {
        reason: `docs/export.md changed in ${newSha.slice(0, 7)}`,
        since: "2026-10-25",
        source: `repo:docs/export.md@${newSha}`,
      },
    });

  test("the list gives each item's note and excerpt, without the change", async () => {
    let fetched = 0;
    __setKnowledgeRouteDepsForTest({
      today: () => TODAY,
      fetchPage: async () => {
        fetched++;
        return { text: "Fresh page text." };
      },
    });
    await seed([
      {
        path: "articles/export.md",
        fm: repoCheck(),
        body: "Export from the menu.\n",
      },
      {
        path: "articles/pricing.md",
        fm: fm({
          title: "Pricing",
          status: "needs-check",
          check: {
            reason: "The pricing page changed",
            since: "2026-10-25",
            source: "url:https://acme.example.test/pricing#sha256=abc",
          },
        }),
        body: `Plans start at 10.\n${"x".repeat(50_000)}\n`,
      },
    ]);
    const response = await call("GET", "/api/knowledge/acme/needs-check");
    expect(response.status).toBe(200);
    const { items } = (await response.json()) as {
      items: Array<KnowledgeItem & Record<string, unknown>>;
    };
    expect(items).toHaveLength(2);
    const byPath = Object.fromEntries(items.map((i) => [i.path, i]));
    expect(byPath["articles/export.md"]!.check?.reason).toBe(
      `docs/export.md changed in ${newSha.slice(0, 7)}`,
    );
    expect(byPath["articles/pricing.md"]!.check?.source).toStartWith("url:");
    for (const item of items) {
      expect(item.change).toBeUndefined();
      expect(item.body).toBeUndefined();
      expect(typeof item.excerpt).toBe("string");
      expect(item.excerpt.length).toBeLessThan(1_000);
    }
    expect(fetched).toBe(0);
  });

  test("the item endpoint gives a repo change with its patch", async () => {
    await seed([
      {
        path: "articles/export.md",
        fm: repoCheck(),
        body: "Export from the menu.\n",
      },
    ]);
    const response = await call(
      "GET",
      "/api/knowledge/acme/needs-check/item?path=articles/export.md",
    );
    expect(response.status).toBe(200);
    const row = (await response.json()) as {
      item: KnowledgeItem;
      body: string;
      change: {
        kind: string;
        patch?: string;
        before?: string;
        after?: string;
      };
    };
    expect(row.item.path).toBe("articles/export.md");
    expect(row.body).toContain("menu");
    expect(row.change.kind).toBe("repo");
    expect(row.change.patch).toContain("+Export from Settings.");
    expect(row.change.before).toContain("menu");
    expect(row.change.after).toContain("Settings");
  });

  test("the item endpoint cuts each side and the body", async () => {
    __setKnowledgeRouteDepsForTest({
      today: () => TODAY,
      fetchPage: async () => ({ text: "y".repeat(60_000) }),
    });
    await seed([
      {
        path: "articles/pricing.md",
        fm: fm({
          title: "Pricing",
          status: "needs-check",
          check: {
            reason: "The pricing page changed",
            since: "2026-10-25",
            source: "url:https://acme.example.test/pricing#sha256=abc",
          },
        }),
        body: `${"x".repeat(60_000)}\n`,
      },
    ]);
    const response = await call(
      "GET",
      "/api/knowledge/acme/needs-check/item?path=articles/pricing.md",
    );
    expect(response.status).toBe(200);
    const row = (await response.json()) as {
      body: string;
      change: { kind: string; before?: string; after?: string; link?: string };
    };
    expect(row.change.kind).toBe("url");
    expect(row.change.link).toBe("https://acme.example.test/pricing");
    expect(row.body.length).toBeLessThanOrEqual(20_002);
    expect(row.change.before!.length).toBeLessThanOrEqual(20_002);
    expect(row.change.after!.length).toBeLessThanOrEqual(20_002);
    expect(row.change.after).toEndWith("…");
  });

  test("the item endpoint answers 404 for an unknown path", async () => {
    await seed([
      { path: "articles/export.md", fm: fm(), body: "Export it.\n" },
    ]);
    const response = await call(
      "GET",
      "/api/knowledge/acme/needs-check/item?path=articles/none.md",
    );
    expect(response.status).toBe(404);
  });
});

describe("imports", () => {
  test("another project's inbox answers 400", async () => {
    const response = await call("POST", "/api/knowledge/acme/import/mailbox", {
      body: { inboxId: "inb_api", months: 12 },
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      "This inbox belongs to another project",
    );
    expect(jobs).toHaveLength(0);
  });

  test("months: 99 answers 400", async () => {
    const response = await call("POST", "/api/knowledge/acme/import/mailbox", {
      body: { inboxId: "inb_acme", months: 99 },
    });
    expect(response.status).toBe(400);
    expect(jobs).toHaveLength(0);
  });

  test("the project's own inbox starts a job", async () => {
    const response = await call("POST", "/api/knowledge/acme/import/mailbox", {
      body: { inboxId: "inb_acme" },
    });
    expect(response.status).toBe(200);
    const { job } = (await response.json()) as { job: KnowledgeImportJob };
    expect(job).toMatchObject({ kind: "mailbox", project: "acme" });
    expect(jobs[0]).toMatchObject({
      options: { inboxId: "inb_acme", months: 12 },
    });
    // The starter sets the repository up when it has something to write.
    expect(await service.hasRepo("acme")).toBe(false);
  });

  test("a refused import leaves no repository behind", async () => {
    __setKnowledgeRouteDepsForTest({
      startImport: async () => {
        throw new MemoryRepoError("An import of this kind is running", 409);
      },
    });
    const response = await call("POST", "/api/knowledge/acme/import/repo", {
      body: {},
    });
    expect(response.status).toBe(409);
    expect(await service.hasRepo("acme")).toBe(false);
  });

  test("a running job can be cancelled", async () => {
    const asked: string[] = [];
    __setKnowledgeRouteDepsForTest({
      cancelJob: async (project, id) => {
        asked.push(`${project}:${id}`);
        return id === "kj_running"
          ? ({ id, project, kind: "mailbox" } as KnowledgeImportJob)
          : null;
      },
    });
    const ok = await call("POST", "/api/knowledge/acme/jobs/kj_running/cancel");
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { job: { id: string } }).job.id).toBe(
      "kj_running",
    );
    const gone = await call("POST", "/api/knowledge/acme/jobs/kj_done/cancel");
    expect(gone.status).toBe(404);
    expect(asked).toEqual(["acme:kj_running", "acme:kj_done"]);
  });

  test("a website import needs an exact support website", async () => {
    __setKnowledgeRouteDepsForTest({ today: () => TODAY });
    const response = await call("POST", "/api/knowledge/acme/import/website", {
      body: {},
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      "Add the project's support website under Support websites first.",
    );
    expect(await service.hasRepo("acme")).toBe(false);
  });

  test("a repository import runs through the default starter", async () => {
    __setKnowledgeRouteDepsForTest({
      today: () => TODAY,
      repoChanges: {
        repo: (project) =>
          project === "acme" ? { dir: code, defaultBranch: "main" } : null,
        serialize: (fn) => fn(),
      },
    });
    const response = await call("POST", "/api/knowledge/acme/import/repo", {
      body: {},
    });
    expect(response.status).toBe(200);
    const { job } = (await response.json()) as { job: KnowledgeImportJob };
    expect(job).toMatchObject({ kind: "repo", project: "acme" });
    await __waitForJobForTest(job.id);
    const listed = await call("GET", "/api/knowledge/acme/jobs");
    const body = (await listed.json()) as { jobs: KnowledgeImportJob[] };
    expect(body.jobs[0]).toMatchObject({ id: job.id, state: "done" });
    expect(body.jobs[0]!.created.trusted).toBe(1);
    expect(await service.hasRepo("acme")).toBe(true);
  });
});

describe("attachments", () => {
  test("a PDF attachment is served as opaque bytes", async () => {
    await seed([
      { path: "articles/export.md", fm: fm(), body: "Export it.\n" },
    ]);
    await service.write(
      "acme",
      [
        {
          op: "attach",
          path: "attachments/export/guide.pdf",
          bytes: new TextEncoder().encode("<script>alert(1)</script>"),
        },
      ],
      { message: "Attach", author: PAT },
    );
    const response = await call(
      "GET",
      "/api/knowledge/acme/attachment?path=attachments/export/guide.pdf",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("content-disposition")).toStartWith(
      "attachment",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("an .html attachment is never served", async () => {
    // The knowledge layout refuses .html attachments, so none can be stored
    // through the service; the route refuses the path before reading.
    await seed([
      { path: "articles/export.md", fm: fm(), body: "Export it.\n" },
    ]);
    const response = await call(
      "GET",
      "/api/knowledge/acme/attachment?path=attachments/export/page.html",
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).not.toContain("text/html");
  });

  test("an upload must belong to an article or a suggestion", async () => {
    await seed([
      {
        path: "sources/files/guide.md",
        fm: fm({ origin: "file", trust: "reference", dependsOn: [] }),
        body: "Guide.\n",
      },
    ]);
    for (const path of ["sources/files/guide.md", "KNOWLEDGE.md"]) {
      const form = new FormData();
      form.set("path", path);
      form.set("file", new File([PNG], "shot.png", { type: "image/png" }));
      const response = await call("POST", "/api/knowledge/acme/attachments", {
        form,
      });
      expect(response.status).toBe(400);
    }
  });

  test("approving a renamed suggestion moves its attachments and links", async () => {
    await seed([
      {
        path: "articles/export.md",
        fm: fm({ title: "Export" }),
        body: "Export it.\n",
      },
      {
        path: "suggestions/export.md",
        fm: fm({ title: "Export", origin: "suggestion", trust: "reference" }),
        body: "Export it.\n",
      },
    ]);
    const form = new FormData();
    form.set("path", "suggestions/export.md");
    form.set("file", new File([PNG], "shot.png", { type: "image/png" }));
    const uploaded = await call("POST", "/api/knowledge/acme/attachments", {
      form,
    });
    expect(uploaded.status).toBe(200);
    const { path, link } = (await uploaded.json()) as {
      path: string;
      link: string;
    };
    expect(path).toBe("attachments/suggestion+export/shot.png");
    expect(link).toBe("../attachments/suggestion+export/shot.png");
    const stored = await service.read("acme", "suggestions/export.md", TODAY);
    await service.write(
      "acme",
      [
        {
          op: "put",
          path: "suggestions/export.md",
          fm: frontMatter(stored!.item),
          body: `See ![the menu](${link}).\n`,
        },
      ],
      { message: "Link", author: PAT },
    );

    const response = await call(
      "POST",
      "/api/knowledge/acme/suggestions/approve",
      { body: { paths: ["suggestions/export.md"] } },
    );
    expect(response.status).toBe(200);
    const { approved } = (await response.json()) as { approved: string[] };
    expect(approved).toEqual(["articles/export-2.md"]);
    const read = await service.read("acme", "articles/export-2.md", TODAY);
    expect(read?.body).toContain("](../attachments/export-2/shot.png)");
    expect(
      await service.readAttachment("acme", "attachments/export-2/shot.png"),
    ).toEqual(PNG);
    expect(
      await service.readAttachment(
        "acme",
        "attachments/suggestion+export/shot.png",
      ),
    ).toBe(null);
    // The existing article's own folder is untouched.
    expect(await service.listAttachments("acme", "attachments/export")).toEqual(
      [],
    );
  });

  test("an uploaded image lands next to its article", async () => {
    await seed([
      { path: "articles/export.md", fm: fm(), body: "Export it.\n" },
    ]);
    const form = new FormData();
    form.set("path", "articles/export.md");
    form.set(
      "file",
      new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1])], "shot.png", {
        type: "image/png",
      }),
    );
    const response = await call("POST", "/api/knowledge/acme/attachments", {
      form,
    });
    expect(response.status).toBe(200);
    const { path } = (await response.json()) as { path: string };
    expect(path).toBe("attachments/export/shot.png");
    const served = await call(
      "GET",
      `/api/knowledge/acme/attachment?path=${path}`,
    );
    expect(served.headers.get("content-type")).toBe("image/png");
  });
});
