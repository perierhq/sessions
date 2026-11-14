/**
 * The morning brief drawn on Blob's board. A stub model plays the brief
 * turn: the server delivers the brief notice, and the stub answers it the
 * way the charter says, through the supervisor's real tools over run-rpc
 * (list_items, board_read, board_apply, write_brief). The test then checks
 * the board got the count line and the decisions as item refs, that the
 * brief records that revision, that item refs resolve to the owner's inbox
 * items, and that a brief written without a board still stores, logged,
 * and picks up a board drawn right after it.
 *
 * In-memory kernel store, fake clock, fake roster and PR sources; no model.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boardRefs, parseCanvasFence } from "../shared/blob-board";
import {
  SessionKernelStore,
  __setSessionKernelStoreForTest,
} from "./session-kernel";
import * as sessionCache from "./session-cache";
import type { UnifiedSession } from "./types";

const root = mkdtempSync(join(tmpdir(), "supervisor-brief-board-test-"));
const prior = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = root;

type Inbox = typeof import("./supervisor-inbox");
type Brief = typeof import("./supervisor-brief");
type BoardStore = typeof import("./blob-board");
type Refs = typeof import("./blob-board-refs");
type RunRpc = typeof import("./run-rpc");
type SupervisorMcp = typeof import("./supervisor-mcp");
let inbox: Inbox;
let brief: Brief;
let boardStore: BoardStore;
let refs: Refs;
let rpc: RunRpc;
let mcp: SupervisorMcp;

beforeAll(async () => {
  inbox = await import("./supervisor-inbox");
  brief = await import("./supervisor-brief");
  boardStore = await import("./blob-board");
  refs = await import("./blob-board-refs");
  rpc = await import("./run-rpc");
  mcp = await import("./supervisor-mcp");
  // Registers the run's MCP builder, as boot does.
  await import("./interactive-mcp");
});

afterAll(() => {
  if (prior === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = prior;
  rmSync(root, { recursive: true, force: true });
});

const SESSION = "os-sup-ada";
let store: SessionKernelStore;
let previousStore: SessionKernelStore | undefined;
let clock = Date.parse("2026-07-01T09:00:00Z");
let model: (notice: string) => Promise<void> = async () => {};
const restores: Array<() => void> = [];
const spies: Array<{ mockRestore(): void }> = [];

beforeEach(() => {
  rmSync(join(root, ".opensession-supervisor-items"), {
    recursive: true,
    force: true,
  });
  store = new SessionKernelStore(":memory:");
  previousStore = __setSessionKernelStoreForTest(store);
  clock = Date.parse("2026-07-01T09:00:00Z");
  const session = {
    id: SESSION,
    title: "Supervisor",
    createdBy: "Ada",
    supervisor: true,
    source: "opensession",
  } as UnifiedSession;
  spies.push(
    spyOn(sessionCache, "findSession").mockImplementation(() => session),
    spyOn(sessionCache, "findSessionAsync").mockImplementation(
      async () => session,
    ),
  );
  restores.push(
    inbox.__setSupervisorInboxDepsForTest({
      now: () => clock,
      notify: async () => ({}),
      markDone: async () => {},
      supervisorSessionId: async () => SESSION,
      rotateSupervisor: async () => {},
      ensureWatch: async () => {},
      checkBlobGithub: async () => {},
      timeZone: () => "UTC",
    }),
    brief.__setBriefDepsForTest({
      now: () => clock,
      currentSessionId: async () => SESSION,
      ensureSessionId: async () => SESSION,
      // The stub model runs the turn the notice starts.
      deliver: async (_sessionId, text) => {
        await model(text);
      },
      expand: async (items) =>
        items.map((item) => ({ ...item, revision: item.updatedAt })),
      announce: async () => {},
      ledger: async () => ({
        day: "2026-07-01",
        handledAlone: 11,
        askedYou: 3,
        byCategory: [],
      }),
      prepareDecisions: async () => null,
    }),
    boardStore.__setBoardDepsForTest({
      now: () => clock,
      ownedProjects: async () => ["acme"],
      announce: async () => {},
    }),
  );
  refs.__setBoardRefDepsForTest({
    now: () => clock,
    roster: async () => [
      {
        project: "acme",
        label: "Acme",
        enabled: true,
        stage: "act",
        owner: "Ada",
      },
    ],
    prs: async () => new Map(),
    incident: async () => null,
    conversation: async () => null,
  });
});

afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
  for (const spy of spies.splice(0)) spy.mockRestore();
  refs.__setBoardRefDepsForTest(undefined);
  inbox.__resetSupervisorInboxForTest();
  __setSessionKernelStoreForTest(previousStore);
  store.close();
});

/** A tool call the way a supervisor run makes it. */
async function call(
  tool: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError?: boolean }> {
  const token = `brief-board-${crypto.randomUUID()}`;
  rpc.registerRunToken(token, { sessionId: SESSION, user: "Ada" });
  try {
    const res = await rpc.dispatchRunRpc("/mcp/call", {
      token,
      server: mcp.SUPERVISOR_MCP_SERVER,
      tool,
      args,
    });
    if (res.kind !== "call")
      throw new Error(`expected a tool call: ${JSON.stringify(res)}`);
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
    rpc.unregisterRunToken(token);
  }
}

