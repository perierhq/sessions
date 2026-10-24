// The command palette's project actions read the project list from the
// cache and load it when the palette opens, never on every window focus.
import { expect, mock, test } from "bun:test";
import type { ProjectListItem } from "../../shared/project-settings";

const mutations: unknown[][] = [];
type Fetcher = (() => Promise<ProjectListItem[]>) | null;
const hooks: Array<{ key: readonly string[] | null; fetcher: Fetcher }> = [];
mock.module("swr", () => ({
  default: (key: readonly string[] | null, fetcher: Fetcher) => {
    hooks.push({ key, fetcher });
    return { data: undefined };
  },
  mutate: (...args: unknown[]) => {
    mutations.push(args);
    return Promise.resolve();
  },
}));
let fetched = 0;
mock.module("../lib/api/projects", () => ({
  fetchProjects: async () => {
    fetched++;
    return [];
  },
  fetchProjectDefaults: async () => ({}),
  fetchProjectSettings: async () => ({}),
}));

const { loadProjects, projectSWRKey, useCachedProjects } =
  await import("./useProjects");

test("the cached list never fetches on its own", () => {
  useCachedProjects();
  expect(hooks.at(-1)).toEqual({
    key: projectSWRKey.projects(),
    fetcher: null,
  });
  expect(fetched).toBe(0);
});

test("opening the palette loads the list into the shared key", () => {
  loadProjects();
  expect(fetched).toBe(1);
  expect(mutations.at(-1)?.[0]).toEqual(projectSWRKey.projects());
  expect(mutations.at(-1)?.[2]).toEqual({ revalidate: false });
});
