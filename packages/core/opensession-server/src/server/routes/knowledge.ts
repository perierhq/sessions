// /api/knowledge/<project>/*: a project's support knowledge for people.
// Read, write, confirm, retire, approve suggestions, look at what needs a
// check, history and revert, attachments, imports and an on-demand
// re-validation. Signed-in people only (`verifiedPerson`): an automation
// principal or a signed-out request answers 401, and nothing here is
// reachable while email support is off (404, like an unknown project).
//
// Reuses the memory Settings API's shape (routes/memory-repo.ts): every write
// is one commit authored as the signed-in person, errors keep the
// MemoryRepoError status (KnowledgeConflictError is 409), and attachments are
// served with the Support conversation download rules (routes/support.ts:
// only plain image types keep their type, everything else is opaque bytes).
// The knowledge repository is reached only through the worker client
// (knowledge/client.ts); reads go through its fresh-first methods.
//
// Imports are started through `startImport` (C3–C7 wire their starters into
// the defaults below); until then an import answers 501.
import {
  KNOWLEDGE_COPY,
  KNOWLEDGE_FILTERS,
  MAX_BACKFILL_MONTHS,
  DEFAULT_BACKFILL_MONTHS,
  type KnowledgeFilter,
  type KnowledgeFrontMatter,
  type KnowledgeImportJob,
  type KnowledgeImportKind,
  type KnowledgeItem,
} from "../../shared/knowledge";
import { knowledgeRepo } from "../knowledge/client";
import { listReleases, type ReleaseInfo } from "../knowledge/freshness/github";
import {
  defaultHead,
  patchFor,
  RepoUnavailableError,
  showAt,
  type RepoChangeDeps,
} from "../knowledge/freshness/repo-changes";
import {
  PAT_TRAILER,
  revalidateProject,
  type RevalidateResult,
} from "../knowledge/freshness/revalidate";
import { freeSlugPath, isAttachmentPath } from "../knowledge/layout";
import type { KnowledgeChange } from "../knowledge/service";
import { MAX_ATTACHMENT_BYTES } from "../knowledge/validate";
import { type Author, MemoryRepoError } from "../memory-repo/git-store";
import { emailSupportEnabled } from "../support/enabled";
import { getInbox, projectExists } from "../support/inboxes";
import { type RouteContext, verifiedPerson } from "./context";

const PREFIX = "/api/knowledge/";

const SAFE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** What a person may attach to an article, by extension. */
const ATTACHMENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
};

const MAX_IMPORT_FILES = 20;
const PAGE_SIZE = 50;
const MAX_NEEDS_CHECK = 100;
const MAX_BATCH = 200;
/** A side of the needs-check comparison is cut here. */
const MAX_CHANGE_CHARS = 100_000;
const SHA = /^[0-9a-f]{7,64}$/;
const SIGN_IN = "Sign in to use project knowledge";
const ATTACH_TYPES_COPY = "Attach an image (PNG, JPEG, GIF or WebP) or a PDF";
const TOO_BIG = "Files can be up to 10 MB";

// ── Seams ───────────────────────────────────────────────────────────────

export interface KnowledgeImportRequest {
  project: string;
  kind: KnowledgeImportKind;
  options: Record<string, unknown>;
  /** `files` imports only. */
  files?: Array<{ name: string; type: string; bytes: Uint8Array }>;
  by: Author;
}

export interface KnowledgeNeedsCheckChange {
  kind: "repo" | "url" | "release" | "issue" | "conflict" | "review";
  title: string;
  before?: string;
  after?: string;
  patch?: string;
  link?: string;
}

export interface KnowledgeRouteDeps {
  /** YYYY-MM-DD, UTC. */
  today(): string;
  /** Passed to the repo-changes defaults (tests point them at a tmp repo). */
  repoChanges: Partial<RepoChangeDeps>;
  /** The project an inbox belongs to; null when there is no such inbox. */
  inboxProject(inboxId: string): Promise<string | null>;
  /** A page's current text (freshness/web.ts on the Support websites). */
  fetchPage(
    project: string,
    url: string,
  ): Promise<{ text: string } | { error: string }>;
  release(project: string, tag: string): Promise<ReleaseInfo | null>;
  revalidate(project: string): Promise<RevalidateResult>;
  startImport(request: KnowledgeImportRequest): Promise<KnowledgeImportJob>;
  listJobs(project: string): Promise<KnowledgeImportJob[]>;
}

