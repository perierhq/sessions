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
    "Deploy after veto",
    "10 min",
    "Spending money",
    "$20",
    "$200",
  ].map((text) => html.indexOf(text));
  expect(order.every((i) => i >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(html).toContain("Spent this month: $6.50");
  // At night says Off once, as its value.
  expect(html).toContain("Fixes can wait for you overnight");
  expect(html.match(/>Off</g)).toHaveLength(1);
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

test("every select is a 44px target on a phone", () => {
  const html = renderToStaticMarkup(
    <PolicySection project="acme" settings={settings} onSave={save} />,
  );
  for (const label of [
    "What agents may do without you",
    "Veto window",
    "Watch after a deploy",
    "Rounds before it asks you",
  ]) {
    const trigger = html.match(
      new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`),
    )?.[0];
    expect(trigger).toBeDefined();
    expect(trigger).toContain("phone:min-h-11");
  }
});
