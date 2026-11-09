import * as React from "react";
import {
  Input,
  Textarea,
  Select as NativeSelect,
  Field,
  FieldGrid,
} from "../../../packages/core/opensession-server/src/frontend/ui/input";
import { Checkbox } from "../../../packages/core/opensession-server/src/frontend/ui/checkbox";
import {
  Radio,
  RadioGroup,
} from "../../../packages/core/opensession-server/src/frontend/ui/radio";
import {
  Switch,
  SwitchIndicator,
} from "../../../packages/core/opensession-server/src/frontend/ui/switch";
import {
  Segmented,
  SegmentedOption,
} from "../../../packages/core/opensession-server/src/frontend/ui/segmented";
import {
  Select,
  OptionSelect,
} from "../../../packages/core/opensession-server/src/frontend/ui/select";
import {
  Combobox,
  SearchSelect,
  type ComboboxOption,
} from "../../../packages/core/opensession-server/src/frontend/ui/combobox";
import { DateRangeField } from "../../../packages/core/opensession-server/src/frontend/ui/date-picker";
import {
  addDays,
  todayIsoDay,
} from "../../../packages/core/opensession-server/src/frontend/lib/date-grid";
import {
  TimeOfDayField,
  TimeZoneField,
} from "../../../packages/core/opensession-server/src/frontend/ui/time-of-day";
import {
  IconTerminal,
  IconGlobe,
  IconServer,
  IconDensityDefault,
  IconDensityCompact,
} from "../../../packages/core/opensession-server/src/frontend/components/icons";
import type { Section } from "../entry";

const noop = () => {};
const SIZES = ["sm", "md", "lg"] as const;
const POPUP = ".app-menu-popup";

/** Clicks the first button inside on mount: for controls that keep their open
 *  state private (DateRangeField), so the real popup renders. */
function AutoOpen({ children }: { children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const t = setTimeout(
      () =>
        ref.current
          ?.querySelector<HTMLButtonElement>(
            'button[aria-label^="Date range,"]',
          )
          ?.click(),
      30,
    );
    return () => clearTimeout(t);
  }, []);
  return (
    <div ref={ref} style={{ display: "contents" }}>
      {children}
    </div>
  );
}

/** Drops SVG paths the stylesheet hides (the checkbox draws a check and a
 *  dash and shows one), so the serializer, which copies SVG markup without
 *  its classes' CSS, does not draw both. */
function DropHiddenPaths({ children }: { children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    for (const p of ref.current?.querySelectorAll("svg path") ?? [])
      if (getComputedStyle(p).display === "none") p.remove();
  });
  return (
    <div ref={ref} className="flex">
      {children}
    </div>
  );
}

const optionLabel = "flex items-center gap-2 text-control-label text-fg";

/* ---------------- Input ---------------- */

const inputSection: Section[] = [
  {
    group: "Input",
    title: "Sizes",
    specimens: SIZES.flatMap((s) => [
      {
        name: `${s} · value`,
        width: 280,
        node: <Input size={s} defaultValue="Wallet pass redesign" />,
      },
      {
        name: `${s} · placeholder`,
        width: 280,
        node: <Input size={s} placeholder="Project name" />,
      },
    ]),
  },
  {
    group: "Input",
    title: "States",
    specimens: [
      {
        name: "md · default",
        width: 280,
        node: <Input defaultValue="Wallet pass redesign" />,
      },
      {
        name: "md · focus",
        width: 280,
        node: <Input autoFocus defaultValue="Wallet pass redesign" />,
      },
      {
        name: "md · disabled",
        width: 280,
        node: <Input disabled defaultValue="Wallet pass redesign" />,
      },
      {
        name: "md · long text",
        width: 280,
        node: (
          <Input defaultValue="Reconcile September Stripe payouts against the ledger export" />
        ),
      },
    ],
  },
  {
    group: "Input",
    title: "Textarea",
    specimens: [
      ...SIZES.map((s) => ({
        name: `textarea · ${s} · value`,
        width: 360,
        node: (
          <Textarea
            size={s}
            rows={3}
            defaultValue="Every weekday at 9:00, summarize new reviews and post the digest to the team channel."
          />
        ),
      })),
      {
        name: "textarea · md · placeholder",
        width: 360,
        node: (
          <Textarea rows={3} placeholder="What should this automation do?" />
        ),
      },
      {
        name: "textarea · md · focus",
        width: 360,
        node: (
          <Textarea
            rows={3}
            autoFocus
            defaultValue="Track the habit streak and nudge me at 20:00."
          />
        ),
      },
      {
        name: "textarea · md · disabled",
        width: 360,
        node: (
          <Textarea
            rows={3}
            disabled
            defaultValue="Track the habit streak and nudge me at 20:00."
          />
        ),
      },
    ],
  },
  {
    group: "Input",
    title: "Native select",
    specimens: [
      ...SIZES.map((s) => ({
        name: `native select · ${s} · default`,
        width: 240,
        node: (
          <NativeSelect size={s} defaultValue="opus">
            <option value="opus">Opus 4.5</option>
            <option value="sonnet">Sonnet 4.5</option>
          </NativeSelect>
        ),
      })),
      {
        name: "native select · md · disabled",
        width: 240,
        node: (
          <NativeSelect disabled defaultValue="opus">
            <option value="opus">Opus 4.5</option>
          </NativeSelect>
        ),
      },
    ],
  },
];

