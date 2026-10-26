// Under an inbox's health: the unread mail already there at its first
// connect, and "Bring in the last N days", which only runs on a press. The
// component's hooks run in the hook harness; children are read, not
// rendered.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { InboxView } from "../../../../shared/support";
import {
  createHookHarness,
  find,
  reactWithHarness,
  settle,
} from "../../../tools/hook-harness";

const harness = createHookHarness();
const realReact = await import("react");
mock.module("react", () => reactWithHarness({ ...realReact }, harness));

const calls: Array<[string, number]> = [];
let answer: number | Error = 2;
const realSupportApi = await import("../../../lib/api/support");
mock.module("../../../lib/api/support", () => ({
  ...realSupportApi,
  bringInMail: async (id: string, days: number) => {
    calls.push([id, days]);
    if (answer instanceof Error) throw answer;
    return { count: answer, inbox: VIEW };
  },
}));

const toasts: string[] = [];
const realToast = await import("../../../ui/toast");
mock.module("../../../ui/toast", () => ({
  ...realToast,
  toast: (message: string) => {
    toasts.push(message);
    return 0;
  },
}));

const { InboxExistingMail } = await import("./InboxExistingMail");
const { Button } = await import("../../../ui/button");
const { OptionSelect } = await import("../../../ui/select");

const AT = "2026-10-25T10:00:00.000Z";
const VIEW: InboxView = {
  id: "inb_0001",
  label: "Acme help",
  address: "help@acme.example.test",
  channel: "email",
  enabled: true,
  project: "acme",
  autonomy: "draft",
  vetoMs: 900_000,
  neverWithoutAPerson: ["refund"],
  mailbox: "untouched",
  folders: { done: "Sessions/Done", spam: "Sessions/Spam" },
  copyToSent: true,
  retention: { conversationDays: 180, attachmentDays: 30 },
  owner: "Ada",
  sendLimitPerMinute: 30,
  allowInternalHost: false,
  imap: {
    host: "imap.example.test",
    port: 993,
    tls: "implicit",
    user: "help@acme.example.test",
    hasPassword: true,
  },
  smtp: {
    host: "smtp.example.test",
    port: 465,
    tls: "implicit",
    user: "help@acme.example.test",
    hasPassword: true,
  },
  createdAt: AT,
  createdBy: "Ada",
  updatedAt: AT,
  updatedBy: "Ada",
  revision: 2,
  health: {
    state: "live",
    since: AT,
    reason: null,
    retryAt: null,
    lastMessageAt: null,
    existingMail: { at: AT, unread: 3 },
  },
};

let refreshed = 0;
beforeEach(() => {
  calls.length = 0;
  toasts.length = 0;
  answer = 2;
  refreshed = 0;
});
afterEach(() => harness.unmountAll());

function mount(inbox: InboxView = VIEW) {
  return harness.mount(InboxExistingMail, {
    inbox,
    isInstanceOwner: false,
    onBroughtIn: () => {
      refreshed++;
    },
  });
}

const button = (tree: ReturnType<typeof mount>) => find(tree.output(), Button);

/** Presses the button the way a click would; its handler reads no event. */
function press(tree: ReturnType<typeof mount>) {
  const onClick = button(tree)?.props.onClick;
  if (!onClick) throw new Error("No Bring in button");
  // SAFETY: the component's handler ignores its event argument.
  onClick(undefined as never);
}

test("nothing comes in until someone presses Bring in", async () => {
  const tree = mount();
  await settle();
  expect(calls).toEqual([]);
  expect(JSON.stringify(tree.output())).toContain(
    "3 unread messages were already here when this inbox connected",
  );
  expect(button(tree)!.props.children).toBe("Bring in the last 7 days");
});

test("the chosen days go to the server, then the list reloads", async () => {
  const tree = mount();
  find(tree.output(), OptionSelect)!.props.onChange("3");
  await settle();
  expect(button(tree)!.props.children).toBe("Bring in the last 3 days");
  press(tree);
  await settle();
  expect(calls).toEqual([["inb_0001", 3]]);
  expect(toasts).toEqual(["Brought in 2 messages from the last 3 days"]);
  expect(refreshed).toBe(1);
});

test("a failure says so and keeps the offer", async () => {
  answer = new Error("The inbox isn't connected. Try again once it is");
  const tree = mount();
  press(tree);
  await settle();
  expect(toasts).toEqual(["The inbox isn't connected. Try again once it is"]);
  expect(refreshed).toBe(0);
  expect(button(tree)!.props.disabled).toBe(false);
});

test("an inbox with no mail waiting shows nothing", () => {
  const none: InboxView = {
    ...VIEW,
    health: { ...VIEW.health, existingMail: { at: AT, unread: 0 } },
  };
  expect(mount(none).output()).toBeNull();
});
