import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createSdkMcpServer, tool } from "./inprocess-mcp";
import {
  boundedSafeJson,
  createMcpRuntime,
  MAX_MCP_SAFE_JSON_BYTES,
  splitMcpMigrationBoundary,
  type McpRuntime,
} from "./mcp-runtime";

let lastMeta: unknown;
let lastSignalAborted = false;
function server() {
  return createSdkMcpServer({
    name: "alpha",
    tools: [
      tool(
        "echo",
        "Echo text",
        { text: z.string() },
        async (args, extra: any) => {
          lastMeta = extra?._meta;
          return { content: [{ type: "text", text: `echo:${args.text}` }] };
        },
      ),
      tool("picture", "Picture", {}, async () => ({
        content: [
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ] as CallToolResult["content"],
      })),
      tool("boom", "Fails", {}, async () => ({
        isError: true,
        content: [{ type: "text", text: "bad input" }],
      })),
      tool("slow", "Answers after 200ms", {}, async () => {
        await Bun.sleep(200);
        return { content: [{ type: "text", text: "answered" }] };
      }),
      tool("hang", "Hangs", {}, async (_args, extra: any) => {
        extra?.signal?.addEventListener?.("abort", () => {
          lastSignalAborted = true;
        });
        return new Promise<CallToolResult>(() => {});
      }),
    ],
  });
}
const open: McpRuntime[] = [];
afterEach(async () => {
  for (const runtime of open.splice(0)) await runtime.close();
});
async function make(
  overrides: Partial<Parameters<typeof createMcpRuntime>[0]> = {},
) {
  const instance = server();
  const runtime = await createMcpRuntime({
    mcpServers: [],
    deniedToolIds: new Set(),
    inProcessMcp: { alpha: instance },
    ...overrides,
  });
  open.push(runtime);
  return { runtime, instance };
}