/* ---------------- Field ---------------- */

const fieldSection: Section[] = [
  {
    group: "Field",
    title: "Field",
    specimens: [
      {
        name: "field · input · default",
        width: 360,
        node: (
          <Field className="w-full" label="Project name">
            <Input defaultValue="Wallet pass redesign" />
          </Field>
        ),
      },
      {
        name: "field · input · placeholder",
        width: 360,
        node: (
          <Field className="w-full" label="Repository URL">
            <Input placeholder="https://github.com/acme/wallet" />
          </Field>
        ),
      },
      {
        name: "field · textarea · default",
        width: 360,
        node: (
          <Field className="w-full" label="Instructions">
            <Textarea
              rows={3}
              defaultValue="Reconcile September Stripe payouts and flag anything over 50 EUR."
            />
          </Field>
        ),
      },
      {
        name: "field · select · default",
        width: 360,
        node: (
          <Field className="w-full" label="Model">
            <OptionSelect
              label="Model"
              value="opus"
              onChange={noop}
              options={[
                { value: "opus", label: "Opus 4.5" },
                { value: "sonnet", label: "Sonnet 4.5" },
              ]}
              className="w-full"
            />
          </Field>
        ),
      },
      {
        name: "field · input · disabled",
        width: 360,
        node: (
          <Field className="w-full" label="Workspace id">
            <Input disabled defaultValue="ws_8f2a1c" />
          </Field>
        ),
      },
    ],
  },
  {
    group: "Field",
    title: "Field grid",
    specimens: [
      {
        name: "grid · desktop · default",
        width: 480,
        node: (
          <FieldGrid className="w-full">
            <Field label="Runner id">
              <Input defaultValue="mac-mini-02" />
            </Field>
            <Field label="Login">
              <Input defaultValue="kacper" />
            </Field>
          </FieldGrid>
        ),
      },
      {
        name: "grid · phone · default",
        width: 358,
        viewport: 390,
        node: (
          <FieldGrid className="w-full">
            <Field label="Runner id">
              <Input defaultValue="mac-mini-02" />
            </Field>
            <Field label="Login">
              <Input defaultValue="kacper" />
            </Field>
          </FieldGrid>
        ),
      },
    ],
  },
];

/* ---------------- Checkbox ---------------- */

const cbState = (st: string) =>
  st === "hover"
    ? { "data-force-hover": "" }
    : st === "focus"
      ? { "data-force-focus": "" }
      : st === "disabled"
        ? { disabled: true }
        : {};

