import * as React from "react";
import {
  Menu,
  MENU_ICON,
} from "../../../packages/core/opensession-server/src/frontend/ui/menu";
import { Popover } from "../../../packages/core/opensession-server/src/frontend/ui/popover";
import { Tooltip } from "../../../packages/core/opensession-server/src/frontend/ui/tooltip";
import { Modal } from "../../../packages/core/opensession-server/src/frontend/ui/modal";
import { ConfirmDialog } from "../../../packages/core/opensession-server/src/frontend/ui/confirm";
import {
  ResponsiveDialog,
  SheetIconButton,
  SheetBody,
  SheetTitle,
  SheetSeparator,
  SheetItem,
  BottomSheet,
  PhonePage,
} from "../../../packages/core/opensession-server/src/frontend/ui/sheet";
import {
  ToastHost,
  toast,
  type ToastOptions,
} from "../../../packages/core/opensession-server/src/frontend/ui/toast";
import { FloatingStatus } from "../../../packages/core/opensession-server/src/frontend/ui/floating-status";
import { OverlayAction } from "../../../packages/core/opensession-server/src/frontend/ui/overlay-action";
import { Button } from "../../../packages/core/opensession-server/src/frontend/ui/button";
import { Spinner } from "../../../packages/core/opensession-server/src/frontend/ui/spinner";
import {
  PhoneTopBar,
  PhoneTopBarTitle,
} from "../../../packages/core/opensession-server/src/frontend/ui/top-bar";
import {
  IconArchive,
  IconCheckCircle,
  IconChevronLeft,
  IconChevronRight,
  IconClock,
  IconCopy,
  IconDotsHorizontal,
  IconGear,
  IconGitMerge,
  IconLink,
  IconMoon,
  IconPencil,
  IconPin,
  IconPullRequest,
  IconShare,
  IconTrash,
  IconX,
} from "../../../packages/core/opensession-server/src/frontend/components/icons";
import type { Section, Specimen } from "../entry";

const noop = () => {};

/** Dialogs park focus on open, and the harness's fresh page counts that as
 *  keyboard focus, so the ring shows. Drop it to capture the at-rest look a
 *  pointer-opened dialog has. */
function BlurOnOpen() {
  React.useEffect(() => {
    const t = window.setTimeout(
      () => (document.activeElement as HTMLElement | null)?.blur(),
      150,
    );
    return () => window.clearTimeout(t);
  }, []);
  return null;
}

/* ───────────────────────── Menu ───────────────────────── */

const ICON = `shrink-0 ${MENU_ICON}`;

/** Open menu with an anchor trigger; the popup is what gets captured. */
function OpenMenu({
  children,
  marker = "spec-menu",
  className,
}: {
  children: React.ReactNode;
  marker?: string;
  className?: string;
}) {
  return (
    <Menu.Root open modal={false}>
      <Menu.Trigger
        render={
          <Button
            variant="ghost"
            size="md"
            icon={<IconDotsHorizontal size={20} />}
            aria-label="Session actions"
          />
        }
      />
      <Menu.Popup className={`${marker} ${className ?? ""}`} align="start">
        {children}
      </Menu.Popup>
    </Menu.Root>
  );
}

const sessionActions = (opts: { highlighted?: string } = {}) => {
  const rows: [string, React.ReactNode, string?][] = [
    ["Rename", <IconPencil size={17} className={ICON} />, "R"],
    ["Pin to sidebar", <IconPin size={17} className={ICON} />, "⌘ P"],
    ["Copy link", <IconLink size={17} className={ICON} />, "⌘ L"],
    ["Archive", <IconArchive size={17} className={ICON} />, "⌘ ⌫"],
  ];
  return (
    <>
      {rows.map(([label, icon, sc]) => (
        <Menu.Item
          key={label}
          {...((opts.highlighted === label
            ? { "data-highlighted": "" }
            : {}) as any)}
        >
          {icon}
          <span className="grow truncate">{label}</span>
          {sc && <Menu.Shortcut>{sc}</Menu.Shortcut>}
        </Menu.Item>
      ))}
      <Menu.Separator />
      <Menu.Item
        className="text-red"
        {...((opts.highlighted === "Delete"
          ? { "data-highlighted": "" }
          : {}) as any)}
      >
        <IconTrash size={17} className="shrink-0" />
        <span className="grow truncate">Delete session</span>
      </Menu.Item>
    </>
  );
};

