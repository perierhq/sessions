import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ASK_CARD_PLATE } from "../../lib/ask-card-classes";
import type { CardButton, ShellCard } from "../../lib/incidents/next-action";

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

const { NextActionView } = await import("./NextAction");

const card = (
  buttons: CardButton[],
  over: Partial<ShellCard> = {},
): ShellCard => ({
  mode: "shell",
  tone: "yellow",
  pulse: false,
  eyebrow: "Next · deploys at 12:37",
  headline: "Deploys the fix at 12:37",
  body: "b",
  footnote: "f",
  buttons,
  ...over,
});
const noop = () => {};

test("veto shell: plate without border, countdown in the Stop button", () => {
  const html = renderToStaticMarkup(
    <NextActionView
      card={card([
        {
          key: "stop",
          kind: "stop",
          label: "Stop",
          weight: "danger",
          decision: "stop",
          countdownTo: new Date(Date.now() + 347_500).toISOString(),
        },
        {
          key: "now",
          kind: "deploy-now",
          label: "Deploy now",
          weight: "soft",
          decision: "deploy-now",
        },
      ])}
      busy={null}
      onButton={noop}
    />,
  );
  expect(html).toContain("bg-raised");
  expect(ASK_CARD_PLATE).not.toContain("border");
  expect(html.indexOf("Deploy now")).toBeLessThan(html.indexOf("Stop"));
  expect(html).toContain("5:48");
  expect(html).toContain('aria-label="Stop, 5:48 left"');
  expect(html).toContain("bg-red-soft");
  expect(html).not.toContain("What the agents did");
});

test("a past deadline renders the deploying state", () => {
  const html = renderToStaticMarkup(
    <NextActionView
      card={card([
        {
          key: "stop",
          kind: "stop",
          label: "Stop",
          weight: "danger",
          decision: "stop",
          countdownTo: new Date(Date.now() - 1000).toISOString(),
          doneLabel: "Deploying",
        },
      ])}
      busy={null}
      onButton={noop}
    />,
  );
  expect(html).toContain("Deploying");
  expect(html).toContain("disabled");
  expect(html).not.toContain("0:00");
});

test("busy keeps the label and disables only the pressed button", () => {
  const html = renderToStaticMarkup(
    <NextActionView
      card={card(
        [
          {
            key: "a",
            kind: "decision",
            label: "Deploy the fix",
            weight: "primary",
            decision: "approve",
          },
          {
            key: "s",
            kind: "decision",
            label: "Stop",
            weight: "soft",
            decision: "stop",
          },
        ],
        { tone: "blue", eyebrow: "Needs you", body: "" },
      )}
      busy="a"
      onButton={noop}
    />,
  );
  expect(html.match(/disabled=""/g)).toHaveLength(1);
  expect(html).toContain("Deploy the fix");
  expect(html.indexOf(">Stop<")).toBeLessThan(html.indexOf("Deploy the fix"));
});

test("a scheduled Deploy now shows its undo in front of it", () => {
  const html = renderToStaticMarkup(
    <NextActionView
      card={card([
        {
          key: "now",
          kind: "deploy-now",
          label: "Deploy now",
          weight: "soft",
          decision: "deploy-now",
        },
      ])}
      busy={null}
      onButton={noop}
      scheduled={{ deadline: Date.now() + 4_900, onUndo: noop }}
    />,
  );
  expect(html).toContain("Undo deploy, 5s left");
  expect(html).toContain("Deploying…");
  expect(html.indexOf("Undo deploy")).toBeLessThan(html.indexOf("Deploying…"));
});

test("working pulses and links to what the agents did", () => {
  const html = renderToStaticMarkup(
    <NextActionView
      card={card([], { tone: "yellow", pulse: true, footnote: undefined })}
      busy={null}
      onButton={noop}
      onAudit={noop}
    />,
  );
  expect(html).toContain("animate-[pulse");
  expect(html).toContain("What the agents did");
});
