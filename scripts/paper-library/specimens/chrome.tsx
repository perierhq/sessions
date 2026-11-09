import * as React from "react";
import {
  PageHeader,
  PageTitle,
  PageDescription,
} from "../../../packages/core/opensession-server/src/frontend/ui/page-header";
import {
  PageLayout,
  PageSection,
} from "../../../packages/core/opensession-server/src/frontend/ui/page";
import {
  SettingsPanel,
  SettingsHeader,
  SettingsGroupLabel,
  SettingCard,
  SettingGroup,
  SettingCardSkeleton,
  SettingsSection,
  SettingRow,
  SettingRowText,
  SettingRowTitle,
  SettingRowDescription,
  SettingRowControl,
  StatusChip,
  SettingsHint,
  SettingsForm,
  SettingsFormTitle,
  SettingsFormRow,
  SettingsField,
  SettingsFormActions,
} from "../../../packages/core/opensession-server/src/frontend/ui/settings";
import {
  SettingRow as PanelSettingRow,
  SwitchRow,
  ValueOptions,
  ValueRow,
} from "../../../packages/core/opensession-server/src/frontend/ui/setting-row";
import {
  TopBar,
  TopBarLeading,
  TopBarTitle,
  TopBarActions,
  TopBarAction,
  TopBarBack,
  PhoneTopBar,
  PhoneTopBarTitle,
  PhoneTopBarAction,
} from "../../../packages/core/opensession-server/src/frontend/ui/top-bar";
import { Button } from "../../../packages/core/opensession-server/src/frontend/ui/button";
import { Switch } from "../../../packages/core/opensession-server/src/frontend/ui/switch";
import { Input } from "../../../packages/core/opensession-server/src/frontend/ui/input";
import { OptionSelect } from "../../../packages/core/opensession-server/src/frontend/ui/select";
import {
  Segmented,
  SegmentedOption,
} from "../../../packages/core/opensession-server/src/frontend/ui/segmented";
import { Menu } from "../../../packages/core/opensession-server/src/frontend/ui/menu";
import {
  SETTING_ROW,
  SETTING_ROW_PRESSABLE,
} from "../../../packages/core/opensession-server/src/frontend/lib/setting-row-classes";
import {
  IconPlus,
  IconShare,
  IconDotsHorizontal,
  IconX,
  IconChevronLeft,
  IconChevronDown,
  IconSidebarRight,
  IconFilter,
  IconArrowDown,
  IconFolder,
  IconClock,
  IconBolt,
  IconSearch,
  IconRestore,
} from "../../../packages/core/opensession-server/src/frontend/components/icons";
import type { Section } from "../entry";

const noop = () => {};

const force = (s: string) =>
  s === "hover"
    ? { "data-force-hover": "" }
    : s === "pressed"
      ? { "data-force-active": "", "data-force-hover": "" }
      : s === "focus"
        ? { "data-force-focus": "" }
        : {};

/* ── Settings building blocks ─────────────────────────────────────────── */

const MODEL_OPTIONS = [
  { value: "opus", label: "Opus 4.5" },
  { value: "sonnet", label: "Sonnet 4.5" },
  { value: "haiku", label: "Haiku 4.5" },
];

function SwitchSetting({
  title,
  desc,
  checked = true,
  disabled,
}: {
  title: string;
  desc?: string;
  checked?: boolean;
  disabled?: boolean;
}) {
  return (
    <SettingRow>
      <SettingRowText>
        <SettingRowTitle>{title}</SettingRowTitle>
        {desc && <SettingRowDescription>{desc}</SettingRowDescription>}
      </SettingRowText>
      <SettingRowControl>
        <Switch aria-label={title} checked={checked} disabled={disabled} />
      </SettingRowControl>
    </SettingRow>
  );
}

function SelectSetting() {
  return (
    <SettingRow>
      <SettingRowText>
        <SettingRowTitle>Default model</SettingRowTitle>
        <SettingRowDescription>
          New sessions start on this model. You can switch per session.
        </SettingRowDescription>
      </SettingRowText>
      <SettingRowControl>
        <OptionSelect
          label="Default model"
          value="opus"
          options={MODEL_OPTIONS}
          onChange={noop}
        />
      </SettingRowControl>
    </SettingRow>
  );
}

function ButtonSetting() {
  return (
    <SettingRow>
      <SettingRowText>
        <SettingRowTitle>Archive finished sessions</SettingRowTitle>
        <SettingRowDescription>
          Moves sessions merged more than 14 days ago out of the sidebar.
        </SettingRowDescription>
      </SettingRowText>
      <SettingRowControl>
        <Button variant="soft">Archive now</Button>
      </SettingRowControl>
    </SettingRow>
  );
}

