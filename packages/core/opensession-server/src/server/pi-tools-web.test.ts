import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPiToolset } from "./pi-tools";
import type { PiMcpBridge } from "./pi-mcp-bridge";
import type { PiSdk } from "./pi-runtime-binding";
import type { RunAgentOpts } from "./agent-runner";

const cwd = mkdtempSync(join(tmpdir(), "pi-tools-web-"));

function toolNames(
  extra: Partial<Parameters<typeof buildPiToolset>[0]>,
  opts: Partial<RunAgentOpts> = {},
): string[] {
  const { customTools } = buildPiToolset({
    // No local tools, so the SDK's tool factories are never called.
    sdk: {} as PiSdk,
    opts: { prompt: "p", cwd, mcpServers: [], ...opts } as RunAgentOpts,
    remote: undefined,
    bashEnv: {},
    runKey: "run-1",
    requestId: "req-1",
    model: "pi/anthropic/claude-haiku-5-5",
    localTools: [],
    mcpBridge: { discoveryTools: [], directTools: [] } as unknown as PiMcpBridge,
    policy: { unattended: false, disables: {}, noteGroups: [] },
    bashGated: false,
    mergeGuard: undefined,
    privateTermsGuard: undefined,
    abort: new AbortController(),
    boundary: { pending: false },
    ...extra,
  });
  return customTools.map((tool) => tool.name);
}

const search = async () => "findings";
const fetch = async () => "page";

describe("buildPiToolset web tools", () => {
  test("registers web_search and web_fetch when the run has them", () => {
    expect(toolNames({ webSearch: search, webFetch: fetch })).toEqual([
      "web_search",
      "web_fetch",
    ]);
  });

  test("omits each tool the run was not given (Settings off, denied, no provider)", () => {
    expect(toolNames({})).toEqual([]);
    expect(toolNames({ webSearch: search })).toEqual(["web_search"]);
    expect(toolNames({ webFetch: fetch })).toEqual(["web_fetch"]);
  });

  test("a tool-less run gets neither", () => {
    expect(
      toolNames(
        { webSearch: search, webFetch: fetch },
        { disableLocalWorkspaceTools: true },
      ),
    ).toEqual([]);
  });
});