const defaults: KnowledgeRouteDeps = {
  today: () => new Date().toISOString().slice(0, 10),
  repoChanges: {},
  inboxProject: async (id) => (await getInbox(id))?.project ?? null,
  fetchPage: async (project, url) => {
    const { roleWebAccess } = await import("../projects/effective");
    const { fetchPage } = await import("../knowledge/freshness/web");
    return fetchPage(url, (await roleWebAccess(project, "support")).websites);
  },
  release: async (project, tag) =>
    (await listReleases(project))?.find((r) => r.tag === tag) ?? null,
  revalidate: (project) => revalidateProject(project),
  startImport: async () => {
    throw new MemoryRepoError("This import isn't available yet.", 501);
  },
  listJobs: async () => [],
};

let deps: KnowledgeRouteDeps = defaults;

/** Replace some of the route's collaborators (tests); undefined restores. */
export function __setKnowledgeRouteDepsForTest(
  over: Partial<KnowledgeRouteDeps> | undefined,
): void {
  deps = over ? { ...defaults, ...over } : defaults;
}

// ── Helpers ─────────────────────────────────────────────────────────────

const json = (status: number, error: string) =>
  Response.json({ error }, { status });

function failure(error: unknown): Response {
  if (error instanceof RepoUnavailableError)
    return json(503, "The code repository can't be read right now. Try again");
  const status = (error as { status?: unknown } | null)?.status;
  if (
    error instanceof Error &&
    typeof status === "number" &&
    status >= 400 &&
    status < 600
  )
    return json(status, error.message);
  console.warn(
    "[knowledge] request failed:",
    error instanceof Error ? error.name : "error",
  );
  return json(500, "Something went wrong. Try again");
}

class BadRequest extends MemoryRepoError {
  constructor(message: string) {
    super(message, 400);
  }
}

function segment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** The same commit author as the memory Settings API. */
function authorOf(ctx: RouteContext): Author {
  const user = ctx.authUser!;
  return {
    name: user.name || user.login,
    email: `${user.login}@users.noreply.github.com`,
  };
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = undefined;
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new BadRequest("Send a JSON object");
  return body as Record<string, unknown>;
}

