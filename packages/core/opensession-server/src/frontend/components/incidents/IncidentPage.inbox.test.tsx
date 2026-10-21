// Opening an incident from any path (a push, the inbox, the list) reads its
// inbox row on every device while the page is on screen: the page watches
// its row from mount to unmount and moves the watch when the incident
// changes. The read rule itself is lib/notifications'
// (watchIncidentNotifications). IncidentPage's own hooks run in the hook
// harness; its children are read, not rendered.
import { afterEach, expect, mock, test } from "bun:test";
import {
  createHookHarness,
  reactWithHarness,
  settle,
} from "../../tools/hook-harness";

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
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
  document: {
    title: "",
    documentElement: { dataset: {}, style: { colorScheme: "" } },
    querySelector: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: "visible",
  },
});

const harness = createHookHarness();
const realReact = await import("react");
mock.module("react", () => reactWithHarness({ ...realReact }, harness));

// Loading: no data yet, which is when a push tap first lands on the page.
const loading = () => ({
  data: undefined,
  error: undefined,
  mutate: () => Promise.resolve(undefined),
});
const realHooks = await import("../../hooks/useIncidents");
mock.module("../../hooks/useIncidents", () => ({
  ...realHooks,
  useIncident: loading,
  useIncidents: loading,
  useIncidentStrip: loading,
  useProjectSettings: loading,
  useSignals: loading,
}));

const watching: string[] = [];
const log: string[] = [];
const realNotifications = await import("../../lib/notifications");
mock.module("../../lib/notifications", () => ({
  ...realNotifications,
  watchIncidentNotifications: (id: string) => {
    watching.push(id);
    log.push(`watch ${id}`);
    return () => {
      watching.splice(watching.indexOf(id), 1);
      log.push(`stop ${id}`);
    };
  },
}));

const { IncidentPage } = await import("./IncidentPage");
type Props = Parameters<typeof IncidentPage>[0];

const props = (id: string): Props => ({
  id,
  sessions: [],
  onBack: () => {},
  navigate: () => {},
});

afterEach(() => {
  harness.unmountAll();
  watching.length = 0;
  log.length = 0;
});

test("the page reads its incident's inbox row while it is on screen", async () => {
  const page = harness.mount(IncidentPage, props("inc-1"));
  await settle();
  expect(watching).toEqual(["inc-1"]);
  page.unmount();
  expect(watching).toEqual([]);
  expect(log).toEqual(["watch inc-1", "stop inc-1"]);
});

test("moving to another incident moves the watch; a re-render keeps it", async () => {
  const page = harness.mount(IncidentPage, props("inc-1"));
  await settle();
  page.update(props("inc-1"));
  await settle();
  expect(log).toEqual(["watch inc-1"]);
  page.update(props("inc-2"));
  await settle();
  expect(watching).toEqual(["inc-2"]);
  expect(log).toEqual(["watch inc-1", "stop inc-1", "watch inc-2"]);
});
