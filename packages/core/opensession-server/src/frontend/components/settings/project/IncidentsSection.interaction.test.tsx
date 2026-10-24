// The project page's pause switch: a refusal toasts the reason, a pause
// that lands offers Undo. The section's own hooks run in the hook
// harness; children are read, not rendered.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type * as React from "react";
import type { ProjectSettingsView } from "../../../../shared/project-settings";
import { READY_4_OF_6 } from "../../../../shared/project-settings-fixtures";
import type { ProjectPatchBody } from "../../../lib/project-settings/save";
import {
  createHookHarness,
  find,
  reactWithHarness,
  settle,
} from "../../../tools/hook-harness";

const harness = createHookHarness();
const realReact = await import("react");
mock.module("react", () => reactWithHarness({ ...realReact }, harness));
mock.module("../../../hooks/useIncidents", () => ({
  useSignals: () => ({ data: [], mutate: async () => [] }),
}));
mock.module("../../../hooks/useProjects", () => ({
  revalidateProjects: () => {},
}));

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

const { IncidentsSection } = await import("./IncidentsSection");
const { Switch } = await import("../../../ui/switch");
type SwitchChange = NonNullable<
  Parameters<typeof Switch>[0]["onCheckedChange"]
>;

const saves: ProjectPatchBody[] = [];
let refuse: Error | null = null;
const onSave = async (body: ProjectPatchBody) => {
  saves.push(body);
  if (refuse) throw refuse;
};

beforeEach(() => {
  toasts.length = 0;
  saves.length = 0;
  refuse = null;
});
afterEach(() => harness.unmountAll());

const mountSection = (view: ProjectSettingsView = READY_4_OF_6) =>
  harness.mount(IncidentsSection, {
    project: "acme-web",
    view,
    addSignal: null,
    onAddSignalClose: () => {},
    onSave,
  });

const pauseSwitch = (tree: React.ReactNode) => {
  const el = find(tree, Switch, (p) => p["aria-label"] === "Pause all agents");
  if (!el?.props.onCheckedChange) throw new Error("No pause switch");
  return el;
};

/** Flip the pause switch the way Base UI reports a change. */
const pause = (tree: React.ReactNode, on: boolean) =>
  // SAFETY: the handler reads only the checked value.
  pauseSwitch(tree).props.onCheckedChange!(
    on,
    {} as Parameters<SwitchChange>[1],
  );

test("the pause switch is a 44px target", () => {
  const section = mountSection();
  const className = String(pauseSwitch(section.output()).props.className);
  // A 24px track grown by 10px above and below.
  expect(className).toContain("before:-inset-y-2.5");
});

test("a refused pause toasts the server's reason", async () => {
  refuse = new Error("Only a signed-in person may change this");
  const section = mountSection();
  pause(section.output(), true);
  await settle();
  expect(saves).toEqual([{ incidents: { agentsPaused: true } }]);
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
  expect(toasts[0]?.message).toBe("Agents paused for acme-web");
  refuse = new Error("offline");
  toasts[0]?.options?.action?.onClick();
  await settle();
  expect(saves).toEqual([
    { incidents: { agentsPaused: true } },
    { incidents: { agentsPaused: false } },
  ]);
  expect(toasts[1]).toEqual({
    message: "offline",
    options: { variant: "error" },
  });
});
