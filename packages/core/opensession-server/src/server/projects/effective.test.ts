import { afterEach, beforeEach, expect, test } from "bun:test";
import { useIncidentTestKernel } from "../incidents/testing/kernel-fixture";
import { patchUiPrefs } from "../ui-prefs";
import {
  __setEffectiveDepsForTest,
  type EffectiveDeps,
  effectiveSandboxes,
  resolveSessionSandbox,
  roleWebAccess,
} from "./effective";
import { __setLegacyEnvironmentForTest } from "./legacy";
import {
  __setProjectStoreContextForTest,
  getProjectDocument,
  updateProjectDocument,
} from "./store";

useIncidentTestKernel();
const MODEL = "pi/anthropic/claude-opus-5-5";

function deps(over: Partial<EffectiveDeps>): void {
  __setEffectiveDepsForTest({
    global: () => "none",
    automationCapable: (p) => p === "daytona",
    podmanReady: () => false,
    hostEnabled: () => false,
    hostProblem: async () => "no user",
    automations: async () => [],
    automationProvider: () => "daytona",
    requested: (r) => ({
      ok: true,
      provider: !r || r === "local" ? null : (r as never),
    }),
    ...over,
  });
}

async function setSandbox(sandbox: string): Promise<void> {
  const { revision } = await getProjectDocument("acme-web");
  const out = await updateProjectDocument(
    "acme-web",
    { expectedRevision: revision, sandbox },
    { name: "Ada", verified: true, login: "ada" },
  );
  if ("error" in out) throw new Error(out.error);
}

beforeEach(() => {
  __setLegacyEnvironmentForTest({
    projects: () => ["acme-web"],
    sandbox: () => ({ perRepo: {} }),
    automations: async () => [],
    mcpServers: async () => [],
    webSearch: async () => "auto",
    defaultReviewServers: async () => [],
  });
  __setProjectStoreContextForTest({
    projectExists: (id) => id === "acme-web",
    modelProblem: () => null,
    runnerProblem: () => null,
  });
});
afterEach(() => {
  __setEffectiveDepsForTest(undefined);
  __setLegacyEnvironmentForTest(undefined);
  __setProjectStoreContextForTest(undefined);
});

test("a container project with a Daytona default: automations keep running where they did", async () => {
  deps({ global: () => "daytona" });
  await setSandbox("podman");
  expect(await effectiveSandboxes("acme-web")).toEqual({
    you: {
      state: "ok",
      provider: "podman",
      label: "This machine · container",
      source: "project",
    },
    incidentAgents: {
      state: "ok",
      provider: "podman",
      label: "This machine · container",
      source: "project",
    },
    automations: {
      state: "ok",
      provider: null,
      label: "This machine, as before",
      source: "fallback",
    },
    reviews: {
      state: "ok",
      provider: null,
      label: "This machine",
      source: "fallback",
    },
    note: "Sessions and incident agents run here. Reviews run on this machine, and automations where they ran before",
  });
});

test("automations run where their own sandbox setting says, whatever the project's", async () => {
  deps({ global: () => "daytona" });
  await setSandbox("daytona");
  // No automation asked for a sandbox: this machine, even on a Daytona
  // project with a Daytona default.
  expect((await effectiveSandboxes("acme-web")).automations).toMatchObject({
    provider: null,
    label: "This machine, as before",
  });
  expect(
    await resolveSessionSandbox(undefined, "acme-web", MODEL, "automation"),
  ).toEqual({ ok: true, provider: null });
  deps({
    global: () => "none",
    automations: async () => [{ sandbox: true }, { sandbox: true }],
  });
  await setSandbox("podman");
  expect((await effectiveSandboxes("acme-web")).automations).toEqual({
    state: "ok",
    provider: "daytona",
    label: "Disposable sandbox",
    source: "fallback",
  });
  deps({ automations: async () => [{ sandbox: true }, {}] });
  expect((await effectiveSandboxes("acme-web")).automations).toEqual({
    state: "ok",
    provider: null,
    label: "This machine, as before (1 of 2 in a disposable sandbox)",
    source: "fallback",
  });
});

test("no sandbox anywhere: incident agents can't start", async () => {
  deps({ global: () => "none" });
  expect((await effectiveSandboxes("acme-web")).incidentAgents).toEqual({
    state: "cant-start",
    reason: "Agents can't start: this project has no sandbox",
  });
});

