import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { usageTone } from "../lib/usage-tone";
import { Meter, MeterTrack } from "./meter";

test("usage tones", () => {
  expect(usageTone(null)).toBe("unknown");
  expect(usageTone(95)).toBe("high");
  expect(usageTone(90)).toBe("high");
  expect(usageTone(75)).toBe("warn");
  expect(usageTone(10)).toBe("normal");
});

test("the track clamps its fill", () => {
  expect(renderToStaticMarkup(<MeterTrack pct={150} />)).toContain(
    "width:100%",
  );
  expect(renderToStaticMarkup(<MeterTrack pct={-3} />)).toContain("width:0%");
  expect(renderToStaticMarkup(<MeterTrack pct={null} />)).toContain("bg-line");
  expect(renderToStaticMarkup(<MeterTrack pct={95} />)).toContain("bg-red");
});

test("a meter is its label, value, track and note", () => {
  const html = renderToStaticMarkup(
    <Meter label="5h" pct={42} value="42%" note="resets in 3h" />,
  );
  expect(html).toContain(">5h</span>");
  expect(html).toContain(">42%</span>");
  expect(html).toContain("resets in 3h");
  expect(html).toContain("width:42%");
});