function StatusSetting({
  title,
  desc,
  label,
  dot,
  action,
}: {
  title: string;
  desc: string;
  label: string;
  dot: string;
  action?: React.ReactNode;
}) {
  return (
    <SettingRow>
      <SettingRowText>
        <SettingRowTitle>{title}</SettingRowTitle>
        <SettingRowDescription>{desc}</SettingRowDescription>
      </SettingRowText>
      <SettingRowControl className="flex items-center gap-3">
        <StatusChip label={label} dot={dot} />
        {action}
      </SettingRowControl>
    </SettingRow>
  );
}

function GeneralCard() {
  return (
    <SettingCard>
      <SwitchSetting
        title="Send with Enter"
        desc="Shift+Enter adds a new line instead."
      />
      <SelectSetting />
      <SettingGroup>
        <SettingRow>
          <SettingRowText>
            <SettingRowTitle>Group sidebar by</SettingRowTitle>
            <SettingRowDescription>
              How sessions are organised in the sidebar.
            </SettingRowDescription>
          </SettingRowText>
          <SettingRowControl>
            <Segmented
              label="Group sidebar by"
              size="sm"
              value="project"
              onValueChange={noop}
            >
              <SegmentedOption value="project">Project</SegmentedOption>
              <SegmentedOption value="status">Status</SegmentedOption>
            </Segmented>
          </SettingRowControl>
        </SettingRow>
        <SwitchSetting title="Hide empty projects" checked={false} />
      </SettingGroup>
      <ButtonSetting />
    </SettingCard>
  );
}

/* ── setting-row panel ────────────────────────────────────────────────── */

const GROUP_OPTIONS = [
  { value: "none", label: "No grouping" },
  { value: "ai", label: "Purpose" },
];
const SORT_OPTIONS = [
  { value: "path", label: "Path" },
  { value: "changes", label: "Changed lines" },
  { value: "pull-request", label: "Pull request order" },
];
const LANE_OPTIONS = [
  { value: "project", label: "Project", icon: <IconFolder size={16} /> },
  { value: "recent", label: "Last activity", icon: <IconClock size={16} /> },
  { value: "automation", label: "Automation", icon: <IconBolt size={16} /> },
];

/** The floating panel these rows live in (sidebar filters, code view). */
const PANEL =
  "flex flex-col gap-0.5 rounded-popup bg-popup-glass [--smooth-ring-color:var(--popup-ring)] p-2 smooth-shadow-ring-md";

function FilePanel() {
  return (
    <div className="p-3">
      <div className={PANEL} style={{ width: 300 }}>
        <PanelSettingRow label="File list">
          <Segmented
            label="File list"
            size="sm"
            value="tree"
            onValueChange={noop}
          >
            <SegmentedOption value="flat">Flat</SegmentedOption>
            <SegmentedOption value="tree">Tree</SegmentedOption>
            <SegmentedOption value="hidden">Hidden</SegmentedOption>
          </Segmented>
        </PanelSettingRow>
        <SwitchRow label="Hide reviewed" checked onCheckedChange={noop} />
        <ValueRow
          label="Group by"
          value="ai"
          options={GROUP_OPTIONS}
          onSelect={noop}
        />
        <ValueRow
          label="Sort by"
          value="changes"
          options={SORT_OPTIONS}
          onSelect={noop}
          trailing={<IconArrowDown size={15} className="shrink-0 text-dim" />}
        />
      </div>
    </div>
  );
}

