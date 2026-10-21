import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RunLedger, type RunLedgerEntry } from "./RunLedger";

const at = new Date(Date.now() - 5 * 60_000).toISOString();
const render = (entries: RunLedgerEntry[]) =>
  renderToStaticMarkup(
    <RunLedger entries={entries} onOpenSession={() => undefined} />,
  );

test("an error entry shows its error and the red mark", () => {
  const html = render([
    {
      key: "a",
      status: "error",
      at,
      meta: ["via cron"],
      error: "Deploy failed: exit 1",
    },
  ]);
  expect(html).toContain("Deploy failed: exit 1");
  expect(html).toContain("text-red");
  expect(html).toContain("✗");
});

test("a running entry renders no action", () => {
  const html = render([
    {
      key: "a",
      status: "running",
      at,
      meta: [],
      action: { label: "retrigger", title: "Run again", onClick: () => {} },
    },
  ]);
  expect(html).not.toContain("retrigger");
  expect(html).toContain("text-yellow");
});

test("meta in order, and a finished entry's action", () => {
  const html = render([
    {
      key: "a",
      status: "ok",
      at,
      meta: ["via webhook", "12m"],
      action: { label: "retrigger", title: "Run again", onClick: () => {} },
    },
  ]);
  expect(html.indexOf("via webhook")).toBeLessThan(html.indexOf("12m"));
  expect(html).toContain("retrigger");
  expect(html).toContain('title="Run again"');
});

test("a session links to its page", () => {
  const html = render([
    { key: "a", status: "ok", at, meta: [], sessionId: "os-123" },
  ]);
  expect(html).toContain('href="/session/os-123"');
});
