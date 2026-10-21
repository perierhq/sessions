import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DOT_BG } from "../../lib/incidents/tone";
import { StatusLine } from "./StatusLine";

test("status line: dot, headline, facts", () => {
  const html = renderToStaticMarkup(
    <StatusLine
      tone="red"
      pulse={false}
      headline="Search is down"
      facts={["since 10:41", "from Search"]}
      level="page"
    />,
  );
  expect(html).toContain("<h1");
  expect(html).toContain("Search is down");
  expect(html).toContain("since 10:41 · from Search");
  expect(html).toContain(DOT_BG.red);
  expect(html).toContain('aria-hidden="true"');
});

test("pulse only when asked", () => {
  expect(
    renderToStaticMarkup(
      <StatusLine tone="yellow" pulse headline="x" facts={[]} level="page" />,
    ),
  ).toContain("animate-[pulse");
  expect(
    renderToStaticMarkup(
      <StatusLine
        tone="yellow"
        pulse={false}
        headline="x"
        facts={[]}
        level="page"
      />,
    ),
  ).not.toContain("animate-[pulse");
});

test("a 200-character title wraps instead of overflowing", () => {
  expect(
    renderToStaticMarkup(
      <StatusLine
        tone="red"
        pulse={false}
        headline={"検索".repeat(100)}
        facts={[]}
        level="page"
      />,
    ),
  ).toContain("overflow-wrap:anywhere");
});

test("no facts, no empty line", () => {
  expect(
    renderToStaticMarkup(
      <StatusLine
        tone="green"
        pulse={false}
        headline="x"
        facts={[]}
        level="home"
      />,
    ),
  ).not.toContain("<p");
});

test("home renders its sentence as is", () => {
  const html = renderToStaticMarkup(
    <StatusLine
      tone="yellow"
      pulse={false}
      headline="1 green, 1 flaky"
      facts={["Webhook: failing on and off"]}
      level="home"
    />,
  );
  expect(html).toContain("Webhook: failing on and off");
});
