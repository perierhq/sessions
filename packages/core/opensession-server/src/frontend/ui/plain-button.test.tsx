import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PlainButton } from "./plain-button";

test("a plain button is a focusable button that the caller lays out", () => {
  const html = renderToStaticMarkup(
    <PlainButton className="flex px-2" disabled>
      Row
    </PlainButton>,
  );
  expect(html).toContain('type="button"');
  expect(html).toContain("focus-ring");
  expect(html).toContain("disabled");
  expect(html).toContain("px-2");
});

test("a submit button stays a submit button", () => {
  expect(
    renderToStaticMarkup(<PlainButton type="submit">Go</PlainButton>),
  ).toContain('type="submit"');
});
