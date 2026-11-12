// The project page's Lead section: the switch saves, a refusal shows inline
// with the server's reason (once), and pinned rules read as plain text.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { ProjectSettingsView } from "../../../../shared/project-settings";
import { READY_4_OF_6 } from "../../../../shared/project-settings-fixtures";
import { ApiError } from "../../../lib/api/request";
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

const { LeadSection, LeadBudgetDialog, LeadWakesDialog, LEAD_HEADROOM_HINT } =
  await import("./LeadSection");
const { SettingLinkRow } = await import("../incidents/SettingLinkRow");
const { SettingsHint } = await import("../../../ui/settings");
const { Input } = await import("../../../ui/input");
const { Switch } = await import("../../../ui/switch");
const { OptionSelect } = await import("../../../ui/select");
const { InlineAlert } = await import("../../../ui/state");
const { Segmented } = await import("../../../ui/segmented");
const { StatusChip } = await import("../../../ui/settings");
const { SettingsDialog } = await import("../incidents/SettingsDialog");
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
  saves.length = 0;
  refuse = null;
});
afterEach(() => harness.unmountAll());

const withLead = (
  lead: Partial<ProjectSettingsView["document"]["lead"]>,
): ProjectSettingsView => ({
  ...READY_4_OF_6,
  document: {
    ...READY_4_OF_6.document,
    lead: { ...READY_4_OF_6.document.lead, ...lead },
  },
});

test("off: only the switch, and turning it on saves", async () => {
  const section = harness.mount(LeadSection, {
    view: withLead({ enabled: false }),
    onSave,
  });
  expect(find(section.output(), Segmented)).toBeUndefined();
  const el = find(section.output(), Switch, (p) => p["aria-label"] === "Lead");
  // SAFETY: the handler reads only the checked value.
  el!.props.onCheckedChange!(true, {} as Parameters<SwitchChange>[1]);
  await settle();
  expect(saves).toEqual([{ lead: { enabled: true } }]);
});

test("a refused loosening shows the server's reason inline", async () => {
  const reason =
    "Only the instance owner or the lead's owner can give the project lead more room";
  refuse = new ApiError(reason, 403);
  const section = harness.mount(LeadSection, {
    view: withLead({ enabled: true }),
    onSave,
  });
  const select = find(
    section.output(),
    OptionSelect,
    (p) => p.label === "Who decides: CI repair",
  );
  select!.props.onChange("alone");
  await settle();
  expect(saves).toEqual([{ lead: { rules: { "ci-repair": "alone" } } }]);
  const alert = find(section.output(), InlineAlert);
  expect(alert?.props.children).toBe(reason);
});

test("pinned rules are plain text, not a select", () => {
  const section = harness.mount(LeadSection, {
    view: withLead({ enabled: true }),
    onSave,
  });
  const refund = find(
    section.output(),
    OptionSelect,
    (p) => p.label === "Who decides: Refunds",
  );
  expect(refund).toBeUndefined();
  expect(JSON.stringify(section.output())).toContain("Always only you");
});

test("the chip says starting until the lead has its goal", () => {
  const chip = (lead: Parameters<typeof withLead>[0]) =>
    find(
      harness.mount(LeadSection, { view: withLead(lead), onSave }).output(),
      StatusChip,
    )?.props.label;
  expect(chip({ enabled: false })).toBe("Off");
  expect(chip({ enabled: true, goalId: undefined })).toBe("Starting");
  expect(chip({ enabled: true, goalId: "g1" })).toBe("Running");
});

test("a refused budget shows in the dialog, not again above", async () => {
  refuse = new ApiError("Too much", 403);
  const section = harness.mount(LeadSection, {
    view: withLead({ enabled: true }),
    onSave,
  });
  const budget = find(section.output(), LeadBudgetDialog);
  const dialog = harness.mount(LeadBudgetDialog, budget!.props);
  find(dialog.output(), SettingsDialog)!.props.onSave!();
  await settle();
  // Off by default: saving the empty field keeps it off.
  expect(saves).toEqual([{ lead: { budgetUsdPerMonth: null } }]);
  expect(find(dialog.output(), SettingsDialog)?.props.error).toBe("Too much");
  expect(find(section.output(), InlineAlert)).toBeUndefined();
});

test("daily wakes and an optional dollar cap, with the headroom line", () => {
  const section = harness.mount(LeadSection, {
    view: withLead({ enabled: true }),
    onSave,
  });
  const row = (title: string) =>
    find(section.output(), SettingLinkRow, (p) => p.title === title)?.props
      .value;
  expect(row("Extra daily wakes")).toBe("24");
  expect(row("Dollar cap")).toBe("Off");
  expect(row("Budget per month")).toBeUndefined();
  expect(find(section.output(), SettingsHint)?.props.children).toBe(
    LEAD_HEADROOM_HINT,
  );
  expect(LEAD_HEADROOM_HINT).toBe(
    "Leads wait while your Claude accounts are near their limits.",
  );
  const capped = harness.mount(LeadSection, {
    view: withLead({ enabled: true, budgetUsdPerMonth: 80 }),
    onSave,
  });
  expect(
    find(capped.output(), SettingLinkRow, (p) => p.title === "Dollar cap")
      ?.props.value,
  ).toBe("$80 a month");
});

test("the wakes dialog saves a whole number", async () => {
  const section = harness.mount(LeadSection, {
    view: withLead({ enabled: true }),
    onSave,
  });
  const wakes = find(section.output(), LeadWakesDialog);
  const dialog = harness.mount(LeadWakesDialog, wakes!.props);
  // SAFETY: the handler reads only currentTarget.value.
  find(dialog.output(), Input)!.props.onChange!({
    currentTarget: { value: "12" },
  } as never);
  await settle();
  find(dialog.output(), SettingsDialog)!.props.onSave!();
  await settle();
  expect(saves).toEqual([{ lead: { dailyWakeLimit: 12 } }]);
});
