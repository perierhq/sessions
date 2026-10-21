import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { formatCountdown } from "../lib/countdown";
import { CountdownDigits } from "./countdown";

test("formats", () => {
  expect(formatCountdown(5, "seconds")).toBe("5");
  expect(formatCountdown(348, "clock")).toBe("5:48");
  expect(formatCountdown(7, "clock")).toBe("0:07");
  expect(formatCountdown(3660, "clock")).toBe("61:00");
  expect(formatCountdown(-3, "clock")).toBe("0:00");
});

test("renders the time left in a fixed-width slot", () => {
  const html = renderToStaticMarkup(
    <CountdownDigits deadline={Date.now() + 347_500} format="clock" />,
  );
  expect(html).toContain("5:48");
  expect(html).toContain("tabular-nums");
  expect(html).toContain("width:4ch");
});

test("the slot is as wide as the longest value this deadline shows", () => {
  const html = renderToStaticMarkup(
    <CountdownDigits deadline={Date.now() + 600_500} format="clock" />,
  );
  expect(html).toContain("10:01");
  expect(html).toContain("width:5ch");
});
