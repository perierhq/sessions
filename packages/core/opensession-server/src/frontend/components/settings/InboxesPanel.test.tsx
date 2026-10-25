// The Inboxes page: one row per inbox with its health line, the off state,
// and Forget a customer behind a confirm. The panel's own hooks run in the
// hook harness; children are read, not rendered.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { InboxView, InboxesResponse } from "../../../shared/support";
import {
  createHookHarness,
  find,
  reactWithHarness,
  settle,
} from "../../tools/hook-harness";

Object.assign(globalThis, {
  localStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
});

const harness = createHookHarness();
const realReact = await import("react");
mock.module("react", () => reactWithHarness({ ...realReact }, harness));

const PAUSED: InboxView = {
  id: "inb_0001",
  label: "Acme help",
  address: "help@acme.example.test",
  channel: "email",
  enabled: true,
  project: "acme",
  moveLock: "agent",
  autonomy: "propose",
  vetoMs: 900_000,
  neverWithoutAPerson: ["refund"],
  bugHandling: "off",
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
  createdAt: "2026-10-25T10:00:00.000Z",
  createdBy: "Ada",
  updatedAt: "2026-10-25T10:00:00.000Z",
  updatedBy: "Ada",
  revision: 2,
  health: {
    state: "paused",
    since: "2026-10-25T10:00:00.000Z",
    reason: "The mail server refused the password. Save a new one to reconnect",
    retryAt: null,
    lastMessageAt: null,
  },
};

let data: InboxesResponse | undefined;
let loadError: Error | undefined;
mock.module("swr", () => ({
  mutate: async () => undefined,
  default: () => ({
    data,
    error: loadError,
    isLoading: false,
    mutate: async () => data,
  }),
}));

const realPeople = await import("../../lib/people");
mock.module("../../lib/people", () => ({
  ...realPeople,
  usePeople: () => [{ name: "Ada", fullName: "Ada Lovelace" }],
}));

const forgets: string[] = [];
const realSupportApi = await import("../../lib/api/support");
mock.module("../../lib/api/support", () => ({
  ...realSupportApi,
  forgetCustomer: async (email: string) => {
    forgets.push(email);
    return {
      conversations: 2,
      sessions: 1,
      attachments: 3,
      failed: 0,
      notDeleted: ["Mail in the mailbox"],
    };
  },
}));

const { InboxesPanel } = await import("./InboxesPanel");
const { Button } = await import("../../ui/button");
const { Input } = await import("../../ui/input");
const { ConfirmDialog } = await import("../../ui/confirm");
const { InlineAlert } = await import("../../ui/state");
const { ApiError } = await import("../../lib/api/request");

beforeEach(() => {
  forgets.length = 0;
  loadError = undefined;
  data = {
    enabled: true,
    isInstanceOwner: true,
    projects: [{ id: "acme", supportConnectors: false }],
    inboxes: [PAUSED],
  };
});
afterEach(() => harness.unmountAll());

type Tree = ReturnType<typeof harness.mount>;

async function mountPanel() {
  const tree = harness.mount(InboxesPanel, {});
  await settle();
  return tree;
}

function text(tree: Tree): string {
  return JSON.stringify(tree.output(), (key, value) =>
    key.startsWith("_") ? undefined : value,
  );
}

test("a paused inbox shows why", async () => {
  const tree = await mountPanel();
  const all = text(tree);
  expect(all).toContain("Acme help");
  expect(all).toContain("help@acme.example.test");
  expect(all).toContain(
    "Paused: The mail server refused the password. Save a new one to reconnect",
  );
});

test("with the integration off the page says how to turn it on", async () => {
  data = { enabled: false, isInstanceOwner: true, projects: [], inboxes: [] };
  const tree = await mountPanel();
  expect(text(tree)).toContain("Email support is off");
  expect(text(tree)).not.toContain("Connect an inbox");
});

test("Forget asks first, then shows what went", async () => {
  const tree = await mountPanel();
  const input = find(
    tree.output(),
    Input,
    (p) => p["aria-label"] === "Customer address",
  );
  // SAFETY: the panel's handler reads only `target.value`.
  const change = { target: { value: "ada@example.test" } } as never;
  input!.props.onChange!(change);
  await settle();
  const forget = find(tree.output(), Button, (p) => p.children === "Forget");
  // SAFETY: the panel's Forget handler ignores the click event.
  forget!.props.onClick!(undefined as never);
  await settle();
  expect(forgets).toEqual([]);
  const request = find(tree.output(), ConfirmDialog)?.props.request;
  expect(request?.title).toBe("Forget ada@example.test?");
  request!.onConfirm();
  await settle();
  expect(forgets).toEqual(["ada@example.test"]);
  const all = text(tree);
  expect(all).toContain("Deleted 2 conversations, 1 session and 3 attachments");
  expect(all).toContain("Mail in the mailbox");
});

test("signed out, the page asks to sign in without a retry", async () => {
  data = undefined;
  loadError = new ApiError("Sign in to change support inboxes", 401);
  const tree = await mountPanel();
  expect(text(tree)).toContain("Sign in to manage inboxes");
  expect(text(tree)).not.toContain("Forget a customer");
  expect(find(tree.output(), InlineAlert)).toBeUndefined();
});

test("an enabled inbox nothing has connected yet says so", async () => {
  data!.inboxes = [
    { ...PAUSED, health: { ...PAUSED.health, state: "off", reason: null } },
  ];
  const tree = await mountPanel();
  expect(text(tree)).toContain("Not connected yet");
  expect(text(tree)).not.toContain('"Off"');
});
