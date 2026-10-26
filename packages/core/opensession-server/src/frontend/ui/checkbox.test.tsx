import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Checkbox } from "./checkbox";

test("an indeterminate box keeps the fill and draws the dash, not the tick", () => {
  const html = renderToStaticMarkup(<Checkbox indeterminate checked={false} />);
  expect(html).toContain("data-indeterminate");
  expect(html).not.toContain("data-checked");
  expect(html).toContain("data-[indeterminate]:bg-accent-control");
  expect(html).toContain('d="M3 6h6"');
  expect(html).toContain("group-data-[indeterminate]:hidden");
});

test("a checked box draws the tick and hides the dash", () => {
  const html = renderToStaticMarkup(<Checkbox checked />);
  expect(html).toContain("data-checked");
  expect(html).not.toContain("data-indeterminate");
  expect(html).toContain('d="M2.4 6.3 4.7 8.6 9.6 3.5"');
  expect(html).toContain("hidden group-data-[indeterminate]:block");
});
