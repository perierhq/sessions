import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useIncidentTestKernel } from "../incidents/testing/kernel-fixture";
import { automationModel } from "../automations";
import { __resetModelCachesForTest } from "../models";
import { patchUiPrefs } from "../ui-prefs";
import { writeWebSearchSetting } from "../web-search-setting";
import {
  __setEffectiveDepsForTest,
  type EffectiveDeps,
  effectiveRoleModel,
  effectiveSandboxes,
  knowledgeWebsites,
  resolveSessionSandbox,
  roleWebAccess,
} from "./effective";
import { setGlobalRoleDefault } from "./global-defaults";
import { defaultSandboxGpu } from "../sandbox/defaults";
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
    providerUsability: () => "usable",
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
  __resetModelCachesForTest();
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
    support: {
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

test("a project's Modal sandbox may carry a GPU, which only an unchosen Machine follows", async () => {
  deps({ global: () => "none" });
  await setSandbox("modal:t4");
  expect((await getProjectDocument("acme-web")).sandbox).toBe("modal:T4");
  // The provider is Modal; the GPU rides along to new sessions only.
  expect(
    await resolveSessionSandbox(undefined, "acme-web", MODEL, "interactive"),
  ).toEqual({ ok: true, provider: "modal" });
  const where = await effectiveSandboxes("acme-web");
  expect(where.you).toMatchObject({
    state: "ok",
    provider: "modal",
    label: "Modal · T4 GPU",
  });
  expect(
    await defaultSandboxGpu(undefined, undefined, "modal", "acme-web"),
  ).toBe("T4");
  expect(await defaultSandboxGpu("modal", undefined, "modal", "acme-web")).toBe(
    undefined,
  );
  expect(await defaultSandboxGpu(undefined, "L4", "modal", "acme-web")).toBe(
    undefined,
  );
  expect(
    await defaultSandboxGpu(undefined, undefined, "daytona", "acme-web"),
  ).toBe(undefined);
  // Plain Modal drops the GPU.
  await setSandbox("modal");
  expect(
    await defaultSandboxGpu(undefined, undefined, "modal", "acme-web"),
  ).toBe(undefined);
  // A GPU only rides on Modal, and only a known one.
  for (const bad of ["daytona:T4", "modal:H100"])
    await expect(setSandbox(bad)).rejects.toThrow(/Unknown sandbox provider/);
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
  // Incident agents and automation runs don't guess: the project may have
  // pinned a sandbox, so they stop with a setup problem instead.
  for (const kind of ["incident", "descendant"] as const)
    expect(
      await resolveSessionSandbox(undefined, "acme-web", MODEL, kind),
    ).toEqual({
      ok: false,
      error: "Can't start: the settings for acme-web could not be read",
    });
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
  // A write to a shared input (here web search) recomposes at once.
  const dir = mkdtempSync(join(tmpdir(), "web-search-"));
  try {
    await writeWebSearchSetting("off", join(dir, "web-search.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  await resolveSessionSandbox(undefined, "acme-web", MODEL, "interactive");
  expect(composed).toBe(2);
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

test("knowledge websites are the Support websites switched to 'Use as knowledge'", async () => {
  deps({});
  const site = (host: string) => ({
    row: { kind: "website" as const, host },
    role: "support" as const,
    value: true,
  });
  const { revision } = await getProjectDocument("acme-web");
  const out = await updateProjectDocument(
    "acme-web",
    {
      expectedRevision: revision,
      access: {
        cells: [
          site("help.acme.example.test"),
          site("status.acme.example.test"),
          {
            row: { kind: "website", host: "docs.example.test" },
            role: "reviews",
            value: true,
          },
        ],
        websiteKnowledge: [
          { host: "help.acme.example.test", on: true },
          // Not ticked for Support: the switch alone imports nothing.
          { host: "docs.example.test", on: true },
        ],
      },
    },
    { name: "Ada", verified: true, login: "ada" },
  );
  if ("error" in out) throw new Error(out.error);
  expect(await knowledgeWebsites("acme-web")).toEqual([
    "help.acme.example.test",
  ]);
  // Every Support website stays one replies may link to.
  expect((await roleWebAccess("acme-web", "support")).websites).toEqual([
    "help.acme.example.test",
    "status.acme.example.test",
  ]);
});

test("Support runs where incident agents run", async () => {
  const same = async () => {
    const s = await effectiveSandboxes("acme-web");
    expect(s.support).toEqual(s.incidentAgents);
    return s.support;
  };
  // Nothing anywhere: can't start.
  deps({ global: () => "none" });
  expect(await same()).toEqual({
    state: "cant-start",
    reason: "Agents can't start: this project has no sandbox",
  });
  // This machine (container) when Ready.
  deps({ global: () => "none", podmanReady: () => true });
  expect(await same()).toMatchObject({
    provider: "podman",
    source: "fallback",
  });
  // The global default.
  deps({ global: () => "daytona" });
  expect(await same()).toMatchObject({
    provider: "daytona",
    source: "default",
  });
  // The project's own sandbox.
  await setSandbox("podman");
  expect(await same()).toMatchObject({ provider: "podman", source: "project" });
});

test("Support never runs unsandboxed on the host, where incident agents may", async () => {
  deps({
    global: () => "none",
    podmanReady: () => false,
    hostEnabled: () => true,
    hostProblem: async () => null,
  });
  const s = await effectiveSandboxes("acme-web");
  expect(s.incidentAgents).toMatchObject({ state: "ok", provider: null });
  expect(s.support).toEqual({
    state: "cant-start",
    reason: "Agents can't start: this project has no sandbox",
  });
  expect(s.note).toBe(
    "Support reads customer mail, so it never runs on this machine without a sandbox and can't start. Connect a sandbox provider in the checklist above",
  );
});

test("a provider that isn't set up is not ready, with the reason, wherever a role would run on it", async () => {
  // Modal has no connection: what Settings, Sandboxes calls Not configured.
  deps({
    global: () => "none",
    providerUsability: (p) => (p === "modal" ? "not_configured" : "usable"),
  });
  await setSandbox("modal:T4");
  const where = await effectiveSandboxes("acme-web");
  const modal = {
    state: "not-ready",
    provider: "modal",
    source: "project",
    reason: "Modal isn't connected",
  } as const;
  expect(where.you).toEqual({ ...modal, label: "Modal · T4 GPU" });
  expect(where.incidentAgents).toEqual({ ...modal, label: "Modal" });
  expect(where.support).toEqual({ ...modal, label: "Modal" });
  // This machine needs no provider.
  expect(where.reviews.state).toBe("ok");
  expect(where.automations.state).toBe("ok");
  expect(where.note).toBe(
    "Modal isn't connected, so sessions, incident agents and Support can't start",
  );

  // A connection that failed its test needs attention; one turned off or
  // uncertified isn't available.
  deps({
    global: () => "daytona",
    providerUsability: (p) => (p === "daytona" ? "unqualified" : "usable"),
  });
  await setSandbox("default");
  expect((await effectiveSandboxes("acme-web")).you).toMatchObject({
    state: "not-ready",
    source: "default",
    reason: "Daytona needs attention",
  });
  deps({
    global: () => "none",
    providerUsability: (p) => (p === "podman" ? "unavailable" : "usable"),
  });
  await setSandbox("podman");
  expect((await effectiveSandboxes("acme-web")).incidentAgents).toMatchObject({
    state: "not-ready",
    reason: "This machine (container) isn't available",
  });
});

test("automations that ask for a disposable sandbox it can't start are not ready", async () => {
  deps({
    automationCapable: () => false,
    providerUsability: (p) => (p === "daytona" ? "not_configured" : "usable"),
    automations: async () => [{ sandbox: true }],
  });
  expect((await effectiveSandboxes("acme-web")).automations).toEqual({
    state: "not-ready",
    provider: "daytona",
    label: "Disposable sandbox",
    source: "fallback",
    reason: "Daytona isn't connected",
  });
});

test("Support's model: the project's, else the global Support default, else the automation model", async () => {
  __resetModelCachesForTest();
  expect(await effectiveRoleModel("acme-web", "support")).toBe(
    automationModel()!,
  );
  setGlobalRoleDefault("support", "pi/anthropic/claude-fable-5-1");
  expect(await effectiveRoleModel("acme-web", "support")).toBe(
    "pi/anthropic/claude-fable-5-1",
  );
  const { revision } = await getProjectDocument("acme-web");
  const out = await updateProjectDocument(
    "acme-web",
    {
      expectedRevision: revision,
      models: { support: "pi/anthropic/claude-opus-5-5" },
    },
    { name: "Ada", verified: true, login: "ada" },
  );
  if ("error" in out) throw new Error(out.error);
  expect(await effectiveRoleModel("acme-web", "support")).toBe(
    "pi/anthropic/claude-opus-5-5",
  );
});