const MODELS = ["Opus 4.5", "Sonnet 4.5", "Haiku 4.5"];

const menuSpecimens: Specimen[] = [
  {
    name: "Actions · icons, shortcuts, destructive · default",
    node: <OpenMenu>{sessionActions()}</OpenMenu>,
    select: ".spec-menu",
  },
  {
    name: "Actions · icons, shortcuts, destructive · highlighted",
    node: (
      <OpenMenu>{sessionActions({ highlighted: "Pin to sidebar" })}</OpenMenu>
    ),
    select: ".spec-menu",
  },
  {
    name: "Actions · icons, shortcuts, destructive · destructive highlighted",
    node: <OpenMenu>{sessionActions({ highlighted: "Delete" })}</OpenMenu>,
    select: ".spec-menu",
  },
  {
    name: "Checks · radio group · one selected",
    node: (
      <OpenMenu>
        <Menu.Group>
          <Menu.GroupLabel>Model</Menu.GroupLabel>
          <Menu.RadioGroup value="Sonnet 4.5">
            {MODELS.map((m) => (
              <Menu.RadioItem key={m} value={m}>
                <span className="grow truncate">{m}</span>
                <Menu.Check on={m === "Sonnet 4.5"} />
              </Menu.RadioItem>
            ))}
          </Menu.RadioGroup>
        </Menu.Group>
      </OpenMenu>
    ),
    select: ".spec-menu",
  },
  {
    name: "Checks · checkbox items · mixed",
    node: (
      <OpenMenu>
        <Menu.Group>
          <Menu.GroupLabel>Show in sidebar</Menu.GroupLabel>
          {[
            ["Sessions", true],
            ["Automations", true],
            ["Reviews", false],
            ["Archived runs", false],
          ].map(([label, on]) => (
            <Menu.CheckboxItem key={label as string} checked={on as boolean}>
              <span className="grow truncate">{label}</span>
              <Menu.Check on={on as boolean} />
            </Menu.CheckboxItem>
          ))}
        </Menu.Group>
      </OpenMenu>
    ),
    select: ".spec-menu",
  },
  {
    name: "Submenu · trigger row · closed",
    node: (
      <OpenMenu>
        <Menu.Item>
          <IconShare size={17} className={ICON} />
          <span className="grow truncate">Share session</span>
        </Menu.Item>
        <Menu.SubmenuRoot>
          <Menu.SubmenuTrigger className="justify-between gap-3">
            <span className="truncate">Move to project</span>
            <span className="flex flex-none items-center gap-2 text-dim">
              <span className="truncate">Wallet pass redesign</span>
              <IconChevronRight className="shrink-0 text-faint" size={17} />
            </span>
          </Menu.SubmenuTrigger>
          <Menu.Popup>
            <Menu.Item>Habit</Menu.Item>
          </Menu.Popup>
        </Menu.SubmenuRoot>
        <Menu.Separator />
        <Menu.Item>
          <IconGear size={17} className={ICON} />
          <span className="grow truncate">Session settings</span>
          <Menu.Shortcut>⌘ ,</Menu.Shortcut>
        </Menu.Item>
      </OpenMenu>
    ),
    select: ".spec-menu",
  },
  {
    name: "Submenu · trigger row · open",
    node: (
      <OpenMenu>
        <Menu.Item>
          <IconShare size={17} className={ICON} />
          <span className="grow truncate">Share session</span>
        </Menu.Item>
        <Menu.SubmenuRoot open>
          <Menu.SubmenuTrigger className="justify-between gap-3">
            <span className="truncate">Move to project</span>
            <span className="flex flex-none items-center gap-2 text-dim">
              <span className="truncate">Wallet pass redesign</span>
              <IconChevronRight className="shrink-0 text-faint" size={17} />
            </span>
          </Menu.SubmenuTrigger>
          <Menu.Popup className="spec-sub">
            {["Wallet pass redesign", "Habit", "Stripe reconciliation"].map(
              (p) => (
                <Menu.Item key={p}>
                  <span className="grow truncate">{p}</span>
                  <Menu.Check on={p === "Wallet pass redesign"} />
                </Menu.Item>
              ),
            )}
          </Menu.Popup>
        </Menu.SubmenuRoot>
        <Menu.Separator />
        <Menu.Item>
          <IconGear size={17} className={ICON} />
          <span className="grow truncate">Session settings</span>
          <Menu.Shortcut>⌘ ,</Menu.Shortcut>
        </Menu.Item>
      </OpenMenu>
    ),
    select: ".spec-menu",
  },
  {
    name: "Submenu · child popup · open",
    node: (
      <OpenMenu>
        <Menu.SubmenuRoot open>
          <Menu.SubmenuTrigger className="justify-between gap-3">
            <span className="truncate">Move to project</span>
            <IconChevronRight className="shrink-0 text-faint" size={17} />
          </Menu.SubmenuTrigger>
          <Menu.Popup className="spec-sub">
            {["Wallet pass redesign", "Habit", "Stripe reconciliation"].map(
              (p) => (
                <Menu.Item key={p}>
                  <span className="grow truncate">{p}</span>
                  <Menu.Check on={p === "Wallet pass redesign"} />
                </Menu.Item>
              ),
            )}
          </Menu.Popup>
        </Menu.SubmenuRoot>
      </OpenMenu>
    ),
    select: ".spec-sub",
  },
  {
    name: "Long text · truncates · default",
    node: (
      <OpenMenu className="w-[240px]">
        <>
          {[
            "Reconcile September Stripe payouts against the ledger export",
            "Wallet pass redesign with the new brand palette and icons",
          ].map((t) => (
            <Menu.Item key={t}>
              <IconClock size={17} className={ICON} />
              <span className="min-w-0 grow truncate">{t}</span>
            </Menu.Item>
          ))}
        </>
      </OpenMenu>
    ),
    select: ".spec-menu",
  },
];

