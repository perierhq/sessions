import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { HiddenListEntry } from "../../lib/hidden-list";
import { HiddenEntry } from "./HiddenEntry";

const entry = (key: string): HiddenListEntry => ({
  kind: "row",
  key,
  hiddenAt: "2026-08-01T10:00:00.000Z",
  title: `Title ${key}`,
  repo: "acme/web",
  sessionId: `session-${key}`,
});

const render = (entries: HiddenListEntry[], isPhone: boolean) =>
  renderToStaticMarkup(
    <HiddenEntry
      entries={entries}
      isPhone={isPhone}
      onOpenEntry={() => {}}
      onRestore={() => {}}
    />,
  );

test("nothing renders while nothing is hidden", () => {
  expect(render([], false)).toBe("");
  expect(render([], true)).toBe("");
});

test("the row names itself and its count for screen readers", () => {
  for (const isPhone of [false, true]) {
    const html = render([entry("a"), entry("b")], isPhone);
    expect(html).toContain(">Hidden<");
    expect(html).toContain(">2<");
    expect(html).toContain('aria-label="Hidden, 2 items"');
  }
  expect(render([entry("a")], false)).toContain('aria-label="Hidden, 1 item"');
});