const checkboxSection: Section[] = [
  {
    group: "Checkbox",
    title: "States",
    specimens: (["unchecked", "checked", "indeterminate"] as const).flatMap(
      (c) =>
        (["default", "hover", "focus", "disabled"] as const).map((st) => ({
          name: `${c} · ${st}`,
          node: (
            <DropHiddenPaths>
              <Checkbox
                checked={c === "checked"}
                indeterminate={c === "indeterminate"}
                aria-label="Select all sessions"
                {...(cbState(st) as any)}
              />
            </DropHiddenPaths>
          ),
        })),
    ),
  },
  {
    group: "Checkbox",
    title: "With label",
    specimens: [
      {
        name: "label · unchecked",
        node: (
          <DropHiddenPaths>
            <label className={optionLabel}>
              <Checkbox checked={false} />
              Include thread replies
            </label>
          </DropHiddenPaths>
        ),
      },
      {
        name: "label · checked",
        node: (
          <DropHiddenPaths>
            <label className={optionLabel}>
              <Checkbox checked />
              Include thread replies
            </label>
          </DropHiddenPaths>
        ),
      },
      {
        name: "label · disabled",
        node: (
          <DropHiddenPaths>
            <label className={optionLabel}>
              <Checkbox checked disabled />
              Include thread replies
            </label>
          </DropHiddenPaths>
        ),
      },
      {
        name: "label · indeterminate",
        node: (
          <DropHiddenPaths>
            <label className={optionLabel}>
              <Checkbox checked={false} indeterminate />
              Select all · 3 of 8 selected
            </label>
          </DropHiddenPaths>
        ),
      },
    ],
  },
];

/* ---------------- Radio ---------------- */

const radioSection: Section[] = [
  {
    group: "Radio",
    title: "States",
    specimens: (["unchecked", "checked"] as const).flatMap((c) =>
      (["default", "hover", "focus", "disabled"] as const).map((st) => ({
        name: `${c} · ${st}`,
        node: (
          <RadioGroup
            value={c === "checked" ? "a" : null}
            disabled={st === "disabled"}
          >
            <Radio
              value="a"
              aria-label="Option"
              {...(st === "hover"
                ? { "data-force-hover": "" }
                : st === "focus"
                  ? { "data-force-focus": "" }
                  : {})}
            />
          </RadioGroup>
        ),
      })),
    ),
  },
  {
    group: "Radio",
    title: "Group",
    specimens: [
      {
        name: "group · vertical · default",
        node: (
          <RadioGroup defaultValue="ask" className="flex flex-col gap-2.5">
            <label className={optionLabel}>
              <Radio value="ask" />
              Ask before running tools
            </label>
            <label className={optionLabel}>
              <Radio value="auto" />
              Run tools automatically
            </label>
            <label className={optionLabel}>
              <Radio value="never" disabled />
              Never run tools
            </label>
          </RadioGroup>
        ),
      },
    ],
  },
];

/* ---------------- Switch ---------------- */

const switchSection: Section[] = [
  {
    group: "Switch",
    title: "States",
    specimens: (["md", "sm"] as const).flatMap((sz) =>
      (["off", "on"] as const).flatMap((c) =>
        (["default", "focus", "disabled"] as const).map((st) => ({
          name: `${sz} · ${c} · ${st}`,
          node: (
            <Switch
              size={sz}
              checked={c === "on"}
              aria-label="Notify when runs finish"
              {...(st === "focus"
                ? { "data-force-focus": "" }
                : st === "disabled"
                  ? { disabled: true }
                  : {})}
            />
          ),
        })),
      ),
    ),
  },
  {
    group: "Switch",
    title: "Indicator",
    specimens: (["sm", "md"] as const).flatMap((sz) => [
      {
        name: `indicator · ${sz} · off`,
        node: <SwitchIndicator size={sz} on={false} />,
      },
      {
        name: `indicator · ${sz} · on`,
        node: <SwitchIndicator size={sz} on />,
      },
    ]),
  },
];

/* ---------------- Segmented ---------------- */

const ranges = ["7d", "14d", "30d", "90d"];

