import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  IncidentSummary,
  SignalState,
  SignalView,
} from "../../../shared/incidents";

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

const { IncidentsHomeView } = await import("./IncidentsHome");

const NOW = Date.parse("2026-10-20T12:31:00Z");

const signal = (
  id: string,
  name: string,
  state: SignalState,
  reason = "All good",
): SignalView =>
  // SAFETY: the home reads only the signal fields set here.
  ({
    id,
    name,
    project: "acme",
    enabled: true,
    source: { kind: "http", url: "https://example.test/search" },
    rule: { kind: "consecutive", failures: 3 },
    intervalMs: 120_000,
    severity: "major",
    createdBy: "Ada",
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    evaluation: {
      signalId: id,
      state,
      since: "2026-10-20T12:00:00Z",
      at: "2026-10-20T12:30:00Z",
      reason,
      inMaintenance: false,
    },
    lastObservation: {
      at: "2026-10-20T12:30:00Z",
      result: state === "ok" ? "ok" : "fail",
      value: 412,
      detail: "200",
    },
  }) as SignalView;

const incident = (over: Partial<IncidentSummary>): IncidentSummary =>
  // SAFETY: the home reads only the incident fields set here.
  ({
    id: "inc-1",
    project: "acme",
    title: "Search down",
    state: "resolved",
    severity: "major",
    signalIds: ["sig-a"],
    primarySignalId: "sig-a",
    openedAt: "2026-10-18T08:00:00Z",
    closedAt: "2026-10-18T10:00:00Z",
    fixedBy: "agents",
    findings: [],
    eventCount: 1,
    ...over,
  }) as IncidentSummary;

const noop = () => {};

const render = (props: Partial<Parameters<typeof IncidentsHomeView>[0]>) =>
  renderToStaticMarkup(
    <IncidentsHomeView
      signals={{
        kind: "ready",
        signals: [
          signal("sig-a", "Search", "ok"),
          signal("sig-b", "Bounce webhook", "failing", "3 failures in a row"),
        ],
      }}
      open={[]}
      past={[incident({})]}
      projects={["acme"]}
      now={NOW}
      onOpenIncident={noop}
      onEditSignal={noop}
      onAddSignal={noop}
      {...props}
    />,
  );

test("status line, signals (problems first), Add a signal, past incidents", () => {
  const html = render({});
  expect(html).toContain("1 green, 1 failing");
  const at = (text: string) => html.indexOf(text, html.indexOf("<section"));
  expect(at("1 green")).toBeLessThan(at(">Signals<"));
  expect(at(">Signals<")).toBeLessThan(at("Bounce webhook"));
  expect(at("Bounce webhook")).toBeLessThan(at(">Search<"));
  expect(at(">Search<")).toBeLessThan(at("Add a signal"));
  expect(at("Add a signal")).toBeLessThan(at(">Past incidents<"));
  for (const header of ["Incident", "Fixed by", "Cost", "Date"])
    expect(html).toContain(`>${header}</th>`);
  expect(html).toContain("Agents · 2 h");
  expect(html).not.toContain("Heads-up");
});

test("the signals list never shows a percentage", () => {
  const html = render({});
  const list = html
    .slice(html.indexOf(">Signals<"), html.indexOf(">Past incidents<"))
    .replace(/<[^>]*>/g, " ");
  expect(list).not.toContain("%");
  expect(list).toContain("412 ms");
  expect(list).toContain("failing");
});

test("heads-up band lists open heads-ups above the signals", () => {
  const html = render({
    open: [
      incident({
        id: "inc-2",
        title: "Bounce webhook flaky",
        state: "heads-up",
        primarySignalId: "sig-b",
        closedAt: undefined,
      }),
    ],
  });
  expect(html).toContain("Heads-up");
  expect(html.indexOf("Heads-up")).toBeLessThan(html.indexOf(">Signals<"));
  expect(html).toContain("Bounce webhook flaky");
  expect(html).toContain("3 failures in a row");
  expect(html).toContain(">heads-up<");
});

test("no signals: the empty state with Add a signal", () => {
  const html = render({ signals: { kind: "ready", signals: [] } });
  expect(html).toContain("No signals yet");
  expect(html).toContain(
    "A signal checks something in production and opens an incident when it breaks",
  );
  expect(html).toContain("Add a signal");
});

test("signals failing to load: Retry in place, past incidents still render", () => {
  const html = render({ signals: { kind: "error", onRetry: noop } });
  expect(html).toContain("Couldn&#x27;t load the signals");
  expect(html).toContain("Try again");
  expect(html).toContain("Search down");
});

test("loading: skeletons, no status words", () => {
  const html = render({ signals: { kind: "loading" }, past: null });
  expect(html).toContain("Loading signals");
  expect(html).not.toContain("green");
});

test("no past incidents", () => {
  expect(render({ past: [] })).toContain("No incidents yet");
});

test("a long Japanese signal name truncates in its slot", () => {
  const name = "検索".repeat(60);
  const html = render({
    signals: { kind: "ready", signals: [signal("sig-j", name, "ok")] },
  });
  const at = html.indexOf(name);
  const open = html.lastIndexOf("<span", at);
  expect(html.slice(open, at)).toContain("truncate");
});
