import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  type ProjectSettingsDocument,
  defaultProjectDocument,
} from "../../shared/project-settings";
import { __setEffectiveDepsForTest } from "../projects/effective";
import { __setLegacyEnvironmentForTest } from "../projects/legacy";
import { projectDocuments } from "../projects/store";
import { supportRunSpec } from "./session-policy";
import { useSupportTestKernel } from "./testing/kernel-fixture";

useSupportTestKernel();

const legacy = (automations: () => Promise<never[]>) =>
  __setLegacyEnvironmentForTest({
    projects: () => ["acme"],
    sandbox: () => ({ perRepo: {} }),
    automations,
    mcpServers: async () => [],
    webSearch: async () => "auto",
    defaultReviewServers: async () => [],
  });

function sandboxes(over: { global?: string; podman?: boolean } = {}): void {
  __setEffectiveDepsForTest({
    global: () => over.global ?? "none",
    automationCapable: () => false,
    podmanReady: () => over.podman ?? false,
    hostEnabled: () => false,
    hostProblem: async () => "no user",
    automations: async () => [],
    automationProvider: () => "daytona",
    requested: (r) => ({
      ok: true,
      provider: !r || r === "local" ? null : (r as never),
    }),
  });
}

async function storeProject(
  change: (doc: ProjectSettingsDocument) => void,
): Promise<void> {
  const doc = defaultProjectDocument("acme", "2026-10-01T09:00:00.000Z");
  change(doc);
  await projectDocuments().set("acme", doc);
}

beforeEach(() => {
  legacy(async () => []);
  sandboxes();
});

afterEach(() => {
  __setEffectiveDepsForTest(undefined);
  __setLegacyEnvironmentForTest(undefined);
});

test("only the connectors ticked for Support", async () => {
  await storeProject((doc) => {
    doc.access.connections = [
      { server: "acme-crm", roles: ["support", "automations"] },
      { server: "acme-billing", roles: ["automations"] },
    ];
  });
  sandboxes({ global: "daytona" });
  const spec = await supportRunSpec("acme");
  expect(spec.mcpServers).toEqual(["acme-crm"]);
  expect(spec.mode).toBe("ask");
  expect(spec.sandbox).toEqual({ ok: true, request: "daytona" });
  expect(typeof spec.model).toBe("string");
});

test("the mode follows the Support row", async () => {
  await storeProject((doc) => {
    doc.access.modes.support = "code";
  });
  sandboxes({ podman: true });
  const spec = await supportRunSpec("acme");
  expect(spec.mode).toBe("code");
  expect(spec.sandbox).toEqual({ ok: true, request: "podman" });
});

test("no sandbox and no host agents: the agent can't start", async () => {
  await storeProject(() => {});
  const spec = await supportRunSpec("acme");
  expect(spec.sandbox.ok).toBe(false);
  if (!spec.sandbox.ok) expect(spec.sandbox.reason).toContain("sandbox");
});

test("unreadable settings: read-only, no connectors, can't start", async () => {
  legacy(async () => {
    throw new Error("catalog unavailable");
  });
  sandboxes({ global: "daytona" });
  const spec = await supportRunSpec("acme");
  expect(spec.mcpServers).toEqual([]);
  expect(spec.mode).toBe("ask");
  expect(spec.sandbox.ok).toBe(false);
});
