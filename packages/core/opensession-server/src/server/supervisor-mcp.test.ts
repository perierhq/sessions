/**
 * opensession-supervisor reaches a run only through a supervisor session:
 * run-rpc's interactive builder (the path hosted runs proxy through) serves it
 * for a session flagged `supervisor`, and refuses it for any other.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as sessionCache from "./session-cache";
import type { UnifiedSession } from "./types";
import {
  dispatchRunRpc,
  registerRunToken,
  unregisterRunToken,
} from "./run-rpc";
import { interactiveMcpServers } from "./interactive-mcp";
import { SUPERVISOR_MCP_SERVER } from "./supervisor-mcp";

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
      "ask_pat",
      "dismiss_item",
      "list_items",
      "post_item",
    ]);
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
