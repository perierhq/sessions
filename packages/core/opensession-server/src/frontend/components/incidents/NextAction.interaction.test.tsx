// What the next-action card does when pressed: decisions, their failures,
// the push intent, Stop at the deadline, Pause and its Undo. NextAction's
// own hooks run in the hook harness; its children are read, not rendered.
import { afterEach, beforeEach, expect, jest, mock, test } from "bun:test";
import type {
  IncidentResponse,
  NextAction as ResponseNext,
  OwnerDecision,
  RedactedProjectSettings,
} from "../../../shared/incident-response";
import type { Incident } from "../../../shared/incidents";
import type { ProjectSettingsInput } from "../../lib/api/incidents";
import {
  createHookHarness,
  find,
  reactWithHarness,
  settle,
} from "../../tools/hook-harness";

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

const harness = createHookHarness();
const realReact = await import("react");
mock.module("react", () => reactWithHarness({ ...realReact }, harness));

const swrCalls: unknown[][] = [];
const realSwr = await import("swr");
mock.module("swr", () => ({
  ...realSwr,
  mutate: (...args: unknown[]) => {
    swrCalls.push(args);
    return Promise.resolve(undefined);
  },
}));

const toasts: Array<{
  message: string;
  options?: {
    variant?: string;
    action?: { label: string; onClick: () => void };
  };
}> = [];
const realToast = await import("../../ui/toast");
mock.module("../../ui/toast", () => ({
  ...realToast,
  toast: (message: string, options?: (typeof toasts)[number]["options"]) => {
    toasts.push({ message, options });
    return toasts.length;
  },
}));

const decide =
  mock<
    (id: string, decision: OwnerDecision, note?: string) => Promise<Incident>
  >();
const updateSettings =
  mock<
    (
      project: string,
      input: ProjectSettingsInput,
    ) => Promise<RedactedProjectSettings>
  >();
const realApi = await import("../../lib/api/incidents");
mock.module("../../lib/api/incidents", () => ({
  ...realApi,
  decideIncidentApi: decide,
  updateProjectSettingsApi: updateSettings,
}));

const { ApiError } = await import("../../lib/api/request");
const { apiSWRKey } = await import("../../lib/api-swr");
const { isIncidentKey } = await import("../../hooks/useIncidents");
const { NextAction, NextActionView, StopButton } = await import("./NextAction");
const { ConfirmDialog } = await import("../../ui/confirm");
const { Button } = await import("../../ui/button");
const { STOP_GRACE_MS } = await import("../../lib/incidents/next-action");
type Props = Parameters<typeof NextAction>[0];

const NOW = Date.now();
const iso = (ms: number) => new Date(NOW + ms).toISOString();

function incident(next: ResponseNext, state: Incident["state"]): Incident {
  const response: IncidentResponse = {
    phase: "deciding",
    round: 1,
    maxRounds: 2,
    agents: [],
    actionRuns: [],
    costUsd: 0,
    ownerTouched: false,
    next,
    ledger: [],
    droppedLedger: 0,
    startedAt: iso(-3_600_000),
    updatedAt: iso(-60_000),
  };
  return {
    id: "inc-1",
    project: "acme",
    title: "Search",
    state,
    severity: "major",
    owner: "Ada",
    openedBy: { kind: "rule" },
    signalIds: ["sig-a"],
    primarySignalId: "sig-a",
    openedAt: iso(-7_200_000),
    updatedAt: iso(-60_000),
    lastProblemAt: iso(-60_000),
    findings: [],
    events: [],
    droppedEvents: 0,
    response,
  };
}

const needsYou = incident(
  {
    kind: "needs-you",
    reason: "The fix is ready",
    needsYou: "policy",
    options: ["approve", "stop"],
  },
  "needs-you",
);
const working = incident(
  { kind: "working", detail: "Reading the logs" },
  "investigating",
);
const veto = (deadlineMs: number) =>
  incident({ kind: "veto", deadline: iso(deadlineMs), rule: "Rule" }, "veto");

