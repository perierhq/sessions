// The email reply box in each draft state: a draft waiting for a person is
// sent as edited, a veto window stops, a draft someone else settled says so,
// and a push intent focuses its control and asks before it acts. The box's
// own hooks run in the hook harness; children are read, not rendered.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { z } from "zod";
import type { SupportConversationView } from "../../shared/support";
import {
  createHookHarness,
  elements,
  find,
  reactWithHarness,
  settle,
} from "../tools/hook-harness";
import { conversation, draft } from "../tools/support-fixture";

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

const toasts: string[] = [];
const realToast = await import("../ui/toast");
mock.module("../ui/toast", () => ({
  ...realToast,
  toast: (message: string) => {
    toasts.push(message);
    return toasts.length;
  },
}));

const view = (c = conversation()): SupportConversationView => ({
  conversation: c,
  inbox: null,
});
const sendDraft = mock(async (..._args: unknown[]) => view());
const stopVeto = mock(async (..._args: unknown[]) => view());
const discardDraft = mock(async (..._args: unknown[]) => view());
const replyToConversation = mock(async (..._args: unknown[]) => view());
const realApi = await import("../lib/api/support");
mock.module("../lib/api/support", () => ({
  ...realApi,
  sendDraft,
  stopVeto,
  discardDraft,
  replyToConversation,
}));

const { ApiError } = await import("../lib/api/request");
const { ConfirmDialog } = await import("../ui/confirm");
const { Button } = await import("../ui/button");
const { loadDraft } = await import("../lib/drafts");
const { SupportReplyBox } = await import("./SupportReplyBox");
const { SupportComposer } = await import("./SupportComposer");
type Props = Parameters<typeof SupportReplyBox>[0];

const props = (over: Partial<Props> = {}): Props => ({
  conversation: conversation(),
  inboxAddress: "help@acme.example.test",
  onChanged: () => {},
  onRefetch: () => {},
  ...over,
});

const button = (tree: React.ReactNode, label: string) => {
  const el = find(tree, Button, (p) => p.children === label);
  if (!el) throw new Error(`No ${label} button`);
  return el.props;
};
const textarea = (tree: React.ReactNode) => {
  const el = find(tree, SupportComposer);
  if (!el) throw new Error("No composer");
  return el.props;
};
const type = (tree: React.ReactNode, value: string) =>
  textarea(tree).onChange(value);
const confirmOf = (tree: React.ReactNode) => find(tree, ConfirmDialog)?.props;

/** The string children in `tree`, in order. */
const childText = z.object({ children: z.string() });
const strings = (tree: React.ReactNode) =>
  elements(tree).flatMap((el) => {
    const parsed = childText.safeParse(el.props);
    return parsed.success ? [parsed.data.children] : [];
  });
/** A press: the handlers under test ignore their event. */
const press = (handler: ((event: never) => void) | undefined) =>
  // SAFETY: every handler pressed here ignores its event argument.
  handler?.(undefined as never);
const text = (tree: React.ReactNode) => strings(tree).join(" | ");

beforeEach(() => {
  store.clear();
  toasts.length = 0;
  for (const m of [sendDraft, stopVeto, discardDraft, replyToConversation]) {
    m.mockReset();
    m.mockImplementation(async () => view());
  }
});
afterEach(() => harness.unmountAll());

test("compose says who the reply goes to and where it is sent from", () => {
  const box = harness.mount(SupportReplyBox, props());
  expect(textarea(box.output()).placeholder).toBe(
    "Reply to Grace, sent from help@acme.example.test…",
  );
});

test("review prefills the draft and Send sends the edited text", async () => {
  const onChanged = mock();
  const box = harness.mount(
    SupportReplyBox,
    props({
      conversation: conversation({ draft: draft("needs-person") }),
      onChanged,
    }),
  );
  expect(textarea(box.output()).value).toBe("Try resetting your password");
  expect(text(box.output())).toContain(
    "Draft by the agent · Draft: a person sends",
  );
  type(box.output(), "Try resetting your password, Grace");
  await settle();
  expect(loadDraft("support-reply:sc_0001:sd_1").text).toBe(
    "Try resetting your password, Grace",
  );
  press(button(box.output(), "Send").onClick);
  await settle();
  expect(sendDraft).toHaveBeenCalledWith("sc_0001", "sd_1", {
    text: "Try resetting your password, Grace",
  });
  expect(onChanged).toHaveBeenCalledTimes(1);
  expect(loadDraft("support-reply:sc_0001:sd_1").text).toBe("");
});

test("an unedited draft is sent as the agent wrote it", async () => {
  const box = harness.mount(
    SupportReplyBox,
    props({ conversation: conversation({ draft: draft("needs-person") }) }),
  );
  press(button(box.output(), "Send").onClick);
  await settle();
  expect(sendDraft).toHaveBeenCalledWith("sc_0001", "sd_1", undefined);
});

test("Discard drops the draft", async () => {
  const box = harness.mount(
    SupportReplyBox,
    props({ conversation: conversation({ draft: draft("needs-person") }) }),
  );
  press(button(box.output(), "Discard").onClick);
  await settle();
  expect(discardDraft).toHaveBeenCalledWith("sc_0001", "sd_1");
});

test("veto mode Stop stops the window, and Send now sends", async () => {
  const box = harness.mount(
    SupportReplyBox,
    props({ conversation: conversation({ draft: draft("veto") }) }),
  );
  expect(textarea(box.output()).readOnly).toBe(true);
  press(button(box.output(), "Stop").onClick);
  await settle();
  expect(stopVeto).toHaveBeenCalledWith("sc_0001", "sd_1");
  press(button(box.output(), "Send now").onClick);
  await settle();
  expect(sendDraft).toHaveBeenCalledWith("sc_0001", "sd_1");
});