const segmentedSection: Section[] = [
  {
    group: "Segmented",
    title: "Sizes",
    specimens: (["md", "sm"] as const).flatMap((sz) => [
      {
        name: `${sz} · text · selected`,
        node: (
          <Segmented label="Range" size={sz} value="30d" onValueChange={noop}>
            {ranges.map((r) => (
              <SegmentedOption key={r} value={r}>
                {r}
              </SegmentedOption>
            ))}
          </Segmented>
        ),
      },
      {
        name: `${sz} · two options · selected`,
        node: (
          <Segmented
            label="Density"
            size={sz}
            value="default"
            onValueChange={noop}
          >
            <SegmentedOption value="default">Default</SegmentedOption>
            <SegmentedOption value="compact">Compact</SegmentedOption>
          </Segmented>
        ),
      },
    ]),
  },
  {
    group: "Segmented",
    title: "States",
    specimens: [
      {
        name: "md · option · hover",
        node: (
          <Segmented label="Range" value="7d" onValueChange={noop}>
            <SegmentedOption value="7d">7d</SegmentedOption>
            <SegmentedOption value="30d" data-force-hover="">
              30d
            </SegmentedOption>
            <SegmentedOption value="90d">90d</SegmentedOption>
          </Segmented>
        ),
      },
      {
        name: "md · option · disabled",
        node: (
          <Segmented label="Range" value="7d" onValueChange={noop}>
            <SegmentedOption value="7d">7d</SegmentedOption>
            <SegmentedOption value="30d">30d</SegmentedOption>
            <SegmentedOption value="90d" disabled>
              90d
            </SegmentedOption>
          </Segmented>
        ),
      },
      {
        name: "md · all · disabled",
        node: (
          <Segmented
            label="Voice backend"
            value="local"
            onValueChange={noop}
            disabled
          >
            <SegmentedOption value="local">On device</SegmentedOption>
            <SegmentedOption value="cloud">Cloud</SegmentedOption>
          </Segmented>
        ),
      },
      {
        name: "md · none · unselected",
        node: (
          <Segmented label="Range" value={null} onValueChange={noop}>
            {ranges.map((r) => (
              <SegmentedOption key={r} value={r}>
                {r}
              </SegmentedOption>
            ))}
          </Segmented>
        ),
      },
      {
        name: "md · icon · selected",
        node: (
          <Segmented label="Density" value="compact" onValueChange={noop}>
            <SegmentedOption value="default">
              <IconDensityDefault size={16} />
              Default
            </SegmentedOption>
            <SegmentedOption value="compact">
              <IconDensityCompact size={16} />
              Compact
            </SegmentedOption>
          </Segmented>
        ),
      },
    ],
  },
  {
    group: "Segmented",
    title: "Phone",
    specimens: [
      {
        name: "phone · text · selected",
        viewport: 390,
        node: (
          <Segmented label="Range" value="30d" onValueChange={noop}>
            {ranges.map((r) => (
              <SegmentedOption key={r} value={r}>
                {r}
              </SegmentedOption>
            ))}
          </Segmented>
        ),
      },
    ],
  },
];

/* ---------------- Time of day ---------------- */

const timeSection: Section[] = [
  {
    group: "Time of day",
    title: "Time",
    specimens: [
      {
        name: "time · md · default",
        width: 160,
        node: (
          <TimeOfDayField
            label="From"
            value="23:00"
            onChange={noop}
            className="w-full"
          />
        ),
      },
      {
        name: "time · md · focus",
        width: 160,
        node: (
          <TimeOfDayField
            label="From"
            value="23:00"
            onChange={noop}
            className="w-full"
            {...({ autoFocus: true } as any)}
          />
        ),
      },
      {
        name: "time · md · invalid",
        width: 160,
        node: (
          <TimeOfDayField
            label="To"
            value="22:30"
            onChange={noop}
            aria-invalid
            className="w-full"
          />
        ),
      },
      {
        name: "time · md · disabled",
        width: 160,
        node: (
          <TimeOfDayField
            label="From"
            value="06:00"
            onChange={noop}
            disabled
            className="w-full"
          />
        ),
      },
    ],
  },
  {
    group: "Time of day",
    title: "Time zone",
    specimens: [
      {
        name: "zone · md · default",
        node: <TimeZoneField value="Europe/Warsaw" onChange={noop} />,
      },
      {
        name: "zone · md · long",
        node: (
          <TimeZoneField
            value="America/Argentina/Buenos_Aires"
            onChange={noop}
          />
        ),
      },
      {
        name: "zone · md · disabled",
        node: <TimeZoneField value="Europe/Warsaw" onChange={noop} disabled />,
      },
    ],
  },
  {
    group: "Time of day",
    title: "Window",
    specimens: [
      {
        name: "window · desktop · default",
        width: 480,
        node: (
          <div className="flex w-full flex-col gap-3">
            <FieldGrid className="w-full">
              <Field label="From">
                <TimeOfDayField label="From" value="23:00" onChange={noop} />
              </Field>
              <Field label="To">
                <TimeOfDayField label="To" value="06:00" onChange={noop} />
              </Field>
            </FieldGrid>
            <Field label="Time zone">
              <TimeZoneField
                value="Europe/Warsaw"
                onChange={noop}
                className="w-full"
              />
            </Field>
          </div>
        ),
      },
      {
        name: "window · phone · default",
        width: 358,
        viewport: 390,
        node: (
          <div className="flex w-full flex-col gap-3">
            <FieldGrid className="w-full">
              <Field label="From">
                <TimeOfDayField label="From" value="23:00" onChange={noop} />
              </Field>
              <Field label="To">
                <TimeOfDayField label="To" value="06:00" onChange={noop} />
              </Field>
            </FieldGrid>
            <Field label="Time zone">
              <TimeZoneField
                value="Europe/Warsaw"
                onChange={noop}
                className="w-full"
              />
            </Field>
          </div>
        ),
      },
    ],
  },
];

