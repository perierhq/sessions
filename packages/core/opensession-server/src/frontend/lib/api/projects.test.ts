// The project settings list has its own path: `/api/projects` is the
// feeds union view, which answers a different shape.
import { afterEach, expect, test } from "bun:test";
import {
  fetchProjects,
  previewRemigration,
  remigrateProject,
  updateProjectSettingsApi,
} from "./projects";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("the list is read from /api/project-settings", async () => {
  const urls: string[] = [];
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return Response.json([{ id: "acme-web" }]);
  }, realFetch);
  expect(await fetchProjects()).toEqual([
    // SAFETY: the fake answers only an id.
    { id: "acme-web" } as Awaited<ReturnType<typeof fetchProjects>>[number],
  ]);
  expect(urls).toEqual([expect.stringMatching(/\/api\/project-settings$/)]);
});

test("re-running one project's migration: a dry run, then force, on its own endpoint", async () => {
  const sent: Array<{ url: string; method?: string; body: unknown }> = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({
        url: String(input),
        method: init?.method,
        body: JSON.parse(String(init?.body)),
      });
      return Response.json({ project: "acme web", overwritten: true });
    },
    realFetch,
  );
  await previewRemigration("acme web");
  await remigrateProject("acme web");
  const url = expect.stringMatching(/\/api\/projects\/acme%20web\/migrate$/);
  expect(sent).toEqual([
    { url, method: "POST", body: { force: false } },
    { url, method: "POST", body: { force: true } },
  ]);
});

test("a settings change is a PATCH of /api/projects/:id/settings at the revision just read", async () => {
  const sent: Array<{ url: string; method: string; body: unknown }> = [];
  let revision = 4;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      sent.push({ url: String(input), method, body });
      // Another tab saves between the read and the first write.
      if (method === "PATCH" && body.expectedRevision !== revision)
        return Response.json({ error: "stale" }, { status: 409 });
      const answer = Response.json({ document: { revision } });
      if (method === "GET" && sent.length === 1) revision = 5;
      return answer;
    },
    realFetch,
  );
  await updateProjectSettingsApi("acme web", {
    incidents: { agentsPaused: true },
  });
  const url = expect.stringMatching(/\/api\/projects\/acme%20web\/settings$/);
  expect(sent).toEqual([
    { url, method: "GET", body: undefined },
    {
      url,
      method: "PATCH",
      body: { incidents: { agentsPaused: true }, expectedRevision: 4 },
    },
    { url, method: "GET", body: undefined },
    {
      url,
      method: "PATCH",
      body: { incidents: { agentsPaused: true }, expectedRevision: 5 },
    },
  ]);
});