/* ───────────────────────── Popover ───────────────────────── */

function HoverCardBody() {
  return (
    <div className="flex w-[280px] flex-col gap-1 p-3">
      <div className="truncate text-control-label font-semibold text-fg">
        Reconcile September Stripe payouts
      </div>
      <div className="text-supporting text-dim">
        Running for 12 min in Finance ops. 3 files changed.
      </div>
    </div>
  );
}

function OpenPopover({
  side = "bottom",
  ...popup
}: Omit<
  React.ComponentProps<typeof Popover.Popup>,
  "children" | "className"
> & { children?: React.ReactNode }) {
  return (
    <Popover.Root open>
      <Popover.Trigger
        render={<Button variant="soft">Session details</Button>}
      />
      <Popover.Popup side={side} className="spec-pop" {...popup}>
        {popup.children ?? <HoverCardBody />}
      </Popover.Popup>
    </Popover.Root>
  );
}

const popoverSpecimens: Specimen[] = [
  ...(["sm", "md", "lg"] as const).map((e) => ({
    name: `Elevation · ${e} · open`,
    node: <OpenPopover elevation={e} />,
    select: ".spec-pop",
  })),
  ...(["default", "soft"] as const).map((r) => ({
    name: `Ring · ${r} · open`,
    node: <OpenPopover ring={r} />,
    select: ".spec-pop",
  })),
  ...(["bottom", "top", "right", "left"] as const).map((s) => ({
    name: `Arrow · ${s} · open`,
    node: (
      <div style={{ padding: 200 }}>
        <OpenPopover side={s} arrow />
      </div>
    ),
    select: ".spec-pop",
  })),
  {
    name: "Controls · click popover · open",
    node: (
      <OpenPopover>
        <div className="flex w-[300px] flex-col gap-3 p-3">
          <div className="text-control-label font-semibold text-fg">
            Run this automation now?
          </div>
          <div className="text-supporting text-dim">
            Weekly payout reconciliation runs on the main workspace.
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="soft" size="sm">
              Cancel
            </Button>
            <Button variant="primary" size="sm">
              Run now
            </Button>
          </div>
        </div>
      </OpenPopover>
    ),
    select: ".spec-pop",
  },
];

/* ───────────────────────── Tooltip ───────────────────────── */

