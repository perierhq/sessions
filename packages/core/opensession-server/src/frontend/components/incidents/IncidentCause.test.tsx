import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { IncidentCause } from "./IncidentCause";

const cause = {
  text: "The upstream wants the app's own user agent",
  source: {
    label: "example.test/acme/db-info",
    url: "https://example.test/acme/db-info/issues/3",
  },
  status: "verified" as const,
};

test("sentence, source and verification", () => {
  const html = renderToStaticMarkup(
    <IncidentCause cause={cause} waiting={false} />,
  );
  expect(html).toContain("Cause");
  expect(html).toContain(
    "<p>The upstream wants the app&#39;s own user agent</p>",
  );
  expect(html).toContain('href="https://example.test/acme/db-info/issues/3"');
  expect(html).toContain('rel="noreferrer"');
  expect(html).toContain(
    "example.test/acme/db-info</a> · verified by the verifier",
  );
});

test("doubt and no verification yet are said in words, in sentence case when they lead", () => {
  expect(
    renderToStaticMarkup(
      <IncidentCause cause={{ ...cause, status: "doubted" }} waiting={false} />,
    ),
  ).toContain("· the verifier is not certain");
  const html = renderToStaticMarkup(
    <IncidentCause
      cause={{ text: "x", status: "unverified" }}
      waiting={false}
    />,
  );
  expect(html).toContain(">Not verified yet</p>");
  expect(html).toContain('class="m-0 text-meta text-dim');
});

test("the cause reads as Markdown: a sentence, then detail lines with inline code", () => {
  const html = renderToStaticMarkup(
    <IncidentCause
      cause={{
        text: "Requests to acme time out because the pool is full.\n\n- `slowP95Ms` is 6000\n- see example.test",
        status: "unverified",
      }}
      waiting={false}
    />,
  );
  expect(html).toContain(
    "<p>Requests to acme time out because the pool is full.</p>",
  );
  expect(html).toContain("<code>slowP95Ms</code>");
  expect(html).toContain("<li>");
  expect(html).toContain("markdown");
});

test("raw HTML in the cause stays text", () => {
  const html = renderToStaticMarkup(
    <IncidentCause
      cause={{ text: '<img src=x onerror="alert(1)">', status: "unverified" }}
      waiting={false}
    />,
  );
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;img");
});

test("an unbroken URL in the sentence wraps", () => {
  const html = renderToStaticMarkup(
    <IncidentCause
      cause={{ ...cause, text: `See https://example.test/${"a".repeat(200)}` }}
      waiting={false}
    />,
  );
  expect(html).toContain("[overflow-wrap:anywhere]");
});

test("the slot is kept while agents work, absent otherwise", () => {
  expect(
    renderToStaticMarkup(<IncidentCause cause={null} waiting />),
  ).toContain("Not known yet");
  expect(
    renderToStaticMarkup(<IncidentCause cause={null} waiting={false} />),
  ).toBe("");
});
