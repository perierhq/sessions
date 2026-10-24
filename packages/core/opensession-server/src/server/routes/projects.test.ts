import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  projectStatusLabel,
  type MigrationResult,
  type ProjectListItem,
  type ProjectSettingsDocument,
  type ProjectSettingsPatch,
} from "../../shared/project-settings";
import { ALL_READY } from "../../shared/project-settings-fixtures";
import { __setProjectViewDepsForTest } from "../projects/view";
import { testProjectViewDeps } from "../projects/view-test-deps";
import type { RouteContext } from "./context";
import { handleIncidentAccessRoutes } from "./incident-access";
import { routeHandlers } from "./index";
import { handleConnectionsRoutes } from "./connections";
import { handleIncidentsRoutes } from "./incidents";
import {
  __setProjectRoutesForTest,
  handleProjectsRoutes,
  type ProjectRouteDeps,
} from "./projects";

const ADA = { login: "ada", name: "Ada Lovelace" };
const STALE = "Settings changed since you loaded them";

let docs: Map<string, ProjectSettingsDocument>;
let calls: {
  update: Array<{ patch: ProjectSettingsPatch; verified: boolean }>;
  previews: string[];
  bound: string[];
  allowed: Array<[string, boolean]>;
  migrations: Array<{ dryRun: boolean; by: string }>;
  remigrations: Array<{ project: string; force: boolean; by: string }>;
  audits: Array<Record<string, unknown>>;
};

/** A store that checks only what these routes rely on: the revision and
 *  the person-only production fields. */
const update: ProjectRouteDeps["update"] = async (project, patch, actor) => {
  calls.update.push({ patch, verified: actor.verified });
  const doc = docs.get(project);
  if (!doc) return { error: `Unknown project ${project}`, status: 404 };
  if (patch.expectedRevision !== doc.revision)
    return { error: STALE, status: 409 };
  if (patch.production && !actor.verified)
    return {
      error: "Only a signed-in person can change actions or production Runners",
      status: 403,
    };
  const next: ProjectSettingsDocument = {
    ...doc,
    revision: doc.revision + 1,
    updatedBy: actor.name,
    production: {
      ...doc.production,
      ...(patch.production?.actions
        ? { actions: patch.production.actions }
        : {}),
      ...(patch.production?.runners
        ? { runners: patch.production.runners }
        : {}),
    },
  };
  docs.set(project, next);
  return next;
};

beforeEach(() => {
  const store = testProjectViewDeps();
  docs = store.docs;
  calls = {
    update: [],
    previews: [],
    bound: [],
    allowed: [],
    migrations: [],
    remigrations: [],
    audits: [],
  };
  __setProjectViewDepsForTest(store.deps);
  __setProjectRoutesForTest({
    update,
    patchAsServer: async (project, mutate) => {
      const next = mutate(docs.get(project)!);
      docs.set(project, next);
      return next;
    },
    previewsProblem: (value) =>
      value === "nowhere" ? 'Unknown sandbox provider "nowhere"' : null,
    savePreviews: async (_project, value) => {
      await Promise.resolve();
      if (value === "offline")
        throw new Error(
          'Sandbox provider "offline" is not currently available',
        );
      calls.previews.push(value);
    },
    bindRunner: async (_project, runnerId, _by, opts) => {
      if (!opts.confirmShared)
        throw new Error(
          "Runner shared serves every repository. Confirm to reserve it for acme-web incidents only",
        );
      calls.bound.push(runnerId);
    },
    allowUnattended: (server, on) => {
      if (server === "missing") return { error: 'Server "missing" not found' };
      calls.allowed.push([server, on]);
      return { ok: true };
    },
    migrate: async (opts) => {
      calls.migrations.push(opts);
      const out: MigrationResult = {
        backupPath: opts.dryRun ? null : "/state/backups/x.json",
        projects: [{ project: "acme-web", dropped: [], access: "migrated" }],
        personalDefaultsCleared: 0,
        alreadyMigrated: [],
      };
      return out;
    },
    remigrate: async (project, opts) => {
      calls.remigrations.push({ project, ...opts });
      return {
        project,
        report: { project, dropped: [], access: "migrated" },
        backupPath: opts.force ? "/state/backups/acme-web.json" : null,
        overwritten: opts.force,
        widened: [],
      };
    },
    audit: (e) => calls.audits.push(e),
  });
});

afterEach(() => {
  __setProjectViewDepsForTest(undefined);
  __setProjectRoutesForTest(undefined);
});

