import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { IncidentSummary } from "../../../shared/incidents";

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
    setInterval: () => 0,
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

const { IncidentRow } = await import("./IncidentRow");
const { IncidentsBand } = await import("./IncidentsBand");

const summary = (over: Partial<IncidentSummary> = {}): IncidentSummary => ({
  id: "inc-1",
  project: "acme",
  title: "Search down",
  state: "investigating",
  severity: "major",
  owner: "Ada",
  openedBy: { kind: "rule" },
  signalIds: ["sig-a"],
  primarySignalId: "sig-a",
  openedAt: "2026-10-20T10:41:00Z",
  updatedAt: "2026-10-20T12:27:00Z",
  lastProblemAt: "2026-10-20T12:27:00Z",
  findings: [],
  droppedEvents: 0,
  eventCount: 0,
  ...over,
});

test("row: project tile, title, trailing word in words", () => {
  const html = renderToStaticMarkup(
    <IncidentRow
      incident={summary({
        title: "Search is down for everyone in every region at once",
        state: "needs-you",
      })}
      headline="Search is down"
      facts={["since 10:41"]}
      active={false}
      onOpen={() => {}}
    />,
  );
  expect(html).toContain("needs you");
  expect(html).toContain("text-blue");
  expect(html).toContain(
    'aria-label="Incident: Search is down for everyone in every region at once, needs you"',
  );
  expect(html).toContain("repo-tile");
  // The title fades out at its edge (the sidebar's truncation); the word
  // never shrinks.
  expect(html).toContain("overflow-hidden whitespace-nowrap");
  expect(html).toMatch(/shrink-0 whitespace-nowrap[^"]*text-blue/);
  expect(html).not.toContain("data-selected");
});

test("a fixed incident reads fixed, faint", () => {
  const html = renderToStaticMarkup(
    <IncidentRow
      incident={summary({
        state: "resolved",
        closedAt: "2026-10-20T12:00:00Z",
      })}
      headline="h"
      facts={[]}
      active
      onOpen={() => {}}
    />,
  );
  expect(html).toContain(">fixed<");
  expect(html).toContain("text-faint");
  expect(html).toContain("data-selected");
  expect(html).toContain("bg-selected");
  expect(html).toContain('aria-current="page"');
});

test("the band renders nothing before the list loads", () => {
  const html = renderToStaticMarkup(
    <IncidentsBand
      open
      onToggleBand={() => {}}
      onOpenIncident={() => {}}
      onOpenAll={() => {}}
    />,
  );
  expect(html).toBe("");
});

test("the heading and All incidents are two buttons, neither inside the other", async () => {
  const { SWRConfig, unstable_serialize } = await import("swr");
  const { apiSWRKey } = await import("../../lib/api-swr");
  const { RECENTLY_FIXED_MS } = await import("../../lib/incidents/sidebar");
  const key = apiSWRKey.incidents("all", undefined, RECENTLY_FIXED_MS);
  const html = renderToStaticMarkup(
    <SWRConfig value={{ fallback: { [unstable_serialize(key)]: [summary()] } }}>
      <IncidentsBand
        open
        onToggleBand={() => {}}
        onOpenIncident={() => {}}
        onOpenAll={() => {}}
      />
    </SWRConfig>,
  );
  expect(html).toContain('aria-label="All incidents"');
  expect(html).not.toContain('role="button"');
  // No button opens before the previous one closes.
  const tags = html.match(/<\/?button\b/g) ?? [];
  for (let i = 1; i < tags.length; i++)
    expect(tags[i - 1] === "<button" && tags[i] === "<button").toBe(false);
});
