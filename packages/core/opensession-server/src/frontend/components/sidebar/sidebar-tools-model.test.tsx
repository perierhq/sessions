import { expect, test } from "bun:test";
import { isValidElement } from "react";
import type { NavigationActions } from "../../lib/navigation";

const store = new Map<string, string>();
Object.assign(globalThis, {
  window: {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  },
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  },
  document: {
    documentElement: { dataset: {}, style: { colorScheme: "" } },
    querySelector: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: "visible",
  },
});

const { createSidebarToolsModel } = await import("./sidebar-tools-model");
const { IncidentsToolStatus } = await import("./IncidentsToolStatus");
const { getSidebarToolOrder, readHiddenSidebarTools } =
  await import("../../lib/sidebar-tools");

const opened: string[] = [];
// SAFETY: every NavigationActions member the model reads is a method, and the
// proxy answers any property with a function that records the call; the
// model never reads `unreadChats` or `allChatsRead`.
const navigation = new Proxy(
  {},
  {
    get:
      (_target, name) =>
      (...args: unknown[]) =>
        opened.push([String(name), ...args.map(String)].join(":")),
  },
) as NavigationActions;

const model = (
  over: Partial<Parameters<typeof createSidebarToolsModel>[0]> = {},
) =>
  createSidebarToolsModel({
    navigation,
    feedActive: false,
    prsActive: false,
    incidentsActive: false,
    issuesActive: false,
    tasksActive: false,
    taskCount: 0,
    plainActive: false,
    catchUpActive: false,
    catchUpCount: 0,
    supportTinderActive: false,
    reportsActive: false,
    databasesActive: false,
    analyticsActive: false,
    isPhone: false,
    toolOrder: getSidebarToolOrder(),
    hiddenTools: readHiddenSidebarTools(),
    hiddenFeeds: new Set(),
    borrowedLens: false,
    productEmpty: false,
    feeds: [],
    archivedActive: false,
    ...over,
  });

test("a new account has Incidents after Feed and Pull requests", () => {
  store.clear();
  expect(model().visibleTools.map((tool) => tool.id)).toEqual([
    "feed",
    "prs",
    "incidents",
    "plain",
  ]);
});

test("the Incidents row opens the incidents home and carries its dot", () => {
  store.clear();
  opened.length = 0;
  const tool = model().visibleTools.find((t) => t.id === "incidents")!;
  expect(tool.label).toBe("Incidents");
  expect(tool.active).toBe(false);
  tool.onClick();
  expect(opened).toEqual(["openIncidents"]);
  expect(
    isValidElement(tool.trailing) && tool.trailing.type === IncidentsToolStatus,
  ).toBe(true);
  expect(
    model({ incidentsActive: true }).visibleTools.find(
      (t) => t.id === "incidents",
    )?.active,
  ).toBe(true);
});

test("Incidents is offered on a phone too, and listed in the chooser", () => {
  store.clear();
  const phone = model({ isPhone: true });
  // Pull requests is the phone's root list, so Incidents follows Feed there.
  expect(phone.visibleTools.map((tool) => tool.id).slice(0, 2)).toEqual([
    "feed",
    "incidents",
  ]);
  const listed = model().sidebarMenuTools.find((t) => t.id === "incidents");
  expect(listed).toMatchObject({ label: "Incidents", shown: true });
});

test("hiding Incidents takes the row out and leaves it in the chooser", () => {
  const hidden = model({ hiddenTools: new Set(["incidents"]) });
  expect(hidden.visibleTools.some((t) => t.id === "incidents")).toBe(false);
  expect(hidden.sidebarMenuTools.find((t) => t.id === "incidents")?.shown).toBe(
    false,
  );
});

test("a borrowed sidebar has no tools, Incidents included", () => {
  expect(model({ borrowedLens: true }).visibleTools).toEqual([]);
});