const call = async (
  method: string,
  path: string,
  body?: unknown,
  authUser: RouteContext["authUser"] = ADA,
) => {
  const url = new URL(`http://localhost${path}`);
  const res = await handleProjectsRoutes({
    req: new Request(url, {
      method,
      body:
        body === undefined
          ? undefined
          : typeof body === "string"
            ? body
            : JSON.stringify(body),
    }),
    url,
    path: url.pathname,
    publicPrefix: "/backstage",
    authUser,
  });
  return res ? { status: res.status, json: await res.json() } : undefined;
};

test("GET settings: the view, 404 for an unknown project", async () => {
  expect((await call("GET", "/api/projects/nope/settings"))?.status).toBe(404);
  const got = await call("GET", "/api/projects/acme-web/settings");
  expect(got?.status).toBe(200);
  expect(got?.json.readiness.status).toEqual({
    kind: "partial",
    label: "4 of 6 ready",
  });
  expect(got?.json.document.releaseHookPath).toBe(
    "/incident-releases/acme-web/fixture",
  );
  const anonymous = await call(
    "GET",
    "/api/projects/acme-web/settings",
    undefined,
    null,
  );
  expect(anonymous?.json.document).not.toHaveProperty("releaseHookPath");
  expect(JSON.stringify(anonymous?.json)).not.toContain("releaseHookSecret");
});

test("PATCH with a stale revision is a 409 with the reason", async () => {
  expect(
    await call("PATCH", "/api/projects/acme-web/settings", {
      expectedRevision: 3,
      sandbox: "daytona",
    }),
  ).toEqual({ status: 409, json: { error: STALE } });
});

test("PATCH by an unverified caller adding a runner is a 403", async () => {
  const out = await call(
    "PATCH",
    "/api/projects/acme-web/settings",
    { expectedRevision: 4, production: { runners: ["rn-2"] }, user: "Ada" },
    null,
  );
  expect(out?.status).toBe(403);
  expect(calls.update[0]?.verified).toBe(false);
  // A claimed user never reaches the store.
  expect(calls.update[0]?.patch).not.toHaveProperty("user");
});

test("a valid PATCH returns readiness recomputed", async () => {
  const out = await call("PATCH", "/api/projects/acme-web/settings", {
    expectedRevision: 4,
    production: { actions: ALL_READY.document.production.actions },
  });
  expect(out?.status).toBe(200);
  expect(out?.json.document.revision).toBe(5);
  expect(out?.json.readiness.readyCount).toBe(5);
  expect(out?.json.readiness.steps[0].title).toBe("Logs for agents");
});

test("PATCH previews saves beside the document; a bad one is a 400", async () => {
  const ok = await call("PATCH", "/api/projects/acme-web/settings", {
    expectedRevision: 4,
    previews: "daytona",
  });
  expect(ok?.status).toBe(200);
  expect(calls.previews).toEqual(["daytona"]);
  expect(
    (
      await call("PATCH", "/api/projects/acme-web/settings", {
        expectedRevision: 5,
        previews: "nowhere",
      })
    )?.json,
  ).toEqual({ error: 'Unknown sandbox provider "nowhere"' });
});

test("a bad previews value writes nothing; a failed save is not a 200", async () => {
  const bad = await call("PATCH", "/api/projects/acme-web/settings", {
    expectedRevision: 4,
    sandbox: "podman",
    previews: "nowhere",
  });
  expect(bad?.status).toBe(400);
  expect(calls.update).toEqual([]);
  const failed = await call("PATCH", "/api/projects/acme-web/settings", {
    expectedRevision: 4,
    previews: "offline",
  });
  expect(failed).toMatchObject({
    status: 400,
    json: { error: 'Sandbox provider "offline" is not currently available' },
  });
});

test("PATCH input errors", async () => {
  expect(
    (await call("PATCH", "/api/projects/acme-web/settings", "{nope"))?.json,
  ).toEqual({ error: "Invalid JSON" });
  expect(
    (await call("PATCH", "/api/projects/acme-web/settings", { sandbox: "x" }))
      ?.json,
  ).toEqual({ error: "expectedRevision must be an integer" });
  expect(
    (
      await call("PATCH", "/api/projects/acme-web/settings", {
        expectedRevision: 4,
        colour: "red",
      })
    )?.json,
  ).toEqual({ error: "Unknown field colour" });
  expect(
    (
      await call("PATCH", "/api/projects/nope/settings", {
        expectedRevision: 0,
      })
    )?.status,
  ).toBe(404);
  expect(calls.update).toEqual([]);
});

test("GET /api/projects labels match projectStatusLabel", async () => {
  const out = await call("GET", "/api/projects");
  const list = out?.json as ProjectListItem[];
  expect(list.map((p) => p.id)).toEqual(["acme-web", "acme-api", "docs-site"]);
  expect(list[0]?.status).toEqual(
    projectStatusLabel({ readyCount: 4, blocking: null }, true),
  );
  expect(list[1]?.status).toEqual(
    projectStatusLabel({ readyCount: 0, blocking: null }, false),
  );
});

