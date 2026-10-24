import { afterEach, beforeEach, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { catalogDocuments } from "../catalog-documents";
import { useIncidentTestKernel } from "../incidents/testing/kernel-fixture";
import { getUiPrefs, patchUiPrefs } from "../ui-prefs";
import { __setLegacyEnvironmentForTest } from "./legacy";
import { legacyDrift, migrateProjectSettings } from "./migrate";
import {
  __setProjectStoreContextForTest,
  getProjectDocument,
  listProjectDocuments,
  updateProjectDocument,
} from "./store";

const kit = useIncidentTestKernel();
const legacyProjects = () => catalogDocuments("incident-projects");
const legacyAccess = () => catalogDocuments("incident-access");

beforeEach(() => {
  __setLegacyEnvironmentForTest({
    projects: () => ["acme-web", "acme-api"],
    sandbox: () => ({ perRepo: { "acme-web": { sessionDefault: "podman" } } }),
    automations: async () => [],
    mcpServers: async () => ["grafana", "linear"],
    webSearch: async () => "auto",
    defaultReviewServers: async () => ["grafana", "linear"],
  });
  __setProjectStoreContextForTest({
    projectExists: (id) => id === "acme-web" || id === "acme-api",
    modelProblem: () => null,
    runnerProblem: () => null,
    connectionExists: () => true,
    credential: () => null,
    isOwner: () => false,
    ownerRoster: () => "none",
    hostProblem: () => null,
  });
});
afterEach(() => {
  __setLegacyEnvironmentForTest(undefined);
  __setProjectStoreContextForTest(undefined);
});

async function backups(): Promise<string[]> {
  try {
    return await readdir(join(kit.root(), ".opensession-backups"));
  } catch {
    return [];
  }
}

test("a dry run writes nothing and reports every project", async () => {
  patchUiPrefs("Ada", { "sandbox-default": "podman" });
  const result = await migrateProjectSettings({ dryRun: true, by: "Ada" });
  expect(result.backupPath).toBeNull();
  expect(result.projects.map((p) => p.project)).toEqual([
    "acme-web",
    "acme-api",
  ]);
  expect(result.personalDefaultsCleared).toBe(1);
  expect(await backups()).toEqual([]);
  expect(await listProjectDocuments()).toEqual([]);
  expect(getUiPrefs("Ada")["sandbox-default"]).toBe("podman");
});

test("a run migrates, backs up, clears personal defaults; a second run writes nothing", async () => {
  await legacyProjects().set("acme-web", {
    project: "acme-web",
    autonomy: "propose",
    updatedAt: "2026-09-01T00:00:00.000Z",
  });
  patchUiPrefs("Ada", { "sandbox-default": "podman", other: "x" });
  patchUiPrefs("Bo", { "sandbox-default": "none" });
  const first = await migrateProjectSettings({ dryRun: false, by: "Ada" });
  expect(first.alreadyMigrated).toEqual([]);
  expect(first.personalDefaultsCleared).toBe(2);
  expect(getUiPrefs("Ada")).toEqual({ other: "x" });
  expect(first.backupPath).toStartWith(
    join(kit.root(), ".opensession-backups"),
  );
  const backup = JSON.parse(await readFile(first.backupPath!, "utf8"));
  // Keyed by each person's prefs file.
  expect(Object.values(backup["ui-prefs:sandbox-default"]).sort()).toEqual([
    "none",
    "podman",
  ]);
  expect(backup.sandbox.perRepo).toEqual({
    "acme-web": { sessionDefault: "podman" },
  });
  const doc = await getProjectDocument("acme-web");
  expect(doc).toMatchObject({
    revision: 1,
    sandbox: "podman",
    updatedBy: "Ada",
    incidents: { autonomy: "propose" },
  });
  expect(doc.migratedAt).toBeString();
  expect((await listProjectDocuments()).map((d) => d.project).sort()).toEqual([
    "acme-api",
    "acme-web",
  ]);
  expect(kit.audits.at(-1)).toMatchObject({
    kind: "project_settings_migrated",
    projects: ["acme-web", "acme-api"],
  });

  const second = await migrateProjectSettings({ dryRun: false, by: "Ada" });
  expect(second.alreadyMigrated).toEqual(["acme-web", "acme-api"]);
  expect(second.projects).toEqual([]);
  expect((await getProjectDocument("acme-web")).revision).toBe(1);
});

test("unreadable access resets to defaults, the run goes on, the raw value is backed up", async () => {
  await legacyAccess().set("acme-web", { garbage: true });
  const result = await migrateProjectSettings({ dryRun: false, by: "Ada" });
  expect(result.projects.find((p) => p.project === "acme-web")?.access).toBe(
    "reset-unreadable",
  );
  expect(result.projects.find((p) => p.project === "acme-api")?.access).toBe(
    "default",
  );
  const backup = JSON.parse(await readFile(result.backupPath!, "utf8"));
  expect(backup["incident-access"]).toEqual([
    { key: "acme-web", value: { garbage: true } },
  ]);
  expect((await getProjectDocument("acme-web")).access.connections).toEqual([
    { server: "grafana", roles: ["reviews"] },
    { server: "linear", roles: ["reviews"] },
  ]);
});

test("a legacy write after migration is drift", async () => {
  await migrateProjectSettings({ dryRun: false, by: "Ada" });
  expect(await legacyDrift()).toEqual([]);
  const later = new Date(Date.now() + 60_000).toISOString();
  await legacyProjects().set("acme-web", {
    project: "acme-web",
    autonomy: "watch",
    updatedAt: later,
  });
  expect(await legacyDrift()).toEqual(["acme-web"]);
});

test("an unmigrated project reads through its legacy settings; its first write migrates it", async () => {
  await legacyProjects().set("acme-web", {
    project: "acme-web",
    maxRounds: 4,
    releaseHookSecret: "b".repeat(48),
  });
  const read = await getProjectDocument("acme-web");
  expect(read).toMatchObject({
    revision: 0,
    sandbox: "podman",
    incidents: { maxRounds: 4 },
  });
  expect(read.migratedAt).toBeUndefined();
  expect(await listProjectDocuments()).toEqual([]);
  const written = await updateProjectDocument(
    "acme-web",
    { expectedRevision: 0, incidents: { maxRounds: 2 } },
    { name: "Ada", verified: true, login: "ada" },
  );
  if ("error" in written) throw new Error(written.error);
  expect(written).toMatchObject({
    revision: 1,
    sandbox: "podman",
    releaseHookSecret: "b".repeat(48),
    incidents: { maxRounds: 2 },
  });
  expect(written.migratedAt).toBeString();
});
