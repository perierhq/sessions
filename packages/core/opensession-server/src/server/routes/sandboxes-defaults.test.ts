import { afterEach, beforeEach, expect, test } from "bun:test";
import { useIncidentTestKernel } from "../incidents/testing/kernel-fixture";
import { __setLegacyEnvironmentForTest } from "../projects/legacy";
import {
  __setProjectStoreContextForTest,
  getProjectDocument,
} from "../projects/store";
import { saveRepoSandboxDefault } from "../sandbox/defaults";
import type { RouteContext } from "./context";
import { handleSandboxesRoutes } from "./sandboxes";

const kit = useIncidentTestKernel();

beforeEach(() => {
  __setLegacyEnvironmentForTest({
    projects: () => ["acme-web"],
    sandbox: () => ({ perRepo: {} }),
    automations: async () => [],
    mcpServers: async () => [],
    webSearch: async () => "auto",
    defaultReviewServers: async () => [],
  });
  __setProjectStoreContextForTest({ projectExists: (id) => id === "acme-web" });
});
afterEach(() => {
  __setLegacyEnvironmentForTest(undefined);
  __setProjectStoreContextForTest(undefined);
});

async function put(body: unknown, authUser: RouteContext["authUser"]) {
  const url = new URL("http://localhost/api/sandbox/defaults");
  const res = await handleSandboxesRoutes({
    req: new Request(url, { method: "PUT", body: JSON.stringify(body) }),
    url,
    path: url.pathname,
    publicPrefix: "/backstage",
    authUser,
  });
  return { status: res!.status, json: (await res!.json()) as unknown };
}

test("only a signed-in person changes the workspace or a project sandbox", async () => {
  const automation = {
    login: "automation",
    name: "Automation",
    automation: true,
  } as RouteContext["authUser"];
  for (const authUser of [null, automation])
    for (const body of [
      { scope: "workspace", value: "none" },
      { scope: "repo", repo: "acme-web", value: "none", user: "Ada" },
    ])
      expect(await put(body, authUser)).toEqual({
        status: 403,
        json: { error: "Only a signed-in person can change where agents run" },
      });
  expect((await getProjectDocument("acme-web")).sandbox).toBe("default");
});

test("a project sandbox write records the signed-in person", async () => {
  await saveRepoSandboxDefault("acme-web", "none", {
    name: "Ada",
    verified: true,
    login: "ada",
  });
  const doc = await getProjectDocument("acme-web");
  expect(doc).toMatchObject({ sandbox: "local", updatedBy: "Ada" });
  expect(kit.audits.at(-1)).toMatchObject({
    kind: "project_settings_updated",
    by: "Ada",
    fields: ["sandbox"],
  });
});
