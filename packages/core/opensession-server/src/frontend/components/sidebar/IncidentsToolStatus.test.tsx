import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SWRConfig, unstable_serialize } from "swr";
import type { IncidentSummary, SignalView } from "../../../shared/incidents";
import { apiSWRKey } from "../../lib/api-swr";
import { RECENTLY_FIXED_MS } from "../../lib/incidents/sidebar";
import { IncidentsToolStatus } from "./IncidentsToolStatus";

const INCIDENTS_KEY = unstable_serialize(
  apiSWRKey.incidents("all", undefined, RECENTLY_FIXED_MS),
);
const SIGNALS_KEY = unstable_serialize(apiSWRKey.incidentSignals());

const signal = (state: "ok" | "failing"): SignalView => ({
  id: `sig-${state}`,
  name: "Search",
  project: "acme",
  enabled: true,
  severity: "major",
  source: { kind: "http", url: "https://acme.example.test" },
  intervalMs: 120_000,
  rule: { kind: "consecutive", failures: 3 },
  createdBy: "Ada",
  createdAt: "2026-10-19T12:00:00Z",
  updatedAt: "2026-10-19T12:00:00Z",
  evaluation: {
    signalId: `sig-${state}`,
    state,
    reason: "",
    since: "2026-10-20T12:00:00Z",
    at: "2026-10-20T12:30:00Z",
    inMaintenance: false,
  },
});

const render = (fallback: Record<string, SignalView[] | IncidentSummary[]>) =>
  renderToStaticMarkup(
    <SWRConfig value={{ fallback, provider: () => new Map() }}>
      <IncidentsToolStatus />
    </SWRConfig>,
  );

test("nothing until both lists have loaded", () => {
  expect(render({})).toBe("");
  expect(render({ [SIGNALS_KEY]: [signal("failing")] })).toBe("");
});

test("nothing when there are no signals and no incidents", () => {
  expect(render({ [SIGNALS_KEY]: [], [INCIDENTS_KEY]: [] })).toBe("");
});

test("a dot in the status colour, with the state in words", () => {
  const red = render({
    [SIGNALS_KEY]: [signal("ok"), signal("failing")],
    [INCIDENTS_KEY]: [],
  });
  expect(red).toContain("bg-red");
  expect(red).toContain('aria-hidden="true"');
  expect(red).toContain('<span class="sr-only">, failing</span>');
  const green = render({
    [SIGNALS_KEY]: [signal("ok")],
    [INCIDENTS_KEY]: [],
  });
  expect(green).toContain("bg-green");
  expect(green).toContain("all ok");
});
