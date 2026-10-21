import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DetailRow } from "../../lib/incidents/details";

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

const { IncidentDetailsView } = await import("./IncidentDetails");

const rows: DetailRow[] = [
  {
    key: "change",
    band: "Fix",
    label: "PR #437 · Send the app's user agent",
    value: "checks pass",
    tone: "green",
    lines: { additions: 84, deletions: 12 },
    target: { kind: "pr", repo: "acme", number: 437 },
  },
  {
    key: "note",
    band: "Fix",
    label: "Incident note",
    value: "Draft",
    target: { kind: "url", url: "https://example.test/pr/438" },
  },
  {
    key: "verifier",
    band: "Agents",
    label: "Verifier",
    value: "Certain · sent round 1 back",
    tone: "green",
    emphasis: "Certain",
    target: { kind: "session", sessionId: "verifier-2" },
  },
  {
    key: "cost",
    band: "Agents",
    label: "Agent cost",
    value: "$3.80",
    meter: { pct: 19, of: "of $20" },
    target: { kind: "sheet", sheet: "cost" },
  },
  {
    key: "earlier",
    band: "History",
    label: "Earlier incidents",
    value: "None like this",
    tone: "faint",
    target: null,
  },
];

const render = (list: DetailRow[], note: string | null = null) =>
  renderToStaticMarkup(
    <IncidentDetailsView rows={list} onRow={() => {}} workspaceNote={note} />,
  );

test("bands in order, rows with a target are buttons or links", () => {
  const html = render(rows);
  const fix = html.indexOf(">Fix<");
  const agents = html.indexOf(">Agents<");
  const history = html.indexOf(">History<");
  expect(fix).toBeGreaterThan(-1);
  expect(agents).toBeGreaterThan(fix);
  expect(history).toBeGreaterThan(agents);
  // The PR, verifier and cost rows; the note is a link.
  expect(html.match(/<button/g)?.length).toBe(3);
  expect(html).toContain('href="https://example.test/pr/438"');
  expect(html).toContain('rel="noreferrer"');
  expect(html).toContain("+84");
  expect(html).toContain("of $20");
  expect(html).toContain(">Certain<");
  expect(html).toContain("text-green");
});

test("a row without a target is no control and has no chevron", () => {
  const html = render([rows[4]!]);
  expect(html).not.toContain("<button");
  expect(html).not.toContain("<a ");
  // The rail glyph only.
  expect(html.match(/<svg/g)?.length).toBe(1);
  expect(html).toContain("None like this");
  const withTarget = render([rows[3]!]);
  // The rail glyph and the chevron.
  expect(withTarget.match(/<svg/g)?.length).toBe(2);
});

test("a long value wraps under its label on a phone", () => {
  const html = render([
    {
      key: "earlier",
      band: "History",
      label: "Earlier incidents",
      value: "x".repeat(300),
      target: { kind: "sheet", sheet: "earlier" },
    },
  ]);
  expect(html).toContain("truncate");
  expect(html).toContain("phone:basis-full");
  expect(render([rows[2]!])).not.toContain("phone:basis-full");
});

test("the workspace note sits under the Agents label", () => {
  const html = render(rows, "Runs on this server, not in a sandbox");
  const agents = html.indexOf(">Agents<");
  const note = html.indexOf("Runs on this server, not in a sandbox");
  expect(note).toBeGreaterThan(agents);
  expect(note).toBeLessThan(html.indexOf("Verifier"));
  expect(render(rows)).not.toContain("not in a sandbox");
});
