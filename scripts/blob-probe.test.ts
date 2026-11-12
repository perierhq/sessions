/**
 * The probe's flows against a stubbed fetch: which requests each scenario
 * makes, in read-only and write mode, and what it concludes. No server and
 * no socket: the flows tested here are HTTP only.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Api, RUNNERS, type Context } from "./blob-probe";
import { parseProbeArgs, type ProbeOptions } from "./lib/blob-probe";

const BASE = "https://sessions.example.test";

interface Seen {
  method: string;
  path: string;
  body: unknown;
}

type Route = (request: Seen) => { status: number; body?: unknown } | undefined;

let seen: Seen[] = [];
const realFetch = globalThis.fetch;
let quiet: ReturnType<typeof spyOn> | null = null;

/** Answers requests from `route`; anything it doesn't know is 404. */
function serve(route: Route): void {
  const stub = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const request: Seen = {
      method: init?.method ?? "GET",
      path: url.pathname + url.search,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    seen.push(request);
    const answer = route(request) ?? { status: 404, body: { error: "nope" } };
    return new Response(JSON.stringify(answer.body ?? {}), {
      status: answer.status,
    });
  };
  // SAFETY: the probe calls fetch(url, init) only; preconnect is unused.
  globalThis.fetch = stub as unknown as typeof fetch;
}

beforeEach(() => {
  seen = [];
  quiet = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = realFetch;
  quiet?.mockRestore();
});

function options(argv: string[]): ProbeOptions {
  const parsed = parseProbeArgs(argv);
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed;
}

function context(argv: string[]): Context {
  const parsed = options(argv);
  return {
    api: new Api(BASE, "token", parsed.ownerReadOnly),
    me: { login: "blob-probe", name: "Blob Probe" },
    ensured: null,
    options: parsed,
  };
}

function brief(revision: number) {
  return {
    state: "ready",
    brief: {
      day: "2026-11-12",
      asOf: 1,
      say: "Morning.",
      seenAt: null,
      handled: [],
      decisions: [
        {
          itemId: "a",
          recommended: "Keep it",
          item: {
            id: "a",
            kind: "needs-you",
            title: "Raise the alert threshold?",
            options: ["Raise to 8", "Keep it"],
            state: "open",
            revision,
          },
        },
      ],
      later: { count: 0 },
    },
    newSince: { itemIds: [] },
  };
}

const exchange = (id: string, sessionId: string) => ({
  id,
  sessionId,
  said: `said ${id}`,
  reply: `reply ${id}`,
  at: 1_700_000_000_000,
});

/** Common read routes: glossary, prefs without a zone, a brief. */
const reads: Route = ({ method, path }) => {
  if (method !== "GET") return undefined;
  if (path === "/api/blob/glossary")
    return { status: 200, body: { terms: [] } };
  if (path.startsWith("/api/supervisor/prefs"))
    return {
      status: 200,
      body: { prefs: { timezone: "", effectiveTimezone: "UTC" } },
    };
  if (path.startsWith("/api/supervisor/brief"))
    return { status: 200, body: brief(7) };
  return undefined;
};

describe("read-only", () => {
  test("the Api throws on anything but GET, before fetching", async () => {
    serve(() => ({ status: 200 }));
    const api = new Api(BASE, "token", true);
    for (const method of ["POST", "PUT", "DELETE"])
      await expect(
        api.call(method, "/api/supervisor/ensure", {}),
      ).rejects.toThrow("read-only");
    expect(seen).toEqual([]);
    expect((await api.call("GET", "/api/blob/glossary")).status).toBe(200);
  });

  test("open and history make GET requests only, and never ensure", async () => {
    serve(
      (request) =>
        reads(request) ??
        (request.path.startsWith("/api/supervisor/history")
          ? {
              status: 200,
              body: {
                exchanges: [exchange("x1", "old"), exchange("x2", "now")],
                before: null,
              },
            }
          : { status: 200, body: {} }),
    );
    const ctx = context(["--owner-read-only"]);
    expect((await RUNNERS.open(ctx)).status).toBe("PASS");
    const history = await RUNNERS.history(ctx);
    expect(history.status).toBe("PASS");
    expect(history.reason).toContain("2 sessions");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r.method === "GET")).toBe(true);
    expect(seen.some((r) => r.path.includes("ensure"))).toBe(false);
    // No start=1 either: that would start a brief turn.
    expect(seen.some((r) => r.path.includes("start=1"))).toBe(false);
  });

  test("history from one session can't tell a rotation without the id", async () => {
    serve((request) =>
      request.path.startsWith("/api/supervisor/history")
        ? {
            status: 200,
            body: { exchanges: [exchange("x1", "now")], before: null },
          }
        : undefined,
    );
    const verdict = await RUNNERS.history(context(["--owner-read-only"]));
    expect(verdict.status).toBe("SKIP");
    expect(verdict.reason).toContain("no current session id");
  });
});

