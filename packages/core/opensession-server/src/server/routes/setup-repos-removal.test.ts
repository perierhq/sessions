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
import { dirname, join } from "path";
import { getConfigAsync } from "../config";
import { OPENSESSION_SESSIONS_DIR } from "../paths";
import {
  PLAN_CHANGED,
  UNVERIFIED_NOTICE,
  __setRepoRemovalDepsForTest,
} from "../repo-removal";
import {
  RepoBeingRemovedError,
  isRepoBeingRemoved,
} from "../repo-removal-guard";
import { getUiPrefs, patchUiPrefs } from "../ui-prefs";
import type { UnifiedSession } from "../types";
import { createWorktree } from "../worktree";
import type { RouteContext } from "./context";
import { handleSetupRepoRoutes } from "./setup-repos";

const saved = {
  sandbox: process.env.OPENSESSION_SANDBOX_CONFIG,
  config: process.env.OPENSESSION_CONFIG,
  worktrees: process.env.OPENSESSION_WORKTREES_DIR,
  home: process.env.HOME,
};
const roots: string[] = [];

afterEach(async () => {
  __setRepoRemovalDepsForTest(null);
  for (const [key, value] of [
    ["OPENSESSION_CONFIG", saved.config],
    ["OPENSESSION_SANDBOX_CONFIG", saved.sandbox],
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

const ALICE = { login: "alice", name: "Alice" };

function route(
  method: string,
  path: string,
  body?: unknown,
  authUser: RouteContext["authUser"] = ALICE,
): RouteContext {
  const url = new URL(`http://localhost${path}`);
  return {
    authUser,
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

/** Fake session layer: `sessions` are live; archiving records the ids.
 *  `onArchive` runs while the removal is under way. */
function fakeSessions(
  sessions: UnifiedSession[],
  opts: {
    automations?: number;
    onArchive?: () => Promise<void> | void;
    stopWorkloadsInDir?: (dir: string) => Promise<void>;
  } = {},
) {
  const archived: string[] = [];
  const released: string[] = [];
  const disabled: string[] = [];
  __setRepoRemovalDepsForTest({
    liveSessions: async () => sessions.filter((s) => !archived.includes(s.id)),
    archiveSessions: async (batch) => {
      archived.push(...batch.map((s) => s.id));
      await opts.onArchive?.();
    },
    releaseWorkspaces: async (repoId) => {
      released.push(repoId);
    },
    stopWorkloadsInDir: opts.stopWorkloadsInDir ?? (async () => {}),
    countAutomations: async () => opts.automations ?? 0,
    disableAutomations: async (repoId) => {
      disabled.push(repoId);
      return opts.automations ?? 0;
    },
  });
  return { archived, released, disabled };
}

async function preview(id: string) {
  const response = await handleSetupRepoRoutes(
    route("GET", `/api/setup/repos/${encodeURIComponent(id)}/removal`),
  );
  return { status: response?.status, body: (await response?.json()) as any };
}

async function remove(
  id: string,
  body?: unknown,
  authUser: RouteContext["authUser"] = ALICE,
) {
  const response = await handleSetupRepoRoutes(
    route(
      "DELETE",
      `/api/setup/repos/${encodeURIComponent(id)}`,
      body,
      authUser,
    ),
  );
  return { status: response?.status, body: (await response?.json()) as any };
}

/** Delete with files, sending back the plan token the preview handed out. */
async function removeWithFiles(
  id: string,
  extra: Record<string, unknown> = {},
) {
  const shown = await preview(id);
  return remove(id, {
    deleteFiles: true,
    planToken: shown.body.planToken,
    ...extra,
  });
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
        attached: 0,
        attachedSessions: [],
        automations: 0,
        deletable: true,
        tier: "managed",
        deletePaths: [
          join(env.checkouts, "widget"),
          join(env.checkouts, "widget.git"),
        ],
        worktrees: 0,
        unpushedBranches: 0,
      });
      expect(body.confirmRequired).toBeUndefined();
      expect(typeof body.sizeBytes).toBe("number");
      expect(body.planToken).toMatch(/^[0-9a-f]{32}$/);
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
      const sandboxPath = join(env.root, "sandbox.json");
      process.env.OPENSESSION_SANDBOX_CONFIG = sandboxPath;
      writeFileSync(
        sandboxPath,
        JSON.stringify({
          provider: "local",
          perRepo: { widget: { sessionDefault: "none" }, other: {} },
          prewarm: {
            keepReady: [
              { provider: "daytona", repoId: "widget" },
              { provider: "daytona", repoId: "other" },
            ],
          },
        }),
      );
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
        automationsDisabled: 0,
        deleted: [],
        kept: [],
      });
      expect(archived).toEqual(["s1", "s2"]);
      expect(released).toEqual(["widget"]);
      const after = readConfig(env);
      expect(after.repos.widget).toBeUndefined();
      expect(after.repos.other).toBeDefined();
      expect(after.newSessionRepo).toBeUndefined();
      expect(JSON.parse(readFileSync(sandboxPath, "utf-8"))).toEqual({
        provider: "local",
        perRepo: { other: {} },
        prewarm: { keepReady: [{ provider: "daytona", repoId: "other" }] },
      });
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

      const { status, body } = await removeWithFiles("widget");

      expect(status).toBe(200);
      expect(body.error).toBeUndefined();
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
    expect(
      (await remove("widget", { deleteFiles: true, planToken: 5 })).status,
    ).toBe(400);
    expect((await remove("__proto__")).status).toBe(400);
    expect((await preview("missing")).status).toBe(404);
  });

  test.serial(
    "deleting files needs a signed-in person, not an automation",
    async () => {
      const env = await setup();
      await createNewRepo("widget");
      fakeSessions([]);
      const token = (await preview("widget")).body.planToken;

      for (const who of [null, { ...ALICE, automation: true }]) {
        const { status } = await remove(
          "widget",
          { deleteFiles: true, planToken: token },
          who as RouteContext["authUser"],
        );
        expect(status).toBe(403);
      }
      expect(readConfig(env).repos.widget).toBeDefined();
      expect(existsSync(join(env.checkouts, "widget"))).toBe(true);
      // Removing without its files needs no sign-in.
      expect(
        (await remove("widget", { deleteFiles: false }, null)).status,
      ).toBe(200);
    },
  );

  test.serial(
    "a delete must carry the token of the plan it reviewed",
    async () => {
      const env = await setup();
      await createNewRepo("widget");
      fakeSessions([]);
      const token = (await preview("widget")).body.planToken;

      const missing = await remove("widget", { deleteFiles: true });
      expect(missing).toMatchObject({
        status: 409,
        body: { error: PLAN_CHANGED },
      });
      // A worktree made after the preview changes the plan.
      await createWorktree("later", "widget");
      const stale = await remove("widget", {
        deleteFiles: true,
        planToken: token,
      });
      expect(stale).toMatchObject({
        status: 409,
        body: { error: PLAN_CHANGED },
      });
      expect(readConfig(env).repos.widget).toBeDefined();
      expect(existsSync(join(env.checkouts, "widget"))).toBe(true);
      expect(existsSync(join(env.worktrees, "widget-later"))).toBe(true);
    },
  );

  for (const [name, addedFrom] of [
    ["an entry from before provenance was recorded", undefined],
    ["a clone that adopted an existing folder", "adopted"],
  ] as const) {
    test.serial(
      `${name} needs the id typed in to delete its files`,
      async () => {
        const env = await setup();
        const checkout = makeCheckout(env.checkouts, "legacy");
        await writeConfig(env, {
          repos: {
            legacy: {
              repo: checkout,
              defaultBranch: "main",
              ...(addedFrom ? { addedFrom } : {}),
            },
          },
        });
        fakeSessions([]);

        const shown = await preview("legacy");
        expect(shown.body).toMatchObject({
          deletable: true,
          tier: "unverified",
          confirmRequired: true,
          reason: UNVERIFIED_NOTICE,
          // Its bare origin sits in the root too, but nothing says this
          // server made it, so it is never part of the plan.
          deletePaths: [checkout],
        });

        const unconfirmed = await remove("legacy", {
          deleteFiles: true,
          planToken: shown.body.planToken,
        });
        expect(unconfirmed.status).toBe(400);
        const wrong = await remove("legacy", {
          deleteFiles: true,
          planToken: shown.body.planToken,
          confirm: "Legacy",
        });
        expect(wrong.status).toBe(400);
        expect(readConfig(env).repos.legacy).toBeDefined();
        expect(existsSync(checkout)).toBe(true);

        const { status, body } = await removeWithFiles("legacy", {
          confirm: "legacy",
        });
        expect(status).toBe(200);
        expect(body.deleted).toEqual([checkout]);
        expect(existsSync(checkout)).toBe(false);
        expect(existsSync(join(env.checkouts, "legacy-remote.git"))).toBe(true);
        expect(readConfig(env).repos.legacy).toBeUndefined();
      },
    );
  }

  test.serial(
    "a folder registered from disk stays even with the id typed in",
    async () => {
      const env = await setup();
      const checkout = makeCheckout(env.checkouts, "mine");
      await writeConfig(env, {
        repos: {
          mine: { repo: checkout, defaultBranch: "main", addedFrom: "local" },
        },
      });
      fakeSessions([]);

      const shown = await preview("mine");
      expect(shown.body).toMatchObject({ deletable: false, tier: "never" });
      expect(shown.body.planToken).toBeUndefined();
      const { status } = await remove("mine", {
        deleteFiles: true,
        confirm: "mine",
        planToken: "0".repeat(32),
      });
      expect(status).toBe(400);
      expect(existsSync(checkout)).toBe(true);
    },
  );

  test.serial("refuses the folder the server runs from", async () => {
    const env = await setup();
    const checkout = makeCheckout(env.checkouts, "self");
    await writeConfig(env, {
      repos: {
        self: { repo: checkout, defaultBranch: "main", addedFrom: "new" },
      },
    });
    fakeSessions([]);
    const cwd = process.cwd();
    process.chdir(checkout);
    try {
      const shown = await preview("self");
      expect(shown.body).toMatchObject({ deletable: false });
      expect(shown.body.reason).toContain("This server runs from this folder");
      expect((await remove("self", { deleteFiles: true })).status).toBe(400);
    } finally {
      process.chdir(cwd);
    }
    expect(existsSync(checkout)).toBe(true);
  });

  test.serial("refuses a checkout nested deeper in the root", async () => {
    const env = await setup();
    mkdirSync(join(env.checkouts, "a"));
    const checkout = makeCheckout(join(env.checkouts, "a"), "b");
    await writeConfig(env, {
      repos: { b: { repo: checkout, defaultBranch: "main", addedFrom: "new" } },
    });
    fakeSessions([]);

    expect((await preview("b")).body).toMatchObject({ deletable: false });
    expect((await remove("b", { deleteFiles: true })).status).toBe(400);
    expect(existsSync(checkout)).toBe(true);
    expect(existsSync(join(env.checkouts, "a"))).toBe(true);
  });

  test.serial(
    "a registered path that no longer resolves still counts as shared",
    async () => {
      const env = await setup();
      await createNewRepo("widget");
      const config = readConfig(env);
      // Another repository registered inside this checkout, whose folder is
      // gone, so realpath can't resolve it.
      config.repos.inner = {
        repo: join(env.checkouts, "widget", "packages", "inner"),
        defaultBranch: "main",
      };
      await writeConfig(env, config);
      fakeSessions([]);

      const shown = await preview("widget");
      expect(shown.body).toMatchObject({ deletable: false });
      expect(shown.body.reason).toContain("Another repository");
    },
  );

  test.serial("removes the last repository and its files", async () => {
    const env = await setup();
    await createNewRepo("widget");
    const config = readConfig(env);
    config.newSessionRepo = "widget";
    await writeConfig(env, config);
    fakeSessions([]);

    const { status, body } = await removeWithFiles("widget");

    expect(status).toBe(200);
    expect(body.kept).toEqual([]);
    const after = readConfig(env);
    expect(after.repos).toEqual({});
    expect(after.newSessionRepo).toBeUndefined();
    expect(existsSync(env.checkouts)).toBe(true);
    expect(existsSync(join(env.checkouts, "widget"))).toBe(false);
  });

  test.serial(
    "leaves a worktree whose admin files point at another repository's",
    async () => {
      const env = await setup();
      await createNewRepo("widget");
      await createNewRepo("widget-two");
      const theirs = await createWorktree("feature", "widget-two");
      const mine = await createWorktree("x", "widget");
      // Edit widget's admin entry so `git worktree list` in widget names
      // widget-two's worktree, whose name also starts with "widget-".
      const admin = readFileSync(join(mine, ".git"), "utf-8")
        .replace(/^gitdir:\s*/, "")
        .trim();
      writeFileSync(join(admin, "gitdir"), `${join(theirs, ".git")}\n`);
      fakeSessions([]);

      const shown = await preview("widget");
      expect(shown.body.deletePaths).not.toContain(realpathSync(theirs));
      const { status, body } = await removeWithFiles("widget");

      expect(status).toBe(200);
      expect(body.deleted).not.toContain(realpathSync(theirs));
      expect(existsSync(join(theirs, "README.md"))).toBe(true);
      expect(existsSync(join(env.checkouts, "widget-two"))).toBe(true);
    },
  );

  test.serial(
    "a worktree git can't remove stays, and so does its checkout",
    async () => {
      const env = await setup();
      await createNewRepo("widget");
      const worktree = realpathSync(await createWorktree("locked", "widget"));
      // A locked worktree refuses a single --force.
      git(["-C", join(env.checkouts, "widget"), "worktree", "lock", worktree]);
      fakeSessions([]);

      const { status, body } = await removeWithFiles("widget");

      expect(status).toBe(200);
      expect(body.kept).toContain(worktree);
      expect(body.kept).toContain(join(env.checkouts, "widget"));
      expect(body.error).toContain("couldn't be deleted");
      expect(existsSync(worktree)).toBe(true);
      expect(existsSync(join(env.checkouts, "widget"))).toBe(true);
      // The registration is gone either way.
      expect(readConfig(env).repos.widget).toBeUndefined();
    },
  );

  test.serial(
    "a session that attached the repository blocks removal",
    async () => {
      const env = await setup();
      await createNewRepo("widget");
      await createNewRepo("other");
      const { archived } = fakeSessions([
        session("s1", "other", {
          title: "Cross-repo change",
          attachedRepos: [
            {
              repo: "widget",
              branch: "feature",
              dir: join(env.worktrees, "widget-feature"),
            },
          ],
        }),
      ]);

      const shown = await preview("widget");
      expect(shown.body).toMatchObject({
        sessions: 0,
        attached: 1,
        attachedSessions: [{ id: "s1", title: "Cross-repo change" }],
      });
      const { status, body } = await remove("widget");
      expect(status).toBe(409);
      expect(body).toMatchObject({
        error: "Archive 1 session that also uses it first",
        attached: 1,
      });
      expect(archived).toEqual([]);
      expect(readConfig(env).repos.widget).toBeDefined();
    },
  );

  test.serial(
    "refuses new work while removing, and keeps files a late session uses",
    async () => {
      const env = await setup();
      await createNewRepo("widget");
      const live = [session("s1", "widget")];
      let refused: unknown;
      fakeSessions(live, {
        onArchive: async () => {
          expect(isRepoBeingRemoved("widget")).toBe(true);
          refused = await createWorktree("late", "widget").catch((e) => e);
          // One that started just before the mark still shows up afterwards.
          live.push(session("s2", "widget"));
        },
      });

      const { status, body } = await removeWithFiles("widget");

      expect(refused).toBeInstanceOf(RepoBeingRemovedError);
      expect(existsSync(join(env.worktrees, "widget-late"))).toBe(false);
      expect(status).toBe(200);
      expect(body.deleted).toEqual([]);
      expect(body.kept).toContain(join(env.checkouts, "widget"));
      expect(body.error).toContain("A session started in this repository");
      expect(existsSync(join(env.checkouts, "widget"))).toBe(true);
      expect(readConfig(env).repos.widget).toBeUndefined();
      expect(isRepoBeingRemoved("widget")).toBe(false);
    },
  );

  test.serial(
    "a failure while deleting still reports the removal",
    async () => {
      const env = await setup();
      await createNewRepo("widget");
      const checkout = join(env.checkouts, "widget");
      fakeSessions([], {
        stopWorkloadsInDir: async (dir) => {
          if (dir === checkout) throw new Error("disk on fire");
        },
      });

      const { status, body } = await removeWithFiles("widget");

      expect(status).toBe(200);
      expect(body.error).toContain("disk on fire");
      expect(body.kept).toContain(checkout);
      expect(existsSync(checkout)).toBe(true);
      expect(readConfig(env).repos.widget).toBeUndefined();
      // Asking again finds nothing to remove.
      expect((await remove("widget")).status).toBe(404);
    },
  );

  test.serial(
    "turns off the repository's automations and counts them",
    async () => {
      await setup();
      await createNewRepo("widget");
      const { disabled } = fakeSessions([], { automations: 2 });

      expect((await preview("widget")).body.automations).toBe(2);
      const { status, body } = await remove("widget");

      expect(status).toBe(200);
      expect(body.automationsDisabled).toBe(2);
      expect(disabled).toEqual(["widget"]);
    },
  );

  test.serial(
    "counts a session without a recorded repo through a symlinked path",
    async () => {
      const env = await setup();
      await createNewRepo("widget");
      const link = join(env.root, "widget-link");
      symlinkSync(join(env.checkouts, "widget"), link);
      const { archived } = fakeSessions([
        session("s1", undefined, { worktreeDir: link }),
        session("s2", undefined, {
          worktreeDir: join(env.worktrees, "widget-gone"),
        }),
      ]);

      expect((await preview("widget")).body.sessions).toBe(2);
      expect((await remove("widget")).status).toBe(200);
      expect(archived).toEqual(["s1", "s2"]);
    },
  );

  test.serial(
    "deletes the warm-template spares and state with the files",
    async () => {
      const env = await setup();
      await createNewRepo("widget");
      await createNewRepo("other");
      const spares = join(env.worktrees, ".warm-spares", "widget");
      const otherSpares = join(env.worktrees, ".warm-spares", "other");
      mkdirSync(join(spares, "spare-abc-123"), { recursive: true });
      mkdirSync(otherSpares, { recursive: true });
      const warmDir = join(OPENSESSION_SESSIONS_DIR, "warm-templates");
      mkdirSync(warmDir, { recursive: true });
      const state = join(warmDir, "widget.state.json");
      const manifest = join(warmDir, "widget.manifest");
      const otherState = join(warmDir, "other.state.json");
      for (const file of [state, manifest, otherState])
        writeFileSync(file, "{}\n");
      fakeSessions([]);

      const shown = await preview("widget");
      expect(shown.body.deletePaths).toContain(realpathSync(spares));
      const { status, body } = await removeWithFiles("widget");

      expect(status).toBe(200);
      expect(body.deleted).toContain(realpathSync(dirname(spares)) + "/widget");
      expect(existsSync(spares)).toBe(false);
      expect(existsSync(state)).toBe(false);
      expect(existsSync(manifest)).toBe(false);
      expect(existsSync(otherSpares)).toBe(true);
      expect(existsSync(otherState)).toBe(true);
    },
  );
});
