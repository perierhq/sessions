import { Button } from "../../../packages/core/opensession-server/src/frontend/ui/button";
import { PlainButton } from "../../../packages/core/opensession-server/src/frontend/ui/plain-button";
import { TextLink } from "../../../packages/core/opensession-server/src/frontend/ui/text-link";
import { SettingsHint } from "../../../packages/core/opensession-server/src/frontend/ui/settings";
import {
  IconPlus,
  IconShare,
  IconGear,
  IconTrash,
  IconGitMerge,
  IconArrowUpRight,
  IconChevronRight,
  IconFolder,
  IconX,
} from "../../../packages/core/opensession-server/src/frontend/components/icons";
import type { Section } from "../entry";

const VARIANTS = [
  "primary",
  "default",
  "soft",
  "ghost",
  "success",
  "danger",
  "warning",
  "success-strong",
  "danger-strong",
] as const;
const SIZES = ["sm", "md", "lg"] as const;
const STATES = ["default", "hover", "pressed", "focus", "disabled"] as const;

const state = (s: (typeof STATES)[number]) =>
  s === "hover"
    ? { "data-force-hover": "" }
    : s === "pressed"
      ? { "data-force-active": "", "data-force-hover": "" }
      : s === "focus"
        ? { "data-force-focus": "" }
        : s === "disabled"
          ? { disabled: true }
          : {};

const label: Record<string, string> = {
  primary: "Create session",
  default: "Share",
  soft: "Cancel",
  ghost: "All workspaces",
  success: "Approve",
  danger: "Delete",
  warning: "Keep worktree",
  "success-strong": "Merge",
  "danger-strong": "Delete session",
};

export const sections: Section[] = [
  {
    group: "Button",
    title: "Variants × sizes",
    specimens: VARIANTS.flatMap((v) =>
      SIZES.map((s) => ({
        name: `${v} · ${s}`,
        node: (
          <Button variant={v} size={s}>
            {label[v]}
          </Button>
        ),
      })),
    ),
  },
  {
    group: "Button",
    title: "States",
    specimens: (
      ["primary", "default", "soft", "ghost", "danger"] as const
    ).flatMap((v) =>
      STATES.map((st) => ({
        name: `${v} · md · ${st}`,
        node: (
          <Button variant={v} size="md" {...(state(st) as any)}>
            {label[v]}
          </Button>
        ),
      })),
    ),
  },
  {
    group: "Button",
    title: "Icon, caret, trailing",
    specimens: [
      {
        name: "default · md · icon lead",
        node: <Button icon={<IconShare size={20} />}>Share</Button>,
      },
      {
        name: "primary · md · icon lead",
        node: (
          <Button variant="primary" icon={<IconPlus size={20} />}>
            New session
          </Button>
        ),
      },
      {
        name: "success-strong · sm · icon lead",
        node: (
          <Button
            variant="success-strong"
            size="sm"
            icon={<IconGitMerge size={20} />}
          >
            Merge
          </Button>
        ),
      },
      {
        name: "soft · md · caret",
        node: (
          <Button variant="soft" caret>
            Opus 4.5
          </Button>
        ),
      },
      {
        name: "ghost · md · caret",
        node: (
          <Button variant="ghost" caret>
            All workspaces
          </Button>
        ),
      },
      {
        name: "default · md · trailing",
        node: (
          <Button trailing={<IconArrowUpRight size={20} />}>Open PR</Button>
        ),
      },
      ...SIZES.map((s) => ({
        name: `ghost · ${s} · icon only`,
        node: (
          <Button
            variant="ghost"
            size={s}
            icon={<IconGear size={20} />}
            aria-label="Settings"
          />
        ),
      })),
      ...SIZES.map((s) => ({
        name: `default · ${s} · icon only`,
        node: (
          <Button
            variant="default"
            size={s}
            icon={<IconShare size={20} />}
            aria-label="Share"
          />
        ),
      })),
      {
        name: "danger · md · icon only",
        node: (
          <Button
            variant="danger"
            icon={<IconTrash size={20} />}
            aria-label="Delete"
          />
        ),
      },
    ],
  },
];

const STATES_PLAIN = ["default", "hover", "focus", "disabled"] as const;

// PlainButton brings no plate: the caller lays it out and paints its hover,
// the way a project row in settings does.
const plainRow =
  "flex w-full items-center gap-3 rounded-row px-3 py-2 hover:bg-hover";

sections.push(
  {
    group: "Button",
    title: "Overlay",
    specimens: (["default", "hover", "disabled"] as const).map((st) => ({
      name: `overlay · md · ${st}`,
      node: (
        <div className="flex gap-1 rounded-lg bg-black/80 p-2">
          <Button
            variant="overlay"
            icon={<IconArrowUpRight size={20} />}
            {...(state(st) as any)}
          >
            Open original
          </Button>
          <Button
            variant="overlay"
            icon={<IconX size={20} />}
            aria-label="Close preview"
            {...(state(st) as any)}
          />
        </div>
      ),
    })),
  },
  {
    group: "Plain button",
    title: "Row",
    specimens: STATES_PLAIN.map((st) => ({
      name: `row · ${st}`,
      width: 368,
      // Padded so the focus outline (2px, offset 2px) is inside the capture.
      node: (
        <div className="flex w-full p-1">
          <PlainButton className={plainRow} {...(state(st) as any)}>
            <IconFolder size={20} className="shrink-0 text-faint" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-label font-medium text-fg">
                wallet
              </span>
              <span className="block text-meta text-dim">
                3 sessions · last run 12 minutes ago
              </span>
            </span>
            <IconChevronRight size={16} className="shrink-0 text-faint" />
          </PlainButton>
        </div>
      ),
    })),
  },
  {
    group: "Plain button",
    title: "Link weight",
    specimens: STATES_PLAIN.map((st) => ({
      name: `action · ${st}`,
      node: (
        <div className="flex p-1">
          <PlainButton
            className="rounded-sm text-label font-medium text-dim hover:text-fg"
            {...(state(st) as any)}
          >
            Show all 14 runs
          </PlainButton>
        </div>
      ),
    })),
  },
  {
    group: "Text link",
    title: "States",
    specimens: (["default", "hover", "focus"] as const).map((st) => ({
      name: `link · ${st}`,
      node: (
        // Padded so the focus outline (2px, offset 2px) is inside the capture.
        <span className="p-1.5 text-supporting text-faint">
          Sandbox providers are connected in{" "}
          <TextLink {...(state(st) as any)}>Organization → Sandboxes</TextLink>
        </span>
      ),
    })),
  },
  {
    group: "Text link",
    title: "In a hint",
    specimens: [
      {
        name: "hint · default",
        width: 640,
        node: (
          <SettingsHint className="w-full">
            Sandbox providers are connected in{" "}
            <TextLink>Organization → Sandboxes</TextLink>
          </SettingsHint>
        ),
      },
    ],
  },
);

export const descriptions: Record<string, string> = {
  Button:
    "ui/button.tsx · primary is the one answer on a surface, soft for every other button in a row",
  "Plain button":
    "ui/plain-button.tsx · a button with no plate: a whole row, a band toggle or a link-weight action the caller lays out",
  "Text link":
    "ui/text-link.tsx · a link-weight action inside a line of text, underlined in the text's own colour",
};
