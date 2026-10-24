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
let AskNote: typeof import("./AskCard").AskNote;
let Questionnaire: typeof import("@shadcn/react/questionnaire").Questionnaire;

beforeAll(async () => {
  ({ AskCard, AskNote } = await import("./AskCard"));
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

function mountCard(
  questions: AskQuestion[] = [SHIP],
  extra: Partial<Parameters<typeof AskCard>[0]> = {},
) {
  const sent: Array<Record<string, string>> = [];
  const notes: Array<Record<string, string>> = [];
  const card = harness.mount(AskCard, {
    questions,
    onAnswer: (answers: Record<string, string>, n: Record<string, string>) => {
      sent.push(answers);
      notes.push(n);
    },
    ...extra,
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
  const note = () => find(tree(), AskNote);
  return {
    sent,
    notes,
    choice,
    submit,
    note,
    /** Typing into a picked option's note field. */
    write: async (value: string) => {
      const field = note();
      if (!field) throw new Error("no note field");
      field.props.onChange(value);
      await settle();
    },
    input: () => find(tree(), Questionnaire.Input),
    /** A click on a row: a pointer press, then the radio's change event. */
    click: async (label: string) => {
      // SAFETY: the card's handlers read nothing off the pointer event, and
      // only `target.checked` off the change.
      choice(label).props.onPointerDown?.({} as never);
      // SAFETY: as above, the change handler reads only `target.checked`.
      choice(label).props.onChange?.({ target: { checked: true } } as never);
      await settle();
    },
    /** A letter typed while the card holds focus. */
    press: async (key: string) => {
      // SAFETY: the capture handler reads `defaultPrevented`, `target`, the
      // native key and its modifiers, and calls `preventDefault`.
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
      // SAFETY: the field's change handler reads only `target.value`.
      find(tree(), Questionnaire.Input)?.props.onChange?.({
        target: { value },
      } as never);
      await settle();
    },
    /** Give the card the form element its window handler reads. */
    attachForm: () => {
      const ref = root().props.ref;
      if (!ref || ref instanceof Function) throw new Error("no form ref");
      // SAFETY: the window handler calls only `contains` and `querySelector`
      // on the form, and the harness never attaches a real one.
      ref.current = {
        contains: () => false,
        querySelector: () => null,
      } as never;
    },
    /** Answer, Enter and Cmd/Ctrl+Enter all reach the form's submit: the
     *  primitive validates, then calls requestSubmit. */
    send: async () => {
      // SAFETY: the submit handler only calls `preventDefault`.
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
  // SAFETY: the window handler reads the key, its modifiers,
  // `defaultPrevented` and `target`, and calls `preventDefault`.
  keydown?.({
    key: "a",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    target: {},
    preventDefault() {},
  } as never);
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

const SEND_BACK: AskQuestion = {
  question: "Stopped by Ada",
  options: [{ label: "Send it back" }, { label: "Close without action" }],
};
const NOTES = {
  "Send it back": { label: "Note for the investigator", maxLength: 20 },
};

test("an option that needs a note asks for it in the card, labelled", async () => {
  const card = mountCard([SEND_BACK], { notes: NOTES });
  expect(card.note()).toBeUndefined();
  await card.click("Send it back");

  expect(card.note()?.props.field.label).toBe("Note for the investigator");
  // Picked, but not an answer until the note is written.
  expect(card.submit()?.props.disabled).toBe(true);
  await card.write("   ");
  expect(card.submit()?.props.disabled).toBe(true);
  await card.write("Check the resume policy");
  // Over the limit the field allows: still not ready.
  expect(card.submit()?.props.disabled).toBe(true);
  await card.write("Check the policy");
  expect(card.submit()?.props.disabled).toBe(false);
  await card.send();

  expect(card.sent).toEqual([{ "Stopped by Ada": "Send it back" }]);
  expect(card.notes).toEqual([{ "Stopped by Ada": "Check the policy" }]);
});

test("Enter on a pick whose note is empty sends nothing", async () => {
  const card = mountCard([SEND_BACK], { notes: NOTES });
  await card.press("a");
  await card.send();
  expect(card.sent).toEqual([]);
  expect(card.submit()?.props.disabled).toBe(true);
});

test("an option without a note sends on its own, and leaves no note", async () => {
  const card = mountCard([SEND_BACK], { notes: NOTES });
  await card.click("Send it back");
  await card.write("Changed my mind");
  await card.click("Close without action");

  expect(card.note()).toBeUndefined();
  expect(card.submit()?.props.disabled).toBe(false);
  await card.send();
  expect(card.sent).toEqual([{ "Stopped by Ada": "Close without action" }]);
  expect(card.notes).toEqual([{}]);
});

test("without free text the card offers only its options", () => {
  expect(mountCard([SHIP], { freeText: false }).input()).toBeUndefined();
  expect(mountCard([SHIP]).input()).toBeDefined();
});
