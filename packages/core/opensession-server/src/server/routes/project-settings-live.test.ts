// The project and defaults routes over their live inputs: the real model
// store, sandbox config, project document store and effective resolvers.
// Only the scratch state and the project list are test-owned.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import {
  PROJECT_ROLES,
  type ProjectDefaultsView,
  type ProjectSettingsView,
} from "../../shared/project-settings";
import { useIncidentTestKernel } from "../incidents/testing/kernel-fixture";
import { __setLegacyEnvironmentForTest } from "../projects/legacy";
import { __setProjectStoreContextForTest } from "../projects/store";
import type { RouteContext } from "./context";
import { handleProjectDefaultsRoutes } from "./project-defaults";
import { handleProjectsRoutes } from "./projects";

const kit = useIncidentTestKernel();
const ADA = { login: "ada", name: "Ada Lovelace" };
const OPUS = "pi/anthropic/claude-opus-5-5";
const FABLE = "pi/anthropic/claude-fable-5-1";
let previousSandbox: string | undefined;

beforeEach(() => {
  previousSandbox = process.env.OPENSESSION_SANDBOX_CONFIG;
  process.env.OPENSESSION_SANDBOX_CONFIG = join(kit.root(), "sandbox.json");
  __setLegacyEnvironmentForTest({
    projects: () => ["acme"],
    sandbox: () => ({ perRepo: {} }),
    automations: async () => [],
    mcpServers: async () => [],
    webSearch: async () => "auto",
    defaultReviewServers: async () => [],
  });
  __setProjectStoreContextForTest({ projectExists: (id) => id === "acme" });
});
afterEach(() => {
  if (previousSandbox === undefined)
    delete process.env.OPENSESSION_SANDBOX_CONFIG;
  else process.env.OPENSESSION_SANDBOX_CONFIG = previousSandbox;
  __setLegacyEnvironmentForTest(undefined);
  __setProjectStoreContextForTest(undefined);
});

async function call<T>(
  handler: (ctx: RouteContext) => Promise<Response | undefined>,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: T }> {
  const url = new URL(`http://localhost${path}`);
  const res = await handler({
    req: new Request(url, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    url,
    path: url.pathname,
    publicPrefix: "/backstage",
    authUser: ADA,
  });
  if (!res) throw new Error(`No route for ${method} ${path}`);
  return { status: res.status, json: (await res.json()) as T };
}

const defaults = (method: string, body?: unknown) =>
  call<ProjectDefaultsView & { error?: string }>(
    handleProjectDefaultsRoutes,
    method,
    "/api/project-defaults",
    body,
  );

test("the Defaults page sets every role's model, all or nothing", async () => {
  const set = await defaults("PATCH", {
    models: {
      automations: OPUS,
      investigator: OPUS,
      verifier: FABLE,
      reviews: FABLE,
    },
  });
  expect(set.status).toBe(200);
  expect(set.json.models).toMatchObject({
    automations: OPUS,
    reviews: FABLE,
  });
  expect(Object.keys(set.json.models).sort()).toEqual(
    [...PROJECT_ROLES].sort(),
  );

  // A bad field refuses the whole patch before any write.
  const bad = await defaults("PATCH", {
    models: { reviews: OPUS },
    sandbox: "nope",
  });
  expect(bad).toMatchObject({
    status: 400,
    json: { error: 'Unknown sandbox provider "nope"' },
  });
  const same = await defaults("PATCH", {
    models: { automations: FABLE, verifier: OPUS },
  });
  expect(same).toMatchObject({
    status: 400,
    json: { error: "Pick a different model for the verifier" },
  });
  const after = await defaults("GET");
  expect(after.json.models).toMatchObject({
    automations: OPUS,
    reviews: FABLE,
  });
});

test("the project page shows where each role runs from the live resolvers", async () => {
  const view = await call<ProjectSettingsView>(
    handleProjectsRoutes,
    "GET",
    "/api/projects/acme/settings",
  );
  expect(view.status).toBe(200);
  const { sandbox, models } = view.json.effective;
  // No sandbox anywhere: interactive sessions, reviews and automations run
  // on this machine as before.
  expect(sandbox.you).toMatchObject({ state: "ok", provider: null });
  expect(sandbox.reviews).toMatchObject({ state: "ok", provider: null });
  expect(sandbox.automations).toMatchObject({ state: "ok", provider: null });
  expect(models.reviews.source).toBe("default");
  expect((await defaults("PATCH", { models: { reviews: OPUS } })).status).toBe(
    200,
  );
  const again = await call<ProjectSettingsView>(
    handleProjectsRoutes,
    "GET",
    "/api/projects/acme/settings",
  );
  expect(again.json.effective.models.reviews).toMatchObject({
    model: OPUS,
    source: "default",
  });
});
