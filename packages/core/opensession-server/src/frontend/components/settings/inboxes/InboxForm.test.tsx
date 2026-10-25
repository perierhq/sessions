// The inbox form: Test connection reports IMAP and SMTP on their own lines,
// the veto field follows the autonomy, removing asks first. The form's own
// hooks run in the hook harness; children are read, not rendered.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type {
  InboxPatch,
  InboxTestBody,
  InboxTestResult,
  InboxView,
  NewInboxInput,
} from "../../../../shared/support";
import {
  createHookHarness,
  find,
  reactWithHarness,
  settle,
} from "../../../tools/hook-harness";

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

type Call =
  | ["test", InboxTestBody]
  | ["delete", string]
  | ["patch", { id: string; patch: InboxPatch }]
  | ["create", NewInboxInput];
const calls: Call[] = [];
let testAnswer: InboxTestResult | null = null;
const realSupportApi = await import("../../../lib/api/support");
mock.module("../../../lib/api/support", () => ({
  ...realSupportApi,
  testInbox: async (body: InboxTestBody) => {
    calls.push(["test", body]);
    return testAnswer;
  },
  deleteInbox: async (id: string) => {
    calls.push(["delete", id]);
    return { ok: true };
  },
  patchInbox: async (id: string, patch: InboxPatch) => {
    calls.push(["patch", { id, patch }]);
    return { inbox: VIEW };
  },
  createInbox: async (input: NewInboxInput) => {
    calls.push(["create", input]);
    return { inbox: VIEW };
  },
}));

const realToast = await import("../../../ui/toast");
mock.module("../../../ui/toast", () => ({
  ...realToast,
  toast: () => 0,
}));

const { InboxForm } = await import("./InboxForm");
const { Button } = await import("../../../ui/button");
const { Input } = await import("../../../ui/input");
const { OptionSelect } = await import("../../../ui/select");
const { ConfirmDialog } = await import("../../../ui/confirm");
const { InlineAlert } = await import("../../../ui/state");

const VIEW: InboxView = {
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
    state: "live",
    since: "2026-10-25T10:00:00.000Z",
    reason: null,
    retryAt: null,
    lastMessageAt: null,
  },
};

const PROJECTS = [
  { id: "acme", supportConnectors: true },
  { id: "acme-api", supportConnectors: false },
];

beforeEach(() => {
  calls.length = 0;
  testAnswer = null;
});
afterEach(() => harness.unmountAll());

type Tree = ReturnType<typeof harness.mount>;

async function mountForm(inbox: InboxView | null = VIEW) {
  const tree = harness.mount(InboxForm, {
    open: true,
    inbox,
    projects: PROJECTS,
    people: ["Ada", "Bea"],
    isInstanceOwner: true,
    onClose: () => {},
    onSaved: () => {},
  });
  await settle();
  return tree;
}

function text(tree: Tree): string {
  return JSON.stringify(tree.output(), (key, value) =>
    key.startsWith("_") ? undefined : value,
  );
}

function button(tree: Tree, label: string) {
  const el = find(tree.output(), Button, (p) => p.children === label);
  if (!el?.props.onClick) throw new Error(`No button ${label}`);
  const onClick = el.props.onClick;
  // SAFETY: the form's handlers ignore the click event.
  return { onClick: () => onClick(undefined as never) };
}

test("Test connection shows the IMAP and SMTP results on their own lines", async () => {
  testAnswer = {
    imap: { ok: true, idle: true, condstore: true, sentFolder: "Sent" },
    smtp: {
      ok: false,
      permanent: true,
      error: "The mail server refused the password",
    },
  };
  const tree = await mountForm();
  button(tree, "Test connection").onClick();
  await settle();
  expect(calls).toEqual([["test", { inboxId: "inb_0001" }]]);
  const all = text(tree);
  expect(all).toContain("IMAP: Connected. Supports instant delivery (IDLE)");
  expect(all).toContain("SMTP: The mail server refused the password");
});

test("the veto field shows only for Send after a veto window", async () => {
  const tree = await mountForm();
  const veto = () =>
    find(
      tree.output(),
      Input,
      (p) => p["aria-label"] === "Veto window in minutes",
    );
  expect(veto()).toBeUndefined();
  const autonomy = find(
    tree.output(),
    OptionSelect,
    (p) => p.label === "Autonomy",
  );
  if (!autonomy) throw new Error("No autonomy select");
  autonomy.props.onChange("deploy-after-veto");
  await settle();
  expect(veto()).toBeDefined();
  find(
    tree.output(),
    OptionSelect,
    (p) => p.label === "Autonomy",
  )!.props.onChange("deploy-right-away");
  await settle();
  expect(veto()).toBeUndefined();
});

test("a send level on a project with connectors warns", async () => {
  const tree = await mountForm();
  expect(text(tree)).not.toContain("The agent can send what its connectors");
  find(
    tree.output(),
    OptionSelect,
    (p) => p.label === "Autonomy",
  )!.props.onChange("deploy-after-veto");
  await settle();
  expect(find(tree.output(), InlineAlert)).toBeDefined();
  expect(text(tree)).toContain(
    "The agent can send what its connectors return. Draft is safer until Sessions checks mail for injected instructions.",
  );
});

test("Remove inbox asks before it removes", async () => {
  const tree = await mountForm();
  button(tree, "Remove inbox").onClick();
  await settle();
  expect(calls).toEqual([]);
  const dialog = find(tree.output(), ConfirmDialog);
  const request = dialog?.props.request;
  expect(request?.title).toBe("Remove this inbox?");
  expect(request?.description).toBe(
    "Conversations stay; Sessions stops reading the mailbox",
  );
  request!.onConfirm();
  await settle();
  expect(calls).toEqual([["delete", "inb_0001"]]);
});

test("a new inbox has no remove or turn off", async () => {
  const tree = await mountForm(null);
  expect(text(tree)).not.toContain("Remove inbox");
  expect(text(tree)).not.toContain("Turn off");
});