/* ---------------- Select ---------------- */

const models = [
  { value: "opus", label: "Opus 4.5" },
  { value: "sonnet", label: "Sonnet 4.5" },
  { value: "haiku", label: "Haiku 4.5" },
];
const runners = [
  { value: "local", label: "This Mac", icon: <IconTerminal size={16} /> },
  { value: "mini", label: "mac-mini-02", icon: <IconServer size={16} /> },
  { value: "cloud", label: "Cloud runner", icon: <IconGlobe size={16} /> },
];
const triggerState = (st: string) =>
  st === "hover"
    ? { "data-force-hover": "" }
    : st === "disabled"
      ? { disabled: true }
      : {};

function OpenSelect({
  children,
  items,
  value,
}: {
  children: React.ReactNode;
  items: { value: string; label: string }[];
  value: string | null;
}) {
  return (
    <Select.Root items={items} value={value} open onOpenChange={noop}>
      {children}
    </Select.Root>
  );
}

const selectSection: Section[] = [
  {
    group: "Select",
    title: "Trigger sizes",
    specimens: SIZES.map((s) => ({
      name: `${s} · value · default`,
      node: (
        <OptionSelect
          label="Model"
          size={s}
          value="opus"
          onChange={noop}
          options={models}
        />
      ),
    })),
  },
  {
    group: "Select",
    title: "Trigger states",
    specimens: [
      {
        name: "md · value · default",
        node: (
          <OptionSelect
            label="Model"
            value="opus"
            onChange={noop}
            options={models}
          />
        ),
      },
      {
        name: "md · value · hover",
        node: (
          <Select.Root items={models} value="opus">
            <Select.Trigger
              aria-label="Model"
              sizeTo={models.map((m) => m.label)}
              {...(triggerState("hover") as any)}
            />
          </Select.Root>
        ),
      },
      {
        name: "md · value · disabled",
        node: (
          <OptionSelect
            label="Model"
            value="opus"
            onChange={noop}
            options={models}
            disabled
          />
        ),
      },
      {
        name: "md · value · open",
        node: (
          <OpenSelect items={models} value="opus">
            <Select.Trigger
              aria-label="Model"
              sizeTo={models.map((m) => m.label)}
            />
            <Select.Popup>
              {models.map((m) => (
                <Select.Item key={m.value} value={m.value}>
                  {m.label}
                </Select.Item>
              ))}
            </Select.Popup>
          </OpenSelect>
        ),
      },
      {
        name: "md · placeholder · default",
        node: (
          <Select.Root items={models} value={null}>
            <Select.Trigger aria-label="Model" placeholder="Choose a model" />
          </Select.Root>
        ),
      },
      {
        name: "md · icon · default",
        node: (
          <OptionSelect
            label="Runner"
            value="mini"
            onChange={noop}
            options={runners}
          />
        ),
      },
      {
        name: "md · long text · truncated",
        width: 180,
        node: (
          <Select.Root
            items={[
              { value: "p", label: "Reconcile September Stripe payouts" },
            ]}
            value="p"
          >
            <Select.Trigger aria-label="Project" className="w-full" />
          </Select.Root>
        ),
      },
    ],
  },
  {
    group: "Select",
    title: "Popup",
    specimens: [
      {
        name: "popup · text · selected",
        select: POPUP,
        node: (
          <OpenSelect items={models} value="sonnet">
            <Select.Trigger aria-label="Model" />
            <Select.Popup>
              {models.map((m) => (
                <Select.Item key={m.value} value={m.value}>
                  {m.label}
                </Select.Item>
              ))}
            </Select.Popup>
          </OpenSelect>
        ),
      },
      {
        name: "popup · icon · selected",
        select: POPUP,
        node: (
          <OpenSelect items={runners} value="local">
            <Select.Trigger aria-label="Runner" icon={runners[0].icon} />
            <Select.Popup>
              {runners.map((m) => (
                <Select.Item key={m.value} value={m.value} icon={m.icon}>
                  {m.label}
                </Select.Item>
              ))}
            </Select.Popup>
          </OpenSelect>
        ),
      },
      {
        name: "popup · grouped · disabled item",
        select: POPUP,
        node: (
          <OpenSelect
            items={[
              ...models,
              { value: "gpt", label: "GPT-5" },
              { value: "gemini", label: "Gemini 3 Pro" },
            ]}
            value="opus"
          >
            <Select.Trigger aria-label="Model" />
            <Select.Popup>
              <Select.Group>
                <Select.GroupLabel>Anthropic</Select.GroupLabel>
                {models.map((m) => (
                  <Select.Item key={m.value} value={m.value}>
                    {m.label}
                  </Select.Item>
                ))}
              </Select.Group>
              <Select.Separator />
              <Select.Group>
                <Select.GroupLabel>Other providers</Select.GroupLabel>
                <Select.Item value="gpt">GPT-5</Select.Item>
                <Select.Item value="gemini" disabled>
                  Gemini 3 Pro
                </Select.Item>
              </Select.Group>
            </Select.Popup>
          </OpenSelect>
        ),
      },
    ],
  },
];