/** Tooltip has no `open` prop: focus the trigger on mount (focus opens it). */
function OpenTooltip(
  props: Omit<
    React.ComponentProps<typeof Tooltip>,
    "children" | "popupClassName"
  > & { trigger?: React.ReactElement },
) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    ref.current?.querySelector<HTMLElement>("button")?.focus();
  }, []);
  const { trigger, ...rest } = props;
  return (
    <div ref={ref} style={{ padding: 80 }}>
      <Tooltip {...rest} popupClassName="spec-tip">
        {trigger ?? (
          <Button
            variant="ghost"
            icon={<IconShare size={20} />}
            aria-label="Share"
          />
        )}
      </Tooltip>
    </div>
  );
}

const tooltipSpecimens: Specimen[] = [
  {
    name: "Label · plain · open",
    node: <OpenTooltip label="Share session" />,
    select: ".spec-tip",
  },
  {
    name: "Label · with shortcut · open",
    node: <OpenTooltip label="New session" shortcut={["⌘", "N"]} />,
    select: ".spec-tip",
  },
  {
    name: "Label · long · truncated",
    node: (
      <OpenTooltip label="Reconcile September Stripe payouts against the October ledger export and flag mismatches" />
    ),
    select: ".spec-tip",
  },
  {
    name: "Multiline · wraps · open",
    node: (
      <OpenTooltip
        multiline
        label={
          "Archived sessions keep their transcript and worktree.\nRestore one from the archive to keep working on it."
        }
      />
    ),
    select: ".spec-tip",
  },
];

/* ───────────────────────── Modal ───────────────────────── */

function Field({ label, value }: { label: string; value: string }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-control-label text-fg">{label}</span>
      <input
        readOnly
        value={value}
        className="h-9 rounded-control border border-line bg-surface px-3 text-control-label text-fg outline-none"
      />
    </label>
  );
}

const modalSpecimens: Specimen[] = [
  {
    name: "Centered · header, body, footer · open",
    node: (
      <>
        <BlurOnOpen />
        <Modal.Root open>
          <Modal.Content>
            <Modal.Header
              title="Session goal"
              description="Rides along with every prompt in this session, so the agent keeps the outcome in view."
            />
            <Field label="Goal" value="Reconcile September Stripe payouts" />
            <Modal.Footer>
              <Button variant="soft" size="lg">
                Cancel
              </Button>
              <Button variant="primary" size="lg">
                Set goal
              </Button>
            </Modal.Footer>
          </Modal.Content>
        </Modal.Root>
      </>
    ),
    select: '[role="dialog"]',
  },
  {
    name: "Centered · title only · open",
    node: (
      <>
        <BlurOnOpen />
        <Modal.Root open>
          <Modal.Content>
            <Modal.Header title="Rename project" />
            <Field label="Name" value="Wallet pass redesign" />
            <Modal.Footer>
              <Button variant="soft" size="lg">
                Cancel
              </Button>
              <Button variant="primary" size="lg">
                Rename
              </Button>
            </Modal.Footer>
          </Modal.Content>
        </Modal.Root>
      </>
    ),
    select: '[role="dialog"]',
  },
  {
    name: "Centered · leading destructive · open",
    node: (
      <>
        <BlurOnOpen />
        <Modal.Root open>
          <Modal.Content>
            <Modal.Header
              title="Edit automation"
              description="Runs every Monday at 09:00 in the Finance ops workspace."
            />
            <Field label="Name" value="Weekly payout reconciliation" />
            <Modal.Footer>
              <Button variant="danger" size="lg" className="mr-auto">
                Delete
              </Button>
              <Button variant="soft" size="lg">
                Cancel
              </Button>
              <Button variant="primary" size="lg">
                Save
              </Button>
            </Modal.Footer>
          </Modal.Content>
        </Modal.Root>
      </>
    ),
    select: '[role="dialog"]',
  },
  {
    name: "Centered · long title · open",
    node: (
      <>
        <BlurOnOpen />
        <Modal.Root open>
          <Modal.Content>
            <Modal.Header
              title="Move Reconcile September Stripe payouts to another workspace"
              description="The worktree and its branch move with the session."
            />
            <Modal.Footer>
              <Button variant="soft" size="lg">
                Cancel
              </Button>
              <Button variant="primary" size="lg">
                Move session
              </Button>
            </Modal.Footer>
          </Modal.Content>
        </Modal.Root>
      </>
    ),
    select: '[role="dialog"]',
  },
  {
    name: "Palette · search and rows · open",
    node: (
      <>
        <BlurOnOpen />
        <Modal.Root open>
          <Modal.Content
            variant="palette"
            aria-label="Search sessions"
            widthClassName="w-[640px]"
          >
            <div className="flex h-12 items-center border-b border-line px-4 text-body text-faint">
              Search sessions
            </div>
            <div className="flex flex-col p-1.5">
              {[
                "Reconcile September Stripe payouts",
                "Wallet pass redesign",
                "Habit streak widget",
              ].map((t, i) => (
                <div
                  key={t}
                  className={`flex items-center gap-2 rounded-md px-3 py-2 text-control-label text-fg ${i === 0 ? "bg-hover" : ""}`}
                >
                  <IconClock size={17} className={ICON} />
                  <span className="grow truncate">{t}</span>
                </div>
              ))}
            </div>
          </Modal.Content>
        </Modal.Root>
      </>
    ),
    select: '[role="dialog"]',
  },
  {
    name: "Floating · panel · open",
    node: (
      <>
        <BlurOnOpen />
        <Modal.Root open modal={false}>
          <Modal.Content
            variant="floating"
            aria-label="Desk"
            style={{ left: 40, top: 40, width: 420, height: 260 }}
          >
            <div className="flex h-11 items-center px-4 text-control-label font-semibold text-fg">
              Desk
            </div>
            <div className="px-4 text-supporting text-dim">
              Ask about any session in this workspace.
            </div>
          </Modal.Content>
        </Modal.Root>
      </>
    ),
    select: '[role="dialog"]',
  },
  {
    name: "Phone · centered · open",
    node: (
      <>
        <BlurOnOpen />
        <Modal.Root open>
          <Modal.Content>
            <Modal.Header
              title="Session goal"
              description="Rides along with every prompt in this session."
            />
            <Field label="Goal" value="Reconcile September Stripe payouts" />
            <Modal.Footer>
              <Button variant="soft" size="lg">
                Cancel
              </Button>
              <Button variant="primary" size="lg">
                Set goal
              </Button>
            </Modal.Footer>
          </Modal.Content>
        </Modal.Root>
      </>
    ),
    select: '[role="dialog"]',
    viewport: 390,
  },
];

