import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { IncidentResponse } from "../../../shared/incident-response";
import type {
  Incident,
  SignalView,
  StripResponse,
} from "../../../shared/incidents";
import { pageModel } from "../../lib/incidents/page-model";

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

const { IncidentPageView } = await import("./IncidentPage");

const NOW = Date.now();
const iso = (ms: number) => new Date(NOW + ms).toISOString();

const response = (over: Partial<IncidentResponse> = {}): IncidentResponse => ({
  phase: "veto",
  round: 1,
  maxRounds: 2,
  agents: [],
  actionRuns: [],
  costUsd: 3.8,
  ownerTouched: false,
  next: { kind: "veto", deadline: iso(360_000), rule: "Deploy after veto" },
  veto: { startedAt: iso(-240_000), deadline: iso(360_000) },
  ledger: [],
  droppedLedger: 0,
  startedAt: iso(-3_600_000),
  updatedAt: iso(-60_000),
  ...over,
});

const incident = (withResponse: boolean): Incident => {
  const value: Incident = {
    id: "inc-1",
    project: "acme",
    title: "Search",
    state: withResponse ? "veto" : "investigating",
    severity: "major",
    owner: "Ada",
    openedBy: { kind: "rule" },
    signalIds: ["sig-a"],
    primarySignalId: "sig-a",
    openedAt: iso(-7_200_000),
    updatedAt: iso(-60_000),
    lastProblemAt: iso(-60_000),
    findings: [],
    events: [],
    droppedEvents: 0,
  };
  if (withResponse) value.response = response();
  return value;
};

const signal: SignalView = {
  id: "sig-a",
  name: "Search",
  project: "acme",
  enabled: true,
  severity: "major",
  source: { kind: "http", url: "https://acme.example.test" },
  intervalMs: 120_000,
  rule: { kind: "consecutive", failures: 3 },
  createdBy: "Ada",
  createdAt: iso(-86_400_000),
  updatedAt: iso(-86_400_000),
  evaluation: {
    signalId: "sig-a",
    state: "failing",
    since: iso(-7_200_000),
    at: iso(-60_000),
    reason: "HTTP 503",
    inMaintenance: false,
  },
};

const strip: StripResponse = {
  from: iso(-14_400_000),
  to: iso(0),
  bucketMs: 120_000,
  lanes: [{ id: "sig-a", signalId: "sig-a", label: "Search", bars: [] }],
  markers: [],
};

const actions = {
  onBack: () => {},
  onOpenAll: () => {},
  onOpenSession: () => {},
  onOpenPr: () => {},
  onOpenIncident: () => {},
  onOpenSettings: () => {},
  onIntentHandled: () => {},
};

const ready = (withResponse: boolean) => {
  const value = incident(withResponse);
  return renderToStaticMarkup(
    <IncidentPageView
      project="acme"
      title={value.title}
      actions={actions}
      body={{
        kind: "ready",
        incident: value,
        model: pageModel({
          incident: value,
          signals: [signal],
          settings: null,
          strip,
          now: NOW,
        }),
        strip,
        onRetryStrip: null,
        earlier: [],
        settings: null,
      }}
    />,
  );
};

test("sections in order: status line, strip, next action, cause, details", () => {
  const html = ready(true);
  const order = [
    "Search is down",
    "Search · Check · every 2 min",
    "Deploys the fix",
    "Cause",
    "Agent cost",
  ].map((text) => html.indexOf(text));
  for (const at of order) expect(at).toBeGreaterThan(-1);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  // The desktop bar names the incident by the title the headline uses.
  expect(html).toContain('<div class="min-w-0 truncate">Search</div>');
  expect(html).toContain('aria-label="Incidents"');
});

test("without a response: no next action, the fixed rows still render", () => {
  const html = ready(false);
  expect(html).not.toContain("Deploys the fix");
  expect(html).not.toContain("Stop");
  expect(html).toContain("Agent cost");
  expect(html).toContain("No agents yet");
  expect(html).toContain("Earlier incidents");
  expect(html).toContain("No change yet");
});

test("a strip that failed keeps its slot with Retry", () => {
  const value = incident(false);
  const html = renderToStaticMarkup(
    <IncidentPageView
      project="acme"
      title={value.title}
      actions={actions}
      body={{
        kind: "ready",
        incident: value,
        model: pageModel({
          incident: value,
          signals: [signal],
          settings: null,
          now: NOW,
        }),
        strip: undefined,
        onRetryStrip: () => {},
        earlier: [],
        settings: null,
      }}
    />,
  );
  expect(html).toContain("Couldn&#x27;t load the strip");
  expect(html).toContain("Try again");
  expect(html).toContain("Agent cost");
});

test("not found and error states", () => {
  const missing = renderToStaticMarkup(
    <IncidentPageView
      project={null}
      title=""
      actions={actions}
      body={{ kind: "missing" }}
    />,
  );
  expect(missing).toContain("This incident does not exist");
  expect(missing).toContain("All incidents");
  const failed = renderToStaticMarkup(
    <IncidentPageView
      project={null}
      title=""
      actions={actions}
      body={{ kind: "error", onRetry: () => {} }}
    />,
  );
  expect(failed).toContain("Couldn&#x27;t load this incident");
  const loading = renderToStaticMarkup(
    <IncidentPageView
      project={null}
      title=""
      actions={actions}
      body={{ kind: "loading" }}
    />,
  );
  expect(loading).toContain("Loading the incident");
});