async function readForm(req: Request): Promise<FormData> {
  try {
    return await req.formData();
  } catch {
    throw new BadRequest("Send the file as multipart/form-data");
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function pathsFrom(body: Record<string, unknown>): string[] {
  const paths = body.paths;
  if (
    !Array.isArray(paths) ||
    !paths.length ||
    paths.length > MAX_BATCH ||
    !paths.every((p) => typeof p === "string" && p)
  )
    throw new BadRequest(`Send 1 to ${MAX_BATCH} paths`);
  return [...new Set(paths as string[])];
}

function intParam(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
  what: string,
): number {
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new BadRequest(`${what} must be between ${min} and ${max}`);
  return n;
}

/** The front matter of an indexed item. */
function frontMatterOf(item: KnowledgeItem): KnowledgeFrontMatter {
  const {
    project: _project,
    path: _path,
    blob: _blob,
    commit: _commit,
    updatedAt: _updatedAt,
    effective: _effective,
    excerpt: _excerpt,
    ...fm
  } = item;
  return fm;
}

async function hasRepo(project: string): Promise<boolean> {
  return knowledgeRepo.call("hasRepo", project);
}

async function readItem(
  project: string,
  path: string,
  today: string,
): Promise<{ item: KnowledgeItem; body: string }> {
  const read = (await hasRepo(project))
    ? await knowledgeRepo.call("read", project, path, today)
    : null;
  if (!read)
    throw new MemoryRepoError(
      `"${path}" isn't in this project's knowledge.`,
      404,
    );
  return read;
}

/** The first free `<dir>/<slug>.md` for `title`, skipping `taken`. */
async function freePath(
  project: string,
  dir: string,
  title: string,
  taken: Set<string> = new Set(),
): Promise<string> {
  const existing = new Set(taken);
  for (;;) {
    const path = freeSlugPath(existing, dir, title);
    if (
      !existing.has(path) &&
      !(await knowledgeRepo.call("index.get", project, path))
    )
      return path;
    existing.add(path);
  }
}

/** The code repository's default-branch head for a confirmation or an
 *  approval; refuses when an item depends on the repository and the head
 *  can't be read (a stale commit would only flip it again). */
async function codeHead(
  project: string,
  fms: KnowledgeFrontMatter[],
): Promise<string | null> {
  const head = await defaultHead(project, deps.repoChanges).catch(() => null);
  if (
    !head &&
    fms.some(
      (fm) =>
        fm.validAsOfCommit || fm.dependsOn.some((d) => d.startsWith("repo:")),
    )
  )
    throw new MemoryRepoError(
      "The code repository can't be read right now, so this can't be confirmed. Try again",
      503,
    );
  return head;
}

function stamped(
  fm: KnowledgeFrontMatter,
  today: string,
  head: string | null,
): KnowledgeFrontMatter {
  const next: KnowledgeFrontMatter = { ...fm, validAsOf: today };
  delete next.check;
  if (head) next.validAsOfCommit = head;
  else delete next.validAsOfCommit;
  return next;
}

function batchMessage(
  verb: string,
  items: Array<{ title: string }>,
  noun = "items",
): string {
  return items.length === 1
    ? `${verb} ${items[0]!.title}`
    : `${verb} ${items.length} ${noun}`;
}

async function currentHead(project: string): Promise<string | null> {
  return knowledgeRepo.call("head", project);
}

function cut(text: string | null | undefined): string | undefined {
  if (text == null) return undefined;
  return text.length > MAX_CHANGE_CHARS
    ? `${text.slice(0, MAX_CHANGE_CHARS)}\n…`
    : text;
}

async function quietly<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

function contentDisposition(kind: string, fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]|["\\]/g, "_") || "attachment";
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** A file name safe as one path segment, with its extension kept. */
function safeFileName(raw: string): string {
  const name = raw
    .split(/[\\/]/)
    .pop()!
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+/, "")
    .slice(-100);
  return name || "file";
}

// ── Reads ───────────────────────────────────────────────────────────────

async function list(project: string, url: URL): Promise<Response> {
  const filter = (url.searchParams.get("filter") || "all") as KnowledgeFilter;
  if (!KNOWLEDGE_FILTERS.includes(filter))
    throw new BadRequest("Unknown filter");
  const offset = intParam(
    url.searchParams.get("offset"),
    0,
    0,
    1_000_000,
    "offset",
  );
  const query = url.searchParams.get("q")?.trim() || undefined;
  const today = deps.today();
  if (!(await hasRepo(project)))
    return Response.json({
      items: [],
      total: 0,
      counts: Object.fromEntries(KNOWLEDGE_FILTERS.map((f) => [f, 0])),
      head: null,
    });
  const [page, counts, head] = await Promise.all([
    knowledgeRepo.call("index.list", project, filter, {
      today,
      query,
      limit: PAGE_SIZE,
      offset,
    }),
    knowledgeRepo.call("index.counts", project, today),
    currentHead(project),
  ]);
  return Response.json({ ...page, counts, head });
}

async function changeFor(
  project: string,
  item: KnowledgeItem,
  body: string,
  today: string,
): Promise<KnowledgeNeedsCheckChange> {
  const check = item.check;
  const title =
    check?.reason ??
    (item.reviewBy && item.reviewBy < today
      ? KNOWLEDGE_COPY.reviewPassed(item.reviewBy)
      : "Needs a check");
  if (check?.conflictWith) {
    const other = await quietly(() =>
      knowledgeRepo.call("read", project, check.conflictWith!, today),
    );
    return {
      kind: "conflict",
      title,
      before: cut(body),
      after: cut(other?.body),
      link: check.conflictWith,
    };
  }
  const source = check?.source ?? "";
  if (source.startsWith("repo:")) {
    const ref = source.slice("repo:".length);
    const at = ref.lastIndexOf("@");
    const path = at > 0 ? ref.slice(0, at) : ref;
    const sha = at > 0 ? ref.slice(at + 1) : "";
    if (!SHA.test(sha)) return { kind: "repo", title };
    const r = deps.repoChanges;
    const [patch, after, before] = await Promise.all([
      quietly(() => patchFor(project, sha, path, r)),
      quietly(() => showAt(project, sha, path, r)),
      item.validAsOfCommit && SHA.test(item.validAsOfCommit)
        ? quietly(() => showAt(project, item.validAsOfCommit!, path, r))
        : undefined,
    ]);
    return {
      kind: "repo",
      title,
      ...(before != null ? { before: cut(before) } : {}),
      ...(after != null ? { after: cut(after) } : {}),
      ...(patch ? { patch: cut(patch) } : {}),
    };
  }
  if (source.startsWith("url:")) {
    const raw = source.slice("url:".length);
    const mark = raw.lastIndexOf("#sha256=");
    const link = mark >= 0 ? raw.slice(0, mark) : raw;
    const page = await quietly(() => deps.fetchPage(project, link));
    return {
      kind: "url",
      title,
      before: cut(body),
      ...(page && "text" in page ? { after: cut(page.text) } : {}),
      link,
    };
  }
  if (source.startsWith("release:")) {
    const release = await quietly(() =>
      deps.release(project, source.slice("release:".length)),
    );
    return {
      kind: "release",
      title,
      before: cut(body),
      ...(release ? { after: cut(release.body) } : {}),
    };
  }
  if (source.startsWith("issue:") || source.startsWith("pr:"))
    return { kind: "issue", title };
  return { kind: "review", title };
}

async function needsCheck(project: string): Promise<Response> {
  if (!(await hasRepo(project))) return Response.json({ items: [] });
  const today = deps.today();
  const { items } = await knowledgeRepo.call(
    "index.list",
    project,
    "needs-check",
    { today, limit: MAX_NEEDS_CHECK },
  );
  const rows = await Promise.all(
    items.map(async (listed) => {
      const read = await knowledgeRepo.call(
        "read",
        project,
        listed.path,
        today,
      );
      if (!read) return null;
      return {
        item: read.item,
        body: read.body,
        change: await changeFor(project, read.item, read.body, today),
      };
    }),
  );
  return Response.json({ items: rows.filter((row) => row !== null) });
}

async function attachment(project: string, url: URL): Promise<Response> {
  const path = url.searchParams.get("path") ?? "";
  if (!isAttachmentPath(path)) throw new BadRequest("Invalid attachment path");
  const bytes = (await hasRepo(project))
    ? await knowledgeRepo.call("readAttachment", project, path)
    : null;
  if (!bytes) return json(404, "Attachment not found");
  const name = path.split("/").pop()!;
  const type = ATTACHMENT_TYPES[extensionOf(name)] ?? "";
  const image = SAFE_IMAGE_TYPES.has(type);
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": image ? type : "application/octet-stream",
      "Content-Disposition": contentDisposition(
        image ? "inline" : "attachment",
        name,
      ),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, no-store",
    },
  });
}