/* ───────────────────────── Confirm ───────────────────────── */

const confirmFocus: Specimen = {
  name: "Desktop · destructive · keyboard focus on cancel",
  node: (
    <ConfirmDialog
      open
      onOpenChange={noop}
      request={{
        title: "Delete this draft?",
        description: "It has no sessions, so nothing else is removed.",
        confirmLabel: "Delete",
        destructive: true,
        onConfirm: noop,
      }}
    />
  ),
  select: '[role="alertdialog"]',
};

const confirmSpecimens = (viewport?: number): Specimen[] => [
  {
    name: `${viewport ? "Phone" : "Desktop"} · default · open`,
    node: (
      <>
        <BlurOnOpen />
        <ConfirmDialog
          open
          onOpenChange={noop}
          request={{
            title: "Restart the run?",
            description: "The agent starts again from the last checkpoint.",
            confirmLabel: "Restart",
            onConfirm: noop,
          }}
        />
      </>
    ),
    select: '[role="alertdialog"]',
    viewport,
  },
  {
    name: `${viewport ? "Phone" : "Desktop"} · destructive · open`,
    node: (
      <>
        <BlurOnOpen />
        <ConfirmDialog
          open
          onOpenChange={noop}
          request={{
            title: "Delete this draft?",
            description: "It has no sessions, so nothing else is removed.",
            confirmLabel: "Delete",
            destructive: true,
            onConfirm: noop,
          }}
        />
      </>
    ),
    select: '[role="alertdialog"]',
    viewport,
  },
  {
    name: `${viewport ? "Phone" : "Desktop"} · title only · open`,
    node: (
      <>
        <BlurOnOpen />
        <ConfirmDialog
          open
          onOpenChange={noop}
          request={{
            title: "Archive Wallet pass redesign?",
            confirmLabel: "Archive",
            onConfirm: noop,
          }}
        />
      </>
    ),
    select: '[role="alertdialog"]',
    viewport,
  },
];

/* ───────────────────────── Sheet ───────────────────────── */