/* ---------------- Combobox ---------------- */

const channels: ComboboxOption[] = [
  { value: "eng", label: "#engineering" },
  { value: "design", label: "#design-reviews" },
  { value: "fin", label: "#finance-ops" },
  { value: "rel", label: "#releases" },
  { value: "rand", label: "#random", disabled: true },
];

function OpenCombobox({
  value,
  query,
}: {
  value: ComboboxOption | null;
  query?: string;
}) {
  return (
    <Combobox.Root
      items={channels}
      value={value}
      open
      onOpenChange={noop}
      defaultInputValue={query}
      isItemEqualToValue={(a: ComboboxOption, b: ComboboxOption) =>
        a.value === b.value
      }
    >
      <Combobox.Trigger aria-label="Channel" placeholder="Choose a channel" />
      <Combobox.Popup
        searchPlaceholder="Search channels"
        emptyText="No channels match"
      >
        {(o: ComboboxOption) => (
          <Combobox.Item key={o.value} value={o} disabled={o.disabled}>
            {o.label}
          </Combobox.Item>
        )}
      </Combobox.Popup>
    </Combobox.Root>
  );
}

const comboboxSection: Section[] = [
  {
    group: "Combobox",
    title: "Trigger",
    specimens: [
      ...SIZES.map((s) => ({
        name: `${s} · value · default`,
        node: (
          <SearchSelect
            label="Channel"
            size={s}
            value="design"
            onChange={noop}
            options={channels}
          />
        ),
      })),
      {
        name: "md · placeholder · default",
        node: (
          <SearchSelect
            label="Channel"
            value={"" as string}
            onChange={noop}
            options={channels}
            placeholder="Choose a channel"
          />
        ),
      },
      {
        name: "md · value · disabled",
        node: (
          <SearchSelect
            label="Channel"
            value="design"
            onChange={noop}
            options={channels}
            disabled
          />
        ),
      },
    ],
  },
  {
    group: "Combobox",
    title: "Popup",
    specimens: [
      {
        name: "popup · all · selected",
        select: POPUP,
        node: <OpenCombobox value={channels[1]} />,
      },
      {
        name: "popup · filtered · query",
        select: POPUP,
        node: <OpenCombobox value={channels[1]} query="re" />,
      },
      {
        name: "popup · empty · no matches",
        select: POPUP,
        node: <OpenCombobox value={null} query="figma" />,
      },
    ],
  },
  {
    group: "Combobox",
    title: "Phone",
    specimens: [
      {
        name: "phone · popup · selected",
        select: POPUP,
        viewport: 390,
        node: <OpenCombobox value={channels[1]} />,
      },
    ],
  },
];