// ── Writes ──────────────────────────────────────────────────────────────

async function putItem(ctx: RouteContext, project: string): Promise<Response> {
  const body = await readJson(ctx.req);
  if (!isObject(body.fm)) throw new BadRequest("Send the article's fm");
  if (typeof body.body !== "string")
    throw new BadRequest("Send the article's body");
  if (body.expectedBlob !== null && typeof body.expectedBlob !== "string")
    throw new BadRequest("Send the blob you read as expectedBlob");
  if (body.path !== undefined && typeof body.path !== "string")
    throw new BadRequest("Invalid path");
  const fm = body.fm as unknown as KnowledgeFrontMatter;
  if (typeof fm.title !== "string" || !fm.title.trim())
    throw new BadRequest("An article needs a title");
  await knowledgeRepo.call("ensureRepo", project);
  const creating = body.path === undefined;
  const path = creating
    ? await freePath(project, "articles", fm.title)
    : (body.path as string);
  const expectedBlob = creating ? null : (body.expectedBlob as string | null);
  const commit = await knowledgeRepo.call(
    "write",
    project,
    [{ op: "put", path, fm, body: body.body }],
    {
      message: `${creating || expectedBlob === null ? "Add" : "Edit"} ${fm.title}`,
      author: authorOf(ctx),
      expected: { [path]: expectedBlob },
    },
  );
  const item = await knowledgeRepo.call(
    "index.get",
    project,
    path,
    deps.today(),
  );
  return Response.json({
    item,
    commit: commit ?? (await currentHead(project)),
  });
}