function SessionSheetContent() {
  return (
    <SheetBody>
      <SheetTitle>Reconcile September Stripe payouts</SheetTitle>
      <SheetItem tone="accent">
        <IconChevronRight size={22} />
        Open session
      </SheetItem>
      <SheetItem tone="green">
        <IconGitMerge size={22} />
        Merge pull request
      </SheetItem>
      <SheetItem>
        <IconPin size={22} />
        Pin to sidebar
      </SheetItem>
      <SheetItem>
        <IconClock size={22} />
        Snooze until tomorrow
      </SheetItem>
      <SheetSeparator />
      <SheetItem tone="danger">
        <IconTrash size={22} />
        Delete session
      </SheetItem>
    </SheetBody>
  );
}

const PANEL = '[role="dialog"] > div:last-child';

const sheetSpecimens: Specimen[] = [
  {
    name: "Responsive dialog · desktop · open",
    node: (
      <ResponsiveDialog
        open
        onClose={noop}
        phone={false}
        label="Session actions"
      >
        <div className="flex flex-col gap-1 p-2.5">
          <SessionSheetContent />
        </div>
      </ResponsiveDialog>
    ),
    select: PANEL,
  },
  {
    name: "Responsive dialog · phone sheet · open",
    node: (
      <ResponsiveDialog open onClose={noop} phone label="Session actions">
        <SessionSheetContent />
      </ResponsiveDialog>
    ),
    select: PANEL,
    viewport: 390,
  },
  {
    name: "Responsive dialog · phone sheet · no grabber",
    node: (
      <ResponsiveDialog
        open
        onClose={noop}
        phone
        showPhoneGrabber={false}
        label="Session actions"
      >
        <SessionSheetContent />
      </ResponsiveDialog>
    ),
    select: PANEL,
    viewport: 390,
  },
  {
    name: "Bottom sheet · snooze · open",
    node: (
      <BottomSheet onClose={noop} label="Snooze">
        <SheetBody>
          <SheetTitle>Snooze Wallet pass redesign</SheetTitle>
          {["Later today", "Tomorrow", "Next week"].map((t) => (
            <SheetItem key={t}>
              <IconClock size={22} />
              {t}
            </SheetItem>
          ))}
          <SheetSeparator />
          <SheetItem tone="accent">
            <IconMoon size={22} />
            Unsnooze
          </SheetItem>
        </SheetBody>
      </BottomSheet>
    ),
    select: PANEL,
    viewport: 390,
  },
  {
    name: "Phone page · settings · open",
    node: (
      <PhonePage onClose={noop} label="Settings">
        <PhoneTopBar>
          <SheetIconButton
            className="absolute left-3"
            aria-label="Back to settings"
          >
            <IconChevronLeft size={24} />
          </SheetIconButton>
          <PhoneTopBarTitle>Model providers</PhoneTopBarTitle>
          <SheetIconButton
            className="absolute right-3"
            aria-label="Close settings"
          >
            <IconX size={24} />
          </SheetIconButton>
        </PhoneTopBar>
        <div className="px-4 pt-4 text-supporting text-dim">
          Connect a provider to run sessions with its models.
        </div>
      </PhonePage>
    ),
    select: PANEL,
    viewport: 390,
  },
  ...(["default", "accent", "green", "purple", "danger"] as const).flatMap(
    (tone) =>
      (["default", "pressed"] as const).map((st) => ({
        name: `Sheet item · ${tone} · ${st}`,
        node: (
          <SheetItem
            tone={tone}
            {...((st === "pressed" ? { "data-force-active": "" } : {}) as any)}
          >
            {tone === "danger" ? (
              <IconTrash size={22} />
            ) : tone === "green" ? (
              <IconGitMerge size={22} />
            ) : tone === "purple" ? (
              <IconPullRequest size={22} />
            ) : tone === "accent" ? (
              <IconCheckCircle size={22} />
            ) : (
              <IconCopy size={22} />
            )}
            {
              {
                default: "Copy branch name",
                accent: "Open session",
                green: "Merge pull request",
                purple: "Open pull request",
                danger: "Delete session",
              }[tone]
            }
          </SheetItem>
        ),
        width: 370,
        on: "--bg-surface",
      })),
  ),
  {
    name: "Sheet item · default · long text",
    node: (
      <SheetItem>
        <IconPin size={22} />
        <span className="min-w-0 truncate">
          Pin Reconcile September Stripe payouts against the ledger to the
          sidebar
        </span>
      </SheetItem>
    ),
    width: 370,
    on: "--bg-surface",
  },
  ...(["default", "hover", "pressed", "focus", "disabled"] as const).map(
    (st) => ({
      name: `Sheet icon button · close · ${st}`,
      node: (
        <SheetIconButton
          aria-label="Close"
          {...((st === "hover"
            ? { "data-force-hover": "" }
            : st === "pressed"
              ? { "data-force-active": "", "data-force-hover": "" }
              : st === "focus"
                ? { "data-force-focus": "" }
                : st === "disabled"
                  ? { disabled: true }
                  : {}) as any)}
        >
          <IconX size={24} />
        </SheetIconButton>
      ),
      on: "--bg-surface",
    }),
  ),
  {
    name: "Sheet title · default · truncates",
    node: (
      <SheetTitle>
        Reconcile September Stripe payouts against the October ledger export
      </SheetTitle>
    ),
    width: 370,
    on: "--bg-surface",
  },
  {
    name: "Sheet separator · default · default",
    node: (
      <div className="w-full py-1">
        <SheetSeparator />
      </div>
    ),
    width: 370,
    on: "--bg-surface",
  },
];

