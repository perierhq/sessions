import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getConfigAsync } from "../config";
import { __setRepoRemovalDepsForTest } from "../repo-removal";
import { getUiPrefs, patchUiPrefs } from "../ui-prefs";
import type { UnifiedSession } from "../types";
import { createWorktree } from "../worktree";
import type { RouteContext } from "./context";
import { handleSetupRepoRoutes } from "./setup-repos";

const saved = {
  config: process.env.OPENSESSION_CONFIG,
  worktrees: process.env.OPENSESSION_WORKTREES_DIR,
  home: process.env.HOME,
};
const roots: string[] = [];

afterEach(async () => {
  __setRepoRemovalDepsForTest(null);
  for (const [key, value] of [
    ["OPENSESSION_CONFIG", saved.config],
    ["OPENSESSION_WORKTREES_DIR", saved.worktrees],
    ["HOME", saved.home],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await getConfigAsync();
  for (const dir of roots.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function git(args: string[], cwd?: string): string {
  const result = Bun.spawnSync(["git", ...args], {
    ...(cwd ? { cwd } : {}),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(result.stderr.toString() || `git ${args.join(" ")}`);
  return result.stdout.toString().trim();
}

/** A checkout with a bare origin, at `<dir>/<name>`. */
function makeCheckout(dir: string, name: string): string {
  const remote = join(dir, `${name}-remote.git`);
  const checkout = join(dir, name);
  git(["init", "-q", "--bare", "-b", "main", remote]);
  git(["init", "-q", "-b", "main", checkout]);
  writeFileSync(join(checkout, "README.md"), `${name}\n`);
  git(["add", "README.md"], checkout);
  git(
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-q",
      "-m",
      "initial",
    ],
    checkout,
  );
  git(["remote", "add", "origin", remote], checkout);
  git(["push", "-q", "-u", "origin", "main"], checkout);
  git(["remote", "set-head", "origin", "main"], checkout);
  return realpathSync(checkout);
}

interface Env {
  root: string;
  configPath: string;
  checkouts: string;
  worktrees: string;
}

/** A fresh HOME (so ~/checkouts is a temp dir) and config. */
async function setup(config: Record<string, unknown> = {}): Promise<Env> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "os-repo-removal-")));
  roots.push(root);
  const checkouts = join(root, "checkouts");
  const worktrees = join(root, "worktrees");
  mkdirSync(checkouts, { recursive: true });
  mkdirSync(worktrees, { recursive: true });
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify({ repos: {}, ...config }));
  process.env.HOME = root;
  process.env.OPENSESSION_WORKTREES_DIR = worktrees;
  process.env.OPENSESSION_CONFIG = configPath;
  await getConfigAsync();
  return { root, configPath, checkouts, worktrees };
}

async function writeConfig(env: Env, config: Record<string, unknown>) {
  writeFileSync(env.configPath, JSON.stringify(config));
  await getConfigAsync();
}

function readConfig(env: Env): Record<string, any> {
  return JSON.parse(readFileSync(env.configPath, "utf-8"));
}

function route(method: string, path: string, body?: unknown): RouteContext {
  const url = new URL(`http://localhost${path}`);
  return {
    req: new Request(url, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
    }),
    url,
    path: url.pathname,
    publicPrefix: "",
  };
}

async function createNewRepo(name: string): Promise<void> {
  const response = await handleSetupRepoRoutes(
    route("POST", "/api/setup/repos", { source: "new", name }),
  );
  expect(response?.status).toBe(201);
  await getConfigAsync();
}

function session(
  id: string,
  repo: string | undefined,
  extra: Partial<UnifiedSession> = {},
): UnifiedSession {
  return {
    id,
    ...(repo ? { repo } : {}),
    isRunning: false,
    ...extra,
  } as UnifiedSession;
}

/** Fake session layer: `sessions` are live; archiving records the ids. */
function fakeSessions(sessions: UnifiedSession[]) {
  const archived: string[] = [];
  const released: string[] = [];
  __setRepoRemovalDepsForTest({
    liveSessions: async () => sessions.filter((s) => !archived.includes(s.id)),
    archiveSessions: async (batch) => {
      archived.push(...batch.map((s) => s.id));
    },
    releaseWorkspaces: async (repoId) => {
      released.push(repoId);
    },
    stopWorkloadsInDir: async () => {},
  });
  return { archived, released };
}