/** Rewrite the front matter of `paths` as one commit. */
async function rewrite(
  ctx: RouteContext,
  project: string,
  verb: string,
  next: (
    fm: KnowledgeFrontMatter,
    items: KnowledgeItem[],
  ) => Promise<KnowledgeFrontMatter> | KnowledgeFrontMatter,
  prepare?: (items: KnowledgeItem[]) => Promise<unknown>,
): Promise<Response> {
  const paths = pathsFrom(await readJson(ctx.req));
  const today = deps.today();
  const reads = await Promise.all(
    paths.map((path) => readItem(project, path, today)),
  );
  const items = reads.map((r) => r.item);
  await prepare?.(items);
  const changes: KnowledgeChange[] = [];
  for (const { item, body } of reads)
    changes.push({
      op: "put",
      path: item.path,
      fm: await next(frontMatterOf(item), items),
      body,
    });
  const commit = await knowledgeRepo.call("write", project, changes, {
    message: batchMessage(verb, items),
    author: authorOf(ctx),
    expected: Object.fromEntries(items.map((i) => [i.path, i.blob])),
  });
  return Response.json({ commit: commit ?? (await currentHead(project)) });
}

async function confirm(ctx: RouteContext, project: string): Promise<Response> {
  const today = deps.today();
  let head: string | null = null;
  return rewrite(
    ctx,
    project,
    "Confirm",
    (fm) => ({ ...stamped(fm, today, head), status: "active" }),
    async (items) => {
      head = await codeHead(project, items.map(frontMatterOf));
    },
  );
}

async function retire(ctx: RouteContext, project: string): Promise<Response> {
  return rewrite(ctx, project, "Retire", (fm) => {
    const next: KnowledgeFrontMatter = { ...fm, status: "retired" };
    delete next.check;
    return next;
  });
}

async function approve(ctx: RouteContext, project: string): Promise<Response> {
  const body = await readJson(ctx.req);
  const paths = pathsFrom(body);
  const edits = body.edits === undefined ? {} : body.edits;
  if (!isObject(edits)) throw new BadRequest("Invalid edits");
  const today = deps.today();
  const author = authorOf(ctx);
  const reads = await Promise.all(
    paths.map(async (path) => {
      if (!path.startsWith("suggestions/"))
        throw new BadRequest(`"${path}" isn't a suggestion`);
      const read = await readItem(project, path, today);
      const edit = edits[path];
      if (edit === undefined) return read;
      if (
        !isObject(edit) ||
        !isObject(edit.fm) ||
        typeof edit.body !== "string"
      )
        throw new BadRequest(`Invalid edit for "${path}"`);
      return {
        item: read.item,
        body: edit.body,
        fm: edit.fm as unknown as KnowledgeFrontMatter,
      };
    }),
  );
  const fms = reads.map((r) => ("fm" in r ? r.fm : frontMatterOf(r.item)));
  const head = await codeHead(project, fms);
  const taken = new Set<string>();
  const changes: KnowledgeChange[] = [];
  const expected: Record<string, string | null> = {};
  const approved: string[] = [];
  for (const [i, read] of reads.entries()) {
    const fm = fms[i]!;
    const name = read.item.path.slice("suggestions/".length);
    const preferred = `articles/${name}`;
    const to =
      !taken.has(preferred) &&
      !(await knowledgeRepo.call("index.get", project, preferred))
        ? preferred
        : await freePath(project, "articles", fm.title, taken);
    taken.add(to);
    changes.push({
      op: "move",
      from: read.item.path,
      to,
      fm: {
        ...stamped(fm, today, head),
        origin: "article",
        trust: "trusted",
        status: "active",
        approvedBy: author.name,
      },
      body: read.body,
    });
    expected[read.item.path] = read.item.blob;
    expected[to] = null;
    approved.push(to);
  }
  const commit = await knowledgeRepo.call("write", project, changes, {
    message: batchMessage(
      "Approve",
      fms.map((fm) => ({ title: fm.title })),
      "suggestions",
    ),
    author,
    trailers: [PAT_TRAILER],
    expected,
  });
  return Response.json({
    commit: commit ?? (await currentHead(project)),
    approved,
  });
}