test("adding a production Runner: a signed-in person, confirmed when shared", async () => {
  const path = "/api/projects/acme-web/production/runners";
  expect(await call("POST", path, { runnerId: "rn-2" }, null)).toEqual({
    status: 403,
    json: { error: "Only a signed-in person can add a production Runner" },
  });
  expect((await call("POST", path, { runnerId: "rn-2" }))?.status).toBe(400);
  expect((await call("POST", path, {}))?.json).toEqual({
    error: "runnerId is required",
  });
  const out = await call("POST", path, { runnerId: "rn-2", shared: true });
  expect(out?.status).toBe(200);
  expect(calls.bound).toEqual(["rn-2"]);
  expect(out?.json.document.production.runners).toEqual([
    "rn-prod-eu-1",
    "rn-2",
  ]);
  expect(
    (await call("POST", "/api/projects/nope/production/runners", {}))?.status,
  ).toBe(404);
});

test("allow agents on a connector: a signed-in person, audited", async () => {
  const path = "/api/connections/grafana/allow-unattended";
  expect((await call("POST", path, { on: true }, null))?.status).toBe(403);
  expect((await call("POST", path, { on: "yes" }))?.status).toBe(400);
  expect(await call("POST", path, { on: true })).toEqual({
    status: 200,
    json: { ok: true },
  });
  expect(calls.allowed).toEqual([["grafana", true]]);
  expect(calls.audits).toEqual([
    {
      kind: "connection_allow_unattended",
      server: "grafana",
      on: true,
      by: "Ada",
    },
  ]);
  expect(
    (
      await call("POST", "/api/connections/missing/allow-unattended", {
        on: true,
      })
    )?.status,
  ).toBe(400);
});

test("migrate: a signed-in person; a dry run only reports", async () => {
  expect(
    (await call("POST", "/api/projects/migrate", { dryRun: true }, null))
      ?.status,
  ).toBe(403);
  const dry = await call("POST", "/api/projects/migrate", { dryRun: true });
  expect(dry?.json).toMatchObject({
    backupPath: null,
    projects: [{ project: "acme-web", access: "migrated" }],
  });
  expect(calls.migrations).toEqual([{ dryRun: true, by: "Ada" }]);
  expect(calls.update).toEqual([]);
  expect(
    (await call("POST", "/api/projects/migrate", { dryRun: "no" }))?.status,
  ).toBe(400);
});

test("re-migrating one project: a signed-in person, overwriting only on force", async () => {
  const path = "/api/projects/acme-web/migrate";
  expect((await call("POST", path, { force: true }, null))?.status).toBe(403);
  expect((await call("POST", path, { force: "yes" }))?.status).toBe(400);
  expect(
    (await call("POST", "/api/projects/acme-gone/migrate", {}))?.status,
  ).toBe(404);
  const preview = await call("POST", path, {});
  expect(preview?.json).toMatchObject({ overwritten: false, backupPath: null });
  const done = await call("POST", path, { force: true });
  expect(done?.json).toMatchObject({
    overwritten: true,
    backupPath: "/state/backups/acme-web.json",
  });
  expect(calls.remigrations).toEqual([
    { project: "acme-web", force: false, by: "Ada" },
    { project: "acme-web", force: true, by: "Ada" },
  ]);
});

test("old incident access writes answer 410", async () => {
  const url = new URL("http://localhost/api/incident-access/acme-web/grants");
  const res = await handleIncidentAccessRoutes({
    req: new Request(url, { method: "PUT", body: "{}" }),
    url,
    path: url.pathname,
    publicPrefix: "/backstage",
    authUser: ADA,
  });
  expect(res?.status).toBe(410);
  expect(await res?.json()).toEqual({
    error: "Moved to /api/projects/acme-web/settings",
  });
});

test("other paths fall through", async () => {
  expect(await call("GET", "/api/projects/acme-web")).toBeUndefined();
  expect(
    await call("DELETE", "/api/projects/acme-web/settings"),
  ).toBeUndefined();
  expect(await call("GET", "/api/connections")).toBeUndefined();
});

test("registered before the incidents and connections routes", () => {
  const at = routeHandlers.indexOf(handleProjectsRoutes);
  expect(at).toBeGreaterThan(-1);
  expect(at).toBeLessThan(routeHandlers.indexOf(handleIncidentsRoutes));
  expect(at).toBeLessThan(routeHandlers.indexOf(handleConnectionsRoutes));
});