async function decision(title: string, dedupeKey: string) {
  return (
    await inbox.postSupervisorItem({
      user: "Ada",
      source: "lead:acme",
      kind: "needs-you",
      title,
      project: "acme",
      options: ["Ship it", "Hold"],
      dedupeKey,
    })
  ).item;
}

/** What the charter asks of a brief turn, done by a stub. */
async function drawBrief(notice: string): Promise<{ canvas: string }> {
  const counts = /Count line: (\d+) handled alone, (\d+) asked you\./.exec(
    notice,
  );
  if (!counts) throw new Error(`no count line in the notice: ${notice}`);
  const listed = await call("list_items", { state: "open" });
  const ids = [...new Set(listed.text.match(/si-[0-9a-f-]{36}/g) ?? [])];
  const read = await call("board_read", {});
  // The session has no camera from the app (a brief turn has no prompt):
  // the tools still give the closed Duo's.
  if (!read.text.includes("Visible board: x 0–382, y 0–678."))
    throw new Error(`no default camera in board_read: ${read.text}`);
  const revision = Number(/Board revision (\d+)/.exec(read.text)?.[1]);
  const applied = await call("board_apply", {
    expected_revision: revision,
    ops: [
      {
        op: "add",
        el: {
          id: "count",
          type: "text",
          role: "stat",
          x: 16,
          y: 16,
          w: 340,
          text: `${counts[1]} handled alone · ${counts[2]} asked you`,
        },
      },
      {
        op: "add",
        el: {
          id: "r-acme",
          type: "frame",
          region: "acme",
          title: "Acme",
          x: 8,
          y: 72,
          w: 366,
          h: 80 + 64 * ids.length,
        },
      },
      ...ids.map((id, i) => ({
        op: "add",
        el: {
          id: `d-${i + 1}`,
          type: "text",
          role: "title",
          ref: `item:${id}`,
          x: 24,
          y: 104 + 64 * i,
          w: 300,
          h: 48,
          ...(i === 0 ? { style: { color: "tangerine" } } : {}),
        },
      })),
      {
        op: "add",
        el: {
          id: "circle-1",
          type: "shape",
          kind: "ellipse",
          x: 12,
          y: 94,
          w: 330,
          h: 68,
          z: 2,
        },
      },
      {
        op: "add",
        el: {
          id: "n-1",
          type: "note",
          anchor: { id: "d-1", side: "bottom", dx: 0, dy: 4 },
          text: "blocks the release",
          leader: true,
        },
      },
    ],
  });
  if (applied.isError) throw new Error(applied.text);
  const written = await call("write_brief", {
    say: "Morning. One thing needs you; it's circled.",
    decisions: ids
      .slice(0, 1)
      .map((id) => ({ item_id: id, recommended: "Ship it" })),
  });
  if (written.isError) throw new Error(written.text);
  return { canvas: applied.text };
}

