// podmanReadyForIncident against real sandbox config: an incident agent is
// put in This machine (container) only when the connection is enabled,
// qualified by the current adapter, the provider is certified, the kill
// switch is off and the model can run in a Sandbox.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigAsync } from "../../config";
import { OPENSESSION_SESSIONS_DIR } from "../../paths";
import {
  SANDBOX_MODEL_FAMILIES,
  SANDBOX_PROVIDER_CERTIFICATIONS,
} from "../../sandbox/config";
import {
  connectSandboxProvider,
  setSandboxConnectionQualification,
  updateSandboxConnection,
} from "../../sandbox/connections";
import { podmanReadyForIncident } from "./host-agents";

const MODEL = "pi/anthropic/claude-opus-5-5";
let scratch: string;
const saved = {
  sandboxConfig: process.env.OPENSESSION_SANDBOX_CONFIG,
  instanceConfig: process.env.OPENSESSION_CONFIG,
};
const certification = SANDBOX_PROVIDER_CERTIFICATIONS.podman;
const cfgPath = () => join(scratch, "sandbox.json");
const killSwitch = () => join(OPENSESSION_SESSIONS_DIR, "disable-sandboxes");

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "incident-podman-ready-"));
  process.env.OPENSESSION_SANDBOX_CONFIG = cfgPath();
  process.env.OPENSESSION_CONFIG = join(scratch, "config.json");
  await getConfigAsync();
});

afterEach(() => {
  SANDBOX_PROVIDER_CERTIFICATIONS.podman = certification;
  rmSync(killSwitch(), { force: true });
  try {
    unlinkSync(cfgPath());
  } catch {}
});

afterAll(async () => {
  for (const [key, value] of [
    ["OPENSESSION_SANDBOX_CONFIG", saved.sandboxConfig],
    ["OPENSESSION_CONFIG", saved.instanceConfig],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await getConfigAsync();
  rmSync(scratch, { recursive: true, force: true });
});

/** A connected, qualified This machine (container), certified unless told
 *  otherwise. */
async function readyPodman(certified = true) {
  writeFileSync(cfgPath(), "{}");
  await connectSandboxProvider("podman", {});
  setSandboxConnectionQualification("podman", { status: "ready" });
  SANDBOX_PROVIDER_CERTIFICATIONS.podman = certified
    ? {
        ...certification,
        certified: true,
        behavioralPassedAt: "2026-10-01",
        warmRestorePassedAt: "2026-10-01",
      }
    : { certified: false, note: "not live-certified" };
}

test("true when the connection is qualified, certified and switched on", async () => {
  await readyPodman();
  expect(podmanReadyForIncident("acme", MODEL)).toBe(true);
});

test("false while the provider is not live-certified", async () => {
  await readyPodman(false);
  expect(SANDBOX_PROVIDER_CERTIFICATIONS.podman.certified).toBe(false);
  expect(podmanReadyForIncident("acme", MODEL)).toBe(false);
});

test("false when the qualification predates the current adapter", async () => {
  await readyPodman();
  const cfg = JSON.parse(readFileSync(cfgPath(), "utf8"));
  for (const connection of cfg.connections)
    if (connection.provider === "podman")
      connection.qualification.adapterSignature = "podman:connection-v0:x";
  writeFileSync(cfgPath(), JSON.stringify(cfg));
  expect(podmanReadyForIncident("acme", MODEL)).toBe(false);
});

test("false with the sandbox kill switch on", async () => {
  await readyPodman();
  mkdirSync(OPENSESSION_SESSIONS_DIR, { recursive: true });
  writeFileSync(killSwitch(), "");
  expect(podmanReadyForIncident("acme", MODEL)).toBe(false);
});

test("false when the connection is disabled", async () => {
  await readyPodman();
  updateSandboxConnection("podman", { enabled: false });
  expect(podmanReadyForIncident("acme", MODEL)).toBe(false);
});

test("false for a model that cannot run in a Sandbox", async () => {
  await readyPodman();
  const family = SANDBOX_MODEL_FAMILIES.find((f) => f.id === "pi")!;
  family.sandboxable = false;
  try {
    expect(podmanReadyForIncident("acme", MODEL)).toBe(false);
  } finally {
    family.sandboxable = true;
  }
});

test("false with no connection at all", () => {
  writeFileSync(cfgPath(), "{}");
  expect(podmanReadyForIncident("acme", MODEL)).toBe(false);
});
