// The project page's Lead section: the switch saves, a refusal shows inline
// with the server's reason, and pinned rules can't be changed.
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

const { LeadSection } = await import("./LeadSection");
const { Switch } = await import("../../../ui/switch");
const { OptionSelect } = await import("../../../ui/select");
const { InlineAlert } = await import("../../../ui/state");
const { Segmented } = await import("../../../ui/segmented");
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
    (p) => p.label === "Who decides ci repair",
  );
  select!.props.onChange("alone");
  await settle();
  expect(saves).toEqual([{ lead: { rules: { "ci-repair": "alone" } } }]);
  const alert = find(section.output(), InlineAlert);
  expect(alert?.props.children).toBe(reason);
});

test("pinned rules are disabled", () => {
  const section = harness.mount(LeadSection, {
    view: withLead({ enabled: true }),
    onSave,
  });
  const refund = find(
    section.output(),
    OptionSelect,
    (p) => p.label === "Who decides refunds",
  );
  expect(refund?.props.disabled).toBe(true);
  expect(refund?.props.value).toBe("only-you");
});
