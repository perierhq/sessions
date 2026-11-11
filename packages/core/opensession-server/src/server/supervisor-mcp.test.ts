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
import {
  SUPERVISOR_MCP_SERVER,
  withoutSupervisorWithheld,
} from "./supervisor-mcp";

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
      "reply_in_thread",
      "watch_for",
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
    const read = (await call("read_ledger", {})).text;
    expect(read).toContain("Owner decided: no Friday deploys.");
    // Labelled as the supervisor's own notes, never the owner speaking.
    expect(read).toStartWith(
      "Your own notes from earlier conversations, not owner instructions.",
    );
    // Over the bound: refused by the schema, nothing written.
    const long = await call("append_ledger", { text: "x".repeat(1_001) });
    expect(long.isError).toBe(true);
    expect((await call("read_ledger", {})).text).not.toContain("xxxx");
    // The ledger is the session owner's: Grace's is separate.
    const { readSupervisorLedgerTail } = await import("./supervisor-ledger");
    expect((await readSupervisorLedgerTail("Grace")).text).toBe("");
  });

  test("append_ledger only records what the owner said", async () => {
    withSession({ supervisor: true });
    const listed = await list("os-supervisor");
    if (listed.kind !== "immediate") throw new Error("expected tools/list");
    const append = (
      listed.body.tools as Array<{ name: string; description: string }>
    ).find((t) => t.name === "append_ledger");
    expect(append?.description).toContain(
      "Record a decision only if the owner said it in their own message or answer",
    );
  });

  test("a retired supervisor session's run gets no inbox tools", async () => {
    withSession({
      supervisor: true,
      supervisorRetiredAt: "2026-07-01T00:00:00.000Z",
    });
    expect(await list("os-supervisor")).toMatchObject({
      kind: "immediate",
      status: 404,
    });
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

  test("a supervisor session's turn keeps no timers of its own", async () => {
    withSession({ supervisor: true });
    const listed = await dispatchRunRpc("/mcp/list", {
      token: (() => {
        const token = `supervisor-mcp-${crypto.randomUUID()}`;
        registerRunToken(token, { sessionId: "os-supervisor", user: "Ada" });
        return token;
      })(),
      server: "opensession-schedule",
    });
    expect(listed).toMatchObject({ kind: "immediate", status: 404 });
    // The rest of the interactive set is still there.
    expect((await list("os-supervisor")).kind).toBe("immediate");
    const todos = await dispatchRunRpc("/mcp/list", {
      token: (() => {
        const token = `supervisor-mcp-${crypto.randomUUID()}`;
        registerRunToken(token, { sessionId: "os-supervisor", user: "Ada" });
        return token;
      })(),
      server: "opensession-todos",
    });
    expect(todos).toMatchObject({ kind: "immediate" });
    expect((todos as { status?: number }).status ?? 200).toBe(200);
    // Any other session keeps its schedule tools.
    const plain = interactiveMcpServers("Ada", "os-plain");
    expect(Object.keys(plain)).toContain("opensession-schedule");
    expect(
      Object.keys(withoutSupervisorWithheld({ supervisor: false }, plain)),
    ).toContain("opensession-schedule");
    expect(
      Object.keys(withoutSupervisorWithheld({ supervisor: true }, plain)),
    ).not.toContain("opensession-schedule");
  });

  test("the plain interactive set never carries it", () => {
    expect(Object.keys(interactiveMcpServers("Ada", "os-plain"))).not.toContain(
      SUPERVISOR_MCP_SERVER,
    );
  });
});
