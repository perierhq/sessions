/**
 * opensession-supervisor reaches a run only through a supervisor session:
 * run-rpc's interactive builder (the path hosted runs proxy through) serves it
 * for a session flagged `supervisor`, and refuses it for any other.
 */
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sessionCache from "./session-cache";
import type { UnifiedSession } from "./types";
import {
  dispatchRunRpc,
  registerRunToken,
  unregisterRunToken,
} from "./run-rpc";
import { interactiveMcpServers } from "./interactive-mcp";
import { SUPERVISOR_MCP_SERVER } from "./supervisor-mcp";

// The ledger tools write under the state dir: a scratch one.
const root = mkdtempSync(join(tmpdir(), "supervisor-mcp-test-"));
const priorStateDir = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = root;
afterAll(() => {
  if (priorStateDir === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = priorStateDir;
  rmSync(root, { recursive: true, force: true });
});

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function withSession(session: Partial<UnifiedSession>): void {
  spies.push(
    spyOn(sessionCache, "findSession").mockImplementation(
      (id: string) =>
        ({
          id,
          title: "Supervisor",
          createdBy: "Ada",
          ...session,
        }) as UnifiedSession,
    ),
  );
}

async function call(
  tool: string,
  args: Record<string, unknown>,
  sessionId = "os-supervisor",
  user = "Ada",
): Promise<{ text: string; isError?: boolean }> {
  const token = `supervisor-mcp-${crypto.randomUUID()}`;
  registerRunToken(token, { sessionId, user });
  try {
    const res = await dispatchRunRpc("/mcp/call", {
      token,
      server: SUPERVISOR_MCP_SERVER,
      tool,
      args,
    });
    if (res.kind !== "call") throw new Error("expected a tool call");
    const body = (await res.done) as {
      result?: { content: Array<{ text: string }>; isError?: boolean };
      error?: string;
    };
    if (!body.result) throw new Error(body.error ?? "no result");
    return {
      text: body.result.content.map((c) => c.text).join(""),
      isError: body.result.isError,
    };
  } finally {
    unregisterRunToken(token);
  }
}

async function list(sessionId: string, user = "Ada") {
  const token = `supervisor-mcp-${crypto.randomUUID()}`;
  registerRunToken(token, { sessionId, user });
  try {
    return await dispatchRunRpc("/mcp/list", {
      token,
      server: SUPERVISOR_MCP_SERVER,
    });
  } finally {
    unregisterRunToken(token);
  }
}

describe("opensession-supervisor wiring", () => {
  test("a supervisor session's run gets the inbox tools", async () => {
    withSession({ supervisor: true });
    const listed = await list("os-supervisor");
    expect(listed.kind).toBe("immediate");
    if (listed.kind !== "immediate") throw new Error("expected tools/list");
    expect(listed.status ?? 200).toBe(200);
    const names = (listed.body.tools as Array<{ name: string }>)
      .map((t) => t.name)
      .sort();
    expect(names).toEqual([
      "answer_item",
      "append_ledger",
      "ask_pat",
      "dismiss_item",
      "list_items",
      "post_item",
      "read_ledger",
    ]);
  });

  test("the ledger tools read and append the owner's ledger, bounded", async () => {
    withSession({ supervisor: true });
    expect((await call("read_ledger", {})).text).toBe("The ledger is empty.");
    const added = await call("append_ledger", {
      text: "Owner decided: no Friday deploys.",
    });
    expect(added.isError).toBeFalsy();
    expect(added.text).toMatch(/^Added:\n## \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
    expect((await call("read_ledger", {})).text).toContain(
      "Owner decided: no Friday deploys.",
    );
    // Over the bound: refused by the schema, nothing written.
    const long = await call("append_ledger", { text: "x".repeat(1_001) });
    expect(long.isError).toBe(true);
    expect((await call("read_ledger", {})).text).not.toContain("xxxx");
    // The ledger is the session owner's: Grace's is separate.
    const { readSupervisorLedgerTail } = await import("./supervisor-ledger");
    expect((await readSupervisorLedgerTail("Grace")).text).toBe("");
  });

  test("a teammate's run in the owner's supervisor session does not", async () => {
    withSession({ supervisor: true, lastPromptedBy: "Grace" });
    expect(await list("os-supervisor", "Grace")).toMatchObject({
      kind: "immediate",
      status: 404,
    });
  });

  test("any other session's run does not", async () => {
    withSession({});
    expect(await list("os-plain")).toMatchObject({
      kind: "immediate",
      status: 404,
    });
  });

  test("the plain interactive set never carries it", () => {
    expect(Object.keys(interactiveMcpServers("Ada", "os-plain"))).not.toContain(
      SUPERVISOR_MCP_SERVER,
    );
  });
});