/* ───────────────────────── Toast ───────────────────────── */

type ToastSpec = [string, ToastOptions?];

/** Fires real toasts through the toast() API once the host is mounted. */
function ToastDemo({ items }: { items: ToastSpec[] }) {
  React.useEffect(() => {
    // Long enough to never expire during capture; keeps the progress line.
    for (const [m, o] of items) toast(m, { duration: 600_000, ...o });
  }, []);
  return <ToastHost />;
}

const TOAST_PILL = ".toast-viewport > * > *";

const toastRows = (viewport?: number): Specimen[] => {
  const row = viewport ? "Phone" : "Tone";
  return [
    {
      name: `${row} · default · no icon`,
      node: <ToastDemo items={[["Run queued behind 2 others"]]} />,
      select: TOAST_PILL,
      viewport,
    },
    {
      name: `${row} · success · check`,
      node: <ToastDemo items={[["Goal saved"]]} />,
      select: TOAST_PILL,
      viewport,
    },
    {
      name: `${row} · success · archived`,
      node: <ToastDemo items={[["Session archived"]]} />,
      select: TOAST_PILL,
      viewport,
    },
    {
      name: `${row} · success · copied`,
      node: <ToastDemo items={[["Branch name copied"]]} />,
      select: TOAST_PILL,
      viewport,
    },
    {
      name: `${row} · error · default`,
      node: (
        <ToastDemo items={[["Could not reach the workspace. Try again."]]} />
      ),
      select: TOAST_PILL,
      viewport,
    },
    {
      name: `${row} · success · with action`,
      node: (
        <ToastDemo
          items={[
            ["Session archived", { action: { label: "Undo", onClick: noop } }],
          ]}
        />
      ),
      select: TOAST_PILL,
      viewport,
    },
    {
      name: `${row} · ongoing · spinner`,
      node: (
        <ToastDemo
          items={[
            ["Restoring worktree", { ongoing: true, variant: "default" }],
          ]}
        />
      ),
      select: TOAST_PILL,
      viewport,
    },
    {
      name: `${row} · error · long text`,
      node: (
        <ToastDemo
          items={[
            [
              "Could not merge the pull request for Reconcile September Stripe payouts because the branch has conflicts with main",
            ],
          ]}
        />
      ),
      select: TOAST_PILL,
      viewport,
    },
  ];
};

const toastStack: Specimen = {
  name: "Stack · three toasts · collapsed",
  node: (
    <ToastDemo
      items={[
        ["Wallet pass redesign created"],
        ["Automation started"],
        ["Session archived", { action: { label: "Undo", onClick: noop } }],
      ]}
    />
  ),
  select: ".toast-viewport",
};

/* ───────────────────────── Floating status ───────────────────────── */

