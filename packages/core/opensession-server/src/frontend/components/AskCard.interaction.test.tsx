// What the question card sends, and when: a click or a letter only picks an
// option, and the answer leaves on Answer or Enter. AskCard's own hooks run in
// the hook harness; the Questionnaire parts it returns are read, not rendered,
// so a test calls their props the way the primitive would.
import { afterEach, beforeAll, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import type { AskQuestion } from "../lib/types";
import {
  createHookHarness,
  find,
  reactWithHarness,
  settle,
} from "../tools/hook-harness";

const windowKeys: Array<(e: KeyboardEvent) => void> = [];
Object.assign(globalThis, {
  window: {
    addEventListener: (type: string, fn: (e: KeyboardEvent) => void) => {
      if (type === "keydown") windowKeys.push(fn);
    },
    removeEventListener: (type: string, fn: (e: KeyboardEvent) => void) => {
      const i = windowKeys.indexOf(fn);
      if (type === "keydown" && i >= 0) windowKeys.splice(i, 1);
    },
    dispatchEvent: () => true,
  },
  localStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
  document: { querySelector: () => null },
  // isTextEntryTarget asks `instanceof Element` first; nothing here is one.
  Element: class {},
  Node: class {},
  fetch: () => Promise.reject(new Error("offline in tests")),
});

const harness = createHookHarness();
const realReact = await import("react");
mock.module("react", () => reactWithHarness({ ...realReact }, harness));
mock.module("./MarkdownBody", () => ({ useMarkdownRepo: () => undefined }));

let AskCard: typeof import("./AskCard").AskCard;
let Questionnaire: typeof import("@shadcn/react/questionnaire").Questionnaire;

beforeAll(async () => {
  AskCard = (await import("./AskCard")).AskCard;
  Questionnaire = (await import("@shadcn/react/questionnaire")).Questionnaire;
});

afterEach(() => {
  harness.unmountAll();
  windowKeys.length = 0;
});

const SHIP: AskQuestion = {
  question: "Ship it?",
  options: [{ label: "Ship" }, { label: "Hold" }, { label: "Revert" }],
};

function mountCard(questions: AskQuestion[] = [SHIP]) {
  const sent: Array<Record<string, string>> = [];
  const card = harness.mount(AskCard, {
    questions,
    onAnswer: (answers: Record<string, string>) => void sent.push(answers),
  });
  const tree = (): ReactNode => card.output();
  const choice = (label: string) => {
    const el = find(tree(), Questionnaire.Choice, (p) => p.value === label);
    if (!el) throw new Error(`no choice ${label}`);
    return el;
  };
  const root = () => {
    const el = find(tree(), Questionnaire.Root);
    if (!el) throw new Error("no root");
    return el;
  };
  const submit = () => find(tree(), Questionnaire.Submit);
  return {
    sent,
    choice,
    submit,
    /** A click on a row: a pointer press, then the radio's change event. */
    click: async (label: string) => {
      const row = choice(label).props as {
        onPointerDown?: (e: unknown) => void;
      };
      row.onPointerDown?.({});
      choice(label).props.onChange?.({
        target: { checked: true },
      } as never);
      await settle();
    },
    /** A letter typed while the card holds focus. */
    press: async (key: string) => {
      root().props.onKeyDownCapture?.({
        defaultPrevented: false,
        target: {},
        nativeEvent: { key, metaKey: false, ctrlKey: false, altKey: false },
        preventDefault() {},
      } as never);
      await settle();
    },
    /** Typing into the "Or type your own answer" field. */
    type: async (value: string) => {
      find(tree(), Questionnaire.Input)?.props.onChange?.({
        target: { value },
      } as never);
      await settle();
    },
    /** Give the card the form element its window handler reads. */
    attachForm: () => {
      const ref = root().props.ref as { current: unknown };
      ref.current = { contains: () => false, querySelector: () => null };
    },
    /** Answer, Enter and Cmd/Ctrl+Enter all reach the form's submit: the
     *  primitive validates, then calls requestSubmit. */
    send: async () => {
      root().props.onSubmit?.({ preventDefault() {} } as never);
      await settle();
    },
  };
}

test("a click on an option selects it without sending", async () => {
  const card = mountCard();
  expect(card.submit()?.props.disabled).toBe(true);

  await card.click("Hold");

  expect(card.sent).toEqual([]);
  expect(card.choice("Hold").props.checked).toBe(true);
  expect(card.choice("Ship").props.checked).toBe(false);
  // Something is picked, so the Answer button is ready.
  expect(card.submit()?.props.disabled).toBe(false);
});

test("Answer sends the picked label", async () => {
  const card = mountCard();
  await card.click("Ship");
  await card.send();

  expect(card.sent).toEqual([{ "Ship it?": "Ship" }]);
  expect(card.submit()?.props.disabled).toBe(true);
});

test("a letter selects its option without sending", async () => {
  const card = mountCard();
  await card.press("b");

  expect(card.sent).toEqual([]);
  expect(card.choice("Hold").props.checked).toBe(true);
});

test("a letter from outside the card selects too", async () => {
  const card = mountCard();
  // The window handler checks the keystroke against the form it is in.
  card.attachForm();
  const keydown = windowKeys.at(-1);
  expect(keydown).toBeDefined();
  keydown?.({
    key: "a",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    target: {},
    preventDefault() {},
  } as unknown as KeyboardEvent);
  await settle();

  expect(card.sent).toEqual([]);
  expect(card.choice("Ship").props.checked).toBe(true);
});

test("Enter after a letter sends that pick", async () => {
  const card = mountCard();
  await card.press("c");
  expect(card.sent).toEqual([]);
  await card.send();

  expect(card.sent).toEqual([{ "Ship it?": "Revert" }]);
});

test("changing the pick before sending sends the last pick", async () => {
  const card = mountCard();
  await card.click("Ship");
  await card.press("b");
  await card.click("Revert");
  expect(card.sent).toEqual([]);
  await card.send();

  expect(card.sent).toEqual([{ "Ship it?": "Revert" }]);
});

test("typing an answer replaces the pick, and sends the text", async () => {
  const card = mountCard();
  await card.click("Ship");
  await card.type("After the freeze");

  expect(card.choice("Ship").props.checked).toBe(false);
  expect(card.sent).toEqual([]);
  await card.send();

  expect(card.sent).toEqual([{ "Ship it?": "After the freeze" }]);
});

test("a multi-select letter toggles, and nothing sends until Answer", async () => {
  const card = mountCard([{ ...SHIP, multiSelect: true }]);
  await card.press("a");
  await card.press("c");
  await card.press("a");
  expect(card.sent).toEqual([]);
  await card.send();

  expect(card.sent).toEqual([{ "Ship it?": "Revert" }]);
});
