import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addCredentialAsync } from "../../keychain";
import { listRunnersAsync } from "../../runners";
import { staticAccessEnvironment } from "../testing/access-fixture";
import { useIncidentTestKernel } from "../testing/kernel-fixture";
import {
  __setAccessEnvironmentForTest,
  loadAccessEnvironment,
} from "./environment";

const kit = useIncidentTestKernel();
let dir: string;

function clearKeychain(): void {
  const g = globalThis as any;
  g.__keychainCredentials?.clear();
  g.__keychainGrants?.clear();
  g.__keychainAsks?.clear();
}

beforeEach(async () => {
  clearKeychain();
  dir = await mkdtemp(join(tmpdir(), "acc-env-"));
  process.env.OPENSESSION_MCP_CONFIG = join(dir, "mcp.json");
  process.env.OPENSESSION_KEYCHAIN_STORE = join(dir, "kc.json");
  await writeFile(
    process.env.OPENSESSION_MCP_CONFIG,
    JSON.stringify({
      mcpServers: {
        sentry: { url: "https://mcp.sentry.example.test" },
        logs: { url: "https://logs.example.test", allowedUsers: ["Ada"] },
        "apple-release": { command: "x" },
      },
    }),
  );
  await writeFile(
    join(kit.root(), ".opensession-runners.json"),
    JSON.stringify({
      runners: [
        {
          id: "rn-prod",
          name: "prod-1",
          platform: "linux",
          arch: "x64",
          address: "100.64.0.2",
          tokenHash: "h",
          createdAt: "2026-10-20T00:00:00Z",
          capabilities: { platform: "linux", toolchains: [], tags: [] },
          permissions: { commands: true, automationDescendants: true },
          allowedUsers: [],
          allowedRepos: [],
          workspaceRoots: ["/srv/w"],
        },
      ],
    }),
  );
  await addCredentialAsync({
    owner: "Ada",
    service: "proxy-api",
    host: "api.proxy.example.test",
    secret: "s3cret",
  });
});
afterEach(async () => {
  delete process.env.OPENSESSION_MCP_CONFIG;
  delete process.env.OPENSESSION_KEYCHAIN_STORE;
  clearKeychain();
  await rm(dir, { recursive: true, force: true });
});

test("connections: ok, user-gated, internal, missing", async () => {
  const env = await loadAccessEnvironment();
  expect(env.connection("sentry")).toBe("ok");
  expect(env.connection("logs")).toBe("user-gated");
  expect(env.connection("apple-release")).toBe("user-gated");
  expect(env.connection("opensession-admin")).toBe("internal");
  expect(env.connection("nope")).toBe("missing");
});
test("runners and credentials, never a secret", async () => {
  const env = await loadAccessEnvironment();
  expect(env.runner("rn-prod")).toMatchObject({
    name: "prod-1",
    isolated: true,
    commands: true,
    userRestricted: false,
    connected: false,
  });
  expect(env.runner("prod-1")?.id).toBe("rn-prod");
  expect(env.runner("rn-gone")).toBeNull();
  const cred = env.credential("proxy-api");
  expect(cred).toMatchObject({
    service: "proxy-api",
    owner: "Ada",
    scope: "personal",
    kind: "api",
    injectionHeader: "Authorization",
  });
  expect(JSON.stringify(cred)).not.toContain("s3cret");
  expect(env.sameOwner("ada", "Ada Lovelace")).toBe(true);
});
test("an unreadable MCP config means no connections", async () => {
  await writeFile(process.env.OPENSESSION_MCP_CONFIG!, "{not json");
  expect((await loadAccessEnvironment()).connection("sentry")).toBe("missing");
});
test("the test seam replaces the live snapshot", async () => {
  __setAccessEnvironmentForTest(
    staticAccessEnvironment({ connections: { only: "ok" } }),
  );
  expect((await loadAccessEnvironment()).connection("only")).toBe("ok");
  __setAccessEnvironmentForTest(undefined);
});
test("listRunnersAsync reads the same store", async () => {
  expect((await listRunnersAsync()).map((r) => r.id)).toEqual(["rn-prod"]);
});
