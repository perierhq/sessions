import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ASK_CARD_PLATE } from "../../lib/ask-card-classes";
import {
  type CardButton,
  type ShellCard,
  STOP_GRACE_MS,
} from "../../lib/incidents/next-action";

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
  eyebrow: "Next",
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

const stopAt = (ms: number): CardButton => ({
  key: "stop",
  kind: "stop",
  label: "Stop",
  weight: "danger",
  decision: "stop",
  countdownTo: new Date(Date.now() + ms).toISOString(),
  doneLabel: "Deploying",
});

test("just past the deadline Stop stays pressable, without a count", () => {
  const html = renderToStaticMarkup(
    <NextActionView card={card([stopAt(-1000)])} busy={null} onButton={noop} />,
  );
  expect(html).toContain(">Stop<");
  expect(html).not.toContain('disabled=""');
  expect(html).not.toContain("aria-disabled");
  expect(html).not.toContain("0:00");
});

test("past the grace it reads the deploying state, still focusable", () => {
  const html = renderToStaticMarkup(
    <NextActionView
      card={card([stopAt(-STOP_GRACE_MS - 1000)])}
      busy={null}
      onButton={noop}
    />,
  );
  expect(html).toContain("Deploying");
  expect(html).toContain('aria-disabled="true"');
  expect(html).not.toContain('disabled=""');
  expect(html).not.toContain("0:00");
});

test("Stop and its count are one label, so the gap opens once", () => {
  const html = renderToStaticMarkup(
    <NextActionView
      card={card([stopAt(347_500)])}
      busy={null}
      onButton={noop}
    />,
  );
  expect(html).toMatch(
    /<span class="inline-flex items-center">Stop\u00a0·\u00a0<span[^>]*>/,
  );
});

test("a rollback's scheduled Roll back now says so", () => {
  const html = renderToStaticMarkup(
    <NextActionView
      card={card([
        {
          key: "now",
          kind: "deploy-now",
          label: "Roll back now",
          weight: "soft",
          decision: "deploy-now",
          undoLabel: "Undo roll back",
          pendingLabel: "Rolling back…",
        },
      ])}
      busy={null}
      onButton={noop}
      scheduled={{ deadline: Date.now() + 4_900, onUndo: noop }}
    />,
  );
  expect(html).toContain("Undo roll back, 5s left");
  expect(html).toContain("Rolling back…");
  expect(html).not.toContain("Deploying…");
});

test("the headline is set larger than the proof sentence", () => {
  const html = renderToStaticMarkup(
    <NextActionView card={card([])} busy={null} onButton={noop} />,
  );
  expect(html).toMatch(/<h2 class="[^"]*text-dialog-title/);
  expect(html).toMatch(/<p class="[^"]*text-supporting[^"]*">b</);
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
