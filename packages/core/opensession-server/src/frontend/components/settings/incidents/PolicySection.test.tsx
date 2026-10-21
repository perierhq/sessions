import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DEFAULT_AUTONOMY,
  DEFAULT_BUDGET,
  DEFAULT_MAX_ROUNDS,
  DEFAULT_NEVER_WITHOUT_YOU,
  DEFAULT_VETO_MS,
  DEFAULT_WATCH_MS,
  type RedactedProjectSettings,
} from "../../../../shared/incident-response";

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

const { IncidentSettingsView } = await import("./IncidentSettings");
const { PolicySection } = await import("./PolicySection");

const settings: RedactedProjectSettings = {
  project: "acme",
  agentsPaused: false,
  autonomy: DEFAULT_AUTONOMY,
  vetoMs: DEFAULT_VETO_MS,
  watchMs: DEFAULT_WATCH_MS,
  maxRounds: DEFAULT_MAX_ROUNDS,
  neverWithoutYou: DEFAULT_NEVER_WITHOUT_YOU,
  budget: DEFAULT_BUDGET,
  agents: {},
  productionRunners: [],
  actions: [],
  releases: [],
};
const save = async () => {};

test("without the fix loop: one info notice, signals still render", () => {
  const html = renderToStaticMarkup(
    <IncidentSettingsView
      project="acme"
      label="acme"
      view={null}
      onSave={save}
      sections={{ signals: <div>Signals</div> }}
    />,
  );
  expect(html).toContain(
    "Autonomy, budget and actions need the incident fix loop on this server. Signals work now",
  );
  expect(html).toContain("border-blue/40");
  expect(html).not.toContain("border-red/40");
  expect(html).toContain("Signals");
  expect(html).not.toContain("Pause all agents");
});

test("while loading, each group keeps its final shape", () => {
  const html = renderToStaticMarkup(
    <IncidentSettingsView
      project="acme"
      label="acme"
      view={undefined}
      onSave={save}
      sections={{}}
    />,
  );
  expect(html).toContain("Autonomy");
  expect(html).toContain("Budget");
  expect(html).toContain("acme · what the agents may do when something breaks");
});

test("policy rows in order, with defaults", () => {
  const html = renderToStaticMarkup(
    <PolicySection
      project="acme"
      settings={settings}
      spend={{ month: "2026-10", monthUsd: 6.5, perMonthUsd: 200 }}
      onSave={save}
    />,
  );
  const order = [
    "Pause all agents",
    "Deploy after veto",
    "10 min",
    "Spending money",
    "$20",
    "$200",
  ].map((text) => html.indexOf(text));
  expect(order.every((i) => i >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(html).toContain("Stops every incident run for acme right now");
  expect(html).toContain("Spent this month: $6.50");
  expect(html).toContain("Off");
  // Semantic tokens only.
  expect(html).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
  // Four levels: a select, not the toggle group a Segmented draws.
  const autonomyRow = html.slice(
    html.indexOf("What agents may do without you"),
    html.indexOf("Veto window"),
  );
  expect(autonomyRow).not.toContain('role="group"');
  expect(autonomyRow).not.toContain('role="radiogroup"');
});

test("a night rule and a paused project read as themselves", () => {
  const html = renderToStaticMarkup(
    <PolicySection
      project="acme"
      settings={{
        ...settings,
        agentsPaused: true,
        night: { start: "23:00", end: "07:00", timeZone: "UTC" },
        neverWithoutYou: [],
      }}
      onSave={save}
    />,
  );
  expect(html).toContain("Propose only");
  expect(html).toContain("fixes wait for you unless the signal is fully down");
  expect(html).toContain("Nothing");
  expect(html).not.toContain("Spent this month");
});
