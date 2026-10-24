import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ProjectRole } from "../../shared/project-settings";
import { DEFAULTS_VIEW } from "../../shared/project-settings-fixtures";
import { __setProjectViewDepsForTest } from "../projects/view";
import { testProjectViewDeps } from "../projects/view-test-deps";
import type { RouteContext } from "./context";
import { routeHandlers } from "./index";
import {
  __setProjectDefaultsRoutesForTest,
  handleProjectDefaultsRoutes,
  parseWebsites,
} from "./project-defaults";

const ADA = { login: "ada", name: "Ada Lovelace" };

let state: {
  models: Record<ProjectRole, string>;
  sandbox: string;
  previews: string;
  websites: string[];
};

beforeEach(() => {
  state = {
    models: { ...DEFAULTS_VIEW.models },
    sandbox: "daytona",
    previews: "same",
    websites: ["api.example.test"],
  };
  __setProjectViewDepsForTest(testProjectViewDeps().deps);
  __setProjectDefaultsRoutesForTest({
    models: () => ({ ...state.models }),
    setModel: (role, id) => {
      if (id === "nope") throw new Error("Unknown model: nope");
      state.models[role] = id ?? "pi/anthropic/claude-opus-5-5";
    },
    sandbox: () => state.sandbox,
    setSandbox: (v) => {
      state.sandbox = v;
    },
    previews: () => state.previews,
    setPreviews: (v) => {
      state.previews = v;
    },
    websites: () => [...state.websites],
    setWebsites: (hosts) => {
      state.websites = hosts;
    },
  });
});

afterEach(() => {
  __setProjectViewDepsForTest(undefined);
  __setProjectDefaultsRoutesForTest(undefined);
});

const call = async (
  method: string,
  body?: unknown,
  authUser: RouteContext["authUser"] = ADA,
  path = "/api/project-defaults",
) => {
  const url = new URL(`http://localhost${path}`);
  const res = await handleProjectDefaultsRoutes({
    req: new Request(url, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    url,
    path: url.pathname,
    publicPrefix: "/backstage",
    authUser,
  });
  return res ? { status: res.status, json: await res.json() } : undefined;
};

test("GET composes the defaults page", async () => {
  const out = await call("GET");
  expect(out?.json).toEqual(DEFAULTS_VIEW);
});

test("PATCH websites: a bad host is a 400 and nothing is written", async () => {
  expect(
    await call("PATCH", {
      websites: ["bad host"],
      sandbox: "none",
    }),
  ).toEqual({
    status: 400,
    json: {
      error:
        "automation egress destinations must be hostnames, not URLs with paths, ports, or CIDRs: bad host",
    },
  });
  expect(state.sandbox).toBe("daytona");
});

test("PATCH saves models, sandbox, previews and websites", async () => {
  const out = await call("PATCH", {
    models: { verifier: "pi/openai/gpt-6", automations: null },
    sandbox: "podman",
    previews: "daytona",
    websites: ["https://Status.Example.test/x", "api.example.test"],
  });
  expect(out?.status).toBe(200);
  expect(out?.json).toMatchObject({
    models: {
      verifier: "pi/openai/gpt-6",
      automations: "pi/anthropic/claude-opus-5-5",
    },
    sandbox: "podman",
    previews: "daytona",
    websites: ["status.example.test", "api.example.test"],
  });
});

test("models, sandbox and websites need a signed-in person; previews don't", async () => {
  for (const body of [
    { models: { you: "pi/openai/gpt-6" } },
    { sandbox: "none" },
    { websites: [] },
  ]) {
    expect((await call("PATCH", body, null))?.status).toBe(403);
  }
  expect((await call("PATCH", { previews: "daytona" }, null))?.status).toBe(
    200,
  );
});

test("PATCH input errors", async () => {
  expect((await call("PATCH", { models: { boss: "x" } }))?.json).toEqual({
    error: 'Unknown role "boss"',
  });
  expect((await call("PATCH", { models: { you: "nope" } }))?.json).toEqual({
    error: "Unknown model: nope",
  });
  expect((await call("PATCH", { sandbox: 3 }))?.status).toBe(400);
});

test("parseWebsites caps the list at Daytona's maximum", () => {
  const many = Array.from({ length: 21 }, (_, i) => `h${i}.example.test`);
  expect(parseWebsites(many)).toEqual({
    error: "At most 20 websites. Daytona allows no more",
  });
  expect(parseWebsites(["a.example.test", "A.example.test"])).toEqual([
    "a.example.test",
  ]);
  expect(parseWebsites("a.example.test")).toEqual({
    error: "websites must be a list of domains",
  });
});

test("other paths fall through; registered in the chain", async () => {
  expect(await call("DELETE")).toBeUndefined();
  expect(
    await call("GET", undefined, ADA, "/api/project-defaults/x"),
  ).toBeUndefined();
  expect(routeHandlers).toContain(handleProjectDefaultsRoutes);
});