const floatingSpecimens: Specimen[] = [
  {
    name: "Status · spinner · default",
    node: (
      <FloatingStatus>
        <Spinner className="text-dim" />
        Reconnecting to workspace
      </FloatingStatus>
    ),
  },
  {
    name: "Status · icon · default",
    node: (
      <FloatingStatus>
        <IconCheckCircle size={16} className="text-green" />
        All runs finished
      </FloatingStatus>
    ),
  },
  {
    name: "Status · text only · default",
    node: <FloatingStatus>3 sessions waiting for review</FloatingStatus>,
  },
];

/* ───────────────────────── Overlay action ───────────────────────── */

function Preview({
  state,
  disabled,
}: {
  state?: "hover" | "focus";
  disabled?: boolean;
}) {
  return (
    <div style={{ padding: 12 }}>
      <div
        className="relative flex items-start group/overlay-action"
        {...((state === "hover" ? { "data-force-hover": "" } : {}) as any)}
      >
        <div className="flex h-16 w-24 items-center justify-center rounded-md text-center border border-line-strong bg-panel text-meta text-faint">
          Screenshot
        </div>
        <OverlayAction
          aria-label="Remove screenshot"
          disabled={disabled}
          icon={<IconX className="text-red" size={16} />}
          {...((state === "focus" ? { "data-force-focus": "" } : {}) as any)}
        />
      </div>
    </div>
  );
}

const overlaySpecimens: Specimen[] = [
  { name: "Remove · over preview · hover", node: <Preview state="hover" /> },
  { name: "Remove · over preview · focus", node: <Preview state="focus" /> },
  {
    name: "Remove · over preview · disabled hover",
    node: <Preview state="hover" disabled />,
  },
];

/* ───────────────────────── Sections ───────────────────────── */

export const sections: Section[] = [
  { group: "Menu", title: "Rows", specimens: menuSpecimens.slice(0, 3) },
  { group: "Menu", title: "Checks", specimens: menuSpecimens.slice(3, 5) },
  { group: "Menu", title: "Submenu", specimens: menuSpecimens.slice(5, 8) },
  { group: "Menu", title: "Truncation", specimens: menuSpecimens.slice(8) },
  {
    group: "Popover",
    title: "Elevation and ring",
    specimens: popoverSpecimens.slice(0, 5),
  },
  { group: "Popover", title: "Arrow", specimens: popoverSpecimens.slice(5, 9) },
  { group: "Popover", title: "Content", specimens: popoverSpecimens.slice(9) },
  { group: "Tooltip", title: "Variants", specimens: tooltipSpecimens },
  { group: "Modal", title: "Variants", specimens: modalSpecimens.slice(0, 6) },
  { group: "Modal", title: "Phone", specimens: modalSpecimens.slice(6) },
  {
    group: "Confirm dialog",
    title: "Variants",
    specimens: [...confirmSpecimens(), confirmFocus],
  },
  { group: "Confirm dialog", title: "Phone", specimens: confirmSpecimens(390) },
  { group: "Sheet", title: "Surfaces", specimens: sheetSpecimens.slice(0, 5) },
  { group: "Sheet", title: "Parts", specimens: sheetSpecimens.slice(5) },
  { group: "Toast", title: "Tones", specimens: [...toastRows(), toastStack] },
  { group: "Toast", title: "Phone", specimens: toastRows(390) },
  { group: "Floating status", title: "Variants", specimens: floatingSpecimens },
  { group: "Overlay action", title: "States", specimens: overlaySpecimens },
];

export const descriptions: Record<string, string> = {
  Menu: "ui/menu.tsx · a list of actions or choices opened from a trigger or a right-click",
  Popover:
    "ui/popover.tsx · a hover card or small click-opened panel anchored to a trigger",
  Tooltip:
    "ui/tooltip.tsx · names an icon-only control, with its shortcut when it has one",
  Modal:
    "ui/modal.tsx · a focused edit or decision that blocks the page until answered",
  "Confirm dialog":
    "ui/confirm.tsx · asks one yes-or-no question before an action, red when it destroys something",
  Sheet:
    "ui/sheet.tsx · surfaces that own their open state, a modal on desktop and a bottom sheet on phone",
  Toast:
    "ui/toast.tsx · a short receipt for something that just happened, with an undo when it can be reversed",
  "Floating status":
    "ui/floating-status.tsx · a passive status line lifted above the current surface",
  "Overlay action":
    "ui/overlay-action.tsx · a compact remove or edit action on the corner of a preview",
};