describe("the brief turn draws on the board", () => {
  test("a stub model's brief turn puts the count line and the decisions as item refs on the board, and the brief records the revision", async () => {
    const a = await decision("Ship 1.19.0?", "a");
    const b = await decision("Merge PR 533?", "b");
    let canvas = "";
    let notice = "";
    model = async (text) => {
      notice = text;
      canvas = (await drawBrief(text)).canvas;
    };

    const run = await brief.startBriefTurn("Ada", "open");
    expect(run.started).toBe(true);
    if (run.started) expect(await run.delivered).toBe(true);

    // The notice asks for the board and carries the ledger's counts.
    expect(notice).toContain("draw it on your board with board_apply");
    expect(notice).toContain("Count line: 11 handled alone, 3 asked you.");

    const board = await boardStore.readBoard("Ada");
    expect(board.revision).toBe(1);
    const count = board.elements.find((el) => el.id === "count");
    expect(count).toMatchObject({
      type: "text",
      role: "stat",
      text: "11 handled alone · 3 asked you",
    });
    expect(boardRefs(board.elements).sort()).toEqual(
      [`item:${a.id}`, `item:${b.id}`].sort(),
    );
    // Drawn where the closed Duo shows it, the default camera.
    for (const el of board.elements)
      if ("x" in el && "w" in el) expect(el.x + el.w).toBeLessThanOrEqual(382);

    // The refs resolve to the owner's own inbox items, tappable by id.
    const resolved = await refs.resolveBoardRefs(
      "Ada",
      boardRefs(board.elements),
    );
    expect(resolved[`item:${a.id}`]).toMatchObject({
      ok: true,
      kind: "item",
      title: "Ship 1.19.0?",
      status: "waiting for you",
      fields: { itemId: a.id, project: "acme", options: "Ship it · Hold" },
    });

    // The reply's canvas fence points at that revision.
    const fence = /```canvas\n([\s\S]*?)```/.exec(canvas)?.[1] ?? "";
    expect(parseCanvasFence(fence)?.revision).toBe(1);

    // The brief keeps the spoken line and decisions, and the revision.
    const read = await brief.getSupervisorBrief("Ada");
    expect(read.state).toBe("ready");
    expect(read.brief?.say).toBe("Morning. One thing needs you; it's circled.");
    const first = board.elements.find((el) => el.id === "d-1");
    const firstRef = first && "ref" in first ? first.ref : undefined;
    expect(read.brief?.decisions.map((d) => `item:${d.itemId}`)).toEqual([
      firstRef!,
    ]);
    expect(read.brief?.boardRevision).toBe(1);
  });

  test("a brief turn that draws nothing still stores its brief, logs it, and Blob falls back to the cards", async () => {
    const a = await decision("Ship 1.19.0?", "a");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    spies.push(warn);
    let reply = "";
    model = async () => {
      reply = (
        await call("write_brief", {
          say: "Morning. One thing needs you.",
          decisions: [{ item_id: a.id }],
        })
      ).text;
    };
    const run = await brief.startBriefTurn("Ada", "open");
    if (run.started) expect(await run.delivered).toBe(true);

    const read = await brief.getSupervisorBrief("Ada");
    expect(read.state).toBe("ready");
    expect(read.brief?.boardRevision).toBeNull();
    expect(reply).toContain("It is not on your board yet");
    expect(
      warn.mock.calls.some((args) =>
        String(args[0]).includes("written without a board revision"),
      ),
    ).toBe(true);

    // Drawn right after write_brief: the brief points at it now.
    clock += 60_000;
    const applied = await call("board_apply", {
      expected_revision: 0,
      ops: [
        {
          op: "add",
          el: {
            id: "d-1",
            type: "text",
            role: "title",
            ref: `item:${a.id}`,
            x: 24,
            y: 24,
            w: 300,
          },
        },
      ],
    });
    expect(applied.isError).toBeFalsy();
    expect((await brief.getSupervisorBrief("Ada")).brief?.boardRevision).toBe(
      1,
    );
  });

  test("a board edited before the turn started is not the brief's board", async () => {
    const a = await decision("Ship 1.19.0?", "a");
    expect(
      (
        await call("board_apply", {
          expected_revision: 0,
          ops: [
            {
              op: "add",
              el: {
                id: "old",
                type: "text",
                role: "supporting",
                x: 10,
                y: 10,
                w: 100,
                text: "Yesterday",
              },
            },
          ],
        })
      ).isError,
    ).toBeFalsy();
    clock += 3_600_000;
    spies.push(spyOn(console, "warn").mockImplementation(() => {}));
    model = async () => {
      await call("write_brief", {
        say: "Morning.",
        decisions: [{ item_id: a.id }],
      });
    };
    const run = await brief.startBriefTurn("Ada", "open");
    if (run.started) await run.delivered;
    expect(
      (await brief.getSupervisorBrief("Ada")).brief?.boardRevision,
    ).toBeNull();
  });
});
