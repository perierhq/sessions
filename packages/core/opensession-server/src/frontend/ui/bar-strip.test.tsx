import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BarStrip, type BarSpec, type BarTone } from "./bar-strip";

const bars = (tones: BarTone[]): BarSpec[] =>
  tones.map((tone, i) => ({
    key: String(i),
    tone,
    height: tone === "empty" ? 0 : 0.5,
    label: `bar ${i}`,
  }));

test("lays bars out across the given width with the gap", () => {
  const html = renderToStaticMarkup(
    <BarStrip
      bars={bars(["ok", "fail"])}
      width={100}
      height={20}
      ariaLabel="Search"
    />,
  );
  expect(html).toContain('aria-label="Search"');
  expect(html).toContain('x="0"');
  expect(html).toContain('x="50"');
  expect(html).toContain('width="48"');
  expect(html).toContain("var(--red)");
  expect(html).toContain("var(--green)");
  expect(html).toContain('height="10"');
});

test("empty is a stub, missed and future are hollow, none draws nothing", () => {
  const html = renderToStaticMarkup(
    <BarStrip
      bars={bars(["empty", "missed", "future", "none"])}
      width={120}
      height={20}
      ariaLabel="x"
    />,
  );
  expect(html).toContain('height="2"');
  expect(html).toMatch(/fill="none"[^>]*stroke="var\(--red\)"/);
  expect(html).toContain("stroke-dasharray");
  expect(html).not.toContain("<title>bar 3</title>");
});

test("threshold and labels", () => {
  const html = renderToStaticMarkup(
    <BarStrip
      bars={bars(["warn"])}
      width={10}
      height={20}
      threshold={0.25}
      ariaLabel="x"
    />,
  );
  expect(html).toContain("<title>bar 0</title>");
  expect(html).toMatch(/y1="15"/);
});

test("radius clamps to half the bar width; baseline adds a pixel", () => {
  const html = renderToStaticMarkup(
    <BarStrip
      bars={bars(["ok", "ok", "ok", "ok"])}
      width={16}
      height={20}
      radius={3}
      baseline
      ariaLabel="x"
    />,
  );
  expect(html).toContain('rx="1"');
  expect(html).toContain('height="21"');
});

test("no raw colours", () => {
  const html = renderToStaticMarkup(
    <BarStrip
      bars={bars([
        "ok",
        "fail",
        "warn",
        "neutral",
        "empty",
        "missed",
        "future",
      ])}
      width={70}
      height={20}
      activeIndex={1}
      ariaLabel="x"
    />,
  );
  expect(html).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  expect(html).toContain("var(--border-strong)");
});
