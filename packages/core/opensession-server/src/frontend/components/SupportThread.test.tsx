// The frame both support channels share: the identity in the bar and at the
// top of the thread, the column's room for the rail, and the session pill.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SupportSessionPill,
  SupportThreadBody,
  SupportThreadHeader,
} from "./SupportThread";
import type { UnifiedSession } from "../lib/types";

const identity = {
  subject: "Login broken",
  customerName: "Grace",
  customerEmail: "grace@example.test",
};

test("in the bar the badge leads and the subject sits over the customer", () => {
  const html = renderToStaticMarkup(
    <SupportThreadHeader
      placement="bar"
      {...identity}
      badge={<i>Todo</i>}
      meta={<b>Acme help · acme</b>}
      actions={<u>Done</u>}
    />,
  );
  expect(html).toMatch(
    /<i>Todo<\/i>.*<h2[^>]*>Login broken<\/h2>.*Grace.*·.*grace@example\.test.*<b>Acme help · acme<\/b><u>Done<\/u>/,
  );
});

test("the bar names a missing subject and falls back to the address", () => {
  const html = renderToStaticMarkup(
    <SupportThreadHeader
      placement="bar"
      subject={null}
      customerName=""
      customerEmail="grace@example.test"
    />,
  );
  expect(html).toContain(">No subject</h2>");
  expect(html).toContain("grace@example.test");
  expect(html).not.toContain("·");
});

test("at the top of the thread a missing subject shows only with a fallback", () => {
  const bare = renderToStaticMarkup(
    <SupportThreadHeader placement="inline" {...identity} subject="" />,
  );
  expect(bare).not.toContain("No subject");
  const email = renderToStaticMarkup(
    <SupportThreadHeader
      placement="inline"
      {...identity}
      subject=""
      subjectFallback="No subject"
      meta={<b>chip</b>}
    />,
  );
  expect(email).toContain("No subject");
  expect(email).toContain("<b>chip</b>");
  expect(email).not.toContain("<h2");
});

test("the column clears the rail only when there is one", () => {
  const withRail = renderToStaticMarkup(
    <SupportThreadBody inBar rail={<span>pill</span>}>
      thread
    </SupportThreadBody>,
  );
  expect(withRail).toContain("pt-12");
  expect(withRail).toContain("<span>pill</span>");
  expect(
    renderToStaticMarkup(<SupportThreadBody inBar>thread</SupportThreadBody>),
  ).toContain("pt-1");
  expect(
    renderToStaticMarkup(
      <SupportThreadBody inBar={false}>thread</SupportThreadBody>,
    ),
  ).toContain("pt-6");
});

test("the session pill names its destination when nothing is running", () => {
  const pill = (session: UnifiedSession | null) =>
    renderToStaticMarkup(
      <SupportSessionPill
        sessionId="s1"
        session={session}
        tooltip="Open the support agent's session"
        onOpenSession={() => {}}
      />,
    );
  expect(pill(null)).toContain('aria-label="Open session"');
});
