import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  MaintenanceWindow,
  SignalView,
} from "../../../../shared/incidents";

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
    documentElement: { dataset: {}, style: { colorScheme: "" } },
    querySelector: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: "visible",
  },
});

const { MaintenanceWindowsEditor, WindowFields } =
  await import("./MaintenanceWindowsEditor");
const { SignalsList } = await import("./SignalsSection");

const weekly: MaintenanceWindow = {
  kind: "weekly",
  days: [0],
  start: "02:00",
  end: "03:00",
  timeZone: "Europe/Warsaw",
};

test("at 20 windows both add buttons disable and say why", () => {
  const html = renderToStaticMarkup(
    <MaintenanceWindowsEditor
      windows={Array.from({ length: 20 }, () => weekly)}
      onChange={() => {}}
    />,
  );
  const adds =
    html.match(
      /<button[^>]*>(?:(?!<\/button>).)*Add a (weekly|one-time) window/g,
    ) ?? [];
  expect(adds).toHaveLength(2);
  for (const button of adds) expect(button).toContain("disabled");
  expect(html).toContain("20 windows at most");
  expect(html).toContain(
    "Planned downtime doesn&#x27;t open incidents. Checks still run and are recorded",
  );
});

test("under the limit the add buttons work and nothing explains", () => {
  const html = renderToStaticMarkup(
    <MaintenanceWindowsEditor windows={[weekly]} onChange={() => {}} />,
  );
  expect(html).not.toContain("20 windows at most");
  expect(html).toContain("Weekly · ");
  expect(html).toContain(">Edit<");
  expect(html).toContain(">Remove<");
});

test("a weekly window's fields: seven days, two times, a zone", () => {
  const html = renderToStaticMarkup(
    <WindowFields window={weekly} onChange={() => {}} />,
  );
  expect(html.match(/role="checkbox"/g)).toHaveLength(7);
  expect(html.match(/type="time"/g)).toHaveLength(2);
  expect(html).toContain('aria-label="Time zone"');
});

test("a problem shows under its field", () => {
  const same = renderToStaticMarkup(
    <WindowFields window={{ ...weekly, end: "02:00" }} onChange={() => {}} />,
  );
  expect(same).toContain("Pick two different times");
  expect(same).toMatch(/aria-describedby="[^"]*-problem"/);
  const once = renderToStaticMarkup(
    <WindowFields
      window={{
        kind: "once",
        start: "2026-10-20T11:00:00.000Z",
        end: "2026-10-20T10:00:00.000Z",
      }}
      onChange={() => {}}
    />,
  );
  expect(once.match(/type="datetime-local"/g)).toHaveLength(2);
  expect(once).toContain("The end must be after the start");
});

test("the Signals card ends with the project's maintenance row", () => {
  /** A stored signal with only the fields the list reads. */
  const signal = (fields: Partial<SignalView>): SignalView =>
    // SAFETY: the list reads only these fields.
    fields as SignalView;
  const html = renderToStaticMarkup(
    <SignalsList
      project="acme"
      signals={[
        signal({
          id: "a",
          name: "Search",
          project: "acme",
          enabled: true,
          source: { kind: "heartbeat" },
          rule: { kind: "missing", everyMs: 3_600_000, graceMs: 0 },
          evaluation: null,
          maintenance: [weekly],
        }),
      ]}
      error={null}
      onRetry={() => {}}
      onOpen={() => {}}
      trailing={<div>Maintenance windows</div>}
    />,
  );
  expect(html.indexOf("Search")).toBeLessThan(
    html.indexOf("Maintenance windows"),
  );
});