test("a project without its own sandbox falls back to the container when Ready", async () => {
  deps({ global: () => "none", podmanReady: () => true });
  expect((await effectiveSandboxes("acme-web")).incidentAgents).toEqual({
    state: "ok",
    provider: "podman",
    label: "This machine · container",
    source: "fallback",
  });
});

test("automation runs never get the container", async () => {
  deps({});
  const out = await resolveSessionSandbox(
    "podman",
    "acme-web",
    MODEL,
    "descendant",
  );
  expect(out.ok).toBe(false);
  expect("error" in out ? out.error : "").toContain("automations");
  expect(
    await resolveSessionSandbox(undefined, "acme-web", MODEL, "descendant"),
  ).toMatchObject({ ok: false });
  expect(
    await resolveSessionSandbox(undefined, "acme-web", MODEL, "automation"),
  ).toEqual({ ok: true, provider: null });
});

test("new sessions ignore a personal default; the project and then the global decide", async () => {
  deps({ global: () => "none" });
  patchUiPrefs("Ada", { "sandbox-default": "podman" });
  expect(
    await resolveSessionSandbox(undefined, "acme-web", MODEL, "interactive"),
  ).toEqual({ ok: true, provider: null });
  deps({ global: () => "daytona" });
  expect(
    await resolveSessionSandbox(undefined, "acme-web", MODEL, "interactive"),
  ).toEqual({ ok: true, provider: "daytona" });
  await setSandbox("podman");
  expect(
    await resolveSessionSandbox(undefined, "acme-web", MODEL, "interactive"),
  ).toEqual({ ok: true, provider: "podman" });
  expect(
    await resolveSessionSandbox("local", "acme-web", MODEL, "interactive"),
  ).toEqual({ ok: true, provider: null });
});

test("unreadable project settings fall back to the global default for new sessions", async () => {
  deps({ global: () => "daytona" });
  __setLegacyEnvironmentForTest({
    projects: () => ["acme-web"],
    sandbox: () => ({ perRepo: {} }),
    automations: async () => {
      throw new Error("catalog unavailable");
    },
    mcpServers: async () => [],
    webSearch: async () => "auto",
    defaultReviewServers: async () => [],
  });
  expect(
    await resolveSessionSandbox(undefined, "acme-web", MODEL, "interactive"),
  ).toEqual({ ok: true, provider: "daytona" });
});

test("an unmigrated project's composed settings are reused, not recomposed per session", async () => {
  deps({ global: () => "none" });
  let composed = 0;
  __setLegacyEnvironmentForTest({
    projects: () => ["acme-web"],
    sandbox: () => ({ perRepo: {} }),
    automations: async () => {
      composed++;
      return [];
    },
    mcpServers: async () => [],
    webSearch: async () => "auto",
    defaultReviewServers: async () => [],
  });
  for (let i = 0; i < 3; i++)
    await resolveSessionSandbox(undefined, "acme-web", MODEL, "interactive");
  expect(composed).toBe(1);
  // The first write stores the project's own document.
  await setSandbox("podman");
  expect(
    await resolveSessionSandbox(undefined, "acme-web", MODEL, "interactive"),
  ).toEqual({ ok: true, provider: "podman" });
});

test("web search and websites for automations and reviews come from the table", async () => {
  deps({});
  // Defaults: both roles search, no websites of their own.
  expect(await roleWebAccess("acme-web", "reviews")).toEqual({
    deniedTools: {},
    websites: [],
  });
  const { revision } = await getProjectDocument("acme-web");
  const out = await updateProjectDocument(
    "acme-web",
    {
      expectedRevision: revision,
      access: {
        cells: [
          { row: { kind: "webSearch" }, role: "reviews", value: false },
          {
            row: { kind: "website", host: "docs.example.test" },
            role: "reviews",
            value: true,
          },
          {
            row: { kind: "website", host: "status.example.test" },
            role: "automations",
            value: true,
          },
        ],
      },
    },
    { name: "Ada", verified: true, login: "ada" },
  );
  if ("error" in out) throw new Error(out.error);
  expect(await roleWebAccess("acme-web", "reviews")).toEqual({
    deniedTools: {
      web_search:
        "Web search is off for this agent in the project's access settings.",
    },
    websites: ["docs.example.test"],
  });
  expect(await roleWebAccess("acme-web", "automations")).toEqual({
    deniedTools: {},
    websites: ["status.example.test"],
  });
});