/** ValueRow with its menu open: the same parts ValueRow renders, held open. */
function OpenValueRow({
  options,
  value,
  label,
  footer,
}: {
  options: typeof SORT_OPTIONS;
  value: string;
  label: string;
  footer?: boolean;
}) {
  const current = options.find((o) => o.value === value);
  return (
    <div style={{ width: 300, paddingBottom: 200 }}>
      <Menu.Root open modal={false}>
        <Menu.Trigger className={`${SETTING_ROW} ${SETTING_ROW_PRESSABLE}`}>
          <span className="shrink-0 text-dim">{label}</span>
          <span className="ml-auto flex min-w-0 items-center gap-2 text-fg">
            <span className="truncate">{current?.label}</span>
            <IconChevronDown
              size={16}
              className="-mr-0.5 shrink-0 text-faint"
            />
          </span>
        </Menu.Trigger>
        <Menu.Popup align="end" sideOffset={6}>
          <ValueOptions value={value} options={options} onSelect={noop} />
          {footer && (
            <>
              <Menu.Separator />
              <Menu.RadioGroup value="desc">
                {[
                  ["asc", "Ascending"],
                  ["desc", "Descending"],
                ].map(([v, l]) => (
                  <Menu.RadioItem
                    key={v}
                    value={v}
                    closeOnClick
                    className="justify-between gap-3"
                  >
                    <span className="min-w-0 truncate">{l}</span>
                    <Menu.Check on={v === "desc"} />
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </>
          )}
        </Menu.Popup>
      </Menu.Root>
    </div>
  );
}

/* ── Sections ─────────────────────────────────────────────────────────── */

export const sections: Section[] = [
  /* PageHeader */
  {
    group: "Page header",
    title: "Variants",
    specimens: [
      {
        name: "title · only",
        width: 720,
        node: (
          <PageHeader className="w-full">
            <div>
              <PageTitle>Automations</PageTitle>
            </div>
          </PageHeader>
        ),
      },
      {
        name: "title · with description",
        width: 720,
        node: (
          <PageHeader className="w-full">
            <div>
              <PageTitle>Automations</PageTitle>
              <PageDescription>
                Scheduled and triggered runs across every workspace.
              </PageDescription>
            </div>
          </PageHeader>
        ),
      },
      {
        name: "title · with description and action",
        width: 720,
        node: (
          <PageHeader className="w-full">
            <div>
              <PageTitle>Automations</PageTitle>
              <PageDescription>
                Scheduled and triggered runs across every workspace.
              </PageDescription>
            </div>
            <Button variant="primary" icon={<IconPlus size={20} />}>
              New automation
            </Button>
          </PageHeader>
        ),
      },
    ],
  },
  {
    group: "Page header",
    title: "Phone",
    specimens: [
      {
        name: "phone · with description and action",
        width: 390,
        viewport: 390,
        node: (
          <PageHeader className="w-full px-3.5">
            <div>
              <PageTitle>Automations</PageTitle>
              <PageDescription>
                Scheduled and triggered runs across every workspace.
              </PageDescription>
            </div>
            <Button variant="primary" icon={<IconPlus size={20} />}>
              New automation
            </Button>
          </PageHeader>
        ),
      },
    ],
  },

  /* PageLayout */
  {
    group: "Page layout",
    title: "Desktop",
    specimens: [
      {
        name: "layout · default · title and actions",
        width: 960,
        node: (
          <PageLayout
            title="Reviews"
            description="Pull requests waiting on you, oldest first."
            actions={
              <Button variant="soft" icon={<IconShare size={20} />}>
                Share queue
              </Button>
            }
          >
            <SettingCard>
              <StatusSetting
                title="Wallet pass redesign"
                desc="opensession/web · 14 files changed"
                label="Ready"
                dot="var(--green)"
                action={<Button size="sm">Open</Button>}
              />
              <StatusSetting
                title="Reconcile September Stripe payouts"
                desc="numify/ledger · 3 files changed"
                label="Changes requested"
                dot="var(--yellow)"
                action={<Button size="sm">Open</Button>}
              />
            </SettingCard>
          </PageLayout>
        ),
      },
      {
        name: "layout · narrow · with filters",
        width: 960,
        node: (
          <PageLayout
            contentWidth="narrow"
            title="Runs"
            filters={
              <>
                <Button variant="soft" size="sm" caret>
                  All automations
                </Button>
                <Button variant="soft" size="sm" caret>
                  Last 7 days
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<IconFilter size={18} />}
                >
                  Failed only
                </Button>
              </>
            }
          >
            <SettingCardSkeleton rows={3} style={{ animation: "none" }} />
          </PageLayout>
        ),
      },
    ],
  },
  {
    group: "Page layout",
    title: "Phone",
    specimens: [
      {
        name: "phone · default · title and actions",
        width: 390,
        viewport: 390,
        node: (
          <PageLayout
            title="Reviews"
            description="Pull requests waiting on you, oldest first."
            actions={
              <Button
                variant="soft"
                className="w-full"
                icon={<IconShare size={20} />}
              >
                Share queue
              </Button>
            }
          >
            <SettingCard>
              <StatusSetting
                title="Wallet pass redesign"
                desc="opensession/web · 14 files changed"
                label="Ready"
                dot="var(--green)"
              />
            </SettingCard>
          </PageLayout>
        ),
      },
    ],
  },
  {
    group: "Page layout",
    title: "Page section",
    specimens: [
      {
        name: "section · default",
        width: 960,
        node: (
          <PageSection>
            <SettingsSection>
              <SettingRowTitle>Weekly summary</SettingRowTitle>
              <SettingRowDescription>
                12 sessions merged, 3 automations failed, 2 reviews waiting on
                you.
              </SettingRowDescription>
            </SettingsSection>
          </PageSection>
        ),
      },
      {
        name: "section · narrow",
        width: 960,
        node: (
          <PageSection contentWidth="narrow">
            <SettingsSection>
              <SettingRowTitle>Weekly summary</SettingRowTitle>
              <SettingRowDescription>
                12 sessions merged, 3 automations failed, 2 reviews waiting on
                you.
              </SettingRowDescription>
            </SettingsSection>
          </PageSection>
        ),
      },
    ],
  },

  /* Settings page */
  {
    group: "Settings page",
    title: "Composition",
    specimens: [
      {
        name: "page · general",
        width: 720,
        node: (
          <SettingsPanel>
            <SettingsHeader
              title="General"
              description="How sessions start, send and show up in the sidebar."
            />
            <SettingsGroupLabel className="mt-0">Sessions</SettingsGroupLabel>
            <GeneralCard />
            <SettingsHint>
              Changes apply to new sessions. Running sessions keep their model.
            </SettingsHint>
            <SettingsGroupLabel
              actions={
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<IconRestore size={18} />}
                >
                  Refresh
                </Button>
              }
            >
              Connected accounts
            </SettingsGroupLabel>
            <SettingCard>
              <StatusSetting
                title="GitHub"
                desc="kacper · 14 repositories"
                label="Connected"
                dot="var(--green)"
                action={
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<IconDotsHorizontal size={18} />}
                    aria-label="More"
                  />
                }
              />
              <StatusSetting
                title="Linear"
                desc="Not connected yet"
                label="Off"
                dot="var(--text-faint)"
                action={<Button size="sm">Connect</Button>}
              />
            </SettingCard>
          </SettingsPanel>
        ),
      },
    ],
  },
  {
    group: "Settings page",
    title: "Phone",
    specimens: [
      {
        name: "phone · general",
        width: 390,
        viewport: 390,
        node: (
          <SettingsPanel>
            <SettingsHeader
              title="General"
              description="How sessions start, send and show up in the sidebar."
            />
            <SettingsGroupLabel className="mt-0">Sessions</SettingsGroupLabel>
            <GeneralCard />
            <SettingsHint>
              Changes apply to new sessions. Running sessions keep their model.
            </SettingsHint>
          </SettingsPanel>
        ),
      },
    ],
  },

  /* SettingsHeader */
  {
    group: "Settings header",
    title: "Variants",
    specimens: [
      {
        name: "header · title only",
        width: 720,
        node: <SettingsHeader className="w-full" title="Notifications" />,
      },
      {
        name: "header · with description",
        width: 720,
        node: (
          <SettingsHeader
            className="w-full"
            title="Notifications"
            description="Where you hear about finished runs, failed automations and reviews waiting on you."
          />
        ),
      },
      {
        name: "header · with actions",
        width: 720,
        node: (
          <SettingsHeader
            className="w-full"
            title="Repositories"
            description="Repos sessions can check out and open pull requests against."
            actions={
              <Button variant="primary" icon={<IconPlus size={20} />}>
                Add repository
              </Button>
            }
          />
        ),
      },
    ],
  },

  /* SettingsGroupLabel */
  {
    group: "Settings group label",
    title: "Variants",
    specimens: [
      {
        name: "label · plain",
        width: 720,
        node: (
          <SettingsGroupLabel className="mt-0 w-full">
            Appearance
          </SettingsGroupLabel>
        ),
      },
      {
        name: "label · with actions",
        width: 720,
        node: (
          <SettingsGroupLabel
            className="mt-0 w-full"
            actions={
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<IconRestore size={18} />}
                >
                  Refresh
                </Button>
                <Button variant="soft" size="sm" icon={<IconPlus size={18} />}>
                  Add runner
                </Button>
              </>
            }
          >
            Runners
          </SettingsGroupLabel>
        ),
      },
    ],
  },

  /* SettingCard + rows */
  {
    group: "Setting card",
    title: "Rows",
    specimens: [
      {
        name: "card · switch rows",
        width: 640,
        node: (
          <SettingCard className="w-full">
            <SwitchSetting
              title="Finished runs"
              desc="When an automation run completes or fails."
            />
            <SwitchSetting
              title="Review requests"
              desc="When someone asks you to review a session."
              checked={false}
            />
            <SwitchSetting
              title="Weekly digest"
              desc="Push needs an HTTPS origin. It isn't available on plain http."
              checked={false}
              disabled
            />
          </SettingCard>
        ),
      },
      {
        name: "card · mixed controls",
        width: 640,
        node: (
          <div className="w-full">
            <GeneralCard />
          </div>
        ),
      },
      {
        name: "card · status and actions",
        width: 640,
        node: (
          <SettingCard className="w-full">
            <StatusSetting
              title="app.opensession.dev"
              desc="Points at this server through Caddy."
              label="Healthy"
              dot="var(--green)"
            />
            <StatusSetting
              title="hooks.opensession.dev"
              desc="Callback URL for GitHub webhooks."
              label="Checking"
              dot="var(--text-faint)"
            />
            <StatusSetting
              title="preview.opensession.dev"
              desc="Certificate expired on 3 September."
              label="Unavailable"
              dot="var(--red)"
              action={<Button size="sm">Retry</Button>}
            />
          </SettingCard>
        ),
      },
    ],
  },
  {
    group: "Setting card",
    title: "Row parts",
    specimens: [
      {
        name: "row · title only",
        width: 640,
        node: (
          <div className="w-full">
            <SettingRow>
              <SettingRowText>
                <SettingRowTitle>Compact sidebar</SettingRowTitle>
              </SettingRowText>
              <SettingRowControl>
                <Switch aria-label="Compact sidebar" checked />
              </SettingRowControl>
            </SettingRow>
          </div>
        ),
      },
      {
        name: "row · title and description",
        width: 640,
        node: (
          <div className="w-full">
            <SwitchSetting
              title="Send with Enter"
              desc="Shift+Enter adds a new line instead."
            />
          </div>
        ),
      },
      {
        name: "row · long description",
        width: 640,
        node: (
          <div className="w-full">
            <SwitchSetting
              title="Keep worktrees after merge"
              desc="Leaves the worktree on disk after a pull request merges, so you can reopen the session and pick up where the run left off. Uses roughly 400 MB per workspace."
            />
          </div>
        ),
      },
      {
        name: "row · items-start",
        width: 640,
        node: (
          <div className="w-full">
            <SettingRow className="items-start">
              <SettingRowText>
                <SettingRowTitle>Anthropic</SettingRowTitle>
                <SettingRowDescription>
                  kacper@opensession.dev · Max plan
                </SettingRowDescription>
                <SettingRowDescription>
                  68% of the weekly limit used, resets Monday.
                </SettingRowDescription>
              </SettingRowText>
              <SettingRowControl className="flex items-center gap-3">
                <StatusChip label="Signed in" dot="var(--green)" />
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<IconDotsHorizontal size={18} />}
                  aria-label="More"
                />
              </SettingRowControl>
            </SettingRow>
          </div>
        ),
      },
    ],
  },
  {
    group: "Setting card",
    title: "Phone",
    specimens: [
      {
        name: "phone · mixed controls",
        width: 390,
        viewport: 390,
        node: (
          <div className="w-full">
            <GeneralCard />
          </div>
        ),
      },
      {
        name: "phone · status and actions",
        width: 390,
        viewport: 390,
        node: (
          <SettingCard className="w-full">
            <StatusSetting
              title="preview.opensession.dev"
              desc="Certificate expired on 3 September."
              label="Unavailable"
              dot="var(--red)"
              action={<Button size="sm">Retry</Button>}
            />
          </SettingCard>
        ),
      },
    ],
  },

  /* SettingCardSkeleton */
  {
    group: "Setting card skeleton",
    title: "Variants",
    specimens: [
      {
        name: "skeleton · 3 rows",
        width: 640,
        node: (
          <div className="w-full">
            <SettingCardSkeleton style={{ animation: "none" }} />
          </div>
        ),
      },
      {
        name: "skeleton · 5 rows",
        width: 640,
        node: (
          <div className="w-full">
            <SettingCardSkeleton rows={5} style={{ animation: "none" }} />
          </div>
        ),
      },
      {
        name: "skeleton · with icon tile",
        width: 640,
        node: (
          <div className="w-full">
            <SettingCardSkeleton
              rows={3}
              icon={34}
              style={{ animation: "none" }}
            />
          </div>
        ),
      },
    ],
  },

  /* SettingsSection */
  {
    group: "Settings section",
    title: "Variants",
    specimens: [
      {
        name: "section · editor",
        width: 640,
        node: (
          <SettingsSection className="w-full">
            <SettingRowTitle>Personal prompt</SettingRowTitle>
            <SettingRowDescription>
              Added to every session you start.
            </SettingRowDescription>
            <textarea
              className="mt-3 w-full rounded-md border border-line bg-transparent p-2 text-supporting text-fg"
              rows={3}
              defaultValue="Prefer small commits. Run the tests before opening a pull request."
              readOnly
            />
          </SettingsSection>
        ),
      },
      {
        name: "section · filter bar",
        width: 640,
        node: (
          <SettingsSection className="flex w-full items-center gap-2.5">
            <Input placeholder="Search memories" className="flex-1" />
            <Button variant="soft" caret>
              All projects
            </Button>
          </SettingsSection>
        ),
      },
    ],
  },

  /* StatusChip */
  {
    group: "Status chip",
    title: "States",
    specimens: [
      {
        name: "chip · connected",
        node: <StatusChip label="Connected" dot="var(--green)" />,
      },
      {
        name: "chip · checking",
        node: <StatusChip label="Checking" dot="var(--text-faint)" />,
      },
      {
        name: "chip · degraded",
        node: <StatusChip label="Degraded" dot="var(--yellow)" />,
      },
      {
        name: "chip · unavailable",
        node: <StatusChip label="Unavailable" dot="var(--red)" />,
      },
    ],
  },

  /* SettingsHint */
  {
    group: "Settings hint",
    title: "Variants",
    specimens: [
      {
        name: "hint · one line",
        width: 640,
        node: (
          <SettingsHint className="w-full">
            Changes apply to new sessions. Running sessions keep their model.
          </SettingsHint>
        ),
      },
      {
        name: "hint · wrapping",
        width: 640,
        node: (
          <SettingsHint className="w-full">
            Runners pick up sessions in the order they were queued. A runner
            that has been offline for more than ten minutes hands its sessions
            back to the queue.
          </SettingsHint>
        ),
      },
    ],
  },

  /* SettingsForm */
  {
    group: "Settings form",
    title: "Variants",
    specimens: [
      {
        name: "form · storage",
        width: 640,
        node: (
          <SettingsForm className="w-full">
            <SettingsFormTitle>Asset storage</SettingsFormTitle>
            <SettingsField>
              Storage backend
              <OptionSelect
                label="Storage backend"
                value="s3"
                className="w-full"
                options={[
                  { value: "local", label: "Local disk" },
                  { value: "s3", label: "S3-compatible" },
                ]}
                onChange={noop}
              />
            </SettingsField>
            <SettingsFormRow>
              <SettingsField>
                Bucket
                <Input defaultValue="opensession-assets" />
              </SettingsField>
              <SettingsField>
                Region
                <Input placeholder="eu-central-1" />
              </SettingsField>
            </SettingsFormRow>
            <SettingsFormActions>
              <Button variant="soft">Cancel</Button>
              <Button variant="primary">Save storage</Button>
            </SettingsFormActions>
          </SettingsForm>
        ),
      },
      {
        name: "form · disabled",
        width: 640,
        node: (
          <SettingsForm className="w-full">
            <SettingsFormTitle>Asset storage</SettingsFormTitle>
            <SettingsFormRow>
              <SettingsField>
                Bucket
                <Input defaultValue="opensession-assets" disabled />
              </SettingsField>
              <SettingsField>
                Region
                <Input defaultValue="eu-central-1" disabled />
              </SettingsField>
            </SettingsFormRow>
            <SettingsFormActions>
              <Button variant="soft" disabled>
                Cancel
              </Button>
              <Button variant="primary" disabled>
                Saving
              </Button>
            </SettingsFormActions>
          </SettingsForm>
        ),
      },
    ],
  },
  {
    group: "Settings form",
    title: "Phone",
    specimens: [
      {
        name: "phone · storage",
        width: 390,
        viewport: 390,
        node: (
          <SettingsForm className="w-full">
            <SettingsFormTitle>Asset storage</SettingsFormTitle>
            <SettingsFormRow>
              <SettingsField>
                Bucket
                <Input defaultValue="opensession-assets" />
              </SettingsField>
              <SettingsField>
                Region
                <Input placeholder="eu-central-1" />
              </SettingsField>
            </SettingsFormRow>
            <SettingsFormActions>
              <Button variant="soft">Cancel</Button>
              <Button variant="primary">Save storage</Button>
            </SettingsFormActions>
          </SettingsForm>
        ),
      },
    ],
  },

  /* setting-row.tsx */
  {
    group: "Panel setting rows",
    title: "Composition",
    specimens: [{ name: "panel · code view settings", node: <FilePanel /> }],
  },
  {
    group: "Panel setting rows",
    title: "Switch row",
    specimens: [
      {
        name: "switch · on · default",
        width: 300,
        node: (
          <div className="w-full">
            <SwitchRow label="Hide reviewed" checked onCheckedChange={noop} />
          </div>
        ),
      },
      {
        name: "switch · off · default",
        width: 300,
        node: (
          <div className="w-full">
            <SwitchRow
              label="Hide reviewed"
              checked={false}
              onCheckedChange={noop}
            />
          </div>
        ),
      },
      {
        name: "switch · off · disabled",
        width: 300,
        node: (
          <div className="w-full">
            <SwitchRow
              label="Hide reviewed"
              checked={false}
              disabled
              onCheckedChange={noop}
            />
          </div>
        ),
      },
    ],
  },
  {
    group: "Panel setting rows",
    title: "Value row",
    specimens: [
      {
        name: "value · plain · default",
        width: 300,
        node: (
          <div className="w-full">
            <ValueRow
              label="Group by"
              value="ai"
              options={GROUP_OPTIONS}
              onSelect={noop}
            />
          </div>
        ),
      },
      {
        name: "value · plain · open",
        select: "button[data-popup-open]",
        node: (
          <OpenValueRow label="Group by" value="ai" options={GROUP_OPTIONS} />
        ),
      },
      {
        name: "value · with icon · default",
        width: 300,
        node: (
          <div className="w-full">
            <ValueRow
              label="Lanes"
              value="recent"
              options={LANE_OPTIONS}
              onSelect={noop}
            />
          </div>
        ),
      },
      {
        name: "value · with trailing · default",
        width: 300,
        node: (
          <div className="w-full">
            <ValueRow
              label="Sort by"
              value="changes"
              options={SORT_OPTIONS}
              onSelect={noop}
              trailing={
                <IconArrowDown size={15} className="shrink-0 text-dim" />
              }
            />
          </div>
        ),
      },
      {
        name: "value · long value · truncated",
        width: 240,
        node: (
          <div className="w-full">
            <ValueRow
              label="Sort by"
              value="pull-request"
              options={[
                {
                  value: "pull-request",
                  label: "Order in the pull request description",
                },
              ]}
              onSelect={noop}
            />
          </div>
        ),
      },
    ],
  },
  {
    group: "Panel setting rows",
    title: "Value options",
    specimens: [
      {
        name: "options · plain · open",
        select: '[role="menu"]',
        node: (
          <OpenValueRow label="Group by" value="ai" options={GROUP_OPTIONS} />
        ),
      },
      {
        name: "options · with icons · open",
        select: '[role="menu"]',
        node: (
          <OpenValueRow
            label="Lanes"
            value="recent"
            options={LANE_OPTIONS as any}
          />
        ),
      },
      {
        name: "options · with footer · open",
        select: '[role="menu"]',
        node: (
          <OpenValueRow
            label="Sort by"
            value="changes"
            options={SORT_OPTIONS}
            footer
          />
        ),
      },
    ],
  },
  {
    group: "Panel setting rows",
    title: "Setting row",
    specimens: [
      {
        name: "segmented · 2 options",
        width: 300,
        node: (
          <div className="w-full">
            <PanelSettingRow label="Source">
              <Segmented
                label="Diff source"
                size="sm"
                value="worktree"
                onValueChange={noop}
              >
                <SegmentedOption value="pull-request">
                  Pull request
                </SegmentedOption>
                <SegmentedOption value="worktree">Worktree</SegmentedOption>
              </Segmented>
            </PanelSettingRow>
          </div>
        ),
      },
      {
        name: "segmented · 3 options",
        width: 300,
        node: (
          <div className="w-full">
            <PanelSettingRow label="File list">
              <Segmented
                label="File list"
                size="sm"
                value="flat"
                onValueChange={noop}
              >
                <SegmentedOption value="flat">Flat</SegmentedOption>
                <SegmentedOption value="tree">Tree</SegmentedOption>
                <SegmentedOption value="hidden">Hidden</SegmentedOption>
              </Segmented>
            </PanelSettingRow>
          </div>
        ),
      },
    ],
  },
  {
    group: "Panel setting rows",
    title: "Phone",
    specimens: [
      {
        name: "phone · rows",
        width: 390,
        viewport: 390,
        node: (
          <div className="w-full p-4">
            <div className={PANEL}>
              <SwitchRow label="Hide reviewed" checked onCheckedChange={noop} />
              <ValueRow
                label="Group by"
                value="ai"
                options={GROUP_OPTIONS}
                onSelect={noop}
              />
              <PanelSettingRow label="File list">
                <Segmented
                  label="File list"
                  size="sm"
                  value="tree"
                  onValueChange={noop}
                >
                  <SegmentedOption value="flat">Flat</SegmentedOption>
                  <SegmentedOption value="tree">Tree</SegmentedOption>
                </Segmented>
              </PanelSettingRow>
            </div>
          </div>
        ),
      },
    ],
  },

  /* TopBar */
  {
    group: "Top bar",
    title: "Desktop",
    specimens: [
      {
        name: "bar · panel page · back and title",
        width: 480,
        node: (
          <TopBar
            as="header"
            className="w-full gap-1 bg-panel-surface px-2 pb-2 pt-3"
          >
            <TopBarBack
              aria-label="Back to workspace"
              iconSize={18}
              className="shrink-0 rounded-control text-dim hover:bg-hover hover:text-fg"
            />
            <TopBarTitle className="flex-1 truncate text-supporting font-semibold text-fg">
              Changed files
            </TopBarTitle>
            <TopBarActions>
              <TopBarAction
                icon={<IconFilter size={18} />}
                aria-label="Filter files"
              />
            </TopBarActions>
          </TopBar>
        ),
      },
      {
        name: "bar · column header · leading and actions",
        width: 640,
        node: (
          <TopBar as="header" className="h-10 w-full gap-2.5 px-4">
            <TopBarLeading>
              <span className="text-item-title font-semibold text-fg">
                Wallet pass redesign
              </span>
              <span className="text-supporting text-faint">#482</span>
            </TopBarLeading>
            <TopBarActions className="gap-1">
              <TopBarAction
                icon={<IconSearch size={20} />}
                aria-label="Search"
              />
              <TopBarAction icon={<IconShare size={20} />} aria-label="Share" />
              <TopBarAction
                icon={<IconSidebarRight size={20} />}
                aria-label="Toggle panel"
              />
            </TopBarActions>
          </TopBar>
        ),
      },
      {
        name: "bar · long title · truncated",
        width: 360,
        node: (
          <TopBar
            as="header"
            className="w-full gap-1 bg-panel-surface px-2 pb-2 pt-3"
          >
            <TopBarBack
              aria-label="Back to workspace"
              iconSize={18}
              className="shrink-0 rounded-control text-dim"
            />
            <TopBarTitle className="flex-1 truncate text-supporting font-semibold text-fg">
              Reconcile September Stripe payouts against the ledger export
            </TopBarTitle>
          </TopBar>
        ),
      },
    ],
  },
  {
    group: "Top bar",
    title: "Actions",
    specimens: [
      ...(["default", "hover", "pressed", "focus"] as const).map((st) => ({
        name: `action · icon · ${st}`,
        node: (
          <div className="p-1">
            <TopBarAction
              icon={<IconShare size={20} />}
              aria-label="Share"
              {...(force(st) as any)}
            />
          </div>
        ),
      })),
      {
        name: "action · icon · disabled",
        node: (
          <TopBarAction
            icon={<IconShare size={20} />}
            aria-label="Share"
            disabled
          />
        ),
      },
      ...(["default", "hover"] as const).map((st) => ({
        name: `back · default · ${st}`,
        node: <TopBarBack aria-label="Back" {...(force(st) as any)} />,
      })),
    ],
  },
  {
    group: "Top bar",
    title: "Floating on phone",
    specimens: [
      {
        name: "floating · back · default",
        viewport: 390,
        on: "--bg",
        node: (
          <div className="p-2">
            <TopBarBack aria-label="Back to sessions" floating />
          </div>
        ),
      },
      {
        name: "floating · action · default",
        viewport: 390,
        on: "--bg",
        node: (
          <div className="p-2">
            <TopBarAction
              icon={<IconDotsHorizontal size={20} />}
              aria-label="More"
              floating
            />
          </div>
        ),
      },
    ],
  },
  {
    group: "Phone top bar",
    title: "Variants",
    specimens: [
      {
        name: "bar · title and close",
        width: 390,
        viewport: 390,
        node: (
          <PhoneTopBar className="w-full">
            <PhoneTopBarTitle>Settings</PhoneTopBarTitle>
            <PhoneTopBarAction
              className="absolute right-3"
              aria-label="Close settings"
              icon={<IconX size={24} />}
            />
          </PhoneTopBar>
        ),
      },
      {
        name: "bar · back, title and close",
        width: 390,
        viewport: 390,
        node: (
          <PhoneTopBar className="w-full">
            <PhoneTopBarAction
              className="absolute left-3"
              aria-label="Back to settings"
              icon={<IconChevronLeft size={24} />}
            />
            <PhoneTopBarTitle>Notifications</PhoneTopBarTitle>
            <PhoneTopBarAction
              className="absolute right-3"
              aria-label="Close settings"
              icon={<IconX size={24} />}
            />
          </PhoneTopBar>
        ),
      },
      {
        name: "bar · back and large title",
        width: 390,
        viewport: 390,
        node: (
          <PhoneTopBar className="w-full">
            <PhoneTopBarAction
              className="absolute left-3"
              aria-label="Back to actions"
              icon={<IconChevronLeft size={24} />}
            />
            <PhoneTopBarTitle className="text-section-title">
              Move to lane
            </PhoneTopBarTitle>
          </PhoneTopBar>
        ),
      },
    ],
  },
  {
    group: "Phone top bar",
    title: "Action",
    specimens: [
      ...(["default", "hover", "pressed", "focus"] as const).map((st) => ({
        name: `action · close · ${st}`,
        viewport: 390,
        node: (
          <div className="p-1">
            <PhoneTopBarAction
              aria-label="Close"
              icon={<IconX size={24} />}
              {...(force(st) as any)}
            />
          </div>
        ),
      })),
      {
        name: "action · close · disabled",
        viewport: 390,
        node: (
          <PhoneTopBarAction
            aria-label="Close"
            icon={<IconX size={24} />}
            disabled
          />
        ),
      },
    ],
  },
];