test("a 409 says someone else handled it and refetches", async () => {
  stopVeto.mockImplementation(async () => {
    throw new ApiError("No veto window is open", 409);
  });
  const onRefetch = mock();
  const box = harness.mount(
    SupportReplyBox,
    props({ conversation: conversation({ draft: draft("veto") }), onRefetch }),
  );
  press(button(box.output(), "Stop").onClick);
  await settle();
  expect(textarea(box.output()).error).toBe(
    "Someone else already handled this draft",
  );
  expect(onRefetch).toHaveBeenCalledTimes(1);
});

test("failed shows the error with Try again and Discard", async () => {
  const box = harness.mount(
    SupportReplyBox,
    props({ conversation: conversation({ draft: draft("failed") }) }),
  );
  expect(text(box.output())).toContain("The mail server refused the reply");
  press(button(box.output(), "Try again").onClick);
  await settle();
  expect(sendDraft).toHaveBeenCalledWith("sc_0001", "sd_1", undefined);
  expect(button(box.output(), "Discard")).toBeDefined();
});

test("sending shows the spinner and no actions", () => {
  const box = harness.mount(
    SupportReplyBox,
    props({
      conversation: conversation({
        draft: draft("sending", { attemptStartedAt: new Date().toISOString() }),
      }),
    }),
  );
  expect(text(box.output())).toContain("Sending…");
  expect(
    find(box.output(), Button, (p) => p.children === "Send"),
  ).toBeUndefined();
});

test("intent stop focuses Stop and asks before stopping", async () => {
  let handled = 0;
  const box = harness.mount(
    SupportReplyBox,
    props({
      conversation: conversation({ draft: draft("veto") }),
      intent: "stop",
      onIntentHandled: () => handled++,
    }),
  );
  await settle();
  expect(button(box.output(), "Stop").autoFocus).toBe(true);
  expect(stopVeto).not.toHaveBeenCalled();
  expect(sendDraft).not.toHaveBeenCalled();
  expect(handled).toBe(1);
  const dialog = confirmOf(box.output());
  expect(dialog?.open).toBe(true);
  expect(dialog?.request?.confirmLabel).toBe("Stop");
  dialog?.request?.onConfirm();
  await settle();
  expect(stopVeto).toHaveBeenCalledWith("sc_0001", "sd_1");
});

test("intent review focuses Send and sends nothing", async () => {
  const box = harness.mount(
    SupportReplyBox,
    props({
      conversation: conversation({ draft: draft("needs-person") }),
      intent: "review",
      onIntentHandled: () => {},
    }),
  );
  await settle();
  expect(button(box.output(), "Send").autoFocus).toBe(true);
  expect(sendDraft).not.toHaveBeenCalled();
  expect(confirmOf(box.output())?.open).toBeFalsy();
});

test("an intent with nothing to act on toasts", async () => {
  harness.mount(
    SupportReplyBox,
    props({ intent: "stop", onIntentHandled: () => {} }),
  );
  await settle();
  expect(toasts).toEqual(["Nothing to stop: the reply was already handled"]);
  expect(stopVeto).not.toHaveBeenCalled();
});

test("a send cut off long ago offers Discard", async () => {
  const box = harness.mount(
    SupportReplyBox,
    props({
      conversation: conversation({
        draft: draft("sending", {
          attemptStartedAt: new Date(Date.now() - 600_000).toISOString(),
        }),
      }),
    }),
  );
  expect(text(box.output())).toContain("Sending…");
  press(button(box.output(), "Discard").onClick);
  await settle();
  expect(discardDraft).toHaveBeenCalledWith("sc_0001", "sd_1");
});

test("a routine draft shows the sources it cites", () => {
  const box = harness.mount(
    SupportReplyBox,
    props({
      conversation: conversation({
        draft: draft("veto", {
          sources: [
            { kind: "url", ref: "https://docs.acme.example.test/reset" },
            { kind: "repo", ref: "docs/sign-in.md" },
            { kind: "record", ref: "stripe:cus_123" },
          ],
        }),
      }),
    }),
  );
  const link = find<React.ComponentProps<"a">>(box.output(), "a");
  expect(link?.props.href).toBe("https://docs.acme.example.test/reset");
  expect(link?.props.target).toBe("_blank");
  const all = strings(box.output());
  expect(all).toContain("Sources");
  expect(all).toContain("docs.acme.example.test/reset");
  expect(all).toContain("docs/sign-in.md");
  expect(all).toContain("stripe:cus_123");
});

test("a draft waiting for judgement says why, as the server wrote it", () => {
  const box = harness.mount(
    SupportReplyBox,
    props({
      conversation: conversation({
        draft: draft("needs-person", { rule: "No source cited" }),
      }),
    }),
  );
  expect(text(box.output())).toContain("Draft by the agent · No source cited");
  expect(strings(box.output())).not.toContain("Sources");
});

test("a prepared fixed note sends with its own button", async () => {
  const box = harness.mount(
    SupportReplyBox,
    props({
      conversation: conversation({
        draft: draft("needs-person", {
          purpose: "fixed-note",
          author: { kind: "sessions" },
          rule: 'An "it\'s fixed" note always needs a person',
        }),
      }),
    }),
  );
  expect(text(box.output())).toContain(
    'Fixed note · An "it\'s fixed" note always needs a person',
  );
  press(button(box.output(), "Send fixed note").onClick);
  await settle();
  expect(sendDraft).toHaveBeenCalledWith("sc_0001", "sd_1", undefined);
});
