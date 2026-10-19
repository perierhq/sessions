import { afterEach, describe, expect, test } from "bun:test";
import type { RouteContext } from "./context";
import {
  __setSessionResourceRouteDepsForTest,
  handleSessionResourceRoutes,
  type SessionResourceRouteDeps,
} from "./session-resources";

function ctx(path: string, method = "GET"): RouteContext {
  const url = new URL(`http://localhost${path}`);
  return {
    req: new Request(url, { method }),
    url,
    path,
    publicPrefix: "/opensession",
  };
}

const stopped: string[] = [];

function deps(
  overrides: Partial<SessionResourceRouteDeps> = {},
): SessionResourceRouteDeps {
  return {
    lookupSession: async (id) =>
      id === "os-a" ? { id, worktreeDir: "/tmp/wt" } : undefined,
    listSessions: async () => [{ id: "os-a" }],
    isIdle: () => true,
    list: async () => ({
      items: [{ kind: "container", id: "container:x", label: "pg" }],
    }),
    stop: async (session) => {
      stopped.push(session.id);
      return { stopped: 2, interrupted: false };
    },
    host: async () => ({
      counts: { live: 1, archived: 0, missing: 0, unknown: 0 },
      byKind: { setup: 0, container: 1, unit: 0 },
      memoryBytes: 0,
      leftoverMemoryBytes: 0,
      leftovers: [],
    }),
    ...overrides,
  };
}

afterEach(() => {
  __setSessionResourceRouteDepsForTest(null);
  stopped.splice(0);
});

describe("session resource routes", () => {
  test("lists what a session runs, and 404s an unknown session", async () => {
    __setSessionResourceRouteDepsForTest(deps());
    const ok = await handleSessionResourceRoutes(
      ctx("/api/sessions/os-a/resources"),
    );
    expect(ok?.status).toBe(200);
    expect(await ok?.json()).toEqual({
      items: [{ kind: "container", id: "container:x", label: "pg" }],
    });
    const missing = await handleSessionResourceRoutes(
      ctx("/api/sessions/os-x/resources"),
    );
    expect(missing?.status).toBe(404);
  });

  test("stops everything for an idle session only", async () => {
    __setSessionResourceRouteDepsForTest(deps({ isIdle: () => false }));
    const busy = await handleSessionResourceRoutes(
      ctx("/api/sessions/os-a/resources/stop", "POST"),
    );
    expect(busy?.status).toBe(409);
    expect(stopped).toEqual([]);

    __setSessionResourceRouteDepsForTest(deps());
    const done = await handleSessionResourceRoutes(
      ctx("/api/sessions/os-a/resources/stop", "POST"),
    );
    expect(await done?.json()).toEqual({ stopped: 2 });
    expect(stopped).toEqual(["os-a"]);
  });

  test("asks again before each stop, and reports a run that started part-way", async () => {
    let idle = true;
    const asked: boolean[] = [];
    __setSessionResourceRouteDepsForTest(
      deps({
        isIdle: () => idle,
        stop: async (_session, _sessions, { stillIdle }) => {
          asked.push(stillIdle());
          // A run starts after the first stop.
          idle = false;
          asked.push(stillIdle());
          return { stopped: 1, interrupted: true };
        },
      }),
    );
    const response = await handleSessionResourceRoutes(
      ctx("/api/sessions/os-a/resources/stop", "POST"),
    );
    expect(asked).toEqual([true, false]);
    expect(response?.status).toBe(409);
    const body = await response?.json();
    expect(body.stopped).toBe(1);
    expect(body.error).toContain("A run started");
  });

  test("answers host health, and leaves other paths and methods alone", async () => {
    __setSessionResourceRouteDepsForTest(deps());
    const host = await handleSessionResourceRoutes(
      ctx("/api/host/session-resources"),
    );
    expect((await host?.json()).byKind.container).toBe(1);
    expect(
      await handleSessionResourceRoutes(ctx("/api/sessions/os-a/assets")),
    ).toBeUndefined();
    expect(
      await handleSessionResourceRoutes(
        ctx("/api/sessions/os-a/resources/stop"),
      ),
    ).toBeUndefined();
    expect(
      await handleSessionResourceRoutes(
        ctx("/api/sessions/os-a/resources", "POST"),
      ),
    ).toBeUndefined();
  });
});