const settings: RedactedProjectSettings = {
  project: "acme",
  agentsPaused: false,
  autonomy: "deploy-after-veto",
  vetoMs: 600_000,
  watchMs: 600_000,
  maxRounds: 2,
  neverWithoutYou: [],
  budget: { perIncidentUsd: 20, perMonthUsd: 200 },
  agents: {},
  productionRunners: [],
  actions: [],
  releases: [],
};

const props = (over: Partial<Props> = {}): Props => ({
  incident: needsYou,
  settings,
  primaryName: "Search",
  agentSessionIds: [],
  onOpenSession: () => {},
  onIntentHandled: () => {},
  ...over,
});

const view = (tree: React.ReactNode) => {
  const el = find(tree, NextActionView);
  if (!el) throw new Error("No next-action card");
  return el.props;
};
const button = (tree: React.ReactNode, kind: string, decision?: string) => {
  const found = view(tree).card.buttons.find(
    (b) => b.kind === kind && (!decision || b.decision === decision),
  );
  if (!found) throw new Error(`No ${kind} button`);
  return found;
};
const confirmOf = (tree: React.ReactNode) => find(tree, ConfirmDialog)?.props;

beforeEach(() => {
  swrCalls.length = 0;
  toasts.length = 0;
  decide.mockReset();
  updateSettings.mockReset();
});
afterEach(() => {
  harness.unmountAll();
  jest.useRealTimers();
});

test("a failed decision toasts, revalidates and frees the button", async () => {
  let fail: (error: Error) => void = () => {};
  decide.mockImplementation(() => new Promise((_, reject) => (fail = reject)));
  const card = harness.mount(NextAction, props());
  const approve = button(card.output(), "decision", "approve");
  view(card.output()).onButton(approve);
  await settle();
  expect(view(card.output()).busy).toBe(approve.key);
  fail(new Error("network down"));
  await settle();
  expect(view(card.output()).busy).toBeNull();
  expect(toasts).toEqual([
    {
      message: `Couldn't ${approve.label.toLowerCase()}: network down`,
      options: { variant: "error" },
    },
  ]);
  expect(swrCalls).toContainEqual([apiSWRKey.incident("inc-1")]);
});

test("a 409 toasts the server's own sentence", async () => {
  decide.mockRejectedValue(new ApiError("Already deploying", 409));
  const card = harness.mount(NextAction, props());
  view(card.output()).onButton(button(card.output(), "decision", "approve"));
  await settle();
  expect(toasts.map((t) => t.message)).toEqual(["Already deploying"]);
  expect(view(card.output()).busy).toBeNull();
});

test("a decision that lands updates the incident and revalidates the rest", async () => {
  decide.mockResolvedValue(needsYou);
  const card = harness.mount(NextAction, props());
  view(card.output()).onButton(button(card.output(), "decision", "approve"));
  await settle();
  expect(decide).toHaveBeenCalledWith("inc-1", "approve", undefined);
  expect(swrCalls[0]).toEqual([
    apiSWRKey.incident("inc-1"),
    needsYou,
    { revalidate: false },
  ]);
  expect(swrCalls[1]).toEqual([isIncidentKey]);
  expect(toasts).toEqual([]);
});

test("an intent opens its confirm once per arrival, and again after it clears", async () => {
  decide.mockResolvedValue(needsYou);
  let handled = 0;
  const p = props({ intent: "approve", onIntentHandled: () => handled++ });
  const card = harness.mount(NextAction, p);
  await settle();
  expect(handled).toBe(1);
  expect(confirmOf(card.output())?.open).toBe(true);
  const request = confirmOf(card.output())?.request;
  expect(request?.confirmLabel).toBe("Deploy the fix");
  request?.onConfirm();
  await settle();
  expect(decide).toHaveBeenCalledWith("inc-1", "approve", undefined);

  // The same intent while it is still in the route is not asked twice.
  card.update({ ...p });
  await settle();
  expect(handled).toBe(1);
  // The route drops it, then the same notification is tapped again.
  card.update({ ...p, intent: undefined });
  card.update({ ...p });
  await settle();
  expect(handled).toBe(2);
});

