import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { JsonMapping } from "../../../../shared/incidents";

Object.assign(globalThis, {
  window: {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  },
  localStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
  document: {
    documentElement: { dataset: {}, style: { colorScheme: "" } },
    querySelector: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: "visible",
  },
});

const { JsonMappingPreview } = await import("./JsonMappingPreview");

const doc = {
  status: { indicator: "minor", description: "Partly degraded" },
  components: [
    { name: "API", status: "operational" },
    { name: "Search", status: "major_outage" },
  ],
};
const http = { kind: "http" as const, url: "https://status.example.test/s" };

function render(
  props: Partial<React.ComponentProps<typeof JsonMappingPreview>> & {
    mapping: JsonMapping | undefined;
  },
) {
  return renderToStaticMarkup(
    <JsonMappingPreview
      kind="http"
      source={http}
      onChange={() => {}}
      sample={undefined}
      onSample={() => {}}
      {...props}
    />,
  );
}

test("statuspage over a sample: result, lanes, what each path found", () => {
  const html = render({ mapping: { preset: "statuspage" }, sample: doc });
  expect(html).toContain("Failing");
  expect(html).toContain("API");
  expect(html).toContain("Search");
  expect(html).toContain("Passing");
  expect(html).toContain("What each path found");
  expect(html).toContain("$.status.indicator");
  expect(html).toContain("Partly degraded");
  // Preset values are placeholders, not typed values.
  expect(html).toContain('placeholder="$.status.indicator"');
});

test("the Format select names the preset", () => {
  const html = render({ mapping: { preset: "statuspage" } });
  expect(html).toContain("Atlassian Statuspage (summary.json)");
});

test("http without a sample offers a fetch; webhook a payload box", () => {
  expect(render({ mapping: { preset: "plain" } })).toContain("Fetch a sample");
  expect(render({ mapping: { preset: "plain" }, source: null })).toContain(
    "Enter a URL first",
  );
  const webhook = render({
    kind: "webhook",
    source: { kind: "webhook" },
    mapping: { preset: "plain" },
  });
  expect(webhook).toContain("Sample payload");
  expect(webhook).toContain("<textarea");
  expect(webhook).toContain("phone:text-input-phone");
});

test("no mapping: only the format", () => {
  const html = render({ mapping: undefined, sample: doc });
  expect(html).toContain("No mapping");
  expect(html).not.toContain("Status path");
  expect(html).not.toContain("What each path found");
});

test("a bad path shows under its field", () => {
  const html = render({
    mapping: { result: { path: "$[", ok: ["up"] } },
    sample: doc,
  });
  expect(html).toContain("Unexpected");
  expect(html).not.toContain("result.path");
  expect(html).toContain('aria-invalid="true"');
});
