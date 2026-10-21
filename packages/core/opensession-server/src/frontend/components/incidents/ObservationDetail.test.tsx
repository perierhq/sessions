import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { StripBar } from "../../../shared/incidents";
import { ObservationDetail } from "./ObservationDetail";

const bar: StripBar = {
  start: "2026-10-20T11:20:00Z",
  end: "2026-10-20T11:22:00Z",
  result: "fail",
  count: 3,
  value: 412,
  sample: {
    at: "2026-10-20T11:21:00Z",
    result: "fail",
    detail: "HTTP 452 blocked",
    value: 412,
    sourceUrl: "https://acme.example.test/search",
  },
};

test("shows the observation with provenance", () => {
  const html = renderToStaticMarkup(
    <ObservationDetail
      bar={bar}
      laneLabel="Search"
      format={(v) => `${v} ms`}
    />,
  );
  expect(html).toContain("Failed");
  expect(html).toContain("HTTP 452 blocked");
  expect(html).toContain("412 ms");
  expect(html).toContain('href="https://acme.example.test/search"');
  expect(html).toContain('rel="noreferrer"');
  expect(html).toContain('target="_blank"');
});

test("never links a non-http source", () => {
  const sample = { ...bar.sample!, sourceUrl: "javascript:alert(1)" };
  const html = renderToStaticMarkup(
    <ObservationDetail
      bar={{ ...bar, sample }}
      laneLabel="Search"
      format={String}
    />,
  );
  expect(html).not.toContain("href=");
});

test("an empty bar says so", () => {
  expect(
    renderToStaticMarkup(
      <ObservationDetail
        bar={{ start: bar.start, end: bar.end, result: null, count: 0 }}
        laneLabel="Search"
        format={String}
      />,
    ),
  ).toContain("No data in this interval");
});

test("a long unbroken detail wraps", () => {
  const sample = { ...bar.sample!, detail: "x".repeat(400) };
  const html = renderToStaticMarkup(
    <ObservationDetail
      bar={{ ...bar, sample }}
      laneLabel="Search"
      format={String}
    />,
  );
  expect(html).toContain("overflow-wrap:anywhere");
});
