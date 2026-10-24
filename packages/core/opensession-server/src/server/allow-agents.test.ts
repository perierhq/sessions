// "Allow agents" (mcp-config `allowUnattended`): a connector limited to
// named people that runs without a user may use, but only where a
// project's access table ticks it for that run's role, never for runs that
// mount every connector, and only when a signed-in person turned it on.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addMcpServerEntry,
  readMcpConfig,
  replaceMcpServerEntries,
  withoutPeopleRestricted,
} from "./connections";
import { liveProjectRouteDeps } from "./routes/project-deps";
import { filterMcpServers, mcpServerAllowedForRun } from "./runner-shared";

let dir = "";
let path = "";
const previous = process.env.OPENSESSION_MCP_CONFIG;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "allow-agents-"));
  path = join(dir, "mcp-config.json");
  await writeFile(
    path,
    JSON.stringify({
      mcpServers: {
        grafana: {
          type: "http",
          url: "https://grafana.example.test/mcp",
          allowedUsers: ["ada"],
          allowUnattended: true,
        },
        linear: { type: "http", url: "https://linear.example.test/mcp" },
        "apple-release": {
          type: "http",
          url: "https://apple.example.test/mcp",
          allowedUsers: ["ada"],
        },
      },
    }),
  );
  process.env.OPENSESSION_MCP_CONFIG = path;
});
afterEach(async () => {
  if (previous === undefined) delete process.env.OPENSESSION_MCP_CONFIG;
  else process.env.OPENSESSION_MCP_CONFIG = previous;
  await rm(dir, { recursive: true, force: true });
});

const stored = async () =>
  JSON.parse(await readFile(path, "utf8")).mcpServers as Record<
    string,
    Record<string, unknown>
  >;

test("only runs whose project ticks the connector for their role get it", () => {
  // Every connector mounted: the flag never applies.
  expect(Object.keys(filterMcpServers("all"))).toEqual(["linear"]);
  // An explicit list built from the project's table carries it.
  expect(Object.keys(filterMcpServers(["grafana", "linear"]))).toEqual([
    "grafana",
    "linear",
  ]);
  // Where the caller knows the ticks, the role's ticks decide.
  expect(
    Object.keys(
      filterMcpServers(["grafana", "linear"], undefined, undefined, {
        agentConnectors: ["linear"],
      }),
    ),
  ).toEqual(["linear"]);
  // Ticked: allowed.
  expect(
    Object.keys(
      filterMcpServers(["grafana", "linear"], undefined, undefined, {
        agentConnectors: ["grafana", "linear"],
      }),
    ),
  ).toEqual(["grafana", "linear"]);
  // A person behind the run is gated by the list as always.
  expect(
    Object.keys(
      filterMcpServers(["grafana"], "bo", undefined, {
        agentConnectors: ["grafana"],
      }),
    ),
  ).toEqual([]);
  expect(
    mcpServerAllowedForRun("grafana", ["ada"], undefined, undefined, true),
  ).toBe(false);
});

test("unattended lists not taken from a project's table drop agent-only connectors", () => {
  expect(
    withoutPeopleRestricted(["grafana", "linear", "apple-release"]),
  ).toEqual(["linear"]);
});

test("a plugin install can't turn on Allow agents", async () => {
  expect(
    addMcpServerEntry("sentry", {
      type: "http",
      url: "https://sentry.example.test/mcp",
      allowUnattended: true,
    }),
  ).toEqual({ ok: true });
  expect((await stored()).sentry).not.toHaveProperty("allowUnattended");
  // Replacing an entry keeps the stored switch, whatever the update says.
  replaceMcpServerEntries({
    linear: {
      type: "http",
      url: "https://linear.example.test/mcp",
      allowUnattended: true,
    },
    grafana: { type: "http", url: "https://grafana.example.test/v2" },
  });
  const after = await stored();
  expect(after.linear).not.toHaveProperty("allowUnattended");
  expect(after.grafana).toMatchObject({ allowUnattended: true });
  expect(readMcpConfig().mcpServers.grafana.allowUnattended).toBe(true);
});

test("the Allow agents route refuses a protected server", async () => {
  const deps = liveProjectRouteDeps();
  expect(deps.allowUnattended("apple-release", true)).toEqual({
    error: 'Server "apple-release" is never available to agents',
  });
  expect(deps.allowUnattended("linear", true)).toEqual({ ok: true });
  expect((await stored()).linear).toMatchObject({ allowUnattended: true });
});