describe("history", () => {
  const ensured = {
    status: 200,
    body: { sessionId: "now", previousSessionIds: ["old"] },
  };

  test("pages GET /api/supervisor/history back to the rotation", async () => {
    serve(({ method, path }) => {
      if (method === "POST" && path === "/api/supervisor/ensure")
        return ensured;
      if (path === "/api/supervisor/history")
        return {
          status: 200,
          body: { exchanges: [exchange("x2", "now")], before: "c1" },
        };
      if (path === "/api/supervisor/history?before=c1")
        return {
          status: 200,
          body: { exchanges: [exchange("x1", "old")], before: "c0" },
        };
      return undefined;
    });
    const verdict = await RUNNERS.history(context(["history"]));
    expect(verdict.status).toBe("PASS");
    expect(verdict.reason).toContain("before the latest rotation (old)");
    // It stops once an earlier exchange is in, as the app stops scrolling.
    expect(seen.map((r) => r.path)).toEqual([
      "/api/supervisor/ensure",
      "/api/supervisor/history",
      "/api/supervisor/history?before=c1",
    ]);
  });

  test("a 404 is history that stops at the current session", async () => {
    serve(({ method, path }) =>
      method === "POST" && path === "/api/supervisor/ensure"
        ? ensured
        : undefined,
    );
    const verdict = await RUNNERS.history(context(["history"]));
    expect(verdict.status).toBe("FAIL");
    expect(verdict.reason).toContain("history stops at the current session");
    const readOnly = await RUNNERS.history(context(["--owner-read-only"]));
    expect(readOnly.reason).toContain("history stops at the current session");
  });
});

describe("open", () => {
  test("ensures, and sets the timezone the server lacks", async () => {
    serve((request) => {
      if (
        request.method === "POST" &&
        request.path === "/api/supervisor/ensure"
      )
        return { status: 200, body: { sessionId: "now" } };
      if (request.method === "PUT") return { status: 200, body: { prefs: {} } };
      return reads(request);
    });
    expect((await RUNNERS.open(context(["open"]))).status).toBe("PASS");
    const put = seen.find((r) => r.method === "PUT");
    expect(put?.path).toBe("/api/supervisor/prefs");
    expect(put?.body).toMatchObject({ user: "Blob Probe" });
    expect(typeof (put?.body as { timezone?: unknown }).timezone).toBe(
      "string",
    );
    expect(
      seen.some((r) => r.path === "/api/supervisor/prefs?user=Blob+Probe"),
    ).toBe(true);
    expect(seen.some((r) => r.path.includes("start=1"))).toBe(true);
  });
});

describe("answer", () => {
  const answers = () =>
    seen.filter((r) => r.method === "POST" && r.path.endsWith("/answer"));

  test("skips without --item or --allow-answer", async () => {
    serve(() => undefined);
    const verdict = await RUNNERS.answer(context(["answer"]));
    expect(verdict.status).toBe("SKIP");
    expect(verdict.reason).toContain("--allow-answer");
    expect(seen).toEqual([]);
  });

  test("--allow-answer: 409 changed, read the brief again, answered once", async () => {
    serve((request) => {
      if (request.method === "POST" && request.path.endsWith("/answer")) {
        const { revision } = request.body as { revision: number };
        return revision === 7
          ? {
              status: 200,
              body: { item: { id: "a", title: "T", state: "answered" } },
            }
          : { status: 409, body: { error: "changed" } };
      }
      return reads(request);
    });
    const verdict = await RUNNERS.answer(context(["answer", "--allow-answer"]));
    expect(verdict.status).toBe("PASS");
    expect(answers().map((r) => r.body)).toEqual([
      { user: "Blob Probe", answer: "Keep it", revision: 6 },
      { user: "Blob Probe", answer: "Keep it", revision: 7 },
    ]);
  });

  test("a second 409 changed fails without answering again", async () => {
    serve((request) =>
      request.method === "POST"
        ? { status: 409, body: { error: "changed" } }
        : reads(request),
    );
    const verdict = await RUNNERS.answer(context(["answer", "--allow-answer"]));
    expect(verdict.status).toBe("FAIL");
    expect(verdict.reason).toContain("This changed");
    expect(answers()).toHaveLength(2);
  });
});
