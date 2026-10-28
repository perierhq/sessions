import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ShellCard } from "../../../lib/incidents/next-action";

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
    getItem: () => "dark",
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

const { NextActionView } = await import("../NextAction");
const { LikelyCause, NextFindingsView } = await import("./NextFindings");

const card: ShellCard = {
  mode: "shell",
  tone: "blue",
  pulse: false,
  eyebrow: "Next · Needs you",
  headline: "The problem stopped before the fix could be proven",
  body: "",
  buttons: [
    {
      key: "send-back",
      kind: "decision",
      decision: "send-back",
      label: "Send it back",
      weight: "primary",
    },
  ],
};

test("the agents' open question sits in the Next card, above its buttons", () => {
  const html = renderToStaticMarkup(
    <NextActionView
      card={card}
      busy={null}
      onButton={() => {}}
      context={
        <NextFindingsView
          findings={{
            cause: null,
            asks: [
              {
                key: "investigator:billing",
                text: "Who restores billing for acme?",
                wouldAnswer: "The owner fixing billing, then a CI re-run.",
              },
            ],
          }}
        />
      }
    />,
  );
  const ask = html.indexOf("Who restores billing for acme?");
  expect(html.indexOf("The problem stopped")).toBeLessThan(ask);
  expect(ask).toBeGreaterThan(-1);
  expect(ask).toBeLessThan(html.indexOf("Send it back"));
  expect(html).toContain("Open question");

  expect(html).toContain("What would answer it: The owner fixing billing");
});

test("without questions the card shows nothing extra", () => {
  expect(
    renderToStaticMarkup(
      <NextFindingsView findings={{ cause: null, asks: [] }} />,
    ),
  ).toBe("");
});

test("the likely cause: one sentence, its status as a mark, the confidence", () => {
  const html = renderToStaticMarkup(
    <LikelyCause
      cause={{
        key: "investigator:pool",
        statement: "The acme pool is too small.",
        status: "refuted",
        confidence: "high",
      }}
    />,
  );
  expect(html).toContain("Likely cause");
  expect(html).toContain("The acme pool is too small.");
  expect(html).toMatch(
    /rounded-full bg-red[^"]*"><\/span><span class="[^"]*text-red[^"]*">Refuted</,
  );
  expect(html).toContain("high confidence");
  expect(html).toContain("See findings");
});
