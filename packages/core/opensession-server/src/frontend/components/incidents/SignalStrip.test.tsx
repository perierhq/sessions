import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { StripResponse } from "../../../shared/incidents";
import { STRIP_LANE, STRIP_LANES_SCROLL } from "../../lib/incident-classes";
import { layoutStrip, liveLineText } from "../../lib/incidents/strip-layout";
import { clockTime } from "../../lib/time";

Object.assign(globalThis, {
  window: {
    addEventListener: () => {},
    removeEventListener: () => {},
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  },
});

const { SignalStrip, SignalStripView } = await import("./SignalStrip");

const T = Date.parse("2026-10-20T12:31:00Z");
const iso = (msAgo: number) => new Date(T - msAgo).toISOString();

function fixtureStrip(): StripResponse {
  const n = 60;
  return {
    from: iso(n * 60_000),
    to: iso(0),
    bucketMs: 60_000,
    lanes: [
      {
        id: "sig-a",
        signalId: "sig-a",
        label: "Search",
        bars: Array.from({ length: n }, (_, i) => ({
          start: iso((n - i) * 60_000),
          end: iso((n - i - 1) * 60_000),
          result: i >= 20 ? "fail" : "ok",
          count: 1,
        })),
      },
    ],
    markers: [
      {
        at: iso(40 * 60_000),
        kind: "detected",
        label: "Detected",
        incidentId: "inc-1",
      },
    ],
  };
}

const noop = () => {};

test("renders lanes, markers and the live line", () => {
  const layout = layoutStrip({
    strip: fixtureStrip(),
    meta: () => ({ kind: "passfail", label: "Search", format: String }),
    width: 720,
    live: true,
    future: [
      { at: new Date(Date.now() + 300_000).toISOString(), label: "Deploys" },
    ],
  });
  const html = renderToStaticMarkup(
    <SignalStripView
      layout={layout}
      title="Search · Check · every 2 min"
      live={{ tone: "red", text: "Live · next run in 48 s" }}
      onOpen={noop}
      activeIndex={null}
      onActiveIndexChange={noop}
    />,
  );
  expect(html).toContain("Search · Check · every 2 min");
  expect(html).toContain("Live · next run in 48 s");
  expect(html).toContain("Detected");
  expect(html).toContain("Deploys");
  expect(html).toContain('role="group"');
  expect(html.match(/tabindex="0"/g)).toHaveLength(1);
});

test("an active bar shows its tooltip", () => {
  const layout = layoutStrip({
    strip: fixtureStrip(),
    meta: () => ({ kind: "passfail", label: "Search", format: String }),
    width: 720,
    live: false,
  });
  const html = renderToStaticMarkup(
    <SignalStripView
      layout={layout}
      title="Search"
      live={null}
      onOpen={noop}
      activeIndex={30}
      onActiveIndexChange={noop}
    />,
  );
  expect(html).toContain("Failed");
});

test("24 component lanes scroll after eight", () => {
  const s = fixtureStrip();
  s.lanes = [
    s.lanes[0],
    ...Array.from({ length: 24 }, (_, i) => ({
      ...s.lanes[0],
      id: `sig-a:c${i}`,
      lane: `c${i}`,
      label: `Component ${i}`,
    })),
  ];
  const layout = layoutStrip({
    strip: s,
    meta: (l) => ({ kind: "passfail", label: l.label, format: String }),
    width: 720,
    live: false,
  });
  const html = renderToStaticMarkup(
    <SignalStripView
      layout={layout}
      title="Status"
      live={null}
      onOpen={noop}
      activeIndex={null}
      onActiveIndexChange={noop}
    />,
  );
  expect(html).toContain("Component 23");
  expect(html).toContain(STRIP_LANES_SCROLL.split(" ")[0]);
  expect(html.match(/tabindex="0"/g)).toHaveLength(1);
});

test("a few lanes do not scroll", () => {
  const layout = layoutStrip({
    strip: fixtureStrip(),
    meta: () => ({ kind: "passfail", label: "Search", format: String }),
    width: 720,
    live: false,
  });
  const html = renderToStaticMarkup(
    <SignalStripView
      layout={layout}
      title="Search"
      live={null}
      onOpen={noop}
      activeIndex={null}
      onActiveIndexChange={noop}
    />,
  );
  expect(html).not.toContain(STRIP_LANES_SCROLL.split(" ")[0]);
});

test("the loading strip keeps its final height", () => {
  const html = renderToStaticMarkup(
    <SignalStrip
      strip={undefined}
      meta={() => ({ kind: "passfail", label: "x", format: String })}
      live
      title="Search"
      liveLine={null}
    />,
  );
  expect(html).toContain(STRIP_LANE.split(" ")[0]);
  expect(html).toContain("Search");
});

test("live line copy", () => {
  const now = Date.parse("2026-10-20T12:31:00Z");
  expect(
    liveLineText({ kind: "http", nextRunAt: "2026-10-20T12:31:48Z", now }),
  ).toBe("Live · next run in 48 s");
  expect(
    liveLineText({ kind: "http", nextRunAt: "2026-10-20T12:34:10Z", now }),
  ).toBe("Live · next run in 3 min");
  expect(
    liveLineText({ kind: "http", nextRunAt: "2026-10-20T12:30:00Z", now }),
  ).toBe("Live · next run now");
  expect(
    liveLineText({ kind: "http", closedAt: "2026-10-20T12:00:00Z", now }),
  ).toBe(`Ended ${clockTime("2026-10-20T12:00:00Z")}`);
  expect(
    liveLineText({
      kind: "heartbeat",
      lastCheckIn: "2026-10-20T03:00:00Z",
      now,
    }),
  ).toBe(`Live · last check-in ${clockTime("2026-10-20T03:00:00Z")}`);
  const webhook = fixtureStrip();
  expect(liveLineText({ kind: "webhook", strip: webhook, now })).toBe(
    "Live · 40 in the last hour",
  );
});