test("an intent the card no longer offers says so instead", async () => {
  const card = harness.mount(
    NextAction,
    props({ intent: "stop", incident: working }),
  );
  await settle();
  expect(toasts.map((t) => t.message)).toEqual(["Nothing to stop: round 1"]);
  expect(confirmOf(card.output())?.open).toBe(false);
});

test("Stop flips while mounted: count, grace, then the state, with a refresh", async () => {
  jest.useFakeTimers();
  let deadlines = 0;
  const stop = {
    key: "stop",
    kind: "stop" as const,
    label: "Stop",
    weight: "danger" as const,
    decision: "stop" as const,
    countdownTo: new Date(Date.now() + 2_000).toISOString(),
    doneLabel: "Deploying",
  };
  const pressed: string[] = [];
  const el = harness.mount(StopButton, {
    button: stop,
    busy: false,
    onPress: () => pressed.push("stop"),
    onDeadline: () => deadlines++,
  });
  const props = () => {
    const found = find(el.output(), Button);
    if (!found) throw new Error("No Stop button");
    return found.props;
  };
  expect(props()["aria-label"]).toBe("Stop, 0:02 left");
  jest.advanceTimersByTime(2_000);
  await settle();
  expect(deadlines).toBe(1);
  expect(props()["aria-label"]).toBeUndefined();
  expect(props().children).toBe("Stop");
  expect(props()["aria-disabled"]).toBeUndefined();
  props().onClick?.(
    // SAFETY: StopButton's handler ignores the event.
    {} as Parameters<NonNullable<ReturnType<typeof props>["onClick"]>>[0],
  );
  expect(pressed).toEqual(["stop"]);
  jest.advanceTimersByTime(STOP_GRACE_MS);
  await settle();
  expect(props().children).toBe("Deploying");
  expect(props()["aria-disabled"]).toBe(true);
  expect(props().disabled).toBeUndefined();
  expect(props().onClick).toBeUndefined();
  expect(deadlines).toBe(1);
});

test("the card refreshes the incident when the veto's deadline passes", async () => {
  const card = harness.mount(NextAction, props({ incident: veto(60_000) }));
  view(card.output()).onDeadline?.();
  expect(swrCalls).toEqual([[apiSWRKey.incident("inc-1")]]);
});

test("a scheduled Deploy now is dropped when the card stops offering it", async () => {
  jest.useFakeTimers();
  decide.mockResolvedValue(veto(60_000));
  const p = props({ incident: veto(60_000) });
  const card = harness.mount(NextAction, p);
  view(card.output()).onButton(button(card.output(), "deploy-now"));
  await settle();
  expect(view(card.output()).scheduled).not.toBeNull();
  card.update({ ...p, incident: working });
  await settle();
  jest.advanceTimersByTime(10_000);
  await settle();
  expect(decide).not.toHaveBeenCalled();
});

test("Pause agents writes the setting and its Undo writes it back once", async () => {
  updateSettings.mockResolvedValue(settings);
  const card = harness.mount(NextAction, props({ incident: working }));
  view(card.output()).onButton(button(card.output(), "pause-agents"));
  await settle();
  expect(updateSettings).toHaveBeenCalledWith("acme", { agentsPaused: true });
  expect(swrCalls).toContainEqual([apiSWRKey.incidentProject("acme")]);
  expect(toasts[0]?.message).toBe("Agents paused for acme");
  expect(view(card.output()).busy).toBeNull();
  toasts[0]?.options?.action?.onClick();
  await settle();
  expect(updateSettings).toHaveBeenLastCalledWith("acme", {
    agentsPaused: false,
  });
  // The undo's own toast offers no second undo.
  expect(toasts[1]).toEqual({
    message: "Agents resumed for acme",
    options: {},
  });
});

test("a failed pause toasts the error and frees the button", async () => {
  updateSettings.mockRejectedValue(new Error("offline"));
  const card = harness.mount(NextAction, props({ incident: working }));
  view(card.output()).onButton(button(card.output(), "pause-agents"));
  await settle();
  expect(toasts).toEqual([
    {
      message: "Couldn't pause agents: offline",
      options: { variant: "error" },
    },
  ]);
  expect(view(card.output()).busy).toBeNull();
});
