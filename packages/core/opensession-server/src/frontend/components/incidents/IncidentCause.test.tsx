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
  expect(html).toContain("The upstream wants the app&#x27;s own user agent");
  expect(html).toContain('href="https://example.test/acme/db-info/issues/3"');
  expect(html).toContain('rel="noreferrer"');
  expect(html).toContain(
    "example.test/acme/db-info</a> · verified by the verifier",
  );
});

test("doubt and no verification yet are said in words", () => {
  expect(
    renderToStaticMarkup(
      <IncidentCause cause={{ ...cause, status: "doubted" }} waiting={false} />,
    ),
  ).toContain("the verifier is not certain");
  expect(
    renderToStaticMarkup(
      <IncidentCause
        cause={{ text: "x", status: "unverified" }}
        waiting={false}
      />,
    ),
  ).toContain("not verified yet");
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