/* ---------------- Date range ---------------- */

const today = todayIsoDay();
const presets = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
];
const last30: [string, string] = [addDays(today, -29), today];
const custom: [string, string] = ["2025-09-01", "2025-09-30"];

const dateSection: Section[] = [
  {
    group: "Date range",
    title: "Trigger",
    specimens: [
      {
        name: "desktop · preset · selected",
        node: (
          <DateRangeField
            label="Date range"
            from={last30[0]}
            to={last30[1]}
            presets={presets}
            onRangeChange={noop}
            max={today}
          />
        ),
      },
      {
        name: "desktop · custom · selected",
        node: (
          <DateRangeField
            label="Date range"
            from={custom[0]}
            to={custom[1]}
            presets={presets}
            onRangeChange={noop}
            max={today}
          />
        ),
      },
      {
        name: "desktop · no presets · default",
        node: (
          <DateRangeField
            label="Date range"
            from={custom[0]}
            to={custom[1]}
            onRangeChange={noop}
            max={today}
          />
        ),
      },
    ],
  },
  {
    group: "Date range",
    title: "Calendar",
    specimens: [
      {
        name: "desktop · calendar · open",
        select: '[role="dialog"]',
        node: (
          <AutoOpen>
            <DateRangeField
              label="Date range"
              from={custom[0]}
              to={custom[1]}
              presets={presets}
              onRangeChange={noop}
              max={today}
            />
          </AutoOpen>
        ),
      },
    ],
  },
  {
    group: "Date range",
    title: "Phone",
    specimens: [
      {
        name: "phone · trigger · default",
        viewport: 390,
        node: (
          <DateRangeField
            label="Date range"
            from={last30[0]}
            to={last30[1]}
            presets={presets}
            onRangeChange={noop}
            max={today}
          />
        ),
      },
      {
        name: "phone · calendar · open",
        viewport: 390,
        select: '[role="dialog"]',
        node: (
          <AutoOpen>
            <DateRangeField
              label="Date range"
              from={last30[0]}
              to={last30[1]}
              presets={presets}
              onRangeChange={noop}
              max={today}
            />
          </AutoOpen>
        ),
      },
    ],
  },
];

export const sections: Section[] = [
  ...inputSection,
  ...fieldSection,
  ...checkboxSection,
  ...radioSection,
  ...switchSection,
  ...segmentedSection,
  ...selectSection,
  ...comboboxSection,
  ...dateSection,
  ...timeSection,
];

export const descriptions: Record<string, string> = {
  Input:
    "ui/input.tsx · single-line, multi-line and native-select fields on the button's size scale",
  Field:
    "ui/input.tsx · a label above its control, or two short fields side by side",
  Checkbox:
    "ui/checkbox.tsx · a form option you pick, as opposed to a setting you turn on",
  Radio: "ui/radio.tsx · choose one option from a short visible set",
  Switch:
    "ui/switch.tsx · turn a setting on or off, or picture its state inside a row",
  Segmented:
    "ui/segmented.tsx · two to four short exclusive options shown in full",
  Select:
    "ui/select.tsx · pick one value from a handful in the app's own popup",
  Combobox:
    "ui/combobox.tsx · pick one value from a long list that needs a search",
  "Date range":
    "ui/date-picker.tsx · the span a page shows, as presets and a custom range on one track",
  "Time of day":
    "ui/time-of-day.tsx · a wall time in the platform's own control, and the searchable time zone beside it",
};
