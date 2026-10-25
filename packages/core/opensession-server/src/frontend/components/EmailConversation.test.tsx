// The email conversation pane: its header chip, and the actions a person
// takes on it (Not spam for spam only, Forget this customer for the
// instance owner only and behind a confirm). Hooks run in the hook harness;
// children are read, not rendered.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { z } from "zod";
import type {
  InboxesResponse,
  SupportConversationView,
} from "../../shared/support";
import {
  createHookHarness,
  elements,
  find,
  reactWithHarness,
  settle,
} from "../tools/hook-harness";
import { conversation } from "../tools/support-fixture";

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

const INBOX: SupportConversationView["inbox"] = {
  id: "inb_0001",
  label: "Acme help",
  address: "help@acme.example.test",
  autonomy: "draft",
  vetoMs: 600_000,
};
const view = (c = conversation()): SupportConversationView => ({
  conversation: c,
  inbox: INBOX,
});
const fetchSupportConversation = mock(async (_id: string) => view());
const forgetCustomer = mock(async (_email: string) => ({
  conversations: 1,
  sessions: 0,
  attachments: 0,
  failed: 0,
  notDeleted: [],
}));
const markNotSpam = mock(async (_id: string) => view());
const approveIssue = mock(async (_id: string, _revision: number) => view());
const startFixSession = mock(
  async (_id: string, _revision: number, _task: string) => view(),
);
const realApi = await import("../lib/api/support");
mock.module("../lib/api/support", () => ({
  ...realApi,
  fetchSupportConversation,
  forgetCustomer,
  markNotSpam,
  approveIssue,
  startFixSession,
}));

const inboxes: InboxesResponse = {
  enabled: true,
  isInstanceOwner: true,
  projects: [{ id: "acme", supportConnectors: false }],
  inboxes: [],
};
const realSwr = await import("swr");
mock.module("swr", () => ({
  ...realSwr,
  default: () => ({ data: inboxes, error: undefined, mutate: async () => {} }),
}));

const realPeople = await import("../lib/people");
mock.module("../lib/people", () => ({
  ...realPeople,
  usePeople: () => [{ name: "Ada", fullName: "Ada Lovelace" }],
}));

const { ConfirmDialog } = await import("../ui/confirm");
const { Button } = await import("../ui/button");
const { Textarea } = await import("../ui/input");
const { Menu } = await import("../ui/menu");
const {
  EmailConversation,
  EmailConversationActions,
  FixTaskCard,
  PendingIssueCard,
} = await import("./EmailConversation");
type ActionProps = Parameters<typeof EmailConversationActions>[0];

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
const item = (tree: React.ReactNode, label: string) =>
  find(tree, Menu.Item, (p) => p.children === label)?.props;

const actionProps = (over: Partial<ActionProps> = {}): ActionProps => ({
  conversation: conversation(),
  isInstanceOwner: true,
  projects: ["acme", "acme-billing"],
  people: ["Ada", "Grace"],
  onChanged: () => {},
  ...over,
});

beforeEach(() => {
  toasts.length = 0;
  fetchSupportConversation.mockClear();
  forgetCustomer.mockClear();
  markNotSpam.mockClear();
  approveIssue.mockClear();
  startFixSession.mockClear();
});
afterEach(() => harness.unmountAll());

test("the header chip names the inbox and the project", async () => {
  const pane = harness.mount(EmailConversation, {
    itemId: "email:sc_0001",
    onOpenSession: () => {},
    headerInBar: true,
  });
  await settle();
  expect(fetchSupportConversation).toHaveBeenCalledWith("sc_0001");
  const all = strings(pane.output());
  expect(all).toContain("Acme help · acme");
  expect(all).toContain("Login broken");
  expect(all).toContain("grace@example.test");
});

test("a conversation with a session wears the Open session pill", async () => {
  fetchSupportConversation.mockImplementationOnce(async () =>
    view(conversation({ sessionId: "s1" })),
  );
  const opened: string[] = [];
  const pane = harness.mount(EmailConversation, {
    itemId: "email:sc_0001",
    onOpenSession: (id) => opened.push(id),
  });
  await settle();
  const pill = find<React.ComponentProps<"button">>(
    pane.output(),
    "button",
    (p) => p["aria-label"] === "Open session",
  );
  press(pill?.props.onClick);
  expect(opened).toEqual(["s1"]);
});