describe("MCP runtime catalog and exact calls", () => {
  test("catalog uses exact identities, schema passthrough and deny policy", async () => {
    const { runtime } = await make({
      deniedToolIds: new Set(["alpha_boom", "*_picture"]),
    });
    const catalog = await runtime.catalog();
    expect(catalog.map((item) => item.id).sort()).toEqual([
      "alpha_echo",
      "alpha_hang",
      "alpha_slow",
    ]);
    expect(
      (catalog.find((item) => item.id === "alpha_echo")!.inputSchema as any)
        .properties.text.type,
    ).toBe("string");
  });

  test("callExact preserves toolCallId and maps content", async () => {
    const { runtime } = await make();
    const result = await runtime.callExact(
      "alpha_echo",
      { text: "hi" },
      { toolCallId: "call-7" },
    );
    expect(result.content).toEqual([{ type: "text", text: "echo:hi" }]);
    expect(lastMeta).toMatchObject({ opensessionToolCallId: "call-7" });
    const picture = await runtime.callExact(
      "alpha_picture",
      {},
      { toolCallId: "call-8" },
    );
    expect(picture.content[0]).toEqual({
      type: "image",
      data: "aGVsbG8=",
      mimeType: "image/png",
    });
  });

  test("errors, timeout, cancellation and audit stay call-scoped", async () => {
    const audits: Array<{ tool: string; ok: boolean }> = [];
    const { runtime } = await make({
      ownServerCallTimeoutMs: 50,
      onAudit: (event) => audits.push({ tool: event.tool, ok: event.ok }),
    });
    await expect(
      runtime.callExact("alpha_boom", {}, { toolCallId: "x" }),
    ).rejects.toThrow("bad input");
    const abort = new AbortController();
    const hanging = runtime.callExact(
      "alpha_hang",
      {},
      { toolCallId: "y", signal: abort.signal },
    );
    abort.abort();
    await expect(hanging).rejects.toThrow(/abort/i);
    await expect(
      runtime.callExact("alpha_hang", {}, { toolCallId: "timeout" }),
    ).rejects.toThrow(/timed out|timeout/i);
    expect(audits).toEqual([
      { tool: "boom", ok: false },
      { tool: "hang", ok: false },
      { tool: "hang", ok: false },
    ]);
    expect(lastSignalAborted || abort.signal.aborted).toBe(true);
    expect(
      (
        await runtime.callExact(
          "alpha_echo",
          { text: "alive" },
          { toolCallId: "z" },
        )
      ).content[0],
    ).toEqual({ type: "text", text: "echo:alive" });
  });

  test("a failed listing or call is audited with its error, secrets masked", async () => {
    const audits: Array<{ tool: string; ok: boolean; error?: string }> = [];
    const broken = server();
    broken.instance.connect = async () => {
      throw new Error(
        'Streamable HTTP error: Error POSTing to http://127.0.0.1:1/relay/acme?t=relay-secret-1: {"error": "invalid_token"} Bearer abcdefghijklmnop',
      );
    };
    const { runtime } = await make({
      inProcessMcp: { alpha: server(), acme: broken },
      onAudit: (event) =>
        audits.push({ tool: event.tool, ok: event.ok, error: event.error }),
    });
    await expect(
      runtime.callExact("alpha_boom", {}, { toolCallId: "x" }),
    ).rejects.toThrow("bad input");
    await runtime.callExact("alpha_echo", { text: "ok" }, { toolCallId: "y" });

    const listing = audits.find((a) => a.tool === "tools/list");
    expect(listing).toMatchObject({ ok: false });
    expect(listing?.error).toContain("invalid_token");
    expect(listing?.error).not.toContain("relay-secret-1");
    expect(listing?.error).not.toContain("abcdefghijklmnop");
    expect(audits.find((a) => a.tool === "boom")).toEqual({
      tool: "boom",
      ok: false,
      error: "bad input",
    });
    expect(audits.find((a) => a.tool === "echo")).toEqual({
      tool: "echo",
      ok: true,
      error: undefined,
    });
  });

  test("each bound server that can't be listed is reported once, eager or deferred", async () => {
    const reported: Array<[string, string]> = [];
    const broken = server();
    broken.instance.connect = async () => {
      throw new Error("connect refused ?t=relay-secret-2");
    };
    const { runtime } = await make({
      inProcessMcp: { alpha: server(), acme: broken },
      legacyProxyMcp: {
        configs: {
          later: {
            type: "run-rpc-relay",
            createServer: () => ({
              connect: async () => {
                throw new Error("relay down");
              },
              close: async () => {},
            }),
          },
        },
      },
      onUnavailable: (name, reason) => reported.push([name, reason]),
    });
    // The eager listing failed at creation; the deferred one has not run.
    expect(reported).toEqual([["acme", "connect refused ?t=***"]]);
    await runtime.catalog();
    await runtime.catalog();
    expect(reported).toEqual([
      ["acme", "connect refused ?t=***"],
      ["later", "relay down"],
    ]);
    expect([...runtime.unavailable()]).toEqual(reported);
  });

  test("own servers' calls are not bound by the external call timeout", async () => {
    const { runtime } = await make({ callTimeoutMs: 50 });

    expect(
      (await runtime.callExact("alpha_slow", {}, { toolCallId: "wait" }))
        .content,
    ).toEqual([{ type: "text", text: "answered" }]);
  });

  test("close owns connections and is idempotent", async () => {
    const { runtime, instance } = await make();
    expect(instance.instance.isConnected()).toBe(true);
    await runtime.close();
    expect(instance.instance.isConnected()).toBe(false);
    await expect(
      runtime.callExact("alpha_echo", {}, { toolCallId: "x" }),
    ).rejects.toThrow(/closed/i);
    await runtime.close();
  });
});

describe("bounded safe JSON", () => {
  test("handles cycles, bigint, depth and byte limits without throwing", () => {
    const cyclic: any = { bigint: 4n };
    cyclic.self = cyclic;
    expect(boundedSafeJson(cyclic)).toContain("[circular]");
    const text = boundedSafeJson({
      huge: "x".repeat(MAX_MCP_SAFE_JSON_BYTES * 2),
    });
    expect(text).toContain("[truncated]");
    expect(() => JSON.parse(text)).not.toThrow();
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(
      MAX_MCP_SAFE_JSON_BYTES,
    );
  });
});

describe("legacy migration boundary", () => {
  test("separates SDK mounts from runner-host proxy configs", () => {
    const sdk = server();
    const split = splitMcpMigrationBoundary({
      alpha: sdk,
      proxy: { command: "/bun", env: { OPENSESSION_RPC_TOKEN: "secret" } },
      unknown: { type: "other" },
    });
    expect(Object.keys(split.sdk)).toEqual(["alpha"]);
    expect(Object.keys(split.legacyProxy!.configs)).toEqual(["proxy"]);
  });
});
