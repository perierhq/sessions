// An unattended run (no user) bound to OAuth MCP servers whose shared
// sign-in has expired: the one with a refresh token must be refreshed before
// it is listed, and the one without must say why it is missing.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type OauthMcpFixture,
  startOauthMcpFixture,
} from "./testing/oauth-mcp-fixture";

let directory: string;
let fixture: OauthMcpFixture;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "mcp-oauth-expiry-"));
  fixture = startOauthMcpFixture();
});

afterEach(async () => {
  fixture.stop();
  await rm(directory, { recursive: true, force: true });
});

function freePort(): number {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

function grant(tokens: Record<string, unknown>) {
  return {
    serverUrl: fixture.mcpUrl,
    endpoints: {
      authorize: `${fixture.url}/authorize`,
      token: fixture.tokenUrl,
    },
    clientInfo: { clientId: "fixture-client" },
    shared: {
      tokens,
      updatedAt: new Date(0).toISOString(),
      connectedBy: "Example",
    },
  };
}

async function runUnattended(): Promise<{
  matched: string;
  missing: string;
  call: string;
}> {
  const pair = fixture.issue();
  const expired = Date.now() - 60 * 60_000;
  const configPath = join(directory, "mcp-config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      mcpServers: {
        fresh: { type: "http", url: fixture.mcpUrl },
        stale: { type: "http", url: fixture.mcpUrl },
      },
    }),
  );
  await writeFile(
    join(directory, ".opensession-mcp-oauth.json"),
    JSON.stringify({
      fresh: grant({
        accessToken: "expired-access",
        refreshToken: pair.refreshToken,
        expiresAt: expired,
      }),
      stale: grant({ accessToken: "expired-access", expiresAt: expired }),
    }),
  );
  const port = freePort();
  const here = import.meta.dir;
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `import { handleMcpRelay } from ${JSON.stringify(join(here, "mcp-relay.ts"))};
       import { createMcpRuntime } from ${JSON.stringify(join(here, "mcp-runtime.ts"))};
       import { createPiMcpBridge } from ${JSON.stringify(join(here, "pi-mcp-bridge.ts"))};
       const relay = Bun.serve({ hostname: "127.0.0.1", port: ${port}, fetch(req) {
         const url = new URL(req.url);
         const name = decodeURIComponent(url.pathname.split("/")[2] ?? "");
         return handleMcpRelay(req, name, url.searchParams.get("t") ?? "");
       } });
       const runtime = await createMcpRuntime({ mcpServers: ["fresh", "stale"], deniedToolIds: new Set(), callTimeoutMs: 5000 });
       const bridge = await createPiMcpBridge(runtime);
       const search = bridge.discoveryTools.find((t) => t.name === "tool_search");
       const text = async (query) => (await search.execute("s", { query })).content[0].text;
       const matched = await text("ping");
       const missing = await text("stale");
       const call = await runtime.callExact("stale_ping", {}, { toolCallId: "c" }).then(() => "ok", (e) => e.message);
       await runtime.close();
       relay.stop(true);
       console.log(JSON.stringify({ matched, missing, call }));
       process.exit(0);`,
    ],
    {
      env: {
        HOME: directory,
        OPENSESSION_STATE_DIR: directory,
        OPENSESSION_DEV: "1",
        OPENSESSION_MCP_CONFIG: configPath,
        OPENSESSION_MCP_HTTP_PORT: String(port),
        OPENSESSION_MCP_TOOLS_CACHE: "1",
        PATH: process.env.PATH ?? "",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`child failed (${exitCode}): ${stderr}`);
  return JSON.parse(stdout.trim().split("\n").at(-1)!);
}

test("an unattended run refreshes an expired shared sign-in and says when one can't be", async () => {
  const out = await runUnattended();
  // Refreshed before listing: the tool is found.
  expect(out.matched).toContain("fresh_ping");
  expect(fixture.tokenRequests).toHaveLength(1);
  expect(fixture.tokenRequests[0]!.grant_type).toBe("refresh_token");
  // No refresh token: search and calls name the reason.
  expect(out.missing).toContain(
    "stale: sign-in expired. A person needs to reconnect it in Settings → Connections.",
  );
  expect(out.call).toContain(
    "sign-in expired. A person needs to reconnect it in Settings → Connections.",
  );
}, 20_000);
