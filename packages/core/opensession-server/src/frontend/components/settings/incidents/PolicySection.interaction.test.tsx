// What the policy controls do when a save fails (and when it lands): the
// pause switch and a select toast, a dialog keeps its error inside. The
// sections' own hooks run in the hook harness; children are read, not
// rendered.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import {
  DEFAULT_AUTONOMY,
  DEFAULT_BUDGET,
  DEFAULT_MAX_ROUNDS,
  DEFAULT_NEVER_WITHOUT_YOU,
  DEFAULT_VETO_MS,
  DEFAULT_WATCH_MS,
  type RedactedProjectSettings,
} from "../../../../shared/incident-response";
import type { ProjectSettingsInput } from "../../../lib/api/incidents";
import {
  createHookHarness,
  find,
  reactWithHarness,
  settle,
} from "../../../tools/hook-harness";

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

const toasts: Array<{
  message: string;
  options?: {
    variant?: string;
    action?: { label: string; onClick: () => void };
  };
}> = [];
const realToast = await import("../../../ui/toast");
mock.module("../../../ui/toast", () => ({
  ...realToast,
  toast: (message: string, options?: (typeof toasts)[number]["options"]) => {
    toasts.push({ message, options });
    return toasts.length;
  },
}));

const { BudgetDialog, PolicySection } = await import("./PolicySection");
const { Switch } = await import("../../../ui/switch");
type SwitchProps = Parameters<typeof Switch>[0];
const { OptionSelect } = await import("../../../ui/select");
const { SettingsDialog } = await import("./SettingsDialog");

const settings: RedactedProjectSettings = {
  project: "acme",
  agentsPaused: false,
  autonomy: DEFAULT_AUTONOMY,
  vetoMs: DEFAULT_VETO_MS,
  watchMs: DEFAULT_WATCH_MS,
  maxRounds: DEFAULT_MAX_ROUNDS,
  neverWithoutYou: DEFAULT_NEVER_WITHOUT_YOU,
  budget: DEFAULT_BUDGET,
  agents: {},
  productionRunners: [],
  actions: [],
  releases: [],
};

const saves: ProjectSettingsInput[] = [];
let refuse: Error | null = null;
const onSave = async (input: ProjectSettingsInput) => {
  saves.push(input);
  if (refuse) throw refuse;
};

beforeEach(() => {
  toasts.length = 0;
  saves.length = 0;
  refuse = null;
});
afterEach(() => harness.unmountAll());

const mountSection = () =>
  harness.mount(PolicySection, { project: "acme", settings, onSave });

type SwitchChange = NonNullable<SwitchProps["onCheckedChange"]>;

/** Flip the pause switch the way Base UI reports a change. */
const pause = (tree: React.ReactNode, on: boolean) => {
  const el = find(tree, Switch, (p) => p["aria-label"] === "Pause all agents");
  if (!el?.props.onCheckedChange) throw new Error("No pause switch");
  // SAFETY: PolicySection's handler reads only the checked value.
  el.props.onCheckedChange(on, {} as Parameters<SwitchChange>[1]);
};

test("a refused pause toasts the server's reason", async () => {
  refuse = new Error("Only a signed-in person may change this");
  const section = mountSection();
  pause(section.output(), true);
  await settle();
  expect(saves).toEqual([{ agentsPaused: true }]);
  expect(toasts).toEqual([
    {
      message: "Only a signed-in person may change this",
      options: { variant: "error" },
    },
  ]);
});

test("a pause that lands offers Undo, and a failed Undo toasts too", async () => {
  const section = mountSection();
  pause(section.output(), true);
  await settle();
  expect(toasts[0]?.message).toBe("Agents paused for acme");
  refuse = new Error("offline");
  toasts[0]?.options?.action?.onClick();
  await settle();
  expect(saves).toEqual([{ agentsPaused: true }, { agentsPaused: false }]);
  expect(toasts[1]).toEqual({
    message: "offline",
    options: { variant: "error" },
  });
});

test("a refused select change toasts, with a fallback message", async () => {
  refuse = new Error("");
  const section = mountSection();
  const autonomy = find(
    section.output(),
    OptionSelect<string>,
    (p) => p.label === "What agents may do without you",
  );
  autonomy?.props.onChange("watch");
  await settle();
  expect(saves).toEqual([{ autonomy: "watch" }]);
  expect(toasts).toEqual([
    { message: "Couldn't save the setting", options: { variant: "error" } },
  ]);
});

test("a dialog's failed save stays in the dialog and frees it", async () => {
  const section = mountSection();
  const budget = find(section.output(), BudgetDialog);
  if (!budget) throw new Error("No budget dialog");
  let fail: (error: Error) => void = () => {};
  let closed = 0;
  const dialog = harness.mount(BudgetDialog, {
    ...budget.props,
    open: true,
    onClose: () => closed++,
    onSave: () => new Promise<void>((_, reject) => (fail = reject)),
  });
  const shell = () => {
    const found = find(dialog.output(), SettingsDialog);
    if (!found) throw new Error("No dialog");
    return found.props;
  };
  shell().onSave?.();
  await settle();
  expect(shell().busy).toBe(true);
  fail(new Error("Budget too high"));
  await settle();
  expect(shell().busy).toBe(false);
  expect(shell().error).toBe("Budget too high");
  expect(closed).toBe(0);
  expect(toasts).toEqual([]);
});