async function preview(id: string) {
  const response = await handleSetupRepoRoutes(
    route("GET", `/api/setup/repos/${encodeURIComponent(id)}/removal`),
  );
  return { status: response?.status, body: (await response?.json()) as any };
}

async function remove(id: string, body?: unknown) {
  const response = await handleSetupRepoRoutes(
    route("DELETE", `/api/setup/repos/${encodeURIComponent(id)}`, body),
  );
  return { status: response?.status, body: (await response?.json()) as any };
}

describe("repository removal", () => {
  test.serial(
    "previews sessions, running count and what deleting would remove",
    async () => {
      const env = await setup();
      await createNewRepo("widget");
      fakeSessions([
        session("s1", "widget", { isRunning: true }),
        session("s2", "widget"),
        session("s3", "other"),
      ]);

      const { status, body } = await preview("widget");

      expect(status).toBe(200);
      expect(body).toMatchObject({
        id: "widget",
        label: "widget",
        path: join(env.checkouts, "widget"),
        sessions: 2,
        running: 1,
        deletable: true,
        deletePaths: [
          join(env.checkouts, "widget"),
          join(env.checkouts, "widget.git"),
        ],
        worktrees: 0,
      });
      expect(typeof body.sizeBytes).toBe("number");
    },
  );

  test.serial(
    "refuses with 409 while a session is running, changing nothing",
    async () => {
      const env = await setup();
      await createNewRepo("widget");
      const { archived } = fakeSessions([
        session("s1", "widget", { isRunning: true }),
        session("s2", "widget", { isRunning: true }),
        session("s3", "widget"),
      ]);

      const { status, body } = await remove("widget", { deleteFiles: true });

      expect(status).toBe(409);
      expect(body).toMatchObject({
        error: "Stop 2 running sessions first",
        running: 2,
      });
      expect(archived).toEqual([]);
      expect(readConfig(env).repos.widget).toBeDefined();
      expect(existsSync(join(env.checkouts, "widget"))).toBe(true);
    },
  );

  test.serial(
    "archives the repository's sessions and drops it from the config",
    async () => {
      const env = await setup();
      await createNewRepo("widget");
      await createNewRepo("other");
      const config = readConfig(env);
      config.newSessionRepo = "widget";
      await writeConfig(env, config);
      patchUiPrefs("alice", {
        "default-repo": "widget",
        "repo-order": JSON.stringify(["other", "widget"]),
      });
      const { archived, released } = fakeSessions([
        session("s1", "widget"),
        session("s2", "widget", { workspaceId: "ws-1" }),
        session("s3", "other"),
        session("s4", undefined, { repoLess: true }),
      ]);

      const { status, body } = await remove("widget", { deleteFiles: false });

      expect(status).toBe(200);
      expect(body).toEqual({
        id: "widget",
        archived: 2,
        deleted: [],
        kept: [],
      });
      expect(archived).toEqual(["s1", "s2"]);
      expect(released).toEqual(["widget"]);
      const after = readConfig(env);
      expect(after.repos.widget).toBeUndefined();
      expect(after.repos.other).toBeDefined();
      expect(after.newSessionRepo).toBeUndefined();
      expect(getUiPrefs("alice")).toMatchObject({
        "default-repo": "",
        "repo-order": JSON.stringify(["other"]),
      });
      // Files stay unless deletion was asked for.
      expect(existsSync(join(env.checkouts, "widget"))).toBe(true);
      expect(existsSync(join(env.checkouts, "widget.git"))).toBe(true);
      expect((await preview("widget")).status).toBe(404);
    },
  );

  test.serial(
    "deletes a managed checkout, its origin and its worktrees",
    async () => {
      const env = await setup();
      await createNewRepo("widget");
      await createNewRepo("other");
      const worktree = await createWorktree("feature", "widget");
      expect(existsSync(worktree)).toBe(true);
      fakeSessions([]);

      const { status, body } = await remove("widget", { deleteFiles: true });

      expect(status).toBe(200);
      const realWorktree = join(env.worktrees, "widget-feature");
      expect(body.deleted.sort()).toEqual(
        [
          join(env.checkouts, "widget"),
          join(env.checkouts, "widget.git"),
          realWorktree,
        ].sort(),
      );
      expect(body.kept).toEqual([]);
      expect(existsSync(join(env.checkouts, "widget"))).toBe(false);
      expect(existsSync(join(env.checkouts, "widget.git"))).toBe(false);
      expect(existsSync(realWorktree)).toBe(false);
      // The root and the other repository are untouched.
      expect(existsSync(env.checkouts)).toBe(true);
      expect(existsSync(join(env.checkouts, "other"))).toBe(true);
      expect(existsSync(join(env.checkouts, "other.git"))).toBe(true);
    },
  );

  test.serial(
    "refuses to delete a folder registered from disk, even under the root",
    async () => {
      const env = await setup();
      const checkout = makeCheckout(env.checkouts, "mine");
      const added = await handleSetupRepoRoutes(
        route("POST", "/api/setup/repos", { source: "local", path: checkout }),
      );
      expect(added?.status).toBe(201);
      await getConfigAsync();
      expect(readConfig(env).repos.mine.addedFrom).toBe("local");
      const { archived } = fakeSessions([session("s1", "mine")]);

      const shown = await preview("mine");
      expect(shown.body).toMatchObject({ deletable: false });
      expect(shown.body.reason).toContain("existing folder");

      const { status } = await remove("mine", { deleteFiles: true });

      expect(status).toBe(400);
      expect(archived).toEqual([]);
      expect(readConfig(env).repos.mine).toBeDefined();
      expect(existsSync(checkout)).toBe(true);
    },
  );

  test.serial("refuses to delete a checkout outside the root", async () => {
    const env = await setup();
    const outside = join(env.root, "elsewhere");
    mkdirSync(outside);
    const checkout = makeCheckout(outside, "far");
    await writeConfig(env, {
      repos: { far: { repo: checkout, defaultBranch: "main" } },
    });
    fakeSessions([]);

    expect((await preview("far")).body).toMatchObject({ deletable: false });
    const { status } = await remove("far", { deleteFiles: true });

    expect(status).toBe(400);
    expect(readConfig(env).repos.far).toBeDefined();
    expect(existsSync(checkout)).toBe(true);

    // Without deleteFiles the same repository is removed and kept on disk.
    expect((await remove("far")).status).toBe(200);
    expect(readConfig(env).repos.far).toBeUndefined();
    expect(existsSync(checkout)).toBe(true);
  });

  test.serial("refuses to delete a path another repository uses", async () => {
    const env = await setup();
    const checkout = makeCheckout(env.checkouts, "shared");
    await writeConfig(env, {
      repos: {
        one: { repo: checkout, defaultBranch: "main" },
        two: { repo: checkout, defaultBranch: "main", wtPrefix: "two" },
      },
    });
    fakeSessions([]);

    const shown = await preview("one");
    expect(shown.body).toMatchObject({ deletable: false });
    expect(shown.body.reason).toContain("Another repository");
    expect((await remove("one", { deleteFiles: true })).status).toBe(400);
    expect(existsSync(checkout)).toBe(true);
    expect(readConfig(env).repos.one).toBeDefined();
  });

  test.serial("refuses a symlink that escapes the root", async () => {
    const env = await setup();
    const outside = join(env.root, "outside");
    mkdirSync(outside);
    const target = makeCheckout(outside, "target");
    const link = join(env.checkouts, "escape");
    symlinkSync(target, link);
    await writeConfig(env, {
      repos: { escape: { repo: link, defaultBranch: "main" } },
    });
    fakeSessions([]);

    expect((await preview("escape")).body).toMatchObject({ deletable: false });
    expect((await remove("escape", { deleteFiles: true })).status).toBe(400);
    expect(existsSync(join(target, "README.md"))).toBe(true);
    expect(existsSync(link)).toBe(true);
  });

  test.serial("never treats the root itself as a checkout", async () => {
    const env = await setup();
    git(["init", "-q", "-b", "main", env.checkouts]);
    await writeConfig(env, {
      repos: { root: { repo: env.checkouts, defaultBranch: "main" } },
    });
    fakeSessions([]);

    expect((await preview("root")).body).toMatchObject({ deletable: false });
    expect((await remove("root", { deleteFiles: true })).status).toBe(400);
    expect(existsSync(env.checkouts)).toBe(true);
  });

  test.serial("validates the request", async () => {
    await setup();
    await createNewRepo("widget");
    fakeSessions([]);

    expect((await remove("missing")).status).toBe(404);
    expect((await remove("widget", { deleteFiles: "yes" })).status).toBe(400);
    expect((await remove("__proto__")).status).toBe(400);
    expect((await preview("missing")).status).toBe(404);
  });
});
