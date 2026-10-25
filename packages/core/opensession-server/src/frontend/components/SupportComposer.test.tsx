// The reply box both support channels share: its slots render where a
// channel puts them, ⌘/Ctrl+Enter submits only while there is a submit, and
// useSavedDraft keeps only text a person changed. The hook runs in the hook
// harness; the box renders to markup.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import {
  createHookHarness,
  find,
  reactWithHarness,
  settle,
} from "../tools/hook-harness";

const store = new Map<string, string>();
const storage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
Object.assign(globalThis, {
  window: {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout,
    clearTimeout,
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  },
  localStorage: storage,
  sessionStorage: storage,
  document: {
    documentElement: { dataset: {}, style: { colorScheme: "" } },
    querySelector: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: "visible",
  },
});

const harness = createHookHarness();
const realReact = await import("react");
mock.module("react", () => reactWithHarness({ ...realReact }, harness));

const { SupportComposer, SupportSendButton } =
  await import("./SupportComposer");
const { useSavedDraft } = await import("../hooks/useSavedDraft");
const { loadDraft, saveDraft } = await import("../lib/drafts");

type ComposerProps = Parameters<typeof SupportComposer>[0];
const composer = (over: Partial<ComposerProps> = {}) =>
  harness.mount(SupportComposer, {
    value: "",
    onChange: () => {},
    placeholder: "Reply…",
    label: "Reply",
    ...over,
  });
const textarea = (tree: React.ReactNode) => {
  const el = find<React.ComponentProps<"textarea">>(tree, "textarea");
  if (!el) throw new Error("No textarea");
  return el.props;
};
const keyDown = (tree: React.ReactNode, over: object) => {
  const preventDefault = mock();
  // SAFETY: the handler reads only the modifier keys, `key` and preventDefault.
  textarea(tree).onKeyDown?.({
    key: "Enter",
    metaKey: false,
    ctrlKey: false,
    preventDefault,
    ...over,
  } as never);
  return preventDefault;
};

beforeEach(() => store.clear());
afterEach(() => harness.unmountAll());

test("the text, its name and every slot land in the box", () => {
  const onChange = mock();
  const box = composer({
    value: "Hi",
    onChange,
    label: "Reply draft",
    error: "Couldn't send",
    header: <span>Draft by the agent</span>,
    children: <span>Toolbar</span>,
  });
  const tree = box.output();
  expect(textarea(tree).value).toBe("Hi");
  expect(textarea(tree)["aria-label"]).toBe("Reply draft");
  const change = { target: { value: "Hi there" } };
  // SAFETY: the change handler reads only `target.value`.
  textarea(tree).onChange?.(change as never);
  expect(onChange).toHaveBeenCalledWith("Hi there");
  const strings = JSON.stringify(tree, (_k, v) =>
    typeof v === "function" ? undefined : v,
  );
  expect(strings).toContain("Draft by the agent");
  expect(strings).toContain("Toolbar");
  expect(
    find(tree, "div", (p: { role?: string }) => p.role === "alert"),
  ).toBeDefined();
});

test("⌘ or Ctrl+Enter submits, plain Enter and a box without submit do not", () => {
  const onSubmit = mock();
  const box = composer({ onSubmit });
  keyDown(box.output(), {});
  expect(onSubmit).not.toHaveBeenCalled();
  expect(keyDown(box.output(), { metaKey: true })).toHaveBeenCalled();
  keyDown(box.output(), { ctrlKey: true });
  expect(onSubmit).toHaveBeenCalledTimes(2);
  const locked = composer({});
  expect(keyDown(locked.output(), { metaKey: true })).not.toHaveBeenCalled();
});

test("the send button is named for what it sends", () => {
  const onClick = mock();
  const el = SupportSendButton({ label: "Add internal note", onClick });
  // SAFETY: SupportSendButton returns one PlainButton element.
  const props = (el as React.ReactElement<React.ComponentProps<"button">>)
    .props;
  expect(props["aria-label"]).toBe("Add internal note");
  props.onClick?.(undefined as never);
  expect(onClick).toHaveBeenCalledTimes(1);
});

function Saved({ k, original }: { k: string; original?: string }) {
  const [text, setText, clear] = useSavedDraft(k, original);
  return (
    <SupportComposer
      value={text}
      onChange={setText}
      onSubmit={clear}
      placeholder=""
      label="Reply"
    />
  );
}

test("useSavedDraft saves a person's text and drops it when it matches the original", async () => {
  const box = harness.mount(Saved, { k: "t:1", original: "Agent text" });
  const props = () => find(box.output(), SupportComposer)!.props;
  expect(props().value).toBe("Agent text");
  props().onChange("Agent text, edited");
  await settle();
  expect(loadDraft("t:1").text).toBe("Agent text, edited");
  expect(props().value).toBe("Agent text, edited");
  props().onChange("Agent text");
  await settle();
  expect(loadDraft("t:1").text).toBe("");
});

test("useSavedDraft starts from saved text and clear forgets it", async () => {
  saveDraft("t:2", { text: "half a reply" });
  const box = harness.mount(Saved, { k: "t:2" });
  const props = () => find(box.output(), SupportComposer)!.props;
  expect(props().value).toBe("half a reply");
  props().onSubmit?.();
  await settle();
  expect(loadDraft("t:2").text).toBe("");
});
