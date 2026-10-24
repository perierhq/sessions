import { afterEach, beforeEach, expect, test } from "bun:test";
import { useIncidentTestKernel } from "../incidents/testing/kernel-fixture";
import { patchUiPrefs } from "../ui-prefs";
import {
  __setEffectiveDepsForTest,
  type EffectiveDeps,
  effectiveSandboxes,
  resolveSessionSandbox,
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

test("a container project with a Daytona default: automations use the default", async () => {
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
      provider: "daytona",
      label: "Daytona",
      source: "default",
    },
    reviews: {
      state: "ok",
      provider: null,
      label: "This machine",
      source: "fallback",
    },
    note: "Sessions, reviews and incident agents run here. Automations use the global default",
  });
});

test("a container project without an unattended default: automations stay on this machine", async () => {
  deps({ global: () => "none", podmanReady: () => true });
  await setSandbox("podman");
  const s = await effectiveSandboxes("acme-web");
  expect(s.automations).toEqual({
    state: "ok",
    provider: null,
    label: "This machine",
    source: "fallback",
  });
  expect(s.incidentAgents).toMatchObject({ state: "ok", provider: "podman" });
  expect(s.note).toBe(
    "Sessions, reviews and incident agents run here. Automations run on this machine",
  );
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
