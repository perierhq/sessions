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
  incidentsPaused: false,
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

test("a lock-screen Stop on a rollback veto asks to stop the rollback", async () => {
  const rollback = veto(360_000);
  // SAFETY: the card reads only `rollbackFirst` from the candidate.
  rollback.response = {
    ...rollback.response!,
    candidate: { rollbackFirst: true },
  } as IncidentResponse;
  const card = harness.mount(
    NextAction,
    props({ intent: "stop", incident: rollback }),
  );
  await settle();
  expect(confirmOf(card.output())?.request).toMatchObject({
    title: "Stop the rollback?",
    confirmLabel: "Stop",
  });
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

test("Set up a sandbox opens Settings, Sandboxes, and decides nothing", async () => {
  const sections: string[] = [];
  const setup = incident(
    {
      kind: "needs-you",
      reason: "Agents can't start: this project has no sandbox",
      needsYou: "setup",
      fix: "sandboxes",
      options: ["resolve", "close"],
    },
    "needs-you",
  );
  const card = harness.mount(
    NextAction,
    props({
      incident: setup,
      onOpenSettings: (section) => sections.push(section),
    }),
  );
  const open = button(card.output(), "open-settings");
  expect(open.label).toBe("Set up a sandbox");
  view(card.output()).onButton(open);
  await settle();
  expect(sections).toEqual(["sandboxes"]);
  expect(decide).not.toHaveBeenCalled();
});

const { AskCard } = await import("../AskCard");

/** The card in the report: the investigator stopped, three ways on. */
const agentError = incident(
  {
    kind: "needs-you",
    reason: "The investigator stopped: Session setup failed",
    needsYou: "agent-error",
    options: ["retry", "resolve", "close"],
  },
  "needs-you",
);
const askOf = (tree: React.ReactNode) => {
  const el = find(tree, AskCard);
  if (!el) throw new Error("No choice card");
  return el.props;
};

test("Try again, Mark as fixed and Close without action go without a note", async () => {
  decide.mockResolvedValue(agentError);
  for (const [label, decision] of [
    ["Try again", "retry"],
    ["Mark as fixed", "resolve"],
    ["Close without action", "close"],
  ] as const) {
    decide.mockClear();
    const card = harness.mount(NextAction, props({ incident: agentError }));
    const ask = askOf(card.output());
    // Nothing on this card needs more than the pick, and there is no
    // free-text answer that would have nowhere to go.
    expect(ask.notes).toEqual({});
    expect(ask.freeText).toBe(false);
    ask.onAnswer({ [ask.questions[0]!.question]: label }, {}, {});
    await settle();
    expect(decide).toHaveBeenCalledWith("inc-1", decision, undefined);
    harness.unmountAll();
  }
  expect(toasts).toEqual([]);
});

test("Send it back carries the note written in the card", async () => {
  const stopped = incident(
    {
      kind: "needs-you",
      reason: "Stopped by Ada",
      needsYou: "stopped",
      options: ["send-back", "close"],
    },
    "needs-you",
  );
  decide.mockResolvedValue(stopped);
  const card = harness.mount(NextAction, props({ incident: stopped }));
  const ask = askOf(card.output());
  expect(Object.keys(ask.notes ?? {})).toEqual(["Send it back"]);
  ask.onAnswer(
    { "Stopped by Ada": "Send it back" },
    { "Stopped by Ada": "Check the resume policy" },
    {},
  );
  await settle();
  expect(decide).toHaveBeenCalledWith(
    "inc-1",
    "send-back",
    "Check the resume policy",
  );
});

test("a Send it back intent points at the card instead of a confirm", async () => {
  const stopped = incident(
    {
      kind: "needs-you",
      reason: "Stopped by Ada",
      needsYou: "stopped",
      options: ["send-back", "close"],
    },
    "needs-you",
  );
  const card = harness.mount(
    NextAction,
    props({ incident: stopped, intent: "send-back" }),
  );
  await settle();
  expect(confirmOf(card.output())?.open).toBeFalsy();
  expect(toasts.map((t) => t.message)).toEqual([
    "Pick Send it back on the card and write the investigator a note",
  ]);
  expect(decide).not.toHaveBeenCalled();
});

// The investigator concluded the cause is only in logs it cannot reach.
const unreachable = (): Incident => {
  const base = incident(
    {
      kind: "needs-you",
      reason:
        "The investigator found no fix: the cause is in logs it can't reach",
      needsYou: "no-candidate",
      options: ["send-back", "resolve", "close"],
    },
    "needs-you",
  );
  base.response!.agents = [
    {
      role: "investigator",
      round: 1,
      attempt: 1,
      sessionId: "s-inv",
      model: "m",
      provider: "p",
      workspace: { kind: "sandbox", provider: "daytona" },
      accessSummary: "",
      accessRevision: "r1",
      status: "done",
      startedAt: iso(-600_000),
      turnSentAt: iso(-600_000),
      costUsd: 0.4,
      tokens: 1000,
      reminded: false,
      report: {
        role: "investigator",
        summary: "Search fails behind the proxy",
        cause: "One of a 452, 429 or 407; only the search service's logs say",
        readFirst: [{ path: "docs/incidents/runbook.md", found: true }],
        attempts: [
          {
            step: "Read the runbook",
            cost: "free",
            result: "informative",
            evidence: "Read",
          },
        ],
        candidate: null,
        noCandidateReason: "The cause is only in logs agents cannot reach",
        check: { kind: "after-deploy", reason: "Nothing to deploy" },
        claims: [],
        notePath: "docs/incidents/2026-10-20-search.md",
        runbookPaths: ["docs/incidents/runbook.md"],
        nextSteps: [
          {
            kind: "open-settings",
            title: "Let agents read the search logs",
            why: "They say which of the three it is",
            payload: "access",
          },
          {
            kind: "send-back",
            title: "Check the proxy's 407s first",
            why: "The cheapest of the three to rule out",
            payload: "Rule out the proxy's 407s before the 452s and 429s.",
          },
          {
            kind: "close-provider",
            title: "Close as the provider's problem",
            why: "Every candidate is on the provider's side",
          },
        ],
      },
    },
  ];
  return base;
};

test("suggested steps lead the card, then the fixed decisions, then a note", () => {
  const card = harness.mount(NextAction, props({ incident: unreachable() }));
  const ask = askOf(card.output());
  expect(ask.questions[0]!.options!.map((o) => o.label)).toEqual([
    "Let agents read the search logs",
    "Check the proxy's 407s first",
    "Close as the provider's problem",
    "Send it back",
    "Mark as fixed",
    "Close without action",
  ]);
  expect(ask.questions[0]!.options![0]!.description).toBe(
    "They say which of the three it is",
  );
  expect(ask.groups).toEqual([
    { label: "Suggested by the investigator", count: 3 },
    { count: 3, quiet: true },
  ]);
  expect(ask.freeText).toMatchObject({
    placeholder: "Tell the investigator…",
  });
  // The suggested send-back opens its note already written.
  expect(ask.notes?.["Check the proxy's 407s first"]).toMatchObject({
    label: "Note for the investigator",
    initial: "Rule out the proxy's 407s before the 452s and 429s.",
  });
  expect(ask.notes?.["Send it back"]?.initial).toBeUndefined();
});

test("a suggested send-back posts Send it back with the note as edited", async () => {
  const inc = unreachable();
  decide.mockResolvedValue(inc);
  const card = harness.mount(NextAction, props({ incident: inc }));
  const ask = askOf(card.output());
  const q = ask.questions[0]!.question;
  ask.onAnswer(
    { [q]: "Check the proxy's 407s first" },
    { [q]: "Rule out the 407s, then the 429s." },
    {},
  );
  await settle();
  expect(decide).toHaveBeenCalledWith(
    "inc-1",
    "send-back",
    "Rule out the 407s, then the 429s.",
  );
});

test("a suggested settings step only opens that section", async () => {
  const opened: string[] = [];
  const card = harness.mount(
    NextAction,
    props({
      incident: unreachable(),
      onOpenProjectSettings: (section) => opened.push(section),
    }),
  );
  const ask = askOf(card.output());
  const q = ask.questions[0]!.question;
  ask.onAnswer({ [q]: "Let agents read the search logs" }, {}, {});
  await settle();
  expect(opened).toEqual(["access"]);
  expect(decide).not.toHaveBeenCalled();
  expect(updateSettings).not.toHaveBeenCalled();
});

test("closing as the provider's problem is Close without action", async () => {
  const inc = unreachable();
  decide.mockResolvedValue(inc);
  const card = harness.mount(NextAction, props({ incident: inc }));
  const ask = askOf(card.output());
  const q = ask.questions[0]!.question;
  ask.onAnswer({ [q]: "Close as the provider's problem" }, {}, {});
  await settle();
  expect(decide).toHaveBeenCalledWith("inc-1", "close", undefined);
});

test("typed text sends it back with that note, even when it reads like an option", async () => {
  const inc = unreachable();
  decide.mockResolvedValue(inc);
  for (const text of ["Look at the proxy logs too", "Mark as fixed"]) {
    decide.mockClear();
    const card = harness.mount(NextAction, props({ incident: inc }));
    const ask = askOf(card.output());
    const q = ask.questions[0]!.question;
    ask.onAnswer({ [q]: text }, {}, { [q]: text });
    await settle();
    expect(decide).toHaveBeenCalledWith("inc-1", "send-back", text);
    harness.unmountAll();
  }
});

test("a refused suggestion keeps the server's refusal, as any decision does", async () => {
  decide.mockRejectedValue(new ApiError("Only an owner can decide", 403));
  const card = harness.mount(NextAction, props({ incident: unreachable() }));
  const ask = askOf(card.output());
  const q = ask.questions[0]!.question;
  ask.onAnswer({ [q]: "Close as the provider's problem" }, {}, {});
  await settle();
  expect(decide).toHaveBeenCalledWith("inc-1", "close", undefined);
  expect(toasts.map((t) => t.message)).toEqual(["Only an owner can decide"]);
});