async function discard(ctx: RouteContext, project: string): Promise<Response> {
  const paths = pathsFrom(await readJson(ctx.req));
  const today = deps.today();
  const items = await Promise.all(
    paths.map(async (path) => {
      if (!path.startsWith("suggestions/"))
        throw new BadRequest(`"${path}" isn't a suggestion`);
      return (await readItem(project, path, today)).item;
    }),
  );
  const commit = await knowledgeRepo.call(
    "write",
    project,
    items.map((item) => ({ op: "delete" as const, path: item.path })),
    {
      message: batchMessage("Discard", items, "suggestions"),
      author: authorOf(ctx),
      expected: Object.fromEntries(items.map((i) => [i.path, i.blob])),
    },
  );
  return Response.json({ commit: commit ?? (await currentHead(project)) });
}

async function attach(ctx: RouteContext, project: string): Promise<Response> {
  const form = await readForm(ctx.req);
  const file = form.get("file");
  const article = form.get("path");
  if (!(file instanceof File)) throw new BadRequest("Choose a file to attach");
  if (typeof article !== "string" || !article.endsWith(".md"))
    throw new BadRequest("Say which article the file belongs to");
  const type = ATTACHMENT_TYPES[extensionOf(file.name)];
  if (!type) throw new BadRequest(ATTACH_TYPES_COPY);
  if (file.size > MAX_ATTACHMENT_BYTES) throw new BadRequest(TOO_BIG);
  await readItem(project, article, deps.today());
  const slug = article.split("/").pop()!.replace(/\.md$/i, "");
  const path = `attachments/${slug}/${safeFileName(file.name)}`;
  if (await knowledgeRepo.call("readAttachment", project, path))
    throw new MemoryRepoError(
      "A file with this name is already attached. Rename it and try again",
      409,
    );
  const commit = await knowledgeRepo.call(
    "write",
    project,
    [{ op: "attach", path, bytes: new Uint8Array(await file.arrayBuffer()) }],
    {
      message: `Attach ${path.split("/").pop()} to ${slug}`,
      author: authorOf(ctx),
      expected: { [path]: null },
    },
  );
  return Response.json({
    path,
    commit: commit ?? (await currentHead(project)),
  });
}

async function revert(ctx: RouteContext, project: string): Promise<Response> {
  const body = await readJson(ctx.req);
  if (typeof body.sha !== "string" || !SHA.test(body.sha))
    throw new BadRequest("Send the commit to revert as sha");
  if (!(await hasRepo(project))) return json(404, "Commit not found");
  const commit = await knowledgeRepo.call(
    "revert",
    project,
    body.sha,
    authorOf(ctx),
  );
  return Response.json({ commit: commit ?? (await currentHead(project)) });
}

// ── Imports ─────────────────────────────────────────────────────────────

