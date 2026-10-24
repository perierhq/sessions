// The project list must be a list: a server whose /api/projects still
// answers the feeds shape is a failed load, not a crash further on.
import { afterEach, expect, test } from "bun:test";
import { fetchProjects, remigrateProject } from "./projects";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const answer = (
  body:
    | { projects: Array<{ id: string; kind: string }> }
    | Array<{ id: string }>,
) => {
  globalThis.fetch = Object.assign(async () => Response.json(body), realFetch);
};

test("an object instead of a list rejects", async () => {
  answer({ projects: [{ id: "acme-todo", kind: "repo" }] });
  await expect(fetchProjects()).rejects.toThrow("Failed to load projects");
});

test("a list is the list", async () => {
  answer([{ id: "acme-web" }]);
  expect(await fetchProjects()).toEqual([
    // SAFETY: the fake answers only an id.
    { id: "acme-web" } as Awaited<ReturnType<typeof fetchProjects>>[number],
  ]);
});

test("re-running one project's migration posts force to its own endpoint", async () => {
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
  await remigrateProject("acme web");
  expect(sent).toEqual([
    {
      url: expect.stringMatching(/\/api\/projects\/acme%20web\/migrate$/),
      method: "POST",
      body: { force: true },
    },
  ]);
});
