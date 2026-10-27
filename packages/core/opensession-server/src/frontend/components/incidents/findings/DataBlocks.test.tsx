import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  FindingBlock,
  SignalMarker,
  ToolRef,
} from "../../../../shared/findings";
import type { StripResponse } from "../../../../shared/incidents";
import { STRIP_NOTE_LINE } from "../../../lib/incident-classes";
import type { FindingItem } from "../../../lib/incidents/findings";
import type { StripLaneMeta } from "../../../lib/incidents/strip-layout";
import {
  stripSummary,
  windowStrip,
} from "../../../lib/incidents/strip-summary";
import { ChangeView, CompareBlock, SignalWindowView } from "./DataBlocks";

// Set after the imports on purpose: with a window at import time the theme
// module paints onto a document the test does not have. The strip asks
// matchMedia whether it is on a phone; MarkdownBody reads the stored theme.
Object.assign(globalThis, {
  localStorage: globalThis.localStorage ?? {
    getItem: () => "dark",
    setItem: () => {},
    removeItem: () => {},
  },
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

const FROM = Date.parse("2026-10-27T14:00:00Z");
const at = (min: number) => new Date(FROM + min * 60_000).toISOString();
const meta = (): StripLaneMeta => ({
  kind: "passfail",
  label: "Checkout",
  format: String,
});
const noop = () => {};

/** 18 checks, 3 failed, over one hour of one-minute buckets. */
function strip(): StripResponse {
  return {
    from: at(0),
    to: at(60),
    bucketMs: 60_000,
    lanes: [
      {
        id: "sig-a",
        signalId: "sig-a",
        label: "Checkout",
        bars: Array.from({ length: 6 }, (_, i) => ({
          start: at(i * 10),
          end: at(i * 10 + 1),
          result: i === 3 ? ("fail" as const) : ("ok" as const),
          count: 3,
          value: 120 + i * 100,
        })),
      },
    ],
    markers: [],
  };
}

const tool: ToolRef = {
  type: "tool",
  sessionId: "os-inv",
  useId: "call_1",
  resultId: "call_1-result",
  tool: "host_command",
  at: at(30),
  provenance: { kind: "host", label: "web-1" },
};

function item(block: FindingBlock): FindingItem {
  return {
    key: `investigator:${block.id}`,
    role: "investigator",
    block,
    span: block.size,
    byline: "from the investigator, 14:32",
  };
}

test("a signal window shows its summary and markers", () => {
  const s = strip();
  const html = renderToStaticMarkup(
    <SignalWindowView
      strip={s}
      error={false}
      onRetry={noop}
      markers={[{ at: at(25), label: "deploy" }]}
      title="Checkout"
      meta={meta}
    />,
  );
  const summary = stripSummary(windowStrip(s));
  expect(summary).toContain("18 checks, 3 failed");
  expect(html).toContain(summary);
  expect(html).toContain(">deploy<");
  expect(html).not.toContain("Couldn&#x27;t load the signal");
});

test("a marker without a checked ref is called the agent's note", () => {
  const view = (markers: SignalMarker[]) =>
    renderToStaticMarkup(
      <SignalWindowView
        strip={strip()}
        error={false}
        onRetry={noop}
        markers={markers}
        title="Checkout"
        meta={meta}
      />,
    );
  const checked: SignalMarker = {
    at: at(25),
    label: "release",
    ref: { type: "release", at: at(25), ref: "abc1234" },
  };
  const NOTES = "Dashed markers are the agent&#x27;s notes, not checked data.";
  expect(view([checked])).not.toContain(NOTES);
  const both = view([checked, { at: at(30), label: "guess" }]);
  expect(both).toContain(NOTES);
  expect(both).toContain(STRIP_NOTE_LINE);
});

test("a signal window that failed to load offers a retry", () => {
  const html = renderToStaticMarkup(
    <SignalWindowView
      strip={undefined}
      error
      onRetry={noop}
      markers={[]}
      title="Checkout"
      meta={meta}
    />,
  );
  expect(html).toContain("Couldn&#x27;t load the signal");
  expect(html).toContain("Try again");
});

test("compare labels both sides", () => {
  const side = (label: string, line: string) => ({
    label,
    log: { source: tool, lines: [line], highlight: [], dropped: 0 },
  });
  const html = renderToStaticMarkup(
    <CompareBlock
      item={item({
        id: "before-after",
        kind: "compare",
        size: "full",
        sides: [
          side("before deploy", "GET /api/checkout 200 in 120ms"),
          side("after", "GET /api/checkout 503 in 980ms"),
        ],
      })}
      meta={meta}
      signalName={() => "Checkout"}
    />,
  );
  const before = html.indexOf("before deploy");
  const after = html.indexOf(">after<");
  expect(before).toBeGreaterThan(-1);
  expect(after).toBeGreaterThan(before);
  expect(html).toContain("GET /api/checkout 503 in 980ms");
});

test("a commit change shows its title, why and link", () => {
  const url = "https://github.com/acme/web/commit/abc";
  const html = renderToStaticMarkup(
    <ChangeView
      title="abc1234 · Drop the search replica from the pool"
      patch={
        "diff --git a/db.ts b/db.ts\n--- a/db.ts\n+++ b/db.ts\n@@ -1 +1 @@\n-replicas: 2\n+replicas: 1"
      }
      kind="commit"
      why="The **pool** lost its only replica here."
      url={url}
      error={false}
      onRetry={noop}
    />,
  );
  expect(html).toContain("abc1234 · Drop the search replica from the pool");
  expect(html).toContain("<strong>pool</strong>");
  expect(html).toContain(`href="${url}"`);
  expect(html).toContain("+replicas: 1");
  expect(html).not.toContain("<button");
});

test("a change that failed to load offers a retry", () => {
  const html = renderToStaticMarkup(
    <ChangeView
      title={null}
      patch={null}
      kind="pr"
      why=""
      error
      onRetry={noop}
    />,
  );
  expect(html).toContain("Couldn&#x27;t load the change");
  expect(html).toContain("Try again");
});
