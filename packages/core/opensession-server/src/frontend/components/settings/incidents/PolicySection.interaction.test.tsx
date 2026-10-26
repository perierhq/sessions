// What the policy controls do when a save fails (and when it lands): a
// select toasts, a dialog keeps its error inside. The pause switch lives on
// the project page (project/IncidentsSection.interaction.test.tsx). The
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
const { OptionSelect } = await import("../../../ui/select");
const { SettingsDialog } = await import("./SettingsDialog");

const settings: RedactedProjectSettings = {
  project: "acme",
  agentsPaused: false,
  incidentsPaused: false,
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