async function startImport(
  ctx: RouteContext,
  project: string,
  kind: KnowledgeImportKind,
): Promise<Response> {
  let options: Record<string, unknown> = {};
  let files: KnowledgeImportRequest["files"];
  if (kind === "files") {
    const form = await readForm(ctx.req);
    const picked = form.getAll("file");
    if (!picked.length || !picked.every((f) => f instanceof File))
      throw new BadRequest("Choose the files to import");
    if (picked.length > MAX_IMPORT_FILES)
      throw new BadRequest(`Import up to ${MAX_IMPORT_FILES} files at a time`);
    files = [];
    for (const file of picked as File[]) {
      if (file.size > MAX_ATTACHMENT_BYTES) throw new BadRequest(TOO_BIG);
      files.push({
        name: file.name,
        type: file.type,
        bytes: new Uint8Array(await file.arrayBuffer()),
      });
    }
  } else {
    const body = await readJson(ctx.req);
    if (kind === "mailbox") {
      const months = body.months ?? DEFAULT_BACKFILL_MONTHS;
      if (
        typeof months !== "number" ||
        !Number.isInteger(months) ||
        months < 1 ||
        months > MAX_BACKFILL_MONTHS
      )
        throw new BadRequest(
          `Choose between 1 and ${MAX_BACKFILL_MONTHS} months`,
        );
      if (typeof body.inboxId !== "string" || !body.inboxId)
        throw new BadRequest("Choose an inbox");
      const owner = await deps.inboxProject(body.inboxId);
      if (owner === null) throw new BadRequest("Unknown inbox");
      if (owner !== project)
        throw new BadRequest("This inbox belongs to another project");
      options = { inboxId: body.inboxId, months };
    }
  }
  await knowledgeRepo.call("ensureRepo", project);
  const job = await deps.startImport({
    project,
    kind,
    options,
    ...(files ? { files } : {}),
    by: authorOf(ctx),
  });
  return Response.json({ job });
}

const IMPORT_KINDS: ReadonlySet<string> = new Set<KnowledgeImportKind>([
  "mailbox",
  "website",
  "repo",
  "files",
  "known-problems",
]);

// ── Handler ─────────────────────────────────────────────────────────────

export async function handleKnowledgeRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, url, path } = ctx;
  if (!path.startsWith(PREFIX)) return undefined;
  const [rawProject, ...rest] = path.slice(PREFIX.length).split("/");
  if (!rawProject) return undefined;
  const sub = rest.join("/");
  const route = `${req.method} ${sub}`;

  if (!verifiedPerson(ctx)) return json(401, SIGN_IN);
  if (!emailSupportEnabled()) return json(404, "Not found");
  const project = segment(rawProject);
  if (project === null || !projectExists(project))
    return json(404, "Project not found");

  try {
    switch (route) {
      case "GET ":
        return await list(project, url);
      case "GET item": {
        const read = await readItem(
          project,
          url.searchParams.get("path") ?? "",
          deps.today(),
        );
        return Response.json({ ...read, commit: read.item.commit });
      }
      case "PUT item":
        return await putItem(ctx, project);
      case "POST confirm":
        return await confirm(ctx, project);
      case "POST retire":
        return await retire(ctx, project);
      case "POST suggestions/approve":
        return await approve(ctx, project);
      case "POST suggestions/discard":
        return await discard(ctx, project);
      case "GET needs-check":
        return await needsCheck(project);
      case "GET history": {
        const filePath = url.searchParams.get("path") || undefined;
        const limit = intParam(
          url.searchParams.get("limit"),
          50,
          1,
          200,
          "limit",
        );
        const commits = (await hasRepo(project))
          ? await knowledgeRepo.call("history", project, filePath, limit)
          : [];
        return Response.json({ commits });
      }
      case "GET diff": {
        const sha = url.searchParams.get("sha") ?? "";
        if (!SHA.test(sha)) throw new BadRequest("Invalid commit");
        if (!(await hasRepo(project))) return json(404, "Commit not found");
        return Response.json({
          diff: await knowledgeRepo.call("diff", project, sha),
        });
      }
      case "POST revert":
        return await revert(ctx, project);
      case "POST attachments":
        return await attach(ctx, project);
      case "GET attachment":
        return await attachment(project, url);
      case "GET jobs":
        return Response.json({ jobs: await deps.listJobs(project) });
      case "POST revalidate":
        return Response.json({ result: await deps.revalidate(project) });
    }
    if (req.method === "POST" && sub.startsWith("import/")) {
      const kind = sub.slice("import/".length);
      if (IMPORT_KINDS.has(kind))
        return await startImport(ctx, project, kind as KnowledgeImportKind);
    }
    return undefined;
  } catch (error) {
    return failure(error);
  }
}
