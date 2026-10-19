import { describe, expect, test } from "bun:test";
import {
  hostMcpProxyMode,
  launchMcpProxyMode,
  MCP_PROXY_MODE_ENV,
} from "./mcp-proxy-mode";

const rollback = { [MCP_PROXY_MODE_ENV]: "per-server" };

describe("launchMcpProxyMode", () => {
  test("records the gateway's mode for a run that proxies servers", () => {
    expect(launchMcpProxyMode(["opensession-a"], {})).toBe("in-process");
    expect(launchMcpProxyMode(["opensession-a"], rollback)).toBe("per-server");
  });

  test("records nothing for a run without servers", () => {
    expect(launchMcpProxyMode(undefined, rollback)).toBeUndefined();
    expect(launchMcpProxyMode([], rollback)).toBeUndefined();
  });
});

describe("hostMcpProxyMode", () => {
  test("the spec's mode wins over the host's env", () => {
    // A Runner-launched host never sees the gateway's env.
    expect(hostMcpProxyMode("per-server", {})).toBe("per-server");
    expect(hostMcpProxyMode("in-process", rollback)).toBe("in-process");
  });

  test("a spec from before the field falls back to the host's env", () => {
    expect(hostMcpProxyMode(undefined, rollback)).toBe("per-server");
    expect(hostMcpProxyMode(undefined, {})).toBe("in-process");
    expect(hostMcpProxyMode("bogus", rollback)).toBe("per-server");
  });
});

describe("every launcher gets the mode through the spec", () => {
  // Contract checks on the glue: the spec builders and the host. Running a
  // real launch needs a Runner or systemd; the behaviour above is the unit.
  const source = (path: string) =>
    Bun.file(new URL(path, import.meta.url)).text();

  test("both spec builders record it", async () => {
    expect(await source("../server/host-client.ts")).toContain(
      "mcpProxyMode: launchMcpProxyMode(opts.proxyMcpServers),",
    );
    const runner = await source("../server/runner-session.ts");
    expect(runner).toMatch(
      /if \(!priorSpec\) \{[\s\S]*?launchMcpProxyMode\(spec\.proxyMcpServers\)[\s\S]*?spec\.mcpProxyMode = mode;/,
    );
  });

  test("the host reads it from the spec", async () => {
    const host = await source("./host.ts");
    expect(host).toContain("hostMcpProxyMode(spec.mcpProxyMode)");
    expect(host).not.toMatch(/\bmcpProxyMode\(\)/);
  });

  test("the host closes the shared client after the run, before lingering", async () => {
    const host = await source("./host.ts");
    const run = host.indexOf("for await (const event of runAgent({");
    const close = host.indexOf("opensessionMcp?.close();");
    const linger = host.indexOf("shutdownAcked = resolveWait;");
    expect(run).toBeGreaterThan(0);
    expect(close).toBeGreaterThan(run);
    expect(linger).toBeGreaterThan(close);
  });
});