test("an agent that couldn't start says why instead", async () => {
  fetchSupportConversation.mockImplementationOnce(async () =>
    view(
      conversation({
        events: [
          {
            at: "2026-10-25T10:01:00.000Z",
            kind: "agent-cant-start",
            actor: { kind: "sessions" },
            detail:
              "Support agent can't start: the session couldn't be created",
          },
        ],
      }),
    ),
  );
  const pane = harness.mount(EmailConversation, {
    itemId: "email:sc_0001",
    onOpenSession: () => {},
  });
  await settle();
  expect(strings(pane.output())).toContain("Agent can't start");
  expect(strings(pane.output())).toContain("the session couldn't be created");
});

test("a held issue offers Create issue and Dismiss", async () => {
  fetchSupportConversation.mockImplementationOnce(async () =>
    view(
      conversation({
        pendingIssue: {
          title: "Login fails",
          body: "Steps",
          requestedBy: { kind: "agent", sessionId: "s1" },
        },
      }),
    ),
  );
  const pane = harness.mount(EmailConversation, {
    itemId: "email:sc_0001",
    onOpenSession: () => {},
  });
  await settle();
  const held = find(pane.output(), PendingIssueCard);
  if (!held) throw new Error("No held issue card");
  const card = harness.mount(PendingIssueCard, held.props);
  const all = strings(card.output());
  expect(all).toContain(
    "The agent reported a bug. The repository is public, so a person creates the issue.",
  );
  expect(all).toContain("Dismiss");
  press(
    find(card.output(), Button, (p) => p.children === "Create issue")?.props
      .onClick,
  );
  await settle();
  expect(approveIssue).toHaveBeenCalledWith("sc_0001", 1);
});

test("a suggested fix task starts a fix session as edited", async () => {
  fetchSupportConversation.mockImplementationOnce(async () =>
    view(
      conversation({
        revision: 4,
        fixTask: {
          text: "Fix the sign-in redirect",
          project: "acme",
          suggestedBy: { kind: "agent", sessionId: "s1" },
          at: "2026-10-25T10:01:00.000Z",
        },
      }),
    ),
  );
  const pane = harness.mount(EmailConversation, {
    itemId: "email:sc_0001",
    onOpenSession: () => {},
  });
  await settle();
  const suggested = find(pane.output(), FixTaskCard);
  if (!suggested) throw new Error("No fix task card");
  const card = harness.mount(FixTaskCard, suggested.props);
  expect(strings(card.output())).toContain("The agent suggests a fix");
  const area = find<React.ComponentProps<"textarea">>(
    card.output(),
    Textarea,
    (p) => p["aria-label"] === "Fix task",
  );
  expect(area?.props.value).toBe("Fix the sign-in redirect");
  const change = { target: { value: "Fix the sign-in redirect on Safari" } };
  // SAFETY: the card's change handler reads only `target.value`.
  area?.props.onChange?.(change as React.ChangeEvent<HTMLTextAreaElement>);
  await settle();
  press(
    find(card.output(), Button, (p) => p.children === "Start fix session")
      ?.props.onClick,
  );
  await settle();
  expect(startFixSession).toHaveBeenCalledWith(
    "sc_0001",
    4,
    "Fix the sign-in redirect on Safari",
  );
});

test("a spam conversation offers Not spam", async () => {
  const onChanged = mock();
  const actions = harness.mount(
    EmailConversationActions,
    actionProps({ conversation: conversation({ status: "spam" }), onChanged }),
  );
  const notSpam = item(actions.output(), "Not spam");
  expect(notSpam).toBeDefined();
  expect(item(actions.output(), "Mark as done")).toBeUndefined();
  press(notSpam?.onClick);
  await settle();
  expect(markNotSpam).toHaveBeenCalledWith("sc_0001");
  expect(onChanged).toHaveBeenCalledTimes(1);
});

test("an open conversation has no Not spam", () => {
  const actions = harness.mount(EmailConversationActions, actionProps());
  expect(item(actions.output(), "Not spam")).toBeUndefined();
});

test("Forget this customer asks first, then forgets", async () => {
  const actions = harness.mount(EmailConversationActions, actionProps());
  press(item(actions.output(), "Forget this customer")?.onClick);
  await settle();
  expect(forgetCustomer).not.toHaveBeenCalled();
  const dialog = find(actions.output(), ConfirmDialog)?.props;
  expect(dialog?.open).toBe(true);
  expect(dialog?.request?.destructive).toBe(true);
  dialog?.request?.onConfirm();
  await settle();
  expect(forgetCustomer).toHaveBeenCalledWith("grace@example.test");
});

test("only the instance owner sees Forget this customer", () => {
  const actions = harness.mount(
    EmailConversationActions,
    actionProps({ isInstanceOwner: false }),
  );
  expect(item(actions.output(), "Forget this customer")).toBeUndefined();
});
