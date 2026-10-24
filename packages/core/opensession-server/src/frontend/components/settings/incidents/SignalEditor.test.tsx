import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SignalView } from "../../../../shared/incidents";
import {
  defaultDraft,
  draftFromSignal,
  REDACTED,
  type SignalDraft,
} from "../../../lib/incidents/signal-form";

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

const { SignalEditorFields } = await import("./SignalEditor");
const { SignalsList } = await import("./SignalsSection");

function fields(
  draft: SignalDraft,
  error: { field: "url"; error: string } | null = null,
) {
  return renderToStaticMarkup(
    <SignalEditorFields
      draft={draft}
      onChange={() => {}}
      error={error}
      idFor={(field) => `sig-${field}`}
      runners={[]}
      others={[]}
    />,
  );
}

/** A stored signal with only the fields a test sets. */
function view(fields: Partial<SignalView>): SignalView {
  // SAFETY: the editor reads only the signal fields each test passes.
  return fields as SignalView;
}

const stored = view({
  id: "sig-a",
  name: "Search",
  project: "acme",
  enabled: true,
  severity: "major",
  rule: { kind: "consecutive", failures: 3, recoveries: 2 },
  intervalMs: 60_000,
  source: {
    kind: "http",
    url: "https://acme.example.test/q",
    headers: { Authorization: REDACTED },
  },
  evaluation: null,
});

test("a stored secret header stays hidden", () => {
  const html = fields(draftFromSignal(stored));
  expect(html).toContain('placeholder="Saved and hidden"');
  expect(html).toContain('type="password"');
  expect(html).not.toContain(REDACTED);
});

test("webhook URL: after the first save, with Copy", () => {
  const draft = { ...defaultDraft("webhook", "acme"), name: "Errors" };
  expect(fields(draft)).toContain("Save to get the URL");
  const saved = fields({
    ...draft,
    id: "sig-w",
    hookPath: "/incident-hooks/sig-w/s3cret",
  });
  expect(saved).toContain("/incident-hooks/sig-w/s3cret");
  expect(saved).toContain(">Copy<");
  expect(saved).not.toContain("Save to get the URL");
});

test("a heartbeat offers its failure URL once saved", () => {
  const html = fields({
    ...defaultDraft("heartbeat", "acme"),
    id: "sig-h",
    hookPath: "/incident-hooks/sig-h/s3cret",
  });
  expect(html).toContain("/incident-hooks/sig-h/s3cret/fail");
  expect(html).toContain("Call this to report a failure");
});

test("rule kinds: a choice for http, none for a heartbeat", () => {
  const http = fields(defaultDraft("http", "acme"));
  expect(http).toContain('aria-label="When to open an incident"');
  expect(http).toContain("In a row");
  expect(http).toContain("Threshold");
  const heartbeat = fields(defaultDraft("heartbeat", "acme"));
  expect(heartbeat).not.toContain('aria-label="When to open an incident"');
  expect(heartbeat).not.toContain("Threshold");
});

test("every text input is 16px on a phone", () => {
  for (const kind of ["http", "webhook", "heartbeat", "expiry"] as const) {
    const html = fields({
      ...defaultDraft(kind, "acme"),
      headers: [{ name: "Accept", value: "text/plain" }],
    });
    const inputs = html.match(/<input[^>]*>/g) ?? [];
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
      if (
        /type="(checkbox|hidden)"/.test(input) ||
        input.includes('aria-hidden="true"')
      )
        continue;
      expect(input).toContain("phone:text-input-phone");
    }
  }
});

test("a field error sits under its field and is described by it", () => {
  const html = fields(defaultDraft("http", "acme"), {
    field: "url",
    error: "Use an http or https URL",
  });
  expect(html).toContain('id="sig-url-message"');
  expect(html).toContain('aria-describedby="sig-url-message"');
  expect(html).toContain("Use an http or https URL");
});

test("the list: rows by signal, or an empty state that adds one", () => {
  const list = renderToStaticMarkup(
    <SignalsList
      project="acme"
      signals={[stored]}
      error={null}
      onRetry={() => {}}
      onOpen={() => {}}
    />,
  );
  expect(list).toContain("Search");
  expect(list).toContain("Check · every minute · 3 failures in a row");
  expect(list).toContain(">No data<");
  const empty = renderToStaticMarkup(
    <SignalsList
      project="acme"
      signals={[]}
      error={null}
      onRetry={() => {}}
      onOpen={() => {}}
    />,
  );
  expect(empty).toContain("No signals for acme yet");
  expect(empty).toContain("Add a signal");
});
