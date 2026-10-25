// The inbox form: Test connection reports IMAP and SMTP on their own lines,
// autonomy is Watch, Draft or Routine with the wait under Routine and the
// drafts figure beside it, removing asks first. The form's own
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
let patchError: Error | null = null;
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
    if (patchError) throw patchError;
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
const { Switch } = await import("../../../ui/switch");
const { RadioGroup } = await import("../../../ui/radio");
const { SettingsDialog } = await import("../incidents/SettingsDialog");
const { ApiError } = await import("../../../lib/api/request");

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
  patchError = null;
  saved = 0;
  reloaded = 0;
});
afterEach(() => harness.unmountAll());

type Tree = ReturnType<typeof harness.mount>;

let saved = 0;
let reloaded = 0;

async function mountForm(
  inbox: InboxView | null = VIEW,
  over: { isInstanceOwner?: boolean; projects?: typeof PROJECTS } = {},
) {
  const tree = harness.mount(InboxForm, {
    open: true,
    inbox,
    projects: over.projects ?? PROJECTS,
    people: ["Ada", "Bea"],
    isInstanceOwner: over.isInstanceOwner ?? true,
    onClose: () => {},
    onSaved: () => {
      saved++;
    },
    onReload: () => {
      reloaded++;
    },
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

function chooseAutonomy(tree: Tree, value: string) {
  const group = find(
    tree.output(),
    RadioGroup,
    (p) => p.value !== undefined && "aria-labelledby" in p,
  );
  if (!group?.props.onValueChange) throw new Error("No autonomy choice");
  // SAFETY: the form's handler reads only the value.
  group.props.onValueChange(value, undefined as never);
}

test("autonomy is Watch, Draft or Routine, each with its one line", async () => {
  const tree = await mountForm();
  const all = text(tree);
  for (const label of ["Watch", "Draft", "Routine"])
    expect(all).toContain(`"children":"${label}"`);
  expect(all).toContain(
    "Repetitive replies backed by a source send on their own. Everything that needs judgement waits for you",
  );
  expect(all).not.toContain("Bug handling");
  expect(all).not.toContain("Who may move conversations");
});

test("the wait shows only for Routine and can be turned off", async () => {
  const tree = await mountForm();
  const minutes = () =>
    find(tree.output(), Input, (p) => p["aria-label"] === "Minutes to wait");
  const wait = () =>
    find(
      tree.output(),
      Switch,
      (p) => p["aria-label"] === "Wait before sending",
    );
  expect(minutes()).toBeUndefined();
  chooseAutonomy(tree, "routine");
  await settle();
  expect(minutes()?.props.value).toBe("15");
  wait()!.props.onCheckedChange?.(false, undefined as never);
  await settle();
  expect(minutes()).toBeUndefined();
  expect(text(tree)).toContain("Routine replies send right away");
  find(tree.output(), SettingsDialog)!.props.onSave!();
  await settle();
  expect(calls).toEqual([
    [
      "patch",
      {
        id: "inb_0001",
        patch: { expectedRevision: 2, autonomy: "routine", vetoMs: null },
      },
    ],
  ]);
});

test("a teammate can't turn off the wait", async () => {
  const tree = await mountForm(VIEW, { isInstanceOwner: false });
  chooseAutonomy(tree, "routine");
  await settle();
  const wait = find(
    tree.output(),
    Switch,
    (p) => p["aria-label"] === "Wait before sending",
  );
  expect(wait?.props.disabled).toBe(true);
  expect(text(tree)).toContain(
    "Only the instance owner can let routine replies send right away",
  );
});

test("the drafts figure sits beside the autonomy", async () => {
  const tree = await mountForm({
    ...VIEW,
    draftStats: { days: 30, sentUnchanged: 9, sentEdited: 2, discarded: 1 },
  });
  expect(text(tree)).toContain(
    "9 of 12 drafts sent unchanged in the last 30 days",
  );
});

test("routine on a project with connectors warns", async () => {
  const tree = await mountForm();
  expect(find(tree.output(), InlineAlert)).toBeUndefined();
  chooseAutonomy(tree, "routine");
  await settle();
  expect(find(tree.output(), InlineAlert)).toBeDefined();
  expect(text(tree)).toContain(
    "Routine replies can carry what the project's connectors",
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

function select(tree: Tree, label: string) {
  const el = find(tree.output(), OptionSelect, (p) => p.label === label);
  if (!el) throw new Error(`No select ${label}`);
  return el.props;
}

function input(tree: Tree, label: string) {
  const el = find(tree.output(), Input, (p) => p["aria-label"] === label);
  if (!el?.props.onChange) throw new Error(`No input ${label}`);
  const onChange = el.props.onChange;
  // SAFETY: the form's handlers read only `target.value`.
  return {
    onChange: (event: { target: { value: string } }) =>
      onChange(event as never),
  };
}

function saveForm(tree: Tree) {
  const onSave = find(tree.output(), SettingsDialog)?.props.onSave;
  if (!onSave) throw new Error("No Save");
  onSave();
}

test("a new inbox's owner starts as whoever connects it", async () => {
  const tree = await mountForm(null);
  const owner = select(tree, "Owner");
  expect(owner.value).toBe("");
  expect(owner.options[0]).toEqual({ value: "", label: "You" });
});

test("no TLS is offered only for a server on this machine", async () => {
  const tree = await mountForm();
  const values = () =>
    select(tree, "IMAP security").options.map(
      (o: { value: string }) => o.value,
    );
  expect(values()).toEqual(["implicit", "starttls"]);
  input(tree, "IMAP server").onChange({ target: { value: "localhost" } });
  await settle();
  expect(values()).toEqual(["implicit", "starttls", "none"]);
});

test("a changed server asks for its password again", async () => {
  const tree = await mountForm();
  input(tree, "SMTP port").onChange({ target: { value: "587" } });
  await settle();
  const field = find(
    tree.output(),
    (await import("../incidents/FormParts")).FormField,
    (p) => p.label === "SMTP password",
  );
  expect(field?.props.hint).toBe(
    "Enter the password again for the changed server",
  );
  saveForm(tree);
  await settle();
  expect(calls).toEqual([]);
  expect(find(tree.output(), SettingsDialog)!.props.error).toBe(
    "Enter the SMTP password again for the changed server",
  );
});

test("someone else's change refreshes the list and offers Reload", async () => {
  patchError = new ApiError(
    "Someone else changed this inbox. Reload and try again",
    409,
  );
  const tree = await mountForm();
  input(tree, "Name shown to customers").onChange({
    target: { value: "Acme support" },
  });
  await settle();
  saveForm(tree);
  await settle();
  expect(saved).toBe(1);
  button(tree, "Reload").onClick();
  expect(reloaded).toBe(1);
});

test("Turn off asks before it drops unsaved edits", async () => {
  const tree = await mountForm();
  input(tree, "Name shown to customers").onChange({
    target: { value: "Acme support" },
  });
  await settle();
  button(tree, "Turn off").onClick();
  await settle();
  expect(calls).toEqual([]);
  const request = find(tree.output(), ConfirmDialog)?.props.request;
  expect(request?.title).toBe("Discard your changes?");
  request!.onConfirm();
  await settle();
  expect(calls).toEqual([
    [
      "patch",
      { id: "inb_0001", patch: { expectedRevision: 2, enabled: false } },
    ],
  ]);
});

test("a new SMTP host resets the Sent copy", async () => {
  const tree = await mountForm();
  const sent = () =>
    find(
      tree.output(),
      Switch,
      (p) => p["aria-label"] === "Save a copy in Sent",
    )!.props.checked;
  expect(sent()).toBe(true);
  input(tree, "SMTP server").onChange({ target: { value: "smtp.gmail.com" } });
  await settle();
  expect(sent()).toBe(false);
});

test("without a repository the form says to add one", async () => {
  const tree = await mountForm(null, { projects: [] });
  expect(text(tree)).toContain("Add a repository first");
});