export const descriptions: Record<string, string> = {
  "Page header":
    "ui/page-header.tsx · the title row at the top of a full page, with optional description and actions",
  "Page layout":
    "ui/page.tsx · the scrolling shell of a full page, centring content at a fixed reading width",
  "Settings page":
    "ui/settings.tsx · a settings panel assembled from header, group labels, cards and hints",
  "Settings header":
    "ui/settings.tsx · the title every settings panel opens with",
  "Settings group label":
    "ui/settings.tsx · the label above a group of settings, with the group's own actions",
  "Setting card":
    "ui/settings.tsx · a group of setting rows, each a title and description beside its control",
  "Setting card skeleton":
    "ui/settings.tsx · ghost rows standing in for a settings group that is still loading",
  "Settings section":
    "ui/settings.tsx · a settings block for content that is not a list of rows",
  "Status chip":
    "ui/settings.tsx · a row's state as a dot and a word, read before its actions",
  "Settings hint": "ui/settings.tsx · a quiet sentence under a settings group",
  "Settings form":
    "ui/settings.tsx · a block of labelled fields with save and cancel",
  "Panel setting rows":
    "ui/setting-row.tsx · one-line settings inside a popover, a switch, segmented or value per row",
  "Top bar":
    "ui/top-bar.tsx · leading, title and action slots for a desktop pane or page header",
  "Phone top bar":
    "ui/top-bar.tsx · the 44px phone navigation row with a centred title and disc actions",
};
